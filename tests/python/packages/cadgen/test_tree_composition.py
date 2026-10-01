"""An all-link parent's saved-document tree, composed from its children's
document trees, is the tree a parse of the written STEP publishes — and every
ineligible case parses (``cadgen.store._compose_readback``, STORE.md §3)."""
from __future__ import annotations

import math
import os
import random
import unittest
from pathlib import Path
from unittest import mock

from tests.python.support.paths import add_repo_path
from tests.python.support.tmp_root import generated_cad_directory

add_repo_path("packages/cadgen/src")


class Fixture(unittest.TestCase):
    """Two children built through STEP (groups, exact-axis and arbitrary
    rotations, non-dyadic and out-of-range translations, a compound leaf, face
    and uniform colours, a grandchild link) and the parents that place them."""

    @classmethod
    def setUpClass(cls):
        cls.temp = generated_cad_directory(prefix="tree-composition-")
        cls.root = Path(cls.temp.name)
        cls.env = mock.patch.dict(os.environ, {
            "CADGEN_CACHE_DIR": str(cls.root / "store"),
            "CADGEN_COMPONENT_WORKERS": "1", "CADGEN_DAEMON": "0",
        })
        cls.env.start()
        from cadgen.store.build import build_tree_through_step

        cls.a_hash, _, a_stats, _ = build_tree_through_step(
            cls.child_a(), cls.root / "child_a.step", root_name="child_a")
        cls.b_hash, _, b_stats, _ = build_tree_through_step(
            cls.child_b(), cls.root / "child_b.step", root_name="child_b", _internal_source_publication=True)
        cls.documents = {cls.a_hash: a_stats["documentTree"], cls.b_hash: b_stats["documentTree"]}

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.temp.cleanup()

    @staticmethod
    def leaf(name, shape, location, color=None, faces=None):
        placed = shape.moved(location)
        placed.label = name
        if color is not None:
            placed.color = color
        if faces is not None:
            placed.cad_face_ordinal_colors = faces
        return placed

    @classmethod
    def child_a(cls):
        import build123d as bd

        box = bd.Solid.make_box(1, 2, 3)
        cylinder = bd.Solid.make_cylinder(0.7, 2.5)
        pair = bd.Compound([bd.Box(2, 2, 2), bd.Pos(4, 0, 0) * bd.Box(2, 2, 2)])
        members = [
            cls.leaf("a", box, bd.Location((0.7, 0.3, 0.9)), color=(0.9, 0.1, 0.1, 1)),
            cls.leaf("b", box, bd.Location(bd.Plane((0.1, 0.2, 0.3), x_dir=(0, 0, -1), z_dir=(1, 0, 0)))),
            cls.leaf("c", cylinder, bd.Location(bd.Plane((5.3, 0.7, -2.1), x_dir=(0, -1, 0), z_dir=(0, 0, -1))),
                     faces={1: (0., 0., 1., 1.)}),
            cls.leaf("d", box, bd.Location((0.1, 7.7, 0.0), (0, 0, 37))),
            cls.leaf("e", pair, bd.Location(bd.Plane((1.1, 1.2, 1.3), x_dir=(0, 1, 0), z_dir=(-1, 0, 0)))),
            cls.leaf("f", box, bd.Location((1234.5678901234, 0.000123456789, -1 / 3), (12, 34, 56))),
        ]
        g1 = bd.Compound(children=members[:2], label="g1")
        g3 = bd.Compound(children=members[3:5], label="g3")
        g2 = bd.Compound(children=[members[2], g3], label="g2")
        return bd.Compound(children=[g1, g2, members[5]], label="child_a")

    @classmethod
    def child_b(cls):
        import build123d as bd

        from cadgen.store.materialize import materialize

        first = materialize(cls.a_hash).moved(bd.Location((0.3, 0.1, 0.2)))
        first.label = "a_first"
        second = materialize(cls.a_hash).moved(bd.Location((10.1, -0.7, 2.2)))
        second.label = "a_second"
        own = cls.leaf("own", bd.Solid.make_cylinder(0.7, 2.5), bd.Location((0.05, 0.25, 0.5)))
        return bd.Compound(children=[first, own, second], label="child_b")

    def parent(self, placements=None, *, grouped=False, extra=None):
        import build123d as bd

        from cadgen.store.materialize import materialize

        placements = placements or [
            (self.a_hash, bd.Location((0.1, 0.2, 0.3))),
            (self.b_hash, bd.Location((7.3, -2.2, 0.0))),
            (self.a_hash, bd.Location((0.0, 0.0, 999.95))),
        ]
        links = []
        for index, (tree_hash, location) in enumerate(placements):
            link = materialize(tree_hash).moved(location)
            link.label = f"link{index}"
            links.append(link)
        if grouped:
            links = [bd.Compound(children=links[:2], label="pair"), *links[2:]]
        if extra is not None:
            links.append(extra)
        return bd.Compound(children=links, label="parent")

    def build(self, shape, *, name="parent", force=False, documents=None, env=None, logger=None):
        from cadgen.store.build import build_tree_through_step

        resolver = (lambda: self.documents) if documents is None else (lambda: documents)
        with mock.patch.dict(os.environ, env or {}):
            return build_tree_through_step(
                shape, self.root / f"{name}.step", root_name=name, force=force,
                _internal_source_publication=True, child_documents=resolver, logger=logger,
            )

    @staticmethod
    def verbose_logger():
        import io

        from cadgen.cli_logging import CliLogger

        return CliLogger(name="t", verbose=True, stream=io.StringIO())

    def parsed_document(self, step):
        from cadgen._internal.step_scene_package import load_step_scene_exact
        from cadgen.store.build import build_document_tree

        return build_document_tree(load_step_scene_exact(step))[0]


class ComposedTreeTest(Fixture):
    def test_composed_tree_is_the_parse_of_the_written_bytes(self):
        from cadgen._internal.step_scene_loader import load_step_scene

        with mock.patch("cadgen._internal.step_scene_loader.load_step_scene",
                        side_effect=AssertionError("the composed path parsed the STEP")):
            _, _, stats, step_hash = self.build(self.parent())
        self.assertEqual(stats["documentReadback"], "composed")
        self.assertEqual(stats["documentTree"], self.parsed_document(self.root / "parent.step"))
        # The same bytes, parsed by the build: the same tree, maps and appearance.
        with mock.patch("cadgen._internal.step_scene_loader.load_step_scene", wraps=load_step_scene) as parse:
            _, _, forced, forced_hash = self.build(self.parent(), name="parent", force=True)
        parse.assert_called_once()
        self.assertEqual(step_hash, forced_hash)
        for key in ("documentTree", "documentOccurrenceMap", "documentNodeMap", "documentAppearance"):
            self.assertEqual(stats[key], forced[key], key)

    def test_links_under_a_group_compose_the_group(self):
        _, _, stats, _ = self.build(self.parent(grouped=True), name="grouped")
        self.assertEqual(stats["documentReadback"], "composed")
        self.assertEqual(stats["documentTree"], self.parsed_document(self.root / "grouped.step"))

    def test_ineligible_parents_parse_and_publish_the_parsed_tree(self):
        import build123d as bd

        from cadgen.store.objects import object_path

        coloured = self.parent()
        coloured.children[1].color = (0.2, 0.4, 0.8, 1.0)
        cases = {
            "rotated link": (self.parent([(self.a_hash, bd.Location((1, 2, 3), (0, 90, 0)))]), None),
            "link colour": (coloured, None),
            "own geometry": (self.parent(extra=self.leaf("plate", bd.Solid.make_box(5, 5, 1), bd.Location((0, 0, -9)))), None),
            "missing document tree": (self.parent(), {self.a_hash: self.documents[self.a_hash]}),
            "incomplete document tree": (self.parent(), None),
        }
        for label, (shape, documents) in cases.items():
            with self.subTest(label):
                if label == "incomplete document tree":
                    tree = object_path(self.documents[self.b_hash])
                    payload = tree.read_bytes()
                    tree.unlink()
                    self.addCleanup(tree.write_bytes, payload)
                name = label.replace(" ", "_")
                logger = self.verbose_logger()
                _, _, stats, _ = self.build(shape, name=name, documents=documents, logger=logger)
                if label == "incomplete document tree":
                    tree.write_bytes(payload)
                self.assertEqual(stats["documentReadback"], "parsed")
                self.assertEqual(stats["documentTree"], self.parsed_document(self.root / f"{name}.step"))
                # Refused by the eligibility rule, not rescued by the correspondence fallback.
                log = logger.stream.getvalue()
                self.assertIn("document composed from children: no (", log)
                self.assertNotIn("warning:", log)

    def test_verify_switch_passes_composition_and_catches_an_injected_difference(self):
        from cadgen.store import _compose_readback as composer

        env = {"CADGEN_VERIFY_READBACK": "1"}
        _, _, stats, _ = self.build(self.parent(), name="verified", env=env)
        self.assertEqual(stats["documentReadback"], "composed")

        compose = composer.compose_document_tree

        def nudged(**kwargs):
            tree = compose(**kwargs)
            tree["bbox"]["max"][2] = math.nextafter(tree["bbox"]["max"][2], math.inf)
            return tree

        with mock.patch.object(composer, "compose_document_tree", side_effect=nudged):
            with self.assertRaisesRegex(RuntimeError, "composed document tree .* differs from the parse.*differs: bbox"):
                self.build(self.parent(), name="nudged", env=env)
        # Without the switch the injected difference is not checked here; the
        # switch exists to find exactly this on a corpus.
        with mock.patch.object(composer, "compose_document_tree", side_effect=nudged):
            _, _, stats, _ = self.build(self.parent(), name="unchecked")
        self.assertEqual(stats["documentReadback"], "composed")


class PinnedChildDocumentsTest(unittest.TestCase):
    def test_only_a_record_that_still_pins_the_tree_resolves_its_document(self):
        from cadgen._internal.generation import _pinned_child_documents
        from cadgen.store.records import write_record

        scratch = generated_cad_directory(prefix="pinned-child-documents-")
        self.addCleanup(scratch.cleanup)
        root = Path(scratch.name)
        with mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(root / "store")}):
            write_record(root / "current.py", {"tree": "a" * 64, "documentTree": "d" * 64})
            write_record(root / "moved.py", {"tree": "b" * 64, "documentTree": "e" * 64})
            write_record(root / "mesh_only.py", {"tree": "c" * 64, "documentTree": None})
            scene = mock.Mock(store_children=[
                {"model": str(root / "current.py"), "tree": "a" * 64},
                {"model": str(root / "moved.py"), "tree": "9" * 64},
                {"model": str(root / "mesh_only.py"), "tree": "c" * 64},
                {"model": str(root / "absent.py"), "tree": "f" * 64},
            ])
            self.assertEqual(_pinned_child_documents(scene), {"a" * 64: "d" * 64})


class WrittenRealTest(unittest.TestCase):
    """``written_real`` is what the reader returns for what the writer printed."""

    def test_emulation_matches_the_writer_and_reader(self):
        import build123d as bd

        from cadgen._internal.step_scene_loader import load_step_scene
        from cadgen.step_export import export_build123d_step_file
        from cadgen.store._compose_readback import written_real

        scratch = generated_cad_directory(prefix="written-real-")
        self.addCleanup(scratch.cleanup)
        values = [0.0, -0.0, 0.1, 0.09999999999999999, 0.1000000000000001, 999.9999999999999, 1000.0,
                  1000.0000000000001, 999.95, 0.5, 1 / 3, 2 / 3, -1 / 3, 1e-7, 1e-12, 1e-300, 1e300,
                  5e-324, 123456789.123456789, 12.345678901234567, -12.345678901234567, 99.999999999999,
                  666.6666666666666, -666.6666666666666, 999.123456789012, -999.123456789012,
                  0.000123456789012345, 1234.5678901234, 55.5555555555555, -5.5, 7.000000000001]
        generator = random.Random(20261001)
        for _ in range(240):
            magnitude = 10.0 ** generator.uniform(-9, 9)
            values.append(generator.choice((-1, 1)) * magnitude * generator.random())
        for _ in range(60):
            values.append(round(generator.uniform(-2000, 2000), generator.randint(0, 6)))
        box = bd.Solid.make_box(1, 1, 1)
        children = []
        for index in range(0, len(values), 3):
            x, y, z = (values[index:index + 3] + [0.0, 0.0])[:3]
            placed = box.moved(bd.Location((x, y, z)))
            placed.label = f"p{index}"
            children.append(placed)
        step = Path(scratch.name) / "points.step"
        with mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(Path(scratch.name) / "store")}):
            export_build123d_step_file(bd.Compound(children=children, label="points"), step)
            scene = load_step_scene(step)
        mismatches = []
        for node, index in zip(scene.roots[0].children, range(0, len(values), 3)):
            expected = (values[index:index + 3] + [0.0, 0.0])[:3]
            for value, read in zip(expected, (node.transform[3], node.transform[7], node.transform[11])):
                emulated = written_real(value)
                if emulated != read or math.copysign(1, emulated) != math.copysign(1, read):
                    mismatches.append((value, emulated, read))
        self.assertEqual(mismatches, [])


if __name__ == "__main__":
    unittest.main()
