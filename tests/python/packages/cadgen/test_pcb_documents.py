"""The KiCad documents a board writes, without KiCad: their frame, their links, their bytes.

A board script works in millimetres with y up; KiCad's files are y down on a
page. These tests pin how the writers map one to the other (the script's origin
becomes the board's drill/place origin), how a bottom-side part is stored (as
KiCad's own flip leaves it), that the schematic labels every connected pin and
flags every no-connect, that each footprint points at its symbol, and that the
same board always writes the same bytes. KiCad's verdict on the documents is the
KiCad suite's (tests/python/packages/kicad).
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tests.python.support.kicad_library import write_test_library
from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadgen/src")

from cadgen.kicad import sexpr  # noqa: E402
from cadgen.kicad.design import Board  # noqa: E402
from cadgen.kicad.project import project_texts  # noqa: E402


def _footprint(tree: list, ref: str) -> list:
    for node in sexpr.find_all(tree, "footprint"):
        if any(prop[1] == "Reference" and prop[2] == ref for prop in sexpr.find_all(node, "property")):
            return node
    raise AssertionError(f"no footprint {ref}")


class PcbDocumentsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.library = write_test_library(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def board(self) -> Board:
        from cadgen import build123d as bd

        with bd.BuildSketch() as outline:
            bd.Rectangle(40, 30)
        board = Board(outline=outline.sketch, libraries=[self.library])
        vin, out, gnd = board.net("VIN", power_flag=True), board.net("OUT"), board.net("GND", power_flag=True)
        amp = board.part("Test:AMP", ref="U1")
        r1 = board.part("Test:R", footprint="Test:R_0603", value="10k")
        r2 = board.part("Test:R", footprint="Test:R_0603", value="1k", properties={"LCSC": "C25804"})
        board.connect(vin, amp["IN"], r1[1])
        board.connect(out, amp["OUT"], r1[2], r2[1])
        board.connect(gnd, amp[3], amp[4], r2[2])
        board.place(amp, at=(-5, 0))
        board.place(r1, at=(8, 4), rotation=90)
        board.place(r2, at=(8, -4), side="bottom")
        board.track(out, [amp["OUT"], r1[2]], width=0.3)
        board.via(gnd, at=(0, -8))
        board.zone(gnd, layers=["B.Cu"])
        return board

    def test_the_same_board_writes_the_same_bytes(self) -> None:
        first, second = project_texts(self.board(), name="amp"), project_texts(self.board(), name="amp")
        self.assertEqual((first.pro, first.sch, first.pcb), (second.pro, second.sch, second.pcb))

    def test_the_script_origin_is_the_drill_origin_and_y_flips(self) -> None:
        tree = project_texts(self.board(), name="amp").pcb_tree
        origin = sexpr.find(sexpr.find(tree, "setup"), "aux_axis_origin")[1:]
        at = sexpr.find(_footprint(tree, "R1"), "at")[1:]
        # R1 is at (8, 4) in the script: KiCad's x grows to the right, its y downwards.
        self.assertEqual((at[0] - origin[0], origin[1] - at[1], at[2]), (8, 4, 90))
        segment = sexpr.find(tree, "segment")
        self.assertEqual(sexpr.value(segment, "net"), "OUT")
        self.assertEqual(sexpr.value(segment, "width"), 0.3)

    def test_pad_angles_are_absolute_and_carry_their_nets(self) -> None:
        tree = project_texts(self.board(), name="amp").pcb_tree
        pads = {str(pad[1]): pad for pad in sexpr.find_all(_footprint(tree, "R1"), "pad")}
        self.assertEqual(sexpr.find(pads["1"], "at")[1:], [-0.825, 0, 90])
        self.assertEqual(sexpr.value(pads["1"], "net"), "VIN")
        self.assertEqual(sexpr.value(pads["2"], "net"), "OUT")

    def test_a_bottom_part_is_stored_as_kicad_flips_it(self) -> None:
        tree = project_texts(self.board(), name="amp").pcb_tree
        r2 = _footprint(tree, "R2")
        self.assertEqual(sexpr.value(r2, "layer"), "B.Cu")
        pad = next(sexpr.find_all(r2, "pad"))
        self.assertEqual(sexpr.find(pad, "layers")[1:], ["B.Cu", "B.Mask", "B.Paste"])
        reference = next(prop for prop in sexpr.find_all(r2, "property") if prop[1] == "Reference")
        # Library text at (0, -1.5, 0) on F.SilkS: mirrored to y = 1.5, on the back,
        # read upside down and mirrored (angle 180 - a), as KiCad's own flip stores it.
        self.assertEqual(sexpr.find(reference, "at")[1:], [0, 1.5, 180])
        self.assertEqual(sexpr.value(reference, "layer"), "B.SilkS")
        self.assertIn("mirror", str(sexpr.find(reference, "effects")))
        lcsc = next(prop for prop in sexpr.find_all(r2, "property") if prop[1] == "LCSC")
        self.assertEqual(lcsc[2], "C25804")

    def test_each_footprint_points_at_its_symbol(self) -> None:
        texts = project_texts(self.board(), name="amp")
        schematic = sexpr.parse(texts.sch)
        symbols = {}
        for symbol in sexpr.find_all(schematic, "symbol"):
            reference = next((prop[2] for prop in sexpr.find_all(symbol, "property") if prop[1] == "Reference"), None)
            symbols.setdefault(reference, f"/{sexpr.value(symbol, 'uuid')}")
        for ref in ("U1", "R1", "R2"):
            self.assertEqual(sexpr.value(_footprint(texts.pcb_tree, ref), "path"), symbols[ref])

    def test_the_schematic_labels_every_connected_pin_and_flags_power(self) -> None:
        schematic = sexpr.parse(project_texts(self.board(), name="amp").sch)
        labels = sorted(str(label[1]) for label in sexpr.find_all(schematic, "global_label"))
        # Nine connected pins, and one PWR_FLAG on each of the two powered nets.
        self.assertEqual(labels, sorted(["VIN"] * 2 + ["OUT"] * 3 + ["GND"] * 3 + ["VIN", "GND"]))
        flags = [
            symbol for symbol in sexpr.find_all(schematic, "symbol") if sexpr.value(symbol, "lib_id") == "power:PWR_FLAG"
        ]
        self.assertEqual(len(flags), 2)

    def test_a_no_connect_pin_is_flagged_and_gets_kicads_own_net(self) -> None:
        board = self.board()
        spare = board.part("Test:R", footprint="Test:R_0603", value="0R")
        board.place(spare, at=(-15, 10))
        board.connect(board.net("GND"), spare[1])
        board.no_connect(spare[2])
        texts = project_texts(board, name="amp")
        self.assertEqual(len(list(sexpr.find_all(sexpr.parse(texts.sch), "no_connect"))), 1)
        pads = {str(pad[1]): pad for pad in sexpr.find_all(_footprint(texts.pcb_tree, spare.ref), "pad")}
        self.assertEqual(sexpr.value(pads["2"], "net"), f"unconnected-({spare.ref}-Pad2)")

    def test_the_project_carries_the_rules_and_net_classes(self) -> None:
        board = self.board()
        board.netclass("Power", track_width=0.5, clearance=0.25)
        board.net("VIN", netclass="Power")
        project = json.loads(project_texts(board, name="amp").pro)
        classes = {entry["name"]: entry for entry in project["net_settings"]["classes"]}
        self.assertEqual((classes["Power"]["track_width"], classes["Default"]["track_width"]), (0.5, board.rules.track_width))
        self.assertEqual(project["net_settings"]["netclass_patterns"], [{"netclass": "Power", "pattern": "VIN"}])
        self.assertEqual(project["board"]["design_settings"]["rules"]["min_clearance"], board.rules.min_clearance)

    def test_custom_rules_are_the_projects_kicad_dru(self) -> None:
        from cadgen.kicad.design import DesignError

        board = self.board()
        self.assertEqual(project_texts(board, name="amp").dru, "(version 1)\n")  # written even when empty
        board.rule("""(rule "U1 pads" (constraint hole_clearance (min 0.15mm)) (condition "A.memberOfFootprint('U1')"))""")
        rules = sexpr.parse(project_texts(board, name="amp").dru.split("\n", 1)[1])
        self.assertEqual((rules[1], sexpr.value(rules, "condition")), ("U1 pads", "A.memberOfFootprint('U1')"))
        for text, message in (
            ("(rule unclosed", "takes one KiCad rule"),
            ('(constraint clearance (min 1mm))', "takes one \\(rule NAME"),
            ('(rule "no constraint" (condition "A.Type == \'Pad\'"))', "has no \\(constraint"),
            ('(rule "U1 pads" (constraint clearance (min 1mm)))', "already has a rule named"),
        ):
            with self.assertRaisesRegex(DesignError, message):
                board.rule(text)


if __name__ == "__main__":
    unittest.main()
