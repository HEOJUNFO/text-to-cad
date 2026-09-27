"""Size-capped LRU eviction of the store's recomputable tiers (STORE.md §8).

Phase 1 of ``cadgen store gc --max-size``: drop op-memo, mesh, surface and
component entries least recently used first until the store's projected size
fits under the low watermark; phase 2 (``cadgen.store.gc``) is the ordinary
mark and sweep that reclaims whatever those entries alone were keeping.

What may go and what may not:

- **Evictable**: every entry under ``index/op`` (shapes, cached values, cached
  failures), ``index/mesh``, ``index/surface`` and ``index/component``. Each is
  a derivation a build recomputes on a miss, and every reader treats a missing
  entry or object as a miss, never an error or a different answer.
- **Protected**: records and their result/document trees, current-schema
  document indexes, output entries, and everything they reach. A record has
  exactly one tree -- there is no revision history in the record model, so
  "older revisions of a model" are already the unreferenced objects phase 2
  sweeps -- and a document index is the one thing a saved file's reader
  consults, so neither tier is an eviction candidate.
- **Leased**: an entry used within the grace window (plus the touch throttle,
  since a hit inside the throttle leaves the stamp alone) stays, whatever the
  cap says: a build in flight holds its entries that way. When the daemon
  knows a job is running against this store, the lease reaches back to that
  job's start.

Sizing is by the deduplicated reachable set, never by summed entry sizes:
objects are shared between tiers (an op result can be the very component a
current document pins), so an entry's eviction frees an object only when
nothing protected or leased still reaches it.

Crash safety needs no protocol: phase 1 removes index entries, phase 2 removes
objects nothing reaches, both temp-free single unlinks. An interruption at any
point leaves orphaned objects for the next sweep and nothing else.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from cadgen.store.index import TOUCH_INTERVAL_SECONDS, entry_path, iter_entries, last_used, read_entry, remove_entry
from cadgen.store.paths import EVICTABLE_KINDS, INDEX_KINDS, index_dir, objects_dir, store_root

ENV_MAX = "CADGEN_STORE_MAX"
# 20 GiB. Two orders of magnitude above a heavy project's working set (a cold
# build of an 18-system engine pins ~330 MB) and a fraction of any developer
# disk, so the cap is met by evicting stale work and never by starving live
# work. Fixed rather than a share of free space: the number a user sees in
# ``store info`` must not move because something else filled the disk.
DEFAULT_MAX_BYTES = 20 * 1024**3
# Eviction runs from the cap down to this fraction of it, so one pass buys
# headroom and the daemon is not evicting on every idle tick.
LOW_WATERMARK = 0.8

_SIZE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?\s*$", re.IGNORECASE)
_UNITS = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}


def parse_size(text: str) -> int:
    """``"20G"``, ``"500MB"``, ``"1.5 GiB"``, ``"0"`` (no cap) → bytes."""
    match = _SIZE.match(str(text))
    if not match:
        raise ValueError(f"not a size: {text!r} (examples: 20G, 500M, 1.5GiB, 0 for no cap)")
    return int(float(match[1]) * _UNITS[match[2].lower()])


def configured_max_bytes(env: dict[str, str] | None = None) -> int | None:
    """The cap in force: ``CADGEN_STORE_MAX`` when set (``0`` disables), else the default."""
    source = os.environ if env is None else env
    raw = str(source.get(ENV_MAX, "") or "").strip()
    if not raw:
        return DEFAULT_MAX_BYTES
    value = parse_size(raw)
    return value or None


# --- sizing ------------------------------------------------------------------------


def _scan_objects() -> tuple[dict[str, int], dict[str, float]]:
    sizes: dict[str, int] = {}
    mtimes: dict[str, float] = {}
    root = objects_dir()
    if not root.is_dir():
        return sizes, mtimes
    for shard in sorted(root.iterdir()):
        if not shard.is_dir() or len(shard.name) != 2:
            continue
        with os.scandir(shard) as it:
            for entry in it:
                if entry.name.startswith(".") or not entry.is_file(follow_symlinks=False):
                    continue
                try:
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                digest = shard.name + entry.name
                sizes[digest] = stat.st_size
                mtimes[digest] = stat.st_mtime
    return sizes, mtimes


def _index_bytes(kind: str) -> int:
    root = index_dir(kind)
    if not root.is_dir():
        return 0
    total = 0
    with os.scandir(root) as it:
        for entry in it:
            if entry.name.startswith("."):
                continue
            try:
                total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
    return total


def store_bytes() -> dict[str, int]:
    """``{"objects", "index", "total"}`` -- what counts against the cap.

    A stat walk, no reads: cheap enough for ``store info`` and for the daemon's
    idle check.
    """
    sizes, _ = _scan_objects()
    index = sum(_index_bytes(kind) for kind in INDEX_KINDS)
    objects = sum(sizes.values())
    return {"objects": objects, "index": index, "total": objects + index}


def foreign_bytes() -> dict[str, int]:
    """Bytes under the root that are NOT the store (``objects/`` and ``index/``).

    Directories an older cadgen wrote under the same root are no store content
    (STORE.md §2: nothing else lives there) and no sweep touches them; ``store
    info`` names them so an operator can delete what nothing reads.
    """
    root = store_root()
    found: dict[str, int] = {}
    if not root.is_dir():
        return found
    for child in sorted(root.iterdir()):
        if child.name in {"objects", "index"} or child.name.startswith("."):
            continue
        total = 0
        if child.is_file(follow_symlinks=False):
            total = child.stat().st_size
        else:
            for folder, _dirs, files in os.walk(child):
                for name in files:
                    try:
                        total += os.lstat(os.path.join(folder, name)).st_size
                    except OSError:
                        continue
        found[child.name] = total
    return found


# --- planning ----------------------------------------------------------------------


@dataclass
class Victim:
    kind: str
    key: str
    used: float
    objects: tuple[str, ...]
    entry_bytes: int


@dataclass
class Plan:
    cap: int
    low: int
    grace_seconds: float
    lease_floor: float | None
    bytes_before: int = 0
    protected_bytes: int = 0
    projected_bytes: int = 0
    counted: dict[str, int] = field(default_factory=dict)
    leased: dict[str, int] = field(default_factory=dict)
    victims: list[Victim] = field(default_factory=list)
    freed_object_bytes: int = 0
    freed_entry_bytes: int = 0

    @property
    def over(self) -> bool:
        return self.bytes_before > self.cap

    @property
    def fits(self) -> bool:
        return self.projected_bytes <= self.low

    def evicted(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for victim in self.victims:
            counts[victim.kind] = counts.get(victim.kind, 0) + 1
        return counts


def _tree_closure(tree_hash: str, sizes: dict[str, int], seen: set[str], cache: dict[str, dict | None]) -> None:
    """Every object a tree reaches, by structure alone (no byte verification --
    phase 2 verifies; here a damaged object just stays counted)."""
    from cadgen.store.objects import object_path

    pending = [tree_hash]
    while pending:
        digest = pending.pop()
        if digest in seen or digest not in sizes:
            continue
        if digest not in cache:
            try:
                data = json.loads(object_path(digest).read_bytes())
                cache[digest] = data if isinstance(data, dict) and data.get("kind") == "geometry-tree" else None
            except (OSError, ValueError, TypeError):
                cache[digest] = None
        tree = cache[digest]
        if tree is None:
            continue
        seen.add(digest)
        components = tree.get("components")
        if isinstance(components, dict):
            for component in components.values():
                if not isinstance(component, dict):
                    continue
                for name in ("brep", "eagerSurface"):
                    value = component.get(name)
                    if isinstance(value, str) and value in sizes:
                        seen.add(value)
        links = tree.get("links")
        if isinstance(links, list):
            pending.extend(link["tree"] for link in links if isinstance(link, dict) and isinstance(link.get("tree"), str))


def protected_objects(sizes: dict[str, int]) -> set[str]:
    """Objects the protected tiers reach: records' result and document trees,
    and current-schema document indexes, transitively through links."""
    from cadgen.store.records import DOCUMENT_SCHEMA_VERSION, RECORD_SCHEMA_VERSION

    protected: set[str] = set()
    cache: dict[str, dict | None] = {}
    for key, _path in iter_entries("model"):
        record = read_entry("model", key)
        if not record or record.get("schemaVersion") != RECORD_SCHEMA_VERSION:
            continue
        for name in ("tree", "documentTree"):
            tree = record.get(name)
            if isinstance(tree, str) and tree:
                _tree_closure(tree, sizes, protected, cache)
    for key, _path in iter_entries("document"):
        entry = read_entry("document", key)
        if not entry or entry.get("schemaVersion") != DOCUMENT_SCHEMA_VERSION:
            continue
        tree = entry.get("tree")
        if isinstance(tree, str) and tree:
            _tree_closure(tree, sizes, protected, cache)
    return protected


def entry_objects(kind: str, entry: dict | None) -> tuple[str, ...]:
    """The objects an evictable entry points at (a value entry points at none)."""
    if not entry:
        return ()
    names = ("brep", "eagerSurface") if kind == "component" else ("object",)
    return tuple(value for value in (entry.get(name) for name in names) if isinstance(value, str) and value)


def lease_since(*, grace_seconds: float, lease_floor: float | None, now: float) -> float:
    """Entries used at or after this instant are leased and never evicted.

    The grace window, widened by the touch throttle: an entry hit inside the
    throttle keeps a stamp up to ``TOUCH_INTERVAL_SECONDS`` older than the hit.
    A running job's start, from the daemon, widens it further.
    """
    since = now - max(0.0, float(grace_seconds)) - TOUCH_INTERVAL_SECONDS
    if lease_floor is not None:
        since = min(since, float(lease_floor) - TOUCH_INTERVAL_SECONDS)
    return since


def plan(*, max_bytes: int, grace_seconds: float, lease_floor: float | None = None,
         low_watermark: float = LOW_WATERMARK, now: float | None = None) -> Plan:
    """Decide which entries phase 1 drops, oldest use first, until the projected
    deduplicated size fits under the low watermark. Reads only index entries
    and tree JSON; never a component or mesh body."""
    clock = time.time() if now is None else float(now)
    cap = int(max_bytes)
    result = Plan(cap=cap, low=int(cap * low_watermark), grace_seconds=grace_seconds, lease_floor=lease_floor)
    sizes, mtimes = _scan_objects()
    index_bytes = {kind: _index_bytes(kind) for kind in INDEX_KINDS}
    result.bytes_before = sum(sizes.values()) + sum(index_bytes.values())

    fixed = protected_objects(sizes)
    result.protected_bytes = sum(sizes[digest] for digest in fixed)
    grace_cutoff = clock - max(0.0, float(grace_seconds))
    fixed.update(digest for digest, mtime in mtimes.items() if mtime > grace_cutoff)

    since = lease_since(grace_seconds=grace_seconds, lease_floor=lease_floor, now=clock)
    candidates: list[Victim] = []
    refcount: dict[str, int] = {}
    for kind in EVICTABLE_KINDS:
        result.counted[kind] = 0
        result.leased[kind] = 0
        for key, path in iter_entries(kind):
            entry = read_entry(kind, key)
            objects = tuple(digest for digest in entry_objects(kind, entry) if digest in sizes)
            used = last_used(entry, path)
            try:
                entry_bytes = path.stat().st_size
            except OSError:
                entry_bytes = 0
            result.counted[kind] += 1
            if used >= since:
                result.leased[kind] += 1
                fixed.update(objects)
                continue
            candidates.append(Victim(kind, key, used, objects, entry_bytes))
            for digest in objects:
                refcount[digest] = refcount.get(digest, 0) + 1

    reachable = set(fixed)
    reachable.update(refcount)
    projected = sum(sizes[digest] for digest in reachable) + sum(index_bytes.values())
    result.projected_bytes = projected
    # The high watermark triggers, the low one is the target: under the cap
    # nothing moves, over it the store comes down to the low watermark.
    if not result.over or projected <= result.low:
        return result

    candidates.sort(key=lambda victim: (victim.used, victim.kind, victim.key))
    for victim in candidates:
        result.victims.append(victim)
        projected -= victim.entry_bytes
        result.freed_entry_bytes += victim.entry_bytes
        for digest in victim.objects:
            refcount[digest] -= 1
            if refcount[digest] == 0 and digest not in fixed:
                projected -= sizes[digest]
                result.freed_object_bytes += sizes[digest]
        if projected <= result.low:
            break
    result.projected_bytes = projected
    return result


def apply(victims: Iterable[Victim], *, should_stop: Callable[[], bool] | None = None) -> int:
    """Drop the planned entries, in order. Objects are phase 2's (grace applies).

    Returns how many entries went. ``should_stop`` is polled between entries so
    the daemon can yield to a job that arrives mid-sweep; stopping early is
    always safe -- what was dropped is dropped, what was not is still valid.
    """
    removed = 0
    for victim in victims:
        if should_stop is not None and should_stop():
            break
        remove_entry(victim.kind, victim.key)
        removed += 1
    return removed


def entry_exists(kind: str, key: str) -> bool:
    return entry_path(kind, key).is_file()
