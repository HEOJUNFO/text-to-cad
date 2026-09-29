"""Functions by reach (STORE.md §3): a helper module is hashed by the part of
it a model can execute, whole wherever the analysis cannot see."""

from __future__ import annotations

import os
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tests.python.support.tmp_root import generated_cad_directory


GEO = """
import math
from lib import spec

SCALE = 2.0
UNUSED_TABLE = [1, 2, 3]


def _unit(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v)


def plane(origin, z_dir):
    return (origin, _unit(z_dir), SCALE * spec.BORE)


def unrelated(x):
    return x + 1


def also_unrelated():
    return unrelated(2)
"""

SPEC = """
BORE = 140.0
STROKE = 160.0
"""

MODEL = """
from cadgen import step
from cadgen import build123d as bd
from lib import geo


@step
def part():
    origin, z, size = geo.plane((0, 0, 0), (0, 0, 1))
    return bd.Box(size, 1, 1)
"""


class ReachClosure(unittest.TestCase):
    def setUp(self):
        from cadgen.store.closure import forget_model_files

        scratch = generated_cad_directory(prefix="closure-reach-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        env = mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(self.root / "store")})
        env.start()
        self.addCleanup(env.stop)
        forget_model_files()
        self.addCleanup(forget_model_files)
        (self.root / "lib").mkdir()
        self.write("lib/__init__.py", "")
        self.geo = self.write("lib/geo.py", GEO)
        self.spec = self.write("lib/spec.py", SPEC)
        self.model = self.write("part.py", MODEL)

    def write(self, name, source):
        path = self.root / name
        path.write_text(textwrap.dedent(source).lstrip() + "\n", encoding="utf-8")
        return path.resolve()

    def edit(self, path, old, new):
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new), encoding="utf-8")

    def executed(self, *paths):
        from cadgen._internal.source_hash import _semantic_source_hash

        return {str(path.resolve()): _semantic_source_hash(path) for path in paths}

    def record(self, script="part.py", function="part", *, executed=None):
        from cadgen.store.closure import build_closure
        from cadgen.store.index import model_ref
        from cadgen.store.records import write_record

        script = self.root / script
        closure = build_closure(script, executed=executed if executed is not None else {})
        reference = model_ref(script, function)
        write_record(reference, {
            "entryKind": "part", "sourceKind": "python", "tree": None,
            "closure": closure.as_json(), "constants": closure.constants,
            "children": [], "outputs": {},
        })
        return reference, closure

    def verdict(self, reference):
        from cadgen.store.gate import stale

        return stale(reference)

    def assert_clause_two(self, reference, is_stale, why=None):
        verdict = self.verdict(reference)
        clause = next(c for c in verdict.clauses if c["clause"] == 2)
        self.assertEqual(clause["stale"], is_stale, verdict.reason())
        if why is not None:
            self.assertIn(why, verdict.reason())

    # --- what the record says ---------------------------------------------------

    def test_the_record_names_what_the_model_reaches_in_each_helper(self):
        reference, closure = self.record()
        self.assertEqual(closure.files, ("lib/__init__.py", "lib/geo.py", "lib/spec.py", "part.py"))
        self.assertEqual(closure.names["lib/geo.py"], ("SCALE", "_unit", "plane"))
        self.assertEqual(closure.names["lib/spec.py"], ("BORE",))
        self.assertEqual(closure.names["lib/__init__.py"], ())
        self.assertNotIn("part.py", closure.names, "the script is always whole")
        self.assertTrue(closure.shas["lib/geo.py"].startswith("slice2:"))
        self.assertTrue(closure.shas["part.py"].startswith("ast1:"))
        self.assertFalse(self.verdict(reference).stale)

    # --- the gate ----------------------------------------------------------------

    def test_editing_an_unreached_helper_leaves_the_importer_current(self):
        reference, _closure = self.record()
        self.edit(self.geo, "return x + 1", "return x + 2")
        self.edit(self.geo, "UNUSED_TABLE = [1, 2, 3]", "UNUSED_TABLE = [1, 2, 3, 4]")
        self.edit(self.spec, "STROKE = 160.0", "STROKE = 170.0")
        # A new helper beside the reached ones changes nothing the model hashes.
        self.geo.write_text(self.geo.read_text(encoding="utf-8") + "\n\ndef brand_new():\n    return 7\n", encoding="utf-8")
        self.assert_clause_two(reference, False)

    def test_editing_a_reached_helper_directly_makes_it_stale(self):
        reference, _closure = self.record()
        self.edit(self.geo, "return (origin, _unit(z_dir), SCALE * spec.BORE)", "return (origin, _unit(z_dir), SCALE * spec.BORE + 1)")
        self.assert_clause_two(reference, True, "closure changed: lib/geo.py")

    def test_editing_a_transitively_reached_helper_makes_it_stale(self):
        reference, _closure = self.record()
        self.edit(self.geo, "n = math.sqrt(sum(c * c for c in v))", "n = math.sqrt(sum(c * c for c in v)) + 1e-9")
        self.assert_clause_two(reference, True, "lib/geo.py")

    def test_editing_a_constant_a_reached_function_reads_makes_it_stale(self):
        reference, _closure = self.record()
        self.edit(self.geo, "SCALE = 2.0", "SCALE = 3.0")
        self.assert_clause_two(reference, True, "lib/geo.py")
        self.edit(self.geo, "SCALE = 3.0", "SCALE = 2.0")
        self.assert_clause_two(reference, False)
        # ...also across modules: a constant read through an alias.
        self.edit(self.spec, "BORE = 140.0", "BORE = 150.0")
        self.assert_clause_two(reference, True, "lib/spec.py")

    def test_a_reached_helper_calling_a_new_helper_is_stale_until_rebuilt(self):
        reference, first = self.record()
        self.edit(self.geo, "return (origin, _unit(z_dir), SCALE * spec.BORE)", "return (origin, _unit(z_dir), SCALE * spec.BORE + unrelated(0))")
        self.assert_clause_two(reference, True)
        reference, second = self.record()
        self.assertEqual(second.names["lib/geo.py"], ("SCALE", "_unit", "plane", "unrelated"))
        self.assertFalse(self.verdict(reference).stale)
        # The newly reached helper is now tracked; the still-unreached one is not.
        self.edit(self.geo, "return x + 1", "return x + 3")
        self.assert_clause_two(reference, True)
        reference, _third = self.record()
        self.edit(self.geo, "return unrelated(2)", "return unrelated(3)")
        self.assert_clause_two(reference, False)

    def test_a_new_module_binding_that_shadows_a_builtin_is_stale(self):
        self.edit(self.geo, "n = math.sqrt(sum(c * c for c in v))", "n = math.sqrt(sum(abs(c) * abs(c) for c in v))")
        reference, _closure = self.record()
        self.geo.write_text(self.geo.read_text(encoding="utf-8") + "\n\ndef abs(x):\n    return x\n", encoding="utf-8")
        self.assert_clause_two(reference, True)

    def test_comments_and_formatting_in_a_reached_helper_do_not_count(self):
        reference, _closure = self.record()
        self.edit(self.geo, "def plane(origin, z_dir):", "def plane(origin, z_dir):  # a comment\n")
        self.assert_clause_two(reference, False)

    def test_module_reads_survive_bindings_in_other_lexical_scopes(self):
        cases = {
            "default": "def plane(WIDTH=WIDTH):\n    return WIDTH\n",
            "keyword default": "def plane(*, WIDTH=WIDTH):\n    return WIDTH\n",
            "annotation": "def plane(WIDTH: WIDTH):\n    return WIDTH\n",
            "nested parameter": "def plane():\n    def inner(WIDTH): return WIDTH\n    return WIDTH\n",
            "comprehension": "def plane():\n    values = [WIDTH for WIDTH in range(3)]\n    return WIDTH\n",
            "comprehension iterable": "def plane():\n    return [WIDTH for WIDTH in range(WIDTH)]\n",
            "class body": "class plane:\n    WIDTH = WIDTH\n",
            "class method": "class plane:\n    WIDTH = 9\n    def size(self): return WIDTH\n",
        }
        for scope, source in cases.items():
            with self.subTest(scope=scope):
                self.write("lib/geo.py", "WIDTH = 2\n" + source)
                reference, _closure = self.record()
                self.edit(self.geo, "WIDTH = 2", "WIDTH = 3")
                self.assert_clause_two(reference, True, "lib/geo.py")

    def test_a_genuinely_local_binding_does_not_reach_the_module_constant(self):
        self.write("lib/geo.py", "WIDTH = 2\ndef plane(WIDTH):\n    return [WIDTH for WIDTH in range(WIDTH)]\n")
        reference, _closure = self.record()
        self.edit(self.geo, "WIDTH = 2", "WIDTH = 3")
        self.assert_clause_two(reference, False)

    def test_nested_imports_with_the_same_alias_keep_both_dependencies(self):
        self.write("lib/geo.py", """
            def plane():
                def first():
                    from lib import left as dims
                    return dims.size()
                def second():
                    from lib import right as dims
                    return dims.size()
                return first() + second()
        """)
        left = self.write("lib/left.py", "def size(): return 2")
        right = self.write("lib/right.py", "def size(): return 3")
        for path, old, new in ((left, "return 2", "return 4"), (right, "return 3", "return 5")):
            with self.subTest(module=path.name):
                reference, closure = self.record()
                self.assertIn("size", closure.names[f"lib/{path.name}"])
                self.edit(path, old, new)
                self.assert_clause_two(reference, True, f"lib/{path.name}")

    def test_legacy_slice_records_rebuild_even_without_a_source_edit(self):
        from cadgen.store.closure import closure_hash
        from cadgen.store.records import read_record, write_record

        self.write("lib/geo.py", "def plane(): return 1")
        reference, _closure = self.record()
        record = read_record(reference)
        # Actual v1 digest for the same source/name set. The old reach walk
        # could have missed another module's names, which re-slicing cannot
        # rediscover; a version change must invalidate the whole record.
        record["closure"]["shas"]["lib/geo.py"] = "slice1:31b94ddedb0576c51e25bc94360f750246a8dbd4fde2a3ec9180f83aedbde3ae"
        record["closure"]["hash"] = closure_hash(record["closure"]["shas"].items())
        write_record(reference, record)
        self.assert_clause_two(reference, True, "lib/geo.py")

    def test_module_level_side_effects_are_always_hashed(self):
        self.geo.write_text(self.geo.read_text(encoding="utf-8") + "\n\nREGISTRY = {}\nREGISTRY['k'] = unrelated(1)\n", encoding="utf-8")
        reference, closure = self.record()
        self.assertIn("unrelated", closure.names["lib/geo.py"], "a module-level call reaches what it names")
        self.edit(self.geo, "REGISTRY['k'] = unrelated(1)", "REGISTRY['k'] = unrelated(2)")
        self.assert_clause_two(reference, True)

    def test_a_decorated_or_calling_definition_is_preamble(self):
        self.write("lib/geo.py", GEO + "\n\ndef register(f):\n    return f\n\n\n@register\ndef plugin():\n    return 1\n\n\ndef defaulted(v=unrelated(1)):\n    return v\n")
        reference, closure = self.record()
        names = closure.names["lib/geo.py"]
        self.assertIn("register", names)
        self.assertIn("unrelated", names)
        self.edit(self.geo, "def plugin():\n    return 1", "def plugin():\n    return 2")
        self.assert_clause_two(reference, True)

    # --- the fallbacks -------------------------------------------------------------

    def assert_whole(self, source, *, files=("lib/geo.py",), reason=""):
        self.write("lib/geo.py", source)
        _reference, closure = self.record()
        for rel in files:
            self.assertNotIn(rel, closure.names, f"{rel} must be tracked whole: {reason}")
            self.assertTrue(closure.shas[rel].startswith("ast1:"), rel)

    def test_dynamic_modules_fall_back_to_the_whole_file(self):
        cases = {
            "star import": GEO.replace("from lib import spec", "from lib.spec import *").replace("spec.BORE", "BORE"),
            "globals()": GEO + "\n\ndef lookup(name):\n    return globals()[name]\n",
            "exec": GEO + "\n\ndef run(code):\n    exec(code)\n",
            "eval": GEO + "\n\ndef run(code):\n    return eval(code)\n",
            "importlib": GEO + "\nimport importlib\n",
            "sys.modules": GEO + "\nimport sys\n\n\ndef here():\n    return sys.modules[__name__]\n",
            "module __getattr__": GEO + "\n\ndef __getattr__(name):\n    return 1\n",
            "unresolved name": GEO + "\n\ndef broken():\n    return never_bound\n",
        }
        for reason, source in cases.items():
            with self.subTest(reason=reason):
                self.assert_whole(source, reason=reason)

    def test_a_module_alias_used_bare_makes_its_target_whole(self):
        for expression in ("getattr(spec, 'BORE')", "vars(spec)['BORE']", "(lambda m: m.BORE)(spec)"):
            with self.subTest(expression=expression):
                self.write("lib/geo.py", GEO.replace("spec.BORE", expression))
                _reference, closure = self.record()
                self.assertNotIn("lib/spec.py", closure.names, "the escaped module is whole")
                self.assertIn("lib/geo.py", closure.names, "the escaping module itself stays sliced")

    def test_writing_a_module_attribute_makes_target_and_writer_whole(self):
        self.write("lib/geo.py", GEO.replace("    return (origin, _unit(z_dir), SCALE * spec.BORE)", "    spec.BORE = 1.0\n    return (origin, _unit(z_dir), SCALE * spec.BORE)"))
        _reference, closure = self.record()
        self.assertNotIn("lib/spec.py", closure.names)
        self.assertNotIn("lib/geo.py", closure.names)

    def test_a_package_alias_used_bare_makes_the_whole_package_whole(self):
        self.write("part.py", MODEL.replace("from lib import geo", "import lib\nimport lib.geo").replace("geo.plane", "getattr(lib, 'geo').plane"))
        _reference, closure = self.record()
        self.assertNotIn("lib/geo.py", closure.names)
        self.assertNotIn("lib/spec.py", closure.names)
        self.assertNotIn("lib/__init__.py", closure.names)

    def test_a_reached_name_a_module_does_not_bind_makes_it_whole(self):
        self.write("part.py", MODEL.replace("geo.plane(", "geo.injected_plane("))
        _reference, closure = self.record()
        self.assertNotIn("lib/geo.py", closure.names)

    def test_an_unbounded_module_makes_every_module_it_imports_whole(self):
        self.write("part.py", MODEL.replace("from lib import geo", "import importlib\nfrom lib import geo"))
        _reference, closure = self.record()
        self.assertNotIn("lib/geo.py", closure.names)
        self.assertIn("lib/spec.py", closure.names, "reach continues past the dynamic module by name")

    def test_a_file_reached_only_by_execution_is_whole(self):
        loaded = self.write("lib/loaded.py", "VALUE = 1\n")
        _reference, closure = self.record(executed=self.executed(loaded))
        self.assertIn("lib/loaded.py", closure.files)
        self.assertNotIn("lib/loaded.py", closure.names)

    def test_a_sliced_file_that_turns_dynamic_reads_stale(self):
        reference, _closure = self.record()
        self.geo.write_text(self.geo.read_text(encoding="utf-8") + "\n\ndef lookup(name):\n    return globals()[name]\n", encoding="utf-8")
        self.assert_clause_two(reference, True, "lib/geo.py")

    # --- determinism -------------------------------------------------------------------

    def test_hit_and_miss_runs_record_identical_closures(self):
        """The closure is a function of the sources alone: whatever executed,
        whatever the bytes captured at execution say, the reach is the same."""
        from cadgen.store.closure import build_closure

        cold = build_closure(self.model, executed={})
        warm = build_closure(self.model, executed=self.executed(self.model, self.geo, self.spec, self.root / "lib/__init__.py"))
        captured = build_closure(
            self.model, executed=self.executed(self.model, self.geo, self.spec),
            sources={str(path): path.read_bytes() for path in (self.model, self.geo, self.spec)},
        )
        self.assertEqual(cold, warm)
        self.assertEqual(cold, captured)
        self.assertEqual(cold.as_json(), captured.as_json())

    def test_the_slice_hashes_the_bytes_that_ran(self):
        """An edit landing mid-build: the reach and the hash both describe the
        revision the exec hook captured, never the file as it is afterwards."""
        import sys

        from cadgen.store.closure import ExecutionHashes, build_closure

        with ExecutionHashes() as executed, mock.patch.object(sys, "path", [str(self.root), *sys.path]):
            exec(compile(self.geo.read_bytes(), str(self.geo), "exec"), {"__name__": "lib.geo"})  # noqa: S102
            sys.modules.pop("lib.spec", None)
            sys.modules.pop("lib", None)
            self.edit(self.geo, "SCALE = 2.0", "SCALE = 9.0")  # edited mid-build
        self.assertIn(str(self.geo), executed.sources)
        recorded = build_closure(self.model, executed=executed.hashes, sources=executed.sources)
        self.edit(self.geo, "SCALE = 9.0", "SCALE = 2.0")
        original = build_closure(self.model, executed={})
        self.assertEqual(recorded.shas["lib/geo.py"], original.shas["lib/geo.py"])
        self.edit(self.geo, "SCALE = 2.0", "SCALE = 9.0")
        edited = build_closure(self.model, executed={})
        self.assertNotEqual(recorded.shas["lib/geo.py"], edited.shas["lib/geo.py"])

    def test_the_publish_rule_compares_slices(self):
        from cadgen.store.publish import decide

        reference, older = self.record()
        self.edit(self.geo, "return x + 1", "return x + 2")  # unreached: still the same slice
        self.assertTrue(decide(reference, ran_closure_hash=older.hash, ran_files=older.files, ran_names=older.names).publish_outputs)
        self.edit(self.geo, "SCALE = 2.0", "SCALE = 3.0")  # reached: the sources moved on
        reference, current = self.record()  # a record that reflects the sources as they are now
        self.assertNotEqual(older.hash, current.hash)
        self.assertFalse(decide(reference, ran_closure_hash=older.hash, ran_files=older.files, ran_names=older.names).publish_outputs)
        self.assertTrue(decide(reference, ran_closure_hash=current.hash, ran_files=current.files, ran_names=current.names).publish_outputs)


class ReachEndToEnd(unittest.TestCase):
    """Over a real model run: the record carries the reached names, an
    unreached helper edit leaves the model current, a reached one rebuilds it."""

    def setUp(self):
        import sys

        from cadgen.store.closure import forget_model_files

        scratch = generated_cad_directory(prefix="closure-reach-e2e-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        env = mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(self.root / "store")})
        env.start()
        self.addCleanup(env.stop)
        forget_model_files()
        self.addCleanup(forget_model_files)
        self.repo = Path(__file__).resolve().parents[4]
        self.python = sys.executable
        (self.root / "src" / "lib").mkdir(parents=True)
        (self.root / "src" / "lib" / "__init__.py").write_text("", encoding="utf-8")
        self.geo = self.root / "src" / "lib" / "geo.py"
        self.geo.write_text(textwrap.dedent("""
            SIZE = 10.0


            def size():
                return SIZE


            def unrelated():
                return 1
        """).lstrip(), encoding="utf-8")
        self.model = self.root / "src" / "part.py"
        self.model.write_text(textwrap.dedent("""
            from cadgen import step
            from cadgen import build123d as bd
            from lib import geo


            @step
            def part():
                return bd.Box(geo.size(), 1, 1)


            if __name__ == "__main__":
                part()
        """).lstrip(), encoding="utf-8")

    def run_model(self):
        import subprocess

        env = dict(os.environ)
        env.update({"CADGEN_DAEMON": "0", "PYTHONPATH": str(self.repo / "packages/cadgen/src")})
        completed = subprocess.run(
            [self.python, self.model.name], cwd=str(self.model.parent), env=env,
            capture_output=True, text=True, timeout=600,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
        return completed.stdout.strip().splitlines()[-1].split(" ", 1)[0]

    def edit(self, old, new):
        text = self.geo.read_text(encoding="utf-8")
        self.assertIn(old, text)
        self.geo.write_text(text.replace(old, new), encoding="utf-8")

    def test_an_unreached_helper_edit_leaves_a_built_model_current(self):
        from cadgen.store.gate import stale
        from cadgen.store.records import read_record

        self.assertEqual(self.run_model(), "built")
        record = read_record(self.model)
        self.assertEqual(record["closure"]["names"], {"lib/__init__.py": [], "lib/geo.py": ["SIZE", "size"]})
        self.assertTrue(record["closure"]["shas"]["lib/geo.py"].startswith("slice2:"))
        self.assertEqual(self.run_model(), "current")

        self.edit("return 1", "return 2")
        self.assertFalse(stale(self.model).stale, "an unreached helper edit")
        self.assertEqual(self.run_model(), "current")

        self.edit("SIZE = 10.0", "SIZE = 12.0")
        verdict = stale(self.model)
        self.assertTrue(verdict.stale)
        self.assertEqual(verdict.reason(), "closure changed: lib/geo.py")
        self.assertEqual(self.run_model(), "built", "a reached constant edit")
        self.assertEqual(self.run_model(), "current")

    def test_store_why_prints_the_reached_names(self):
        import subprocess

        self.assertEqual(self.run_model(), "built")
        env = dict(os.environ)
        env["PYTHONPATH"] = str(self.repo / "packages/cadgen/src")
        completed = subprocess.run(
            [self.python, "-m", "cadgen.cli", "store", "why", str(self.model)],
            env=env, capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
        self.assertIn("lib/geo.py[SIZE, size]", completed.stdout)
        self.assertIn("verdict current", completed.stdout)


class ReachAnalysis(unittest.TestCase):
    """The per-module analysis, on bytes alone."""

    def analyze(self, source):
        from cadgen.store.reach import analyze

        return analyze(textwrap.dedent(source).encode("utf-8"), "m.py")

    def test_definitions_and_preamble(self):
        syntax = self.analyze("""
            import math
            from functools import lru_cache
            A = 1
            B = math.pi
            C = compute()
            D, E = 1, 2
            F: int = 3
            X.y = 2
            for i in range(3):
                pass

            def f(a=1):
                return a

            @lru_cache(maxsize=4)
            def g():
                return 1

            @register
            def h():
                return 1

            def k(v=compute()):
                return v

            class P:
                Q = 1

            class R(Base):
                pass

            class S(Exception):
                pass
        """)
        definitions = {name for name, _ in syntax.definitions.items()}
        self.assertEqual(definitions, {"A", "B", "D", "E", "F", "f", "g", "P", "S"})
        preamble = {syntax.statements[i].binds for i in syntax.preamble}
        self.assertIn(("C",), preamble)
        self.assertIn(("h",), preamble)
        self.assertIn(("k",), preamble)
        self.assertIn(("R",), preamble)
        self.assertIn(("i",), preamble)
        self.assertTrue(syntax.dynamic.startswith("unresolved name"), syntax.dynamic)

    def test_pure_vocabulary_calls_keep_an_assignment_a_definition(self):
        syntax = self.analyze("""
            import math
            from cadgen import build123d as bd, srgb
            from lib import registry
            COLOR = srgb("#fff")
            AXIS = bd.Vector(0, 0, 1).normalized()
            R = math.hypot(3, 4)
            NAMES = tuple(sorted(["b", "a"]))
            PARTS = "a b".split()
            TABLE = registry.load()
            ROWS = REGISTRY.get("k")
            REGISTRY = {}
        """)
        self.assertEqual(set(syntax.definitions), {"COLOR", "AXIS", "R", "NAMES", "PARTS", "REGISTRY"})
        preamble_binds = {b for i in syntax.preamble for b in syntax.statements[i].binds}
        self.assertEqual(preamble_binds & {"TABLE", "ROWS"}, {"TABLE", "ROWS"})

    def test_a_main_guard_is_in_no_slice(self):
        from cadgen.store.reach import close_names, slice_hash

        source = textwrap.dedent("""
            def a():
                return 1

            def b():
                return 2

            if __name__ == "__main__":
                b()
        """)
        syntax = self.analyze(source)
        self.assertEqual(close_names(syntax, ["a"]), frozenset({"a"}))
        before = slice_hash(syntax, ["a"])
        self.assertEqual(before, slice_hash(self.analyze(source.replace("    b()", "    a()\n    b()")), ["a"]))

    def test_reads_resolve_locals_and_follow_globals(self):
        syntax = self.analyze("""
            import lib.geo as geo
            TOTAL = 0

            def f(x):
                global TOTAL
                y = [c for c in x]
                z = geo.plane(y)
                return z, TOTAL, len(y)
        """)
        f = syntax.statements[[i for i, s in enumerate(syntax.statements) if "f" in s.binds][0]]
        self.assertIn("TOTAL", f.reads)
        self.assertIn("len", f.reads)
        self.assertNotIn("y", f.reads)
        self.assertNotIn("c", f.reads)
        self.assertEqual(f.chains, (("geo", ("plane",)),))
        self.assertIsNone(syntax.dynamic)

    def test_slice_hash_is_stable_under_unreached_edits_and_moves_with_reached_ones(self):
        from cadgen.store.reach import slice_hash

        base = textwrap.dedent("""
            import math
            K = 2

            def a():
                return K

            def b():
                return 1
        """)
        before = slice_hash(self.analyze(base), ["a"])
        self.assertEqual(before, slice_hash(self.analyze(base.replace("return 1", "return 2")), ["a"]))
        self.assertEqual(before, slice_hash(self.analyze(base + "\ndef c():\n    return 3\n"), ["a"]))
        self.assertNotEqual(before, slice_hash(self.analyze(base.replace("K = 2", "K = 3")), ["a"]))
        self.assertNotEqual(before, slice_hash(self.analyze(base.replace("return K", "return K + 1")), ["a"]))
        self.assertNotEqual(before, slice_hash(self.analyze(base.replace("import math", "import math, os")), ["a"]))
        self.assertNotEqual(before, slice_hash(self.analyze(base), ["a", "b"]))
        self.assertTrue(before.startswith("slice2:"))
        self.assertTrue(slice_hash(self.analyze(base + "\nfrom os import *\n"), ["a"]).startswith("ast1:"))


if __name__ == "__main__":
    unittest.main()
