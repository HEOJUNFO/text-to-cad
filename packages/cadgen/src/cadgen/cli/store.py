"""``cadgen store`` — inspect, explain and collect the store.

    cadgen store info              what is in the store, by kind, and its size against the cap
    cadgen store why <model.py>    why the gate says stale (or current), clause by clause
    cadgen store forget <target>…  drop one model's record or one document's tree entry
    cadgen store gc [--dry-run]    mark and sweep unreachable objects
    cadgen store gc --max-size [SIZE]   evict least recently used entries to the cap, then sweep

``why`` is the debugging surface STORE.md describes: it prints the record, then
each gate clause's verdict with its evidence, then the tree's links and
components. Stdlib + the store modules only; it never imports the CAD kernel.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from cadgen._internal.doors import STEP_SUFFIXES
from cadgen.store import store_root
from cadgen.store.gate import stale
from cadgen.store.index import iter_entries
from cadgen.store.objects import iter_objects
from cadgen.store.records import read_record, source_for_document
from cadgen.store.trees import get_tree

DEFAULT_PROG = "cadgen store"


def _human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def _cmd_info(as_json: bool) -> int:
    from cadgen.store.evict import LOW_WATERMARK, configured_max_bytes, foreign_bytes, store_bytes
    from cadgen.store.paths import INDEX_KINDS

    objects = sum(1 for _ in iter_objects())
    size = store_bytes()
    object_bytes = size["objects"]
    counts = {kind: sum(1 for _ in iter_entries(kind)) for kind in INDEX_KINDS}
    cap = configured_max_bytes()
    foreign = foreign_bytes()
    payload = {
        "root": str(store_root()),
        "objects": {"count": objects, "bytes": object_bytes},
        "index": counts,
        "bytes": size["total"],
        "indexBytes": size["index"],
        "cap": cap,
        "lowWatermark": None if cap is None else int(cap * LOW_WATERMARK),
        "overCap": cap is not None and size["total"] > cap,
        "foreign": foreign,
    }
    if as_json:
        print(json.dumps(payload, separators=(",", ":")))
        return 0
    print(f"store  {payload['root']}")
    print(f"objects  {objects} ({_human(object_bytes)})")
    if cap is None:
        print(f"size     {_human(size['total'])} (index {_human(size['index'])}); no cap (CADGEN_STORE_MAX=0)")
    else:
        state = "over the cap: the daemon evicts when idle, or run `cadgen store gc --max-size`" if payload["overCap"] else "under the cap"
        print(f"size     {_human(size['total'])} of {_human(cap)} cap ({100.0 * size['total'] / cap:.0f}%, index {_human(size['index'])}); {state}")
    if foreign:
        names = ", ".join(f"{name}/ {_human(total)}" for name, total in foreign.items())
        print(f"not the store  {_human(sum(foreign.values()))} under the root outside objects/ and index/ ({names}); nothing reads it, safe to delete")
    labels = {
        "model": "records",
        "document": "document entries (bytes -> tree)",
        "output": "output entries (path -> model)",
        "component": "component entries",
        "surface": "surface entries",
        "op": "op-memo entries",
        "mesh": "mesh entries",
        "drawing": "drawing render payloads",
    }
    for kind, count in counts.items():
        print(f"index/{kind:<10} {count} {labels[kind]}")
    return 0


def _resolve_models(target: str) -> list[str]:
    """The model identities a ``why`` target names: one for ``script.py::fn`` or a
    document, every model of the file for a bare script."""
    from cadgen.store.index import MODEL_REF_SEP, model_ref, split_model_ref

    if MODEL_REF_SEP in target:
        script, function = split_model_ref(target)
        return [model_ref(script, function)]
    path = Path(target).expanduser()
    if path.suffix.lower() in STEP_SUFFIXES:
        return [source_for_document(path)]
    resolved = path.resolve()
    if resolved.suffix.lower() == ".py":
        from cadgen.metadata import model_function_names

        names = model_function_names(resolved)
        if names:
            return [model_ref(resolved, name) for name in names]
    return [str(resolved)]


def _cmd_why(target: str, as_json: bool) -> int:
    code = 0
    for model in _resolve_models(target):
        code = max(code, _why_one(model, as_json))
    return code


def _why_one(model: str, as_json: bool) -> int:
    verdict = stale(model)
    record = read_record(model)
    tree = get_tree(str(record.get("tree"))) if record and record.get("tree") else None
    if as_json:
        print(json.dumps({"model": str(model), "stale": verdict.stale, "clauses": verdict.clauses, "record": record}, separators=(",", ":")))
        return 0 if not verdict.stale else 1
    print(f"model   {model}")
    print(f"verdict {'STALE' if verdict.stale else 'current'}  ({verdict.reason()})")
    for clause in verdict.clauses:
        number = clause.get("clause")
        mark = "x" if clause.get("stale") else "ok"
        if number == 1:
            print(f"  [{mark}] 1 record {'missing' if clause.get('stale') else 'present'}")
        elif number == 2:
            why = clause.get("why") or f"{clause.get('files', 0)} files unchanged"
            print(f"  [{mark}] 2 closure {why}")
        elif number == 3:
            children = clause.get("children") or []
            print(f"  [{mark}] 3 children ({len(children)})")
            for child in children:
                cmark = "x" if child.get("stale") else "ok"
                print(f"        [{cmark}] {child.get('model')}  pinned {str(child.get('pinned'))[:12]}  current {str(child.get('current'))[:12]}  {child.get('why') or ''}")
        elif number == 4:
            print(f"  [{mark}] 4 tree {str(clause.get('tree'))[:12]} {'complete' if not clause.get('stale') else clause.get('why')}")
        elif number == 5:
            outputs = clause.get("outputs") or []
            print(f"  [{mark}] 5 outputs ({len(outputs)})")
            for output in outputs:
                omark = "x" if output.get("stale") else "ok"
                print(f"        [{omark}] {output.get('path')}  {output.get('why') or ''}")
    if record:
        closure = record.get("closure") or {}
        print(f"closure {str(closure.get('hash'))[:12]}  files: {', '.join(closure.get('files') or [])}")
    if tree:
        print(f"tree    components {len(tree.get('components') or {})}  occurrences {len(tree.get('occurrences') or [])}  links {len(tree.get('links') or [])}")
        for link in tree.get("links") or []:
            print(f"        link {link.get('name')} -> {str(link.get('tree'))[:12]}")
    return 0 if not verdict.stale else 1


def _cmd_gc(dry_run: bool, grace_hours: float, max_size: str | None, as_json: bool) -> int:
    from cadgen.store.gc import collect, running_jobs_since

    max_bytes = None
    if max_size is not None:
        from cadgen.store.evict import configured_max_bytes, parse_size

        max_bytes = configured_max_bytes() if max_size == "" else (parse_size(max_size) or None)
        if max_bytes is None:
            print("no cap: CADGEN_STORE_MAX=0 and no --max-size value; sweeping without eviction", file=sys.stderr)
    lease_floor = running_jobs_since() if max_bytes is not None else None
    report = collect(grace_seconds=grace_hours * 3600.0, dry_run=dry_run, max_bytes=max_bytes, lease_floor=lease_floor)
    payload = {
        "dryRun": report.dry_run,
        "records": report.records,
        "reachable": report.reachable,
        "keptByGrace": report.kept_by_grace,
        "removed": report.removed,
        "removedBytes": report.removed_bytes,
    }
    if max_bytes is not None:
        payload.update({
            "cap": report.cap,
            "bytesBefore": report.bytes_before,
            "bytesAfter": report.bytes_after,
            "evicted": report.evicted,
            "evictedEntryBytes": report.evicted_entry_bytes,
            "leased": report.leased,
            "protectedBytes": report.protected_bytes,
            "leaseFloor": report.lease_floor,
        })
    if as_json:
        print(json.dumps(payload, separators=(",", ":")))
        return 0
    verb = "would remove" if dry_run else "removed"
    if max_bytes is not None:
        evict_verb = "would evict" if dry_run else "evicted"
        parts = ", ".join(f"{count} {kind}" for kind, count in sorted(report.evicted.items())) or "nothing"
        leased = sum(report.leased.values())
        print(f"{evict_verb} {parts} (least recently used first; {leased} leased entries kept); "
              f"{_human(report.protected_bytes)} protected by records and documents")
    print(f"{report.records} records, {report.reachable} reachable objects, {report.kept_by_grace} kept by grace; {verb} {report.removed} objects ({_human(report.removed_bytes)})")
    if max_bytes is not None:
        after = "would be" if dry_run else "now"
        print(f"store {_human(report.bytes_before)} -> {after} {_human(report.bytes_after)} of {_human(report.cap)} cap")
    return 0


def _cmd_forget(targets: Sequence[str], dry_run: bool, as_json: bool) -> int:
    from cadgen.store.forget import describe, forget

    reports = [forget(target, dry_run=dry_run) for target in targets]
    if as_json:
        print(json.dumps({"dryRun": dry_run, "targets": reports}, separators=(",", ":")))
        return 0
    for report in reports:
        for line in describe(report):
            print(line)
    return 0


def build_parser(prog: str | None = None) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=prog or DEFAULT_PROG, description="Inspect, explain and collect the cadgen store.")
    sub = parser.add_subparsers(dest="command", required=True)
    info = sub.add_parser("info", help="what is in the store, by kind")
    info.add_argument("--json", action="store_true")
    why = sub.add_parser("why", help="why the gate says a model is stale (or current)")
    why.add_argument("model", help="a model script, script.py::function for one model of a file holding several, or a generated .step (the store remembers which model wrote it)")
    why.add_argument("--json", action="store_true")
    forget = sub.add_parser(
        "forget",
        help="drop one model's record, or one document's tree entry, so the next run or open redoes it",
        description=(
            "A surgical reset. A model script drops its record (the next run rebuilds it; children and parents "
            "are untouched). A document (.step/.dxf/mesh) drops its bytes' tree entry so the next open or door "
            "call compiles it again, and the record that wrote it. Objects are never deleted (that is gc); an "
            "unknown target is 'nothing to forget'."
        ),
    )
    forget.add_argument("targets", nargs="+", metavar="TARGET", help="a model script or a document path")
    forget.add_argument("--dry-run", action="store_true", help="report what would be forgotten")
    forget.add_argument("--json", action="store_true")
    gc = sub.add_parser(
        "gc",
        help="mark and sweep unreachable objects; with --max-size, evict least recently used entries first",
        description=(
            "Two phases. --max-size drops op-memo, mesh, surface and component entries least recently used "
            "first until the store's projected size fits under 80%% of the cap; records, document entries and "
            "everything they reach are never evicted, and entries used within the grace window or by a job the "
            "daemon is running are leased. Then the ordinary mark and sweep removes objects nothing reaches."
        ),
    )
    gc.add_argument("--dry-run", action="store_true", help="report what would go, delete nothing")
    gc.add_argument("--grace-hours", type=float, default=1.0, help="keep objects touched within this window (default 1h)")
    gc.add_argument(
        "--max-size", nargs="?", const="", default=None, metavar="SIZE",
        help="evict to this cap (20G, 500M, 0 for none) before sweeping; bare --max-size uses CADGEN_STORE_MAX (default 20G)",
    )
    gc.add_argument("--json", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None, prog: str | None = None) -> int:
    args = build_parser(prog).parse_args(list(argv) if argv is not None else sys.argv[1:])
    if args.command == "info":
        return _cmd_info(bool(args.json))
    if args.command == "why":
        return _cmd_why(args.model, bool(args.json))
    if args.command == "forget":
        return _cmd_forget(list(args.targets), bool(args.dry_run), bool(args.json))
    if args.command == "gc":
        return _cmd_gc(bool(args.dry_run), float(args.grace_hours), args.max_size, bool(args.json))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
