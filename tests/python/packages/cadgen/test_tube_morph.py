"""A clip's deforming tubes, baked into glTF morph targets (`deform: "morph"`).

Morph weights blend the RESULT of two poses while the clip rebuilds the path from
its own numbers, so a file is honest only where its targets were fitted: these
pin that the blend a player computes from the file stays within the requested
tolerance of the clip's own deformation, between keys as well as at them; that
the targets are one-hot and a motionless key costs none; what the bake refuses
before allocating a delta; and that the writer puts base, deltas and weights in
one space and refuses a file that would not.
"""

from __future__ import annotations

import json
import math
import struct
import unittest

import numpy as np

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadgen/src")

import cadgen  # noqa: E402
from cadgen._internal import glb_animation as ga  # noqa: E402
from cadgen._internal import tube_deformation as td  # noqa: E402
from cadgen._internal.animation_bake import animation_targets, bake_clip  # noqa: E402
from cadgen._internal.mesh_formats import (  # noqa: E402
    MorphTarget,
    Primitive,
    Tessellation,
    build_primitives,
    glb_bytes,
    occurrence_world_mesh,
)
from cadgen._internal.tube_morph import build_tube_morph_targets  # noqa: E402

# A cord, placed 5 mm up, and a post beside it.
DESCRIPTOR = {
    "components": {"cord": {"color": [0.8, 0.1, 0.1]}, "post": {}},
    "occurrences": [
        {"id": "o1.1", "component": "cord", "name": "cord",
         "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 0, 0, 0, 1]},
        {"id": "o1.2", "component": "post", "name": "post"},
    ],
    "assembly": {"root": {"id": "o1", "name": "rig", "children": [
        {"id": "o1.1", "name": "cord", "children": []}, {"id": "o1.2", "name": "post", "children": []}]}},
}
REST = {"normal": [0, 0, 1], "segments": [{"kind": "line", "start": [0, 0, 5], "end": [20, 0, 5]}]}


def _cord(sides: int = 12) -> Tessellation:
    """A 20 mm cord along +X, 1 mm round, meshed with its end rings only, in two colours."""
    angle = np.arange(sides) * 2 * np.pi / sides
    ring = np.stack([np.zeros(sides), np.cos(angle), np.sin(angle)], axis=1)
    positions = np.vstack([ring, ring + [20.0, 0.0, 0.0]])
    normals = np.vstack([ring, ring]) * [0.0, 1.0, 1.0]
    indices = []
    for k in range(sides):
        a, b = k, (k + 1) % sides
        indices += [a, b, b + sides, a, b + sides, a + sides]
    half = len(indices) // 2
    return Tessellation(positions.astype(np.float32), normals.astype(np.float32), np.array(indices, dtype=np.uint32),
                        [{"indexStart": 0, "indexCount": half, "color": [0.1, 0.6, 0.1]},
                         {"indexStart": half, "indexCount": len(indices) - half}])


def _post() -> Tessellation:
    positions = np.array([[x, y, z] for x in (30, 32) for y in (0, 2) for z in (0, 2)], dtype=np.float32)
    return Tessellation(positions, np.tile(np.array([[0, 0, 1]], dtype=np.float32), (8, 1)),
                        np.array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5], dtype=np.uint32),
                        [{"indexStart": 0, "indexCount": 12}])


TESSELLATIONS = {"cord": _cord(), "post": _post()}


def _arc(t: float) -> dict:
    """The cord curled from a fifth of a quarter circle to a whole one, keeping its length."""
    angle = (0.2 + 0.8 * t) * math.pi / 2
    return {"normal": [0, 0, 1], "segments": [{"kind": "arc", "center": [0, 20 / angle, 5], "axis": [0, 0, 1],
                                               "start": [0, 0, 5], "sweepDeg": math.degrees(angle)}]}


def _clip(update, duration: float = 1) -> dict:
    baked = bake_clip("bend", cadgen.clip(update, duration=duration, loop=False), animation_targets(DESCRIPTOR),
                      ((0, -2, 0), (32, 22, 7)), None)
    return {"id": "bend", **baked}


def bend(t, m):
    m.get("#cord").deform_tube(rest=REST, path=_arc(t), twist_deg=60 * t, max_segment_length=1.0)


def _bake(clip: dict, fps: int = 12, **options):
    plan = ga.resolve_frame_plan({"fps": fps}, clip)
    sampled = ga.sample_clip(clip, plan, deform="morph")
    return plan, sampled, build_tube_morph_targets(DESCRIPTOR, TESSELLATIONS, sampled.deformations,
                                                   grid=sampled.grid, clip_id="bend", **options)


class TheFileTracksTheClip(unittest.TestCase):
    def test_a_player_blending_the_targets_stays_within_the_tolerance_of_the_clips_own_tube(self):
        clip = _clip(bend)
        _plan, sampled, bake = _bake(clip, tolerance_mm=0.25)
        (channel,) = bake.channels
        times = np.array(channel["times"])
        weights = np.array(channel["weights"]).reshape(len(times), channel["targetCount"])
        self.assertLessEqual(bake.stats["deviationMm"], 0.25)
        # The exact poser, on the cord placed in the document, independently of the bake.
        positions, normals, triangles, _ranges = occurrence_world_mesh(DESCRIPTOR["occurrences"][0], TESSELLATIONS["cord"])
        first = sampled.deformations["o1.1"].rest
        prepared = td.prepare_tube_bake(td.RestMesh(positions, normals, triangles.reshape(-1)), td.compile_deformation(first))

        def exact(t: float) -> np.ndarray:
            bent = ga.evaluate_clip(clip, t)[2].get("o1.1")
            pose = first if bent is None else bent
            return td.pose_tube_bake(prepared, td.compile_deformation(pose), normals=False)[0].astype(np.float64)

        # Each file vertex IS a refined vertex: found by its base, the pose at time 0.
        base_rows = {row.tobytes(): index for index, row in enumerate(np.ascontiguousarray(exact(0.0).astype(np.float32)))}
        primitives = bake.overrides["o1.1"]
        self.assertEqual(2, len(primitives))  # one per colour the cord's faces resolve to
        located = [np.array([base_rows[row.tobytes()] for row in np.ascontiguousarray(primitive.positions)])
                   for primitive in primitives]

        def worst_at(t: float) -> float:
            k = min(max(int(np.searchsorted(times, t, side="right")) - 1, 0), len(times) - 2)
            alpha = (t - times[k]) / (times[k + 1] - times[k])
            w = weights[k] * (1 - alpha) + weights[k + 1] * alpha
            truth = exact(t)
            worst = 0.0
            for primitive, rows in zip(primitives, located):
                played = primitive.positions.astype(np.float64) + sum(
                    w[n] * target.position_deltas.astype(np.float64) for n, target in enumerate(primitive.targets))
                worst = max(worst, float(np.max(np.linalg.norm(played - truth[rows], axis=1))))
            return worst

        self.assertLess(max(worst_at(t) for t in times[:-1]), 1e-4)  # exact at every key
        # The fit's guarantee is its grid: every sample there, which every export frame is.
        grid = [index / sampled.grid.hz for index in range(sampled.grid.count)]
        between = [worst_at(t) for t in grid]
        self.assertLessEqual(max(between), 0.25 + 1e-3)
        self.assertGreater(max(between), 0.01)  # a real bend, not a held pose

    def test_targets_are_one_hot_and_a_key_that_does_not_move_costs_none(self):
        _plan, sampled, bake = _bake(_clip(bend), tolerance_mm=1.0)
        (channel,) = bake.channels
        rows = np.array(channel["weights"]).reshape(-1, channel["targetCount"])
        self.assertEqual(0.0, rows[0].sum())  # the first key is the base
        self.assertTrue(np.all((rows == 0) | (rows == 1)) and np.all(rows.sum(axis=1) <= 1))
        self.assertEqual(sampled.grid.hz * np.array(channel["times"], dtype=np.float32)[-1],
                         np.float32(sampled.grid.count - 1))
        self.assertEqual(channel["targetCount"], len(bake.overrides["o1.1"][0].targets))

    def test_a_tube_the_clip_holds_bent_ships_bent_and_moves_nothing(self):
        def held(t, m):
            m.get("#cord").deform_tube(rest=REST, path=_arc(0.5), max_segment_length=1.0)

        _plan, _sampled, bake = _bake(_clip(held))
        self.assertEqual([], bake.channels)
        primitives = bake.overrides["o1.1"]
        self.assertTrue(all(primitive.targets is None for primitive in primitives))
        # Bent, not the rest: the far end has swung off the line.
        self.assertGreater(max(float(np.abs(primitive.positions[:, 1]).max()) for primitive in primitives), 5.0)


class WhatTheBakeRefusesOrSays(unittest.TestCase):
    def test_the_playback_ceiling_refuses_before_a_delta_is_built(self):
        with self.assertRaisesRegex(ValueError, r"clip bend needs \d+ morph targets over 1 tubes .* of morph texture at "
                                                r"playback — past the 0.0 MiB ceiling"):
            _bake(_clip(bend), max_runtime_bytes=1024)

    def test_a_tube_that_barely_turns_leaves_its_normals_out(self):
        def stretch(t, m):
            m.get("#cord").deform_tube(rest=REST, max_segment_length=2.0, path={"normal": [0, 0, 1], "segments": [
                {"kind": "line", "start": [0, 0, 5], "end": [20 + 4 * t, 0, 5]}]})

        _plan, _sampled, bake = _bake(_clip(stretch))
        self.assertEqual(["o1.1"], bake.stats["normalsOmitted"])
        self.assertIn("o1.1 turns by less than 5° over this clip, so its morph targets carry positions only", bake.warnings[0])
        self.assertTrue(all(target.normal_deltas is None for primitive in bake.overrides["o1.1"] for target in primitive.targets))

    def test_a_deforming_occurrence_that_meshed_to_nothing_is_named(self):
        plan = ga.resolve_frame_plan({"fps": 12}, clip := _clip(bend))
        sampled = ga.sample_clip(clip, plan, deform="morph")
        empty = Tessellation(np.zeros((0, 3), np.float32), np.zeros((0, 3), np.float32), np.zeros(0, np.uint32), [])
        bake = build_tube_morph_targets(DESCRIPTOR, {**TESSELLATIONS, "cord": empty}, sampled.deformations,
                                        grid=sampled.grid, clip_id="bend")
        self.assertEqual({}, bake.overrides)
        self.assertEqual(["o1.1 deforms in this clip but tessellated to nothing, so the file carries no geometry to "
                          "morph for it"], bake.warnings)


def _parse(data: bytes) -> tuple[dict, bytes]:
    length = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20:20 + length]), data[28 + length:]


def _floats(gltf: dict, binary: bytes, accessor: int) -> np.ndarray:
    entry = gltf["accessors"][accessor]
    width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[entry["type"]]
    view = gltf["bufferViews"][entry["bufferView"]]
    return np.frombuffer(binary, "<f4", entry["count"] * width, view["byteOffset"]).reshape(entry["count"], width)


class TheWriter(unittest.TestCase):
    def setUp(self):
        def bend_and_lift(t, m):
            bend(t, m)
            m.get("#cord").translate((0, 0, 3 * t))

        _plan, self.sampled, self.bake = _bake(_clip(bend_and_lift), tolerance_mm=0.5)
        self.primitives = build_primitives(DESCRIPTOR, TESSELLATIONS, per_occurrence=True, overrides=self.bake.overrides)

    def test_targets_default_weights_and_the_weights_channel_land_on_the_cords_node(self):
        clip = ga.with_morph_channels(self.sampled, self.bake.channels)
        gltf, binary = _parse(glb_bytes(self.primitives, name="rig", animation=clip.gltf()))
        node = next(index for index, entry in enumerate(gltf["nodes"]) if entry["name"] == "cord")
        mesh = gltf["meshes"][gltf["nodes"][node]["mesh"]]
        (channel,) = self.bake.channels
        count = channel["targetCount"]
        self.assertEqual([0.0] * count, mesh["weights"])
        for primitive in mesh["primitives"]:
            self.assertEqual(count, len(primitive["targets"]))
            self.assertEqual({"POSITION", "NORMAL"}, set(primitive["targets"][0]))
            deltas = _floats(gltf, binary, primitive["targets"][0]["POSITION"])
            accessor = gltf["accessors"][primitive["targets"][0]["POSITION"]]
            self.assertEqual(deltas.min(axis=0).tolist(), accessor["min"])
            self.assertEqual(deltas.max(axis=0).tolist(), accessor["max"])
        (animation,) = gltf["animations"]
        on_cord = [(entry["target"]["path"], animation["samplers"][entry["sampler"]])
                   for entry in animation["channels"] if entry["target"]["node"] == node]
        # By node, then the node's transform before its weights.
        self.assertEqual(["translation", "weights"], [path for path, _sampler in on_cord])
        weights = on_cord[1][1]
        self.assertEqual(len(channel["times"]), gltf["accessors"][weights["input"]]["count"])
        self.assertEqual(len(channel["times"]) * count, gltf["accessors"][weights["output"]]["count"])

    def test_deltas_in_the_wrong_space_fail_the_reconstruction_check(self):
        primitive = next(primitive for primitive in self.primitives if primitive.targets)
        primitive.targets[0] = MorphTarget(primitive.targets[0].position_deltas[:, [0, 2, 1]], primitive.targets[0].normal_deltas)
        with self.assertRaisesRegex(ValueError, "base and deltas are not in the same space"):
            glb_bytes(self.primitives, name="rig")

    def test_one_node_cannot_mix_target_counts_and_a_channel_must_match_its_mesh(self):
        cord = [primitive for primitive in self.primitives if primitive.node == "o1.1"]
        cord[1].targets, cord[1].check = None, None
        with self.assertRaisesRegex(ValueError, "glTF weights are per mesh"):
            glb_bytes(self.primitives, name="rig")
        lonely = Primitive(color="#ffffff", positions=np.zeros((3, 3), np.float32), normals=np.zeros((3, 3), np.float32),
                           indices=np.array([0, 1, 2], np.uint32), node="n", name="n", occurrence_id="n")
        with self.assertRaisesRegex(ValueError, "declares 2 morph targets, but its mesh has 0"):
            glb_bytes([lonely], animation={"name": "c", "times": [0.0, 1.0], "rest": {}, "channels": [
                {"node": "n", "times": [0.0, 1.0], "weights": [0, 0, 1, 0], "targetCount": 2}]})


if __name__ == "__main__":
    unittest.main()
