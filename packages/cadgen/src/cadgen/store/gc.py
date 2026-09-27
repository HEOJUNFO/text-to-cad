"""GC: LRU eviction to a size cap, then mark and sweep over the store.

Phase 1 (only with a cap, ``cadgen.store.evict``): drop op-memo, mesh,
surface and component entries least recently used first until the projected
deduplicated reachable size fits under the low watermark. Phase 2: reachable =
every object referenced (transitively, through links) from a current record
or document index, plus objects pointed at by the component, surface, op-memo
and mesh entries that remain and by every drawing entry, plus anything
modified within a grace period (default 1 h — the window in which a build may
still hold a pin to a child's previous tree); everything else goes.
Best-effort: deleting an entry or an object costs a rebuild, never
correctness.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Callable

from cadgen.store.index import iter_entries, read_entry, strip_last_used
from cadgen.store.objects import iter_objects
from cadgen.store.records import tree_for_document_hash
from cadgen.store.trees import tree_objects

DEFAULT_GRACE_SECONDS = 3600.0


@dataclass
class GcReport:
    reachable: int = 0
    kept_by_grace: int = 0
    removed: int = 0
    removed_bytes: int = 0
    records: int = 0
    dry_run: bool = False
    removed_paths: list[str] = field(default_factory=list)
    # Phase 1, present only when a cap was given.
    cap: int | None = None
    bytes_before: int = 0
    bytes_after: int = 0
    evicted: dict[str, int] = field(default_factory=dict)
    evicted_entry_bytes: int = 0
    leased: dict[str, int] = field(default_factory=dict)
    protected_bytes: int = 0
    lease_floor: float | None = None
    stopped: bool = False

    @property
    def evicted_total(self) -> int:
        return sum(self.evicted.values())


def reachable_objects(*, exclude: set[tuple[str, str]] | None = None) -> set[str]:
    """The mark phase. ``exclude`` names index entries to read as already gone
    (a dry run's projection of phase 1)."""
    skip = exclude or set()
    reachable: set[str] = set()
    for _name, path in iter_entries("model"):
        record = read_entry("model", path.name)
        from cadgen.store.records import RECORD_SCHEMA_VERSION
        if not record or record.get("schemaVersion") != RECORD_SCHEMA_VERSION:
            continue
        for field_name in ("tree", "documentTree"):
            tree = str(record.get(field_name) or "")
            if tree:
                tree_objects(tree, _seen=reachable)
    for document_hash, _path in iter_entries("document"):
        tree = tree_for_document_hash(document_hash)
        if tree:
            # Saved artifacts keep their own closure after source records are
            # forgotten. The document's mesh ledger names external outputs,
            # not objects in this store, and therefore adds no GC roots.
            tree_objects(tree, _seen=reachable)
    from cadgen.store.objects import read_verified_object
    from cadgen._internal.component_package import validate_geometry_component
    from cadgen.store.surfaces import validate_surface_record
    for key, path in iter_entries("component"):
        if ("component", key) in skip:
            continue
        entry = read_entry("component", key)
        if not entry or entry.get("schemaVersion") != 1:
            continue
        entry = {field: value for field, value in strip_last_used(entry).items() if field != "schemaVersion"}
        try:
            validate_geometry_component(entry, read_verified_object(entry["brep"]), cid=key)
        except (OSError, ValueError, TypeError, KeyError):
            continue
        reachable.add(entry["brep"])
        if entry.get("eagerSurface"):
            try:
                read_verified_object(entry["eagerSurface"])
            except (OSError, ValueError, TypeError):
                pass
            else:
                reachable.add(entry["eagerSurface"])
    for key, path in iter_entries("surface"):
        if ("surface", key) in skip:
            continue
        entry = read_entry("surface", key)
        try:
            validate_surface_record(entry, surface_input_key=key)
        except (OSError, ValueError, TypeError, KeyError):
            continue
        reachable.add(entry["object"])
    for kind in ("op", "mesh", "drawing"):
        for _name, path in iter_entries(kind):
            if (kind, path.name) in skip:
                continue
            entry = read_entry(kind, path.name)
            if entry and entry.get("object"):
                reachable.add(str(entry["object"]))
    return reachable


def running_jobs_since() -> float | None:
    """When the oldest job the daemon is running against THIS store started, or
    None when no daemon answers or none is running. The daemon knows every job;
    a manual sweep asks it so nothing a live build touched is evicted."""
    try:
        from cadgen.daemon.client import status
        from cadgen.store.paths import store_root

        payload = status()
    except Exception:  # noqa: BLE001 - a sweep never fails for want of a daemon
        return None
    if not payload:
        return None
    root = os.path.realpath(str(store_root()))
    started: list[float] = []
    for job in payload.get("jobs") or []:
        if not isinstance(job, dict) or job.get("state") not in {"submitted", "queued", "building"}:
            continue
        if os.path.realpath(str(job.get("storeRoot") or "")) != root:
            continue
        value = job.get("startedAt")
        if isinstance(value, (int, float)):
            started.append(float(value))
    return min(started) if started else None


def collect(
    *,
    grace_seconds: float = DEFAULT_GRACE_SECONDS,
    dry_run: bool = False,
    max_bytes: int | None = None,
    lease_floor: float | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> GcReport:
    """Sweep the store. With ``max_bytes``, evict LRU entries first (phase 1)
    so that phase 2 brings the store under the low watermark."""
    report = GcReport(dry_run=dry_run)
    exclude: set[tuple[str, str]] | None = None
    if max_bytes is not None:
        from cadgen.store import evict

        planned = evict.plan(max_bytes=max_bytes, grace_seconds=grace_seconds, lease_floor=lease_floor)
        report.cap = planned.cap
        report.bytes_before = planned.bytes_before
        report.evicted = planned.evicted()
        report.evicted_entry_bytes = planned.freed_entry_bytes
        report.leased = dict(planned.leased)
        report.protected_bytes = planned.protected_bytes
        report.lease_floor = lease_floor
        if dry_run:
            exclude = {(victim.kind, victim.key) for victim in planned.victims}
        else:
            done = evict.apply(planned.victims, should_stop=should_stop)
            if done < len(planned.victims):
                report.stopped = True
                report.evicted = _count(planned.victims[:done])
                report.evicted_entry_bytes = sum(v.entry_bytes for v in planned.victims[:done])
    reachable = reachable_objects(exclude=exclude)
    report.reachable = len(reachable)
    report.records = sum(1 for _ in iter_entries("model"))
    cutoff = time.time() - max(0.0, float(grace_seconds))
    for index, (digest, path) in enumerate(iter_objects()):
        if should_stop is not None and index % 256 == 0 and should_stop():
            report.stopped = True
            break
        if digest in reachable:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        if stat.st_mtime > cutoff:
            report.kept_by_grace += 1
            continue
        report.removed += 1
        report.removed_bytes += stat.st_size
        report.removed_paths.append(str(path))
        if not dry_run:
            try:
                os.unlink(path)
            except OSError:
                pass
    if max_bytes is not None:
        report.bytes_after = max(0, report.bytes_before - report.removed_bytes - report.evicted_entry_bytes)
    return report


def _count(victims) -> dict[str, int]:
    counts: dict[str, int] = {}
    for victim in victims:
        counts[victim.kind] = counts.get(victim.kind, 0) + 1
    return counts
