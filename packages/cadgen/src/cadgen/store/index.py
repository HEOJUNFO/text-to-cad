"""Input-addressed index entries: records, op-memo entries, mesh entries.

Every entry is a small JSON file written temp + rename. The key is what
PRODUCED the entry (a model's script, an op's inputs, a surface × tolerance),
never the content — that is the one distinction between ``index/`` and
``objects/``.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Iterator

from cadgen._internal.atomic_replace import replace_atomic, temp_suffix
from cadgen.store.paths import EVICTABLE_KINDS as _EVICTABLE, index_dir


MODEL_REF_SEP = "::"


def _resolved_text(path: Path | str) -> str:
    try:
        return str(Path(path).expanduser().resolve())
    except (OSError, ValueError, RuntimeError):
        return os.path.abspath(str(path))


def split_model_ref(model: Path | str) -> tuple[Path, str | None]:
    """``"/abs/file.py::fn"`` -> (script, "fn"); a bare path -> (path, None)."""
    text = str(model)
    if MODEL_REF_SEP in text:
        script, _, function = text.rpartition(MODEL_REF_SEP)
        return Path(_resolved_text(script)), (function or None)
    return Path(_resolved_text(text)), None


def model_ref(script: Path | str, function: str | None) -> str:
    """A model's identity: its resolved script path and the decorated function's
    name, ``/abs/file.py::fn``. A document (an imported STEP, keyed on its own
    path) has no function and its identity is the bare path."""
    resolved = _resolved_text(script)
    return f"{resolved}{MODEL_REF_SEP}{function}" if function else resolved


def resolve_model_ref(model: Path | str) -> str:
    """The identity behind what a caller named: an explicit ``script::fn`` stands;
    a bare ``.py`` path names its sole model (a file holding several models must be
    named ``script::fn`` -- ``cadgen.metadata.parse_generator_metadata`` says so);
    any other path is a document and its own identity."""
    script, function = split_model_ref(model)
    if function is not None:
        return model_ref(script, function)
    if script.suffix.lower() != ".py":
        return model_ref(script, None)
    from cadgen.metadata import model_function_names

    names = model_function_names(script)
    if len(names) == 1:
        return model_ref(script, names[0])
    if len(names) > 1:
        raise ValueError(
            f"{script.name} declares several models ({', '.join(n + '()' for n in names)}); "
            f"name one as {script.name}{MODEL_REF_SEP}{names[0]}"
        )
    # No parseable model (the script is gone, or declares none): the bare path,
    # which a record written for it can still be found under (records.read_record
    # falls back to the script field).
    return model_ref(script, None)


def display_model(model: Path | str) -> str:
    """How a model is named to a person and in events: its script path, plus
    ``::fn`` only when the file holds more than one model."""
    script, function = split_model_ref(model)
    if function is None:
        return str(script)
    from cadgen.metadata import model_function_names

    names = model_function_names(script)
    if len(names) <= 1 and (not names or names[0] == function):
        return str(script)
    return model_ref(script, function)


def model_key(model: Path | str) -> str:
    """A model's index key: sha256 of its identity (``resolve_model_ref``)."""
    return hashlib.sha256(resolve_model_ref(model).encode("utf-8")).hexdigest()


def path_key(path: Path | str) -> str:
    """The index key of a plain path (output entries): sha256 of the resolved path."""
    return hashlib.sha256(_resolved_text(path).encode("utf-8")).hexdigest()


def entry_path(kind: str, key: str) -> Path:
    return index_dir(kind) / key


def read_entry(kind: str, key: str) -> dict[str, Any] | None:
    try:
        data = json.loads(entry_path(kind, key).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


# --- last use ------------------------------------------------------------------
#
# Every evictable entry (``paths.EVICTABLE_KINDS``) carries ``lastUsed``: the
# wall-clock second it was written or last hit. Eviction (STORE.md §8) drops
# entries least recently used first, so a hit refreshes the stamp -- at most
# once per ``TOUCH_INTERVAL_SECONDS`` per entry, so a warm build that hits an
# entry ten thousand times rewrites it once. Filesystem atime is never
# consulted: it is unreliable (noatime, relatime) and not ours to define.
#
# The stamp is bookkeeping on the entry, not part of what the entry says: a
# reader that validates an entry's field set strips it first (``strip_last_used``).

LAST_USED = "lastUsed"
TOUCH_INTERVAL_SECONDS = 3600.0


def strip_last_used(entry: dict[str, Any]) -> dict[str, Any]:
    """The entry without its use stamp -- what a field-set validator sees."""
    if LAST_USED not in entry:
        return entry
    return {field: value for field, value in entry.items() if field != LAST_USED}


def last_used(entry: dict[str, Any] | None, path: Path | None = None) -> float:
    """When an entry was last used, as a wall-clock timestamp.

    The ``lastUsed`` stamp when present; else the entry file's mtime, which is
    the moment it was written -- a genuine use event (never atime). An entry
    with neither is the least recently used of all (0.0).
    """
    stamp = 0.0
    if entry:
        raw = entry.get(LAST_USED)
        if isinstance(raw, (int, float)) and raw > 0:
            stamp = float(raw)
    if path is not None:
        try:
            stamp = max(stamp, path.stat().st_mtime)
        except OSError:
            pass
    return stamp


def touch_entry(kind: str, key: str, entry: dict[str, Any], *, now: float | None = None) -> bool:
    """Refresh ``lastUsed`` on a hit, throttled. True when the entry was rewritten.

    Best-effort: a store that cannot be written still serves the hit, and a
    concurrent rewrite of the same key carries identical content (an entry is a
    pure function of its key), so the rename race is harmless.
    """
    if kind not in _EVICTABLE:
        return False
    clock = time.time() if now is None else float(now)
    if clock - last_used(entry, entry_path(kind, key)) < TOUCH_INTERVAL_SECONDS:
        return False
    try:
        _write_entry_raw(kind, key, {**entry, LAST_USED: clock})
    except OSError:
        return False
    return True


def write_entry(kind: str, key: str, payload: dict[str, Any]) -> None:
    if kind in _EVICTABLE:
        payload = {**payload, LAST_USED: time.time()}
    _write_entry_raw(kind, key, payload)


def _write_entry_raw(kind: str, key: str, payload: dict[str, Any]) -> None:
    target = entry_path(kind, key)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}{temp_suffix()}")
        tmp.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        replace_atomic(tmp, target)
    except PermissionError as exc:
        from cadgen.store.paths import unwritable

        raise unwritable(exc, target) from None


def remove_entry(kind: str, key: str) -> None:
    try:
        entry_path(kind, key).unlink()
    except OSError:
        pass


def iter_entries(kind: str) -> Iterator[tuple[str, Path]]:
    root = index_dir(kind)
    if not root.is_dir():
        return
    for entry in sorted(root.iterdir()):
        if entry.is_file() and not entry.name.startswith("."):
            yield entry.name, entry
