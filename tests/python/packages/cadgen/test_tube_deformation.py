"""cadgen's headless tube deformation is the runtime's (`common/tubeDeformation.js`).

A GLB morph bake (`tube_morph`) poses a clip's tubes with this module, and a file
is only right if every pose is the one the CAD Viewer draws. The parity fixture
beside the JavaScript holds rest meshes, rest paths and poses -- a bend, a twist,
an S, a spring's mapped keys and the blend between two of them, a pinch -- and
what the runtime's headless half makes of them; its own test pins the JavaScript
half against the same file. Then what both refuse, in the runtime's words and in
its order.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadgen/src")

from cadgen._internal import tube_deformation as td  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[4] / "packages" / "core" / "src" / "common" / "tubeDeformation.parity.json"
LINE = {"normal": [0.0, 0.0, 1.0], "segments": [{"kind": "line", "start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 0.0]}]}


def _case_deformations(case: dict) -> list[td.Deformation]:
    out: list[td.Deformation] = []
    for pose in case["poses"]:
        spec = {"rest": case["rest"], "path": pose["path"], "twistDeg": pose["twistDeg"],
                "maxSegmentLength": case["maxSegmentLength"], "mapsRest": bool(pose.get("mapsRest"))}
        if pose.get("between"):
            between = pose["between"]
            spec["between"] = (out[between["from"]], out[between["to"]], between["u"])
        out.append(td.normalize_tube_deformation(spec))
    return out


def _probe(path: td.Path) -> np.ndarray:
    length = path.length
    frames = td.sample_frames(path, np.array([-1, 0, 0.137 * length, 0.5 * length, 0.77 * length, length, length + 1.5]))
    return np.hstack([frames.point, frames.tangent, frames.normal, frames.binormal, frames.curvature]).reshape(-1)


def _mesh(case: dict) -> td.RestMesh:
    return td.RestMesh(np.array(case["mesh"]["positions"], dtype=np.float32).reshape(-1, 3),
                       np.array(case["mesh"]["normals"], dtype=np.float32).reshape(-1, 3),
                       np.array(case["mesh"]["indices"], dtype=np.uint32))


class TheRuntimesPoses(unittest.TestCase):
    def assertClose(self, got, want, tolerance: float, where: str) -> None:
        got = np.asarray(got, dtype=np.float64).reshape(-1)
        want = np.asarray(want, dtype=np.float64).reshape(-1)
        self.assertEqual(want.shape, got.shape, where)
        worst = float(np.max(np.abs(got - want))) if want.size else 0.0
        self.assertLessEqual(worst, tolerance, where)

    def test_every_case_refines_maps_samples_and_poses_as_the_runtime_does(self):
        parity = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertTrue(any(pose.get("between") for case in parity["cases"] for pose in case["poses"]))
        for case in parity["cases"]:
            with self.subTest(case=case["name"]):
                compiled = [td.compile_deformation(deformation) for deformation in _case_deformations(case)]
                prepared = td.prepare_tube_bake(_mesh(case), compiled[0])
                want = case["expected"]
                # The topology is exact: one band boundary misplaced is a different mesh.
                self.assertEqual(want["refined"]["indices"], prepared.mesh.indices.tolist())
                self.assertEqual(want["refined"]["sourceTriangles"], prepared.mesh.source_triangles.tolist())
                self.assertEqual(want["mapping"]["slots"], prepared.mapping.slots.tolist())
                # The fixture keeps eight digits of float32 data and twelve of float64.
                self.assertClose(prepared.mesh.positions, want["refined"]["positions"], 5e-6, "refined positions")
                self.assertClose(prepared.mesh.normals, want["refined"]["normals"], 1e-7, "refined normals")
                self.assertClose(prepared.mapping.values, want["mapping"]["values"], 1e-9, "mapping")
                frames = [_probe(compiled[0].rest), *(_probe(deformation.path) for deformation in compiled)]
                for index, (got, expected) in enumerate(zip(frames, want["frames"])):
                    self.assertClose(got, expected, 1e-9, f"frames {index}")
                for index, (deformation, expected) in enumerate(zip(compiled, want["poses"])):
                    positions, normals = td.pose_tube_bake(prepared, deformation)
                    self.assertClose(positions, expected["positions"], 5e-6, f"pose {index} positions")
                    self.assertClose(normals, expected["normals"], 1e-7, f"pose {index} normals")


def _refusal(path: dict) -> str:
    try:
        td.compile_tube_path(path)
    except td.TubeDeformationError as error:
        return str(error)
    raise AssertionError("compiled a path the runtime refuses")


def _line(start, end) -> dict:
    return {"kind": "line", "start": list(start), "end": list(end)}


class WhatTheRuntimeRefuses(unittest.TestCase):
    def test_a_path_names_its_frame_and_its_closed_vocabulary(self):
        self.assertEqual(
            "tube deformation: path normal is required: give both the rest and the posed path an explicit "
            "transverse normal seed",
            _refusal({"segments": LINE["segments"]}))
        self.assertEqual("tube deformation: path normal transverse to first tangent must be nonzero",
                         _refusal({**LINE, "normal": [1.0, 0.0, 0.0]}))
        self.assertEqual('tube deformation: unknown segment kind "spline"; expected line, arc, bezier',
                         _refusal({**LINE, "segments": [{"kind": "spline"}]}))
        self.assertEqual('tube deformation: unknown segment 0 key "radius"; expected kind, start, end',
                         _refusal({**LINE, "segments": [{**LINE["segments"][0], "radius": 2}]}))
        self.assertEqual("tube deformation: arc sweepDeg must be nonzero and at most 360 degrees", _refusal({
            **LINE, "segments": [{"kind": "arc", "center": [0, 5, 0], "axis": [0, 0, 1], "start": [0, 0, 0], "sweepDeg": 400}]}))
        # A cusp where no split lands is found unresolved at the deepest split; one at
        # t = 1/2, where a split lands, is a zero tangent -- as the runtime finds them.
        self.assertEqual("tube deformation: Bezier has a cusp or unresolved tangent", _refusal({
            **LINE, "segments": [{"kind": "bezier", "points": [[0, 0, 0], [1, 1, 0], [0, 1, 0], [0, -3, 0]]}]}))
        self.assertEqual("tube deformation: Bezier tangent must be nonzero", _refusal({
            **LINE, "segments": [{"kind": "bezier", "points": [[0, 0, 0], [1, 1, 0], [0, 1, 0], [1, 0, 0]]}]}))

    def test_segments_meet_end_to_end_and_tangent_to_tangent(self):
        self.assertEqual("tube deformation: path discontinuity before segment 1",
                         _refusal({**LINE, "segments": [_line((0, 0, 0), (10, 0, 0)), _line((11, 0, 0), (20, 0, 0))]}))
        self.assertEqual("tube deformation: path is not tangent-continuous before segment 1",
                         _refusal({**LINE, "segments": [_line((0, 0, 0), (10, 0, 0)), _line((10, 0, 0), (10, 10, 0))]}))

    def test_the_first_failure_in_the_runtimes_order_is_the_one_reported(self):
        # The runtime walks the segments in order: the gap before segment 1 is met
        # before segment 2 is ever read, however wrong segment 2 is.
        self.assertEqual("tube deformation: path discontinuity before segment 1", _refusal({**LINE, "segments": [
            _line((0, 0, 0), (10, 0, 0)), _line((11, 0, 0), (20, 0, 0)), {"kind": "spline"}]}))

    def test_a_deformation_bounds_its_bands_and_its_braid(self):
        with self.assertRaisesRegex(td.TubeDeformationError, "maxSegmentLength must be at least 0.05 mm"):
            td.normalize_tube_deformation({"rest": LINE, "path": LINE, "maxSegmentLength": 0.01})
        with self.assertRaisesRegex(td.TubeDeformationError, "an even strand count from 2 to 64"):
            td.normalize_tube_deformation({"rest": LINE, "path": LINE, "braid": {"pitch": 1, "depth": 0, "strands": 3}})
        with self.assertRaisesRegex(td.TubeDeformationError, 'unknown deformation key "rest_path"'):
            td.normalize_tube_deformation({"rest_path": LINE, "path": LINE})

    def test_deformations_compare_by_value(self):
        a = td.normalize_tube_deformation({"rest": LINE, "path": LINE, "twistDeg": 10})
        b = td.normalize_tube_deformation({"rest": json.loads(json.dumps(LINE)), "path": LINE, "twistDeg": 10})
        self.assertTrue(td.same_tube_deformation(a, b))
        self.assertFalse(td.same_tube_deformation(a, td.normalize_tube_deformation({"rest": LINE, "path": LINE})))
        self.assertTrue(td.same_tube_rest_shape(a, td.normalize_tube_deformation({"rest": LINE, "path": LINE})))


class TheRestMesh(unittest.TestCase):
    """A straight tube: 1 mm round, 10 mm long, its mesh only the two end rings."""

    def setUp(self):
        sides = 8
        angle = np.arange(sides) * 2 * np.pi / sides
        ring = np.stack([np.zeros(sides), np.cos(angle), np.sin(angle)], axis=1)
        positions = np.vstack([ring, ring + [10.0, 0.0, 0.0]])
        normals = np.vstack([ring, ring])
        indices = []
        for k in range(sides):
            a, b = k, (k + 1) % sides
            indices += [a, b, b + sides, a, b + sides, a + sides]
        self.mesh = td.RestMesh(positions.astype(np.float32), normals.astype(np.float32), np.array(indices, dtype=np.uint32))

    def test_a_long_triangle_is_split_into_bands_of_rest_arc_length(self):
        rest = td.compile_tube_path(LINE)
        refined = td.refine_rest_mesh(self.mesh, rest, 1.0)
        # Ten bands, each carrying every side, and every refined triangle names its source.
        self.assertGreaterEqual(len(refined.indices) // 3, 10 * 16)
        distances = td.project_distances(rest, refined.positions.astype(np.float64))
        self.assertEqual(set(np.round(np.unique(np.round(distances, 6)), 6)), {float(n) for n in range(11)})
        self.assertEqual(len(refined.indices) // 3, len(refined.source_triangles))
        # A band no shorter than the tube leaves it as it is.
        self.assertIsNone(td.refine_rest_mesh(self.mesh, rest, 10.0).source_triangles)

    def test_refinement_past_its_ceiling_and_a_mesh_past_the_bend_are_refused(self):
        rest = td.compile_tube_path(LINE)
        with mock.patch.object(td, "MAX_REFINED_TRIANGLES", 20), self.assertRaisesRegex(
                td.TubeDeformationError, "refined tube exceeds 20 triangles; increase maxSegmentLength"):
            td.refine_rest_mesh(self.mesh, rest, 1.0)
        # Bent tighter than the tube is round, the inside of the rest surface would cross
        # the centre of curvature.
        tight = {"normal": [0.0, 0.0, 1.0], "segments": [
            {"kind": "arc", "center": [0.0, 0.5, 0.0], "axis": [0.0, 0.0, 1.0], "start": [0.0, 0.0, 0.0], "sweepDeg": 90.0}]}
        with self.assertRaisesRegex(td.TubeDeformationError, "rest mesh crosses the centerline curvature radius"):
            td.mapping_for(self.mesh, td.compile_tube_path(tight))

    def test_posing_the_rest_on_itself_gives_the_rest_back(self):
        deformation = td.compile_deformation(td.normalize_tube_deformation({"rest": LINE, "path": LINE, "maxSegmentLength": 1.0}))
        prepared = td.prepare_tube_bake(self.mesh, deformation)
        positions, normals = td.pose_tube_bake(prepared, deformation)
        np.testing.assert_allclose(positions, prepared.mesh.positions, atol=1e-6)
        # A refined vertex's normal is its corners' interpolated, short of unit length; a
        # posed one is a direction.
        rest = prepared.mesh.normals.astype(np.float64)
        np.testing.assert_allclose(normals, rest / np.linalg.norm(rest, axis=1)[:, None], atol=1e-6)


if __name__ == "__main__":
    unittest.main()
