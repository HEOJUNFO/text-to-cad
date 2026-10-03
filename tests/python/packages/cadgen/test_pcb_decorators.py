"""How @pcb stacks with 3D and manufacturing exports, read statically and at decoration.

A board alone is a tree-less model ("pcb"); a board with any 3D export is a
geometry model ("step") whose tree is the populated board. Stacking order never
changes the answer, the static reader and the decorators agree, and every file
a board declares is among its declared outputs. No KiCad: nothing is built.
"""

from __future__ import annotations

import tempfile
import textwrap
import unittest
from pathlib import Path

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadgen/src")

from cadgen.metadata import declared_output_paths, model_function_formats, parse_generator_metadata  # noqa: E402

SCRIPT = textwrap.dedent(
    """
    from cadgen import bom, gerber, glb, pcb, pos, step


    @pcb
    def flat():
        pass


    @step
    @pcb
    def step_above():
        pass


    @pcb
    @step
    def step_below():
        pass


    @glb
    @pcb
    def mesh_only():
        pass


    @gerber
    @bom
    @pos
    @pcb(out="fab/board.kicad_pcb")
    def fabricated():
        pass
    """
)


class PcbDecoratorsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.script = Path(self._tmp.name) / "boards.py"
        self.script.write_text(SCRIPT, encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_a_board_with_a_3d_export_is_a_geometry_model_in_any_order(self) -> None:
        formats = model_function_formats(SCRIPT)
        self.assertEqual(
            formats,
            {"flat": "pcb", "step_above": "step", "step_below": "step", "mesh_only": "step", "fabricated": "pcb"},
        )
        for name, step_output in (("step_above", True), ("step_below", True), ("mesh_only", False)):
            metadata = parse_generator_metadata(self.script, name)
            self.assertEqual((metadata.format, metadata.board, metadata.step_output), ("step", True, step_output), name)
        self.assertEqual([decl.fmt for decl in parse_generator_metadata(self.script, "mesh_only").mesh_exports], ["glb"])

    def test_every_declared_file_is_an_output(self) -> None:
        folder = self.script.parent.resolve()

        def outputs(name: str) -> list[str]:
            return [str(path.relative_to(folder)) for path in declared_output_paths(self.script, function=name)]

        self.assertEqual(outputs("flat"), ["flat.kicad_pcb", "flat.kicad_sch", "flat.kicad_pro"])
        self.assertEqual(outputs("step_above"), ["step_above.kicad_pcb", "step_above.kicad_sch", "step_above.kicad_pro", "step_above.step"])
        self.assertEqual(outputs("mesh_only"), ["mesh_only.kicad_pcb", "mesh_only.kicad_sch", "mesh_only.kicad_pro", "mesh_only.glb"])
        self.assertEqual(
            sorted(outputs("fabricated")),
            sorted(["fab/board.kicad_pcb", "fab/board.kicad_sch", "fab/board.kicad_pro",
                    "fab/board.gerbers.zip", "fab/board.bom.csv", "fab/board.pos.csv"]),
        )

    def test_misplaced_exports_are_refused(self) -> None:
        from cadgen import gerber, pcb, step

        with self.assertRaisesRegex(ValueError, "@gerber goes ABOVE @pcb"):
            gerber(lambda: None)
        with self.assertRaisesRegex(ValueError, "exports a @pcb board's manufacturing files"):
            gerber(step(_part))
        with self.assertRaisesRegex(ValueError, "@pcb out= names the board file"):
            pcb(out="board.step")


def _part():
    return None


if __name__ == "__main__":
    unittest.main()
