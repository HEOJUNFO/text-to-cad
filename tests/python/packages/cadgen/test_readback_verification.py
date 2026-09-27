"""A written STEP is verified against the result that produced it, never trusted.

OCCT's STEP writer can emit a solid that reads back as something else while
the in-memory shape passed BRepCheck: a sphere-boolean cap comes back as its
complement (42.3 mm³ → 0.35 mm³), a ring came back as a 988 mm spike, a swept
bore meeting a coaxial cylinder left a face with ``BadOrientationOfSubshape``.
``build_tree_through_step`` re-reads what it wrote; this suite pins that the
re-read is COMPARED with the returned shape — solid count, volume, bounds, and
BRepCheck validity where the source was valid — and that a mismatch fails the
build with the occurrence and the numbers (STORE.md §5, read-back
verification), leaving no document behind.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.python.support.paths import add_repo_path
from tests.python.support.tmp_root import generated_cad_directory

CADGEN_SRC = add_repo_path("packages/cadgen/src")


_VOLUMES = re.compile(r"volume ([0-9.eE+-]+) mm³ written, ([0-9.eE+-]+) mm³ read back")


def assert_grossly_lossy(case: unittest.TestCase, message: str) -> None:
    """The message carries both volumes, and the read-back is a sliver of what was written.

    The digits of the read-back volume differ between OCCT builds (0.354915 on
    macOS, 0.354923 on Linux), so this pins the failure itself -- the ~42 mm³
    cap coming back as its ~0.35 mm³ complement -- rather than a formatting.
    """
    match = _VOLUMES.search(message)
    case.assertIsNotNone(match, f"no 'volume … written, … read back' in: {message}")
    written, read = (float(group) for group in match.groups())
    case.assertAlmostEqual(written, 42.3353, places=3)
    case.assertLess(read, 0.05 * written, message)


def _rot_cap():
    """The lossy solid: an anisotropically scaled, rotated sphere trimmed by a box."""
    import build123d as bd

    sphere = bd.Rot(90, 0, 0) * bd.Rot(0, 0, -90) * bd.Sphere(1)
    ellipsoid = sphere.transform_geometry(
        bd.Matrix([[2.7, 0, 0, 0], [0, 2.7, 0, 0], [0, 0, 1.4, 0], [0, 0, 0, 1]]))
    pad = bd.Pos(0, 0, 5.4) * ellipsoid
    return pad - (bd.Pos(0, 0, 4.15 - 10) * bd.Box(30, 30, 20))


def _open_solid():
    """A 'solid' whose shell lacks one face: BRepCheck rejects it (NotClosed)."""
    import build123d as bd
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Shell, TopoDS_Solid

    faces = bd.Box(2, 2, 2).faces()[:-1]
    shell = TopoDS_Shell()
    builder = BRep_Builder()
    builder.MakeShell(shell)
    for face in faces:
        builder.Add(shell, face.wrapped)
    solid = TopoDS_Solid()
    builder.MakeSolid(solid)
    builder.Add(solid, shell)
    return solid


def _round_trip(shape, directory: Path):
    """Write ``shape`` with cadgen's writer; return the prototype the scene reads back."""
    from cadgen._internal.step_scene_loader import load_step_scene
    from cadgen.step_export import export_build123d_step_file

    path = directory / "part.step"
    export_build123d_step_file(shape, path)
    scene = load_step_scene(path, record_read=False)
    prototypes = list(scene.prototype_shapes.values())
    assert len(prototypes) == 1, prototypes
    return prototypes[0]


class VerifyReadbackComponent(unittest.TestCase):
    """The comparison itself, on shapes pushed through the real writer and reader."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="readback-verify-")
        self.addCleanup(self._tmp.cleanup)
        self.directory = Path(self._tmp.name)
        self._env = mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(self.directory / "store")})
        self._env.start()
        self.addCleanup(self._env.stop)

    def test_a_clean_round_trip_passes_and_reports_facts(self) -> None:
        import build123d as bd

        from cadgen.store.build import verify_readback_component

        written = bd.Box(2, 3, 4) - bd.Cylinder(0.5, 4)
        facts = verify_readback_component("part", written.wrapped, _round_trip(written, self.directory))
        self.assertEqual(facts.solids, 1)
        self.assertAlmostEqual(facts.volume, written.volume, places=6)
        self.assertEqual(tuple(round(v, 6) for v in facts.bounds), (-1.0, -1.5, -2.0, 1.0, 1.5, 2.0))

    def test_a_lossy_translation_fails_with_both_volumes(self) -> None:
        from cadgen.store.build import verify_readback_component

        written = _rot_cap()
        self.assertGreater(written.volume, 40.0)
        with self.assertRaises(RuntimeError) as caught:
            verify_readback_component("rot.step: occurrence o1 (cap)", written.wrapped, _round_trip(written, self.directory))
        message = str(caught.exception)
        self.assertIn("rot.step: occurrence o1 (cap)", message)
        self.assertIn("different geometry", message)
        assert_grossly_lossy(self, message)

    def test_a_reversed_solid_passes_on_magnitude(self) -> None:
        # STEP carries no solid orientation: a Reversed solid (signed volume
        # -V) reads back as +V with the same geometry, and that is not damage.
        import build123d as bd

        from cadgen.store.build import readback_facts, verify_readback_component

        written = bd.Box(2, 3, 4)
        written.wrapped.Reverse()
        self.assertAlmostEqual(readback_facts(written.wrapped).volume, -24.0, places=9)
        facts = verify_readback_component("part", written.wrapped, _round_trip(written, self.directory))
        self.assertAlmostEqual(facts.volume, 24.0, places=6)

    def test_a_dropped_member_fails_on_solid_count(self) -> None:
        import build123d as bd

        from cadgen.store.build import verify_readback_component

        pair = bd.Compound([bd.Box(1, 1, 1), bd.Pos(3, 0, 0) * bd.Box(1, 1, 1)])
        with self.assertRaises(RuntimeError) as caught:
            verify_readback_component("pair", pair.wrapped, bd.Box(1, 1, 1).wrapped)
        self.assertIn("2 solid(s) written, 1 read back", str(caught.exception))

    def test_a_moved_solid_of_equal_volume_fails_on_bounds(self) -> None:
        import build123d as bd

        from cadgen.store.build import verify_readback_component

        with self.assertRaises(RuntimeError) as caught:
            verify_readback_component("cube", bd.Box(2, 2, 2).wrapped, (bd.Pos(0, 0, 900) * bd.Box(2, 2, 2)).wrapped)
        self.assertIn("zmin -1 written, 899 read back", str(caught.exception))

    def test_an_invalid_readback_of_a_valid_source_fails_naming_the_fault(self) -> None:
        import build123d as bd

        from cadgen.store import build as build_module

        written = bd.Box(2, 2, 2)
        # The same volume/bounds/solid count either side; only validity differs.
        # Written invalid solids that keep the measurements are what the writer
        # produced in the field (a sliver face with BadOrientationOfSubshape),
        # and are not constructible on demand, so the analyzer's verdict is the
        # crafted input and the diagnostic comes from a genuinely open solid.
        with mock.patch.object(build_module, "_brepcheck_valid", side_effect=[False, True]) as valid:
            with self.assertRaises(RuntimeError) as caught:
                build_module.verify_readback_component("part.step: occurrence o1 (lid)", written.wrapped, written.wrapped)
        message = str(caught.exception)
        self.assertIn("part.step: occurrence o1 (lid)", message)
        self.assertIn("invalid where the returned solid was valid: BRepCheck reports it invalid", message)
        self.assertEqual(valid.call_count, 2, "read-back is examined first, source only when it fails")

    def test_the_diagnostic_names_the_kernel_status(self) -> None:
        from cadgen.store.build import _topology_codes

        self.assertIn("NotClosed", _topology_codes(_open_solid()))

    def test_an_invalid_source_is_not_blamed_on_the_writer(self) -> None:
        from cadgen.store.build import verify_readback_component

        broken = _open_solid()
        # Same shape both sides: the round trip changed nothing, and the
        # model's own solid is what BRepCheck rejects.
        verify_readback_component("part", broken, broken)

    def test_a_valid_round_trip_asks_brepcheck_once(self) -> None:
        import build123d as bd

        from cadgen.store import build as build_module

        written = bd.Box(2, 2, 2)
        with mock.patch.object(build_module, "_brepcheck_valid", wraps=build_module._brepcheck_valid) as valid:
            build_module.verify_readback_component("part", written.wrapped, _round_trip(written, self.directory))
        self.assertEqual(valid.call_count, 1)


class ReadbackVerificationFailsTheBuild(unittest.TestCase):
    """Through ``python model.py``: the lossy solid fails, the staged STEP is gone."""

    def setUp(self) -> None:
        self._tmp = generated_cad_directory(prefix="readback-build-")
        self.addCleanup(self._tmp.cleanup)
        self.project = Path(self._tmp.name).resolve()
        self.environment = dict(os.environ)
        self.environment.update({
            "CADGEN_DAEMON": "0",
            "CADGEN_COMPONENT_WORKERS": "1",
            "CADGEN_CACHE_DIR": str(self.project / "store"),
            "PYTHONPATH": str(CADGEN_SRC),
        })

    def _run(self, name: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(self.project / name), "--force"],
            cwd=str(self.project), env=self.environment,
            capture_output=True, text=True, timeout=600,
        )

    def test_lossy_model_fails_loudly_and_writes_nothing(self) -> None:
        (self.project / "rot_cap.py").write_text(
            "from cadgen import build123d as bd, step\n\n\n"
            "@step\ndef rot_cap():\n"
            "    sphere = bd.Rot(90, 0, 0) * bd.Rot(0, 0, -90) * bd.Sphere(1)\n"
            "    ellipsoid = sphere.transform_geometry(\n"
            "        bd.Matrix([[2.7, 0, 0, 0], [0, 2.7, 0, 0], [0, 0, 1.4, 0], [0, 0, 0, 1]]))\n"
            "    pad = bd.Pos(0, 0, 5.4) * ellipsoid\n"
            "    cap = pad - (bd.Pos(0, 0, 4.15 - 10) * bd.Box(30, 30, 20))\n"
            "    cap.label = 'seat_cap'\n"
            "    return cap\n\n\n"
            "if __name__ == '__main__':\n    rot_cap()\n",
            encoding="utf-8",
        )
        completed = self._run("rot_cap.py")
        self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("rot_cap.step: occurrence o1 (seat_cap", completed.stderr)
        assert_grossly_lossy(self, completed.stderr)
        self.assertFalse((self.project / "rot_cap.step").exists(), "a failed build must leave no document")
        self.assertEqual([p.name for p in self.project.iterdir() if p.name.startswith(".rot_cap")], [],
                         "the staging directory is cleaned up")
        from cadgen.store.records import read_record

        with mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(self.project / "store")}):
            self.assertIsNone(read_record(self.project / "rot_cap.py"))

    def test_a_faithful_model_still_builds(self) -> None:
        (self.project / "bracket.py").write_text(
            "from cadgen import build123d as bd, step\n\n\n"
            "@step\ndef bracket():\n"
            "    plate = bd.Box(20, 10, 2) - bd.Cylinder(1.5, 2)\n"
            "    plate.label = 'plate'\n"
            "    boss = bd.Pos(6, 0, 3) * bd.Cylinder(3, 4)\n"
            "    boss.label = 'boss'\n"
            "    return bd.Compound(children=[plate, boss], label='bracket')\n\n\n"
            "if __name__ == '__main__':\n    bracket()\n",
            encoding="utf-8",
        )
        completed = self._run("bracket.py")
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertTrue((self.project / "bracket.step").is_file())


if __name__ == "__main__":
    unittest.main()
