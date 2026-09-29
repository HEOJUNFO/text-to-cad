"""Size-capped LRU eviction of the store (STORE.md §8): last-use stamps, the
LRU order, the protected tiers, shared objects, leases, misses after eviction,
the watermarks, crash safety between the two phases, and the daemon's idle
trigger. Tiny stores in fresh temp directories; no kernel."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from tests.python.support.paths import add_repo_path
from tests.python.support.tmp_root import generated_cad_directory

add_repo_path("packages/cadgen/src")

HOUR = 3600.0


class EvictionCase(unittest.TestCase):
    def setUp(self):
        self.tmp = generated_cad_directory(prefix="store-evict-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = self.root / "store"
        patch = mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(self.store), "CADGEN_DAEMON": "0"})
        patch.start()
        self.addCleanup(patch.stop)
        os.environ.pop("CADGEN_STORE_MAX", None)

    # --- fixtures -----------------------------------------------------------------

    def seed_document(self, name: str = "part.step") -> str:
        """A record + document entry + tree + component brep + surface entry."""
        from tests.python.support.store_fixtures import seed_result

        path = self.root / name
        path.write_bytes(f"fixture document {name}".encode())
        return seed_result(path)

    def op_entry(self, key: str, payload: bytes, *, used: float, kind: str = "op") -> str:
        """An op-memo shape entry over a fresh object, stamped ``used``."""
        from cadgen.store.index import LAST_USED, _write_entry_raw, entry_path
        from cadgen.store.objects import put_object

        digest = put_object(payload)
        _write_entry_raw(kind, key, {"object": digest, "cls": "build123d.topology.Solid", "recipe": {}, LAST_USED: used})
        os.utime(entry_path(kind, key), (used, used))
        return digest

    def backdate_objects(self, seconds: float = 3 * HOUR) -> None:
        """Every object older than any grace window under test."""
        from cadgen.store.objects import iter_objects

        then = time.time() - seconds
        for _digest, path in list(iter_objects()):
            os.utime(path, (then, then))

    @staticmethod
    def entries(kind: str) -> set[str]:
        from cadgen.store.index import iter_entries

        return {key for key, _ in iter_entries(kind)}

    # --- last use -------------------------------------------------------------------

    def test_info_counts_legacy_files_and_directories(self):
        from cadgen.cli.store import main

        legacy = self.store / "legacy"
        legacy.mkdir(parents=True)
        (legacy / "data").write_bytes(b"123")
        (self.store / "old-file").write_bytes(b"45")
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main(["info", "--json"]), 0)
        self.assertEqual(json.loads(out.getvalue())["foreign"], {"legacy": 3, "old-file": 2})

    def test_write_stamps_last_used_and_touch_is_throttled(self):
        from cadgen.store.index import LAST_USED, TOUCH_INTERVAL_SECONDS, entry_path, read_entry, touch_entry, write_entry

        write_entry("op", "k", {"value": 1})
        stamped = read_entry("op", "k")
        self.assertAlmostEqual(stamped[LAST_USED], time.time(), delta=5)
        # A record is never stamped: it is not an evictable tier.
        write_entry("output", "o", {"model": "x"})
        self.assertNotIn(LAST_USED, read_entry("output", "o"))

        then = time.time() - 2 * HOUR
        write_entry("op", "k", {"value": 1})
        entry = {**read_entry("op", "k"), LAST_USED: then}
        entry_path("op", "k").write_text(json.dumps(entry), encoding="utf-8")
        os.utime(entry_path("op", "k"), (then, then))
        now = time.time()
        self.assertTrue(touch_entry("op", "k", read_entry("op", "k"), now=now))
        self.assertAlmostEqual(read_entry("op", "k")[LAST_USED], now, delta=1)
        # Inside the throttle: a hit leaves the entry alone (no rewrite, no mtime change).
        before = entry_path("op", "k").stat()
        self.assertFalse(touch_entry("op", "k", read_entry("op", "k"), now=now + TOUCH_INTERVAL_SECONDS / 2))
        self.assertEqual(entry_path("op", "k").stat().st_mtime_ns, before.st_mtime_ns)
        self.assertTrue(touch_entry("op", "k", read_entry("op", "k"), now=now + TOUCH_INTERVAL_SECONDS + 1))
        self.assertAlmostEqual(read_entry("op", "k")[LAST_USED], now + TOUCH_INTERVAL_SECONDS + 1, delta=1)

    def test_a_value_memo_hit_touches_its_entry_once_per_hour(self):
        from cadgen._internal import op_memo
        from cadgen.store.index import LAST_USED, entry_path, read_entry

        calls = []

        def compute():
            calls.append(1)
            return {"volume": 42.0}

        with mock.patch.object(op_memo, "_runtime_versions", return_value=("0.0", "0.0", "0.0")), \
                mock.patch.dict(os.environ, {"CADGEN_OP_MEMO": "1", "CADGEN_OP_MEMO_DISK": "1"}):
            key = op_memo._build_key("test-volume", ("a", 1), {})
            index_key = op_memo._op_index_key(key)
            self.assertEqual(op_memo.memoized_value("test-volume", ("a", 1), compute), {"volume": 42.0})
            self.assertEqual(len(calls), 1)
            then = time.time() - 2 * HOUR
            entry = {**read_entry("op", index_key), LAST_USED: then}
            entry_path("op", index_key).write_text(json.dumps(entry), encoding="utf-8")
            os.utime(entry_path("op", index_key), (then, then))
            with op_memo._lock:
                op_memo._cache.clear()
            self.assertEqual(op_memo.memoized_value("test-volume", ("a", 1), compute), {"volume": 42.0})
            self.assertEqual(len(calls), 1, "a disk hit, not a recompute")
            self.assertAlmostEqual(read_entry("op", index_key)[LAST_USED], time.time(), delta=5)
            stat = entry_path("op", index_key).stat()
            with op_memo._lock:
                op_memo._cache.clear()
            op_memo.memoized_value("test-volume", ("a", 1), compute)
            self.assertEqual(entry_path("op", index_key).stat().st_mtime_ns, stat.st_mtime_ns, "throttled: no rewrite")

    def test_mesh_probe_strips_the_stamp_and_surface_lookup_tolerates_it(self):
        from tests.python.support.tessellation import tessellation_fixture
        from cadgen.store import meshes
        from cadgen.store.index import LAST_USED, read_entry

        fixture = tessellation_fixture()
        key, payload = fixture["key"], base64.b64decode(fixture["bytes"])
        record = meshes.write(key, payload)
        self.assertIn(LAST_USED, read_entry("mesh", key))
        self.assertNotIn(LAST_USED, record)
        self.assertEqual(meshes.probe(key), record, "the row a consumer validates carries no stamp")
        self.assertEqual(meshes.read(key), payload)

        from cadgen.store.surfaces import validate_surface_record
        from tests.python.support.store_fixtures import FIXTURE_SURFACE_PRODUCER
        from cadgen.store import surfaces
        from cadgen.store.trees import get_tree

        tree = self.seed_document()
        entry = next(iter(get_tree(tree)["components"].values()))
        surface_key = next(iter(self.entries("surface")))
        stamped = read_entry("surface", surface_key)
        self.assertIn(LAST_USED, stamped)
        validate_surface_record(stamped, surface_input_key=surface_key)
        found = surfaces.lookup(entry, FIXTURE_SURFACE_PRODUCER)
        self.assertIsNotNone(found)
        self.assertNotIn(LAST_USED, found)

    def test_every_evictable_reader_tolerates_the_stamp(self):
        """Every field-set validator over an evictable tier strips the stamp; the
        component fast path (the one exact-match reader) is pinned here so a
        stamped entry keeps matching -- and, as a hit, refreshes it."""
        from cadgen._internal import component_package
        from cadgen.store.index import LAST_USED, _write_entry_raw, entry_path, read_entry
        from cadgen.store.trees import get_tree

        tree = self.seed_document()
        cid, entry = next(iter(get_tree(tree)["components"].items()))
        then = time.time() - 5 * HOUR
        _write_entry_raw("component", cid, {"schemaVersion": 1, **entry, LAST_USED: then})
        os.utime(entry_path("component", cid), (then, then))
        published = {**read_entry("component", cid)}
        self.assertIn(LAST_USED, published)
        # The comparison the fast path makes, on the stamped entry it reads.
        seen = {key: value for key, value in published.items() if key not in ("schemaVersion", "color", LAST_USED)}
        self.assertEqual(component_package.canonical_json_bytes(seen), component_package.canonical_json_bytes(entry))
        with mock.patch.object(component_package, "_shape_brep_bytes", return_value=b"x"), \
                mock.patch.object(component_package, "effective_face_colors", return_value=entry["faceColors"]), \
                mock.patch.object(component_package, "geometry_component_hash", return_value=entry["contentHash"]), \
                mock.patch.object(component_package, "_build123d_shape_from_topods", return_value=mock.Mock()), \
                mock.patch.object(component_package, "prepare_geometry_component", side_effect=AssertionError("slow path")), \
                mock.patch.object(component_package.hashlib, "sha256") as sha:
            sha.return_value.hexdigest.return_value = entry["brep"]
            prepared = component_package.prepare_published_component(mock.Mock(wrapped=object(), cad_face_ordinal_colors=None))
        self.assertEqual(prepared["entry"]["contentHash"], entry["contentHash"])
        self.assertAlmostEqual(read_entry("component", cid)[LAST_USED], time.time(), delta=5, msg="a component hit refreshes the stamp")

    # --- the plan -------------------------------------------------------------------

    def test_lru_order_is_respected(self):
        from cadgen.store import evict

        now = time.time()
        sizes = {}
        for index, age in enumerate((5, 1, 3, 4, 2)):  # hours since last use
            sizes[f"k{index}"] = self.op_entry(f"k{index}", os.urandom(1000) + bytes([index]), used=now - age * HOUR)
        self.backdate_objects()
        # Six entries of ~1 KB each plus their index entries; a cap that needs
        # roughly the two oldest gone to fit under 80%.
        total = evict.store_bytes()["total"]
        cap = int(total - 1200)
        plan = evict.plan(max_bytes=cap, grace_seconds=0, now=now)
        self.assertEqual([victim.key for victim in plan.victims], ["k0", "k3"], "oldest use first, only as many as needed")
        self.assertLessEqual(plan.projected_bytes, plan.low)
        self.assertTrue(plan.over)

    def test_an_entry_without_a_stamp_counts_as_least_recently_used(self):
        from cadgen.store import evict
        from cadgen.store.index import _write_entry_raw, entry_path
        from cadgen.store.objects import put_object

        now = time.time()
        self.op_entry("recent", b"recent" * 200, used=now - HOUR)
        digest = put_object(b"unstamped" * 200)
        _write_entry_raw("op", "unstamped", {"object": digest, "cls": "x", "recipe": {}})
        then = now - 10 * HOUR
        os.utime(entry_path("op", "unstamped"), (then, then))
        self.backdate_objects()
        plan = evict.plan(max_bytes=1, grace_seconds=0, now=now)
        self.assertEqual(plan.victims[0].key, "unstamped")

    def test_protected_tiers_are_never_evicted(self):
        from cadgen.store.gc import collect
        from cadgen.store.objects import has_object
        from cadgen.store.records import tree_for_document_hash
        from cadgen.store.trees import get_tree, tree_complete

        tree = self.seed_document()
        brep = next(iter(get_tree(tree)["components"].values()))["brep"]
        self.op_entry("old", b"op result" * 100, used=time.time() - 5 * HOUR)
        self.backdate_objects()
        document = hashlib.sha256(b"fixture document part.step").hexdigest()

        report = collect(grace_seconds=0, max_bytes=1)  # a cap nothing fits under
        self.assertEqual(report.evicted.get("op"), 1)
        self.assertEqual(self.entries("op"), set())
        self.assertEqual(len(self.entries("model")), 1)
        self.assertEqual(tree_for_document_hash(document), tree)
        self.assertTrue(tree_complete(tree))
        self.assertTrue(has_object(brep))
        self.assertGreater(report.protected_bytes, 0)

    def test_a_shared_object_survives_eviction_of_the_op_entry_that_also_references_it(self):
        from cadgen.store import evict
        from cadgen.store.gc import collect
        from cadgen.store.index import _write_entry_raw, LAST_USED, entry_path
        from cadgen.store.objects import has_object
        from cadgen.store.trees import get_tree

        tree = self.seed_document()
        brep = next(iter(get_tree(tree)["components"].values()))["brep"]
        then = time.time() - 5 * HOUR
        _write_entry_raw("op", "shared", {"object": brep, "cls": "x", "recipe": {}, LAST_USED: then})
        os.utime(entry_path("op", "shared"), (then, then))
        private = self.op_entry("private", b"private op result" * 100, used=then)
        self.backdate_objects()

        plan = evict.plan(max_bytes=1, grace_seconds=0)
        by_key = {victim.key: victim for victim in plan.victims}
        self.assertIn("shared", by_key)
        # Sized by the deduplicated reachable set: the shared object frees nothing.
        private_size = (self.store / "objects" / private[:2] / private[2:]).stat().st_size
        self.assertEqual(plan.freed_object_bytes, private_size)

        collect(grace_seconds=0, max_bytes=1)
        self.assertTrue(has_object(brep), "still reachable from the current document")
        self.assertFalse(has_object(private))
        self.assertEqual(self.entries("op"), set())

    def test_a_leased_or_in_flight_entry_survives(self):
        from cadgen.store import evict

        now = time.time()
        self.op_entry("fresh", b"fresh" * 100, used=now - 60)          # used a minute ago
        self.op_entry("hour", b"hour" * 100, used=now - 1.5 * HOUR)    # inside grace + throttle
        self.op_entry("old", b"old" * 100, used=now - 5 * HOUR)
        self.op_entry("job", b"job" * 100, used=now - 4 * HOUR)        # used by a job that started 3.5 h ago
        self.backdate_objects()
        plan = evict.plan(max_bytes=1, grace_seconds=HOUR, now=now)
        self.assertEqual({victim.key for victim in plan.victims}, {"old", "job"})
        self.assertEqual(plan.leased["op"], 2)
        # The daemon reports a job started 3.5 h ago: nothing that job may have
        # hit -- anything used since its start, minus the touch throttle -- goes.
        plan = evict.plan(max_bytes=1, grace_seconds=HOUR, lease_floor=now - 3.5 * HOUR, now=now)
        self.assertEqual({victim.key for victim in plan.victims}, {"old"})
        self.assertEqual(plan.leased["op"], 3)

    def test_an_evicted_entry_is_a_miss_and_the_rebuild_is_identical(self):
        from cadgen._internal import op_memo
        from cadgen.store.gc import collect
        from cadgen.store.index import LAST_USED, entry_path, read_entry

        calls = []

        def compute():
            calls.append(1)
            return [1.0, 2.5, "x"]

        with mock.patch.object(op_memo, "_runtime_versions", return_value=("0.0", "0.0", "0.0")), \
                mock.patch.dict(os.environ, {"CADGEN_OP_MEMO": "1", "CADGEN_OP_MEMO_DISK": "1"}):
            first = op_memo.memoized_value("test-evicted", (7,), compute)
            index_key = op_memo._op_index_key(op_memo._build_key("test-evicted", (7,), {}))
            then = time.time() - 5 * HOUR
            entry_path("op", index_key).write_text(json.dumps({**read_entry("op", index_key), LAST_USED: then}), encoding="utf-8")
            os.utime(entry_path("op", index_key), (then, then))
            report = collect(grace_seconds=0, max_bytes=1)
            self.assertEqual(report.evicted.get("op"), 1)
            self.assertIsNone(read_entry("op", index_key))
            with op_memo._lock:
                op_memo._cache.clear()
            second = op_memo.memoized_value("test-evicted", (7,), compute)
            self.assertEqual(len(calls), 2, "a miss: computed again, never an error")
            self.assertEqual(first, second)
            self.assertIsNotNone(read_entry("op", index_key), "the miss repaired the entry")

    def test_a_missing_object_behind_a_live_entry_is_a_miss(self):
        from cadgen import memoization
        from cadgen.store.index import LAST_USED, write_entry

        write_entry("op", "memo-key", {"memoScheme": memoization._SCHEME, "object": "f" * 64, "cls": "x", "recipe": {}})
        self.assertIsNone(memoization._read("memo-key"))

    def test_the_watermarks(self):
        from cadgen.store import evict
        from cadgen.store.gc import collect

        now = time.time()
        for index in range(10):
            self.op_entry(f"k{index}", os.urandom(2000) + bytes([index]), used=now - (10 - index) * HOUR)
        self.backdate_objects()
        total = evict.store_bytes()["total"]

        under = collect(grace_seconds=0, max_bytes=total + 1)
        self.assertEqual(under.evicted_total, 0, "under the cap: nothing moves")
        self.assertEqual(len(self.entries("op")), 10)

        cap = int(total * 0.9)
        over = collect(grace_seconds=0, max_bytes=cap)
        self.assertLessEqual(over.bytes_after, int(cap * evict.LOW_WATERMARK), "down to the low watermark")
        self.assertGreater(over.bytes_after, int(cap * evict.LOW_WATERMARK) - 2200, "and no further than one entry past it")
        self.assertLess(over.evicted_total, 10)
        remaining = self.entries("op")
        self.assertEqual(remaining, {f"k{index}" for index in range(10 - len(remaining), 10)}, "the most recent survive")
        self.assertEqual(evict.store_bytes()["total"], over.bytes_after)

    def test_dry_run_reports_what_would_go_and_deletes_nothing(self):
        from cadgen.store.gc import collect
        from cadgen.store.objects import has_object

        digest = self.op_entry("old", b"old" * 300, used=time.time() - 5 * HOUR)
        self.backdate_objects()
        report = collect(grace_seconds=0, max_bytes=1, dry_run=True)
        self.assertEqual(report.evicted, {"op": 1})
        self.assertEqual(report.removed, 1, "the sweep's projection counts the object the entry alone kept")
        self.assertEqual(self.entries("op"), {"old"})
        self.assertTrue(has_object(digest))

    def test_crash_between_the_index_delete_and_the_object_delete_leaves_only_orphans(self):
        from cadgen.store import evict, gc
        from cadgen.store.objects import has_object

        digest = self.op_entry("old", b"old" * 300, used=time.time() - 5 * HOUR)
        self.backdate_objects()

        def crash(*_args, **_kwargs):
            raise KeyboardInterrupt

        with mock.patch.object(gc, "iter_objects", side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                gc.collect(grace_seconds=0, max_bytes=1)
        self.assertEqual(self.entries("op"), set(), "the entry went first")
        self.assertTrue(has_object(digest), "its object is an orphan, not a dangling reference")
        # Every reader treats the orphan as a miss (no entry) and the next sweep reclaims it.
        self.assertIsNone(evict.plan(max_bytes=1, grace_seconds=0).victims or None)
        report = gc.collect(grace_seconds=0)
        self.assertEqual(report.removed, 1)
        self.assertFalse(has_object(digest))

    def test_eviction_stops_between_entries_when_asked(self):
        from cadgen.store.gc import collect

        for index in range(5):
            self.op_entry(f"k{index}", os.urandom(500) + bytes([index]), used=time.time() - (10 - index) * HOUR)
        self.backdate_objects()
        polls = []

        def should_stop():
            polls.append(1)
            return len(polls) > 2

        report = collect(grace_seconds=0, max_bytes=1, should_stop=should_stop)
        self.assertTrue(report.stopped)
        self.assertEqual(report.evicted_total, 2)
        self.assertEqual(len(self.entries("op")), 3, "what was not dropped is still valid")

    # --- the daemon's idle trigger --------------------------------------------------

    def test_the_daemon_trigger_never_runs_while_a_job_is_active(self):
        from cadgen.daemon.housekeeping import Housekeeper

        clock = {"now": 1000.0}
        state = {"active": True}
        runs = []

        def run(root, cap, should_stop):
            runs.append((root, cap, should_stop()))
            return "ran"

        keeper = Housekeeper(active=lambda: state["active"], clock=lambda: clock["now"], run=run,
                             check_interval=600.0, quiet_seconds=30.0)
        keeper.note_request(str(self.store), {"CADGEN_STORE_MAX": "1G"})
        for _ in range(10):
            clock["now"] += 300.0
            self.assertIsNone(keeper.tick(), "a job is running: never mid-build")
        self.assertEqual(runs, [])
        state["active"] = False
        self.assertIsNone(keeper.tick(), "just went idle: the quiet window has not elapsed")
        clock["now"] += 31.0
        self.assertEqual(keeper.tick(), str(self.store))
        keeper.wait(5.0)
        self.assertEqual(runs, [(str(self.store), 1024 ** 3, False)], "the client's cap, and a stop poll that says go")
        clock["now"] += 100.0
        self.assertIsNone(keeper.tick(), "checked within the interval: not again yet")
        clock["now"] += 600.0
        state["active"] = True
        self.assertIsNone(keeper.tick(), "due, but a job arrived")
        state["active"] = False
        clock["now"] += 31.0
        self.assertEqual(keeper.tick(), str(self.store))
        keeper.wait(5.0)
        self.assertEqual(len(runs), 2)

    def test_the_daemon_sweep_evicts_only_over_the_cap_and_names_the_root(self):
        from cadgen.daemon.housekeeping import evict_if_over_cap
        from cadgen.store import evict

        self.op_entry("old", b"old" * 300, used=time.time() - 5 * HOUR)
        self.backdate_objects()
        total = evict.store_bytes()["total"]
        # The supervisor names the root explicitly; its own environment points elsewhere.
        with mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(self.root / "elsewhere")}):
            self.assertIsNone(evict_if_over_cap(str(self.store), None, lambda: False), "no cap, nothing to do")
            self.assertIsNone(evict_if_over_cap(str(self.store), total + 1, lambda: False), "under the cap")
            self.assertIsNone(evict_if_over_cap(str(self.store), 1, lambda: True), "a job arrived first")
        self.assertEqual(self.entries("op"), {"old"})
        with mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(self.root / "elsewhere")}):
            outcome = evict_if_over_cap(str(self.store), 1, lambda: False)
        self.assertIn("evicted 1 op", outcome)
        self.assertEqual(self.entries("op"), set())
        self.assertFalse((self.root / "elsewhere").exists())

    def test_store_root_override_is_per_thread(self):
        import threading

        from cadgen.store.paths import store_root, store_root_override

        seen = {}

        def other():
            seen["other"] = store_root()

        with store_root_override(self.root / "override"):
            self.assertEqual(store_root(), self.root / "override")
            thread = threading.Thread(target=other)
            thread.start()
            thread.join()
        self.assertEqual(seen["other"], self.store)
        self.assertEqual(store_root(), self.store)

    # --- the CLI ---------------------------------------------------------------------

    def run_cli(self, *argv: str) -> tuple[int, str]:
        from cadgen.cli.store import main

        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = main(list(argv))
        return code, out.getvalue()

    def test_cli_gc_max_size_and_info_against_the_cap(self):
        from cadgen.store import evict

        self.op_entry("old", b"old" * 300, used=time.time() - 5 * HOUR)
        self.backdate_objects()
        total = evict.store_bytes()["total"]

        code, text = self.run_cli("info", "--json")
        payload = json.loads(text)
        self.assertEqual(code, 0)
        self.assertEqual(payload["cap"], evict.DEFAULT_MAX_BYTES)
        self.assertEqual(payload["bytes"], total)
        self.assertFalse(payload["overCap"])
        with mock.patch.dict(os.environ, {"CADGEN_STORE_MAX": "1"}):
            code, text = self.run_cli("info")
            self.assertIn("over the cap", text)
            code, text = self.run_cli("gc", "--max-size", "--dry-run", "--grace-hours", "0", "--json")
            self.assertEqual(json.loads(text)["evicted"], {"op": 1})
            self.assertEqual(self.entries("op"), {"old"})
        with mock.patch("cadgen.store.gc.running_jobs_since", return_value=None):
            code, text = self.run_cli("gc", "--max-size", "1", "--grace-hours", "0")
        self.assertEqual(code, 0)
        self.assertIn("evicted 1 op", text)
        self.assertEqual(self.entries("op"), set())

    def test_parse_size(self):
        from cadgen.store.evict import configured_max_bytes, parse_size

        self.assertEqual(parse_size("20G"), 20 * 1024 ** 3)
        self.assertEqual(parse_size("500MB"), 500 * 1024 ** 2)
        self.assertEqual(parse_size("1.5 GiB"), int(1.5 * 1024 ** 3))
        self.assertEqual(parse_size("0"), 0)
        with self.assertRaises(ValueError):
            parse_size("lots")
        self.assertIsNone(configured_max_bytes({"CADGEN_STORE_MAX": "0"}))
        self.assertEqual(configured_max_bytes({}), 20 * 1024 ** 3)


if __name__ == "__main__":
    unittest.main()
