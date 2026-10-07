"""A clip sampled into glTF node animation (`cadgen glb build --animation`).

The interpolation is the viewer's (`common/animationRuntime.js`), so these pin it
where an error would be a file that plays the wrong motion: a constant spin is
exact, a pivot carries its translation, a looping clip wraps and one that does
not holds. Then what the sampler makes of a clip -- the schedule, the shared
time line, the rest pose, one hemisphere per track, the effects glTF cannot
animate refused or baked by name -- and one real document exported end to end.
"""

from __future__ import annotations

import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadgen/src")

from cadgen._internal.glb_animation import (  # noqa: E402
    FramePlan,
    evaluate_clip,
    find_clip,
    resolve_frame_plan,
    restrict_to_nodes,
    sample_clip,
)

REPO = Path(__file__).resolve().parents[4]
HALF_PI = math.pi / 2


def spin_key(degrees: float, rate_degrees: float = 90.0) -> list[float]:
    """A transform key turned ``degrees`` about +Z, spinning at ``rate_degrees``/s."""
    half = math.radians(degrees) / 2
    return [0, 0, 0, 0, 0, math.sin(half), math.cos(half), 0, 0, 0, 0, 0, math.radians(rate_degrees)]


def spin_clip(*, duration: int = 4, loop: bool = True, pivot=(0.0, 0.0, 0.0), extra=()) -> dict:
    """``o1.2`` spins about +Z at 90 degrees a second for the whole clip, keyed every
    second as a bake keys it: kept keys never turn more than 120 degrees apart."""
    track = {"targets": ["o1.2"], "times": list(range(duration + 1)), "pivot": list(pivot),
             "transform": [spin_key(90 * second) for second in range(duration + 1)]}
    return {"id": "spin", "label": "Spin", "duration": duration, "loop": loop, "tracks": [track, *extra]}


class TheSchedule(unittest.TestCase):
    def test_a_clip_supplies_the_span_a_request_leaves_out(self):
        self.assertEqual(FramePlan(30, 4.0, 0.0, 120), resolve_frame_plan({"fps": 30}, spin_clip()))
        # What is LEFT of a clip that stops, a whole cycle of one that loops.
        self.assertEqual(90, resolve_frame_plan({"fps": 30, "start": 1}, spin_clip(loop=False)).frame_count)
        self.assertEqual(120, resolve_frame_plan({"fps": 30, "start": 1}, spin_clip()).frame_count)
        # Rounded half up, the snapshot video's arithmetic.
        self.assertEqual(3, resolve_frame_plan({"fps": 2, "seconds": 1.25}, spin_clip()).frame_count)

    def test_a_span_the_clip_cannot_fill_is_refused_or_named(self):
        with self.assertRaisesRegex(ValueError, "start 4s is at or past the end of a 4s clip"):
            resolve_frame_plan({"fps": 30, "start": 4}, spin_clip())
        with self.assertRaisesRegex(ValueError, "7201 frames, past the 7200-frame ceiling"):
            resolve_frame_plan({"fps": 1, "seconds": 7201}, spin_clip())
        plan = resolve_frame_plan({"fps": 10, "seconds": 5}, spin_clip(loop=False))
        self.assertEqual(("animation covers 0s..5s of a 4s clip that does not loop: every frame past its "
                          "end is the same final pose",), plan.warnings)
        self.assertEqual((), resolve_frame_plan({"fps": 10, "seconds": 5}, spin_clip()).warnings)


class TheRuntimesInterpolation(unittest.TestCase):
    def test_a_constant_spin_is_exact_between_its_keys(self):
        poses, _styles = evaluate_clip(spin_clip(), 0.5)
        x, y, z, w = poses["o1.2"].quaternion
        self.assertAlmostEqual(math.sin(math.radians(22.5)), z, places=12)
        self.assertAlmostEqual(math.cos(math.radians(22.5)), w, places=12)
        self.assertEqual((0.0, 0.0), (x, y))

    def test_a_pivot_is_carried_as_the_translation_it_implies(self):
        poses, _styles = evaluate_clip(spin_clip(pivot=(10.0, 0.0, 0.0)), 1.0)
        tx, ty, tz = poses["o1.2"].translation  # 90 degrees about (10, 0, 0)
        self.assertAlmostEqual(10.0, tx, places=9)
        self.assertAlmostEqual(-10.0, ty, places=9)
        self.assertAlmostEqual(0.0, tz, places=12)

    def test_a_looping_clip_wraps_and_one_that_does_not_holds_its_end(self):
        wrapped, _ = evaluate_clip(spin_clip(), 5.0)
        held, _ = evaluate_clip(spin_clip(loop=False), 5.0)
        self.assertAlmostEqual(math.sin(math.radians(45)), wrapped["o1.2"].quaternion[2], places=12)
        self.assertAlmostEqual(math.sin(math.radians(180)), held["o1.2"].quaternion[2], places=12)

    def test_appearance_lerps_or_holds_and_null_is_the_rest_state(self):
        clip = spin_clip(extra=[
            {"targets": ["o1.1"], "times": [0, 4], "opacity": [1, 0]},
            {"targets": ["o1.3"], "times": [0, 2], "visible": [True, False]},
            {"targets": ["o1.4"], "times": [0], "opacity": [None]},
        ])
        _poses, styles = evaluate_clip(clip, 1.0)
        self.assertEqual({"o1.1": {"opacity": 0.75}, "o1.3": {"visible": True}}, styles)
        _poses, styles = evaluate_clip(clip, 3.0)
        self.assertEqual(False, styles["o1.3"]["visible"])


class TheSampler(unittest.TestCase):
    def test_tracks_share_one_rebased_time_line_and_stay_in_one_hemisphere(self):
        # Two full turns: a quaternion revisits -q, and the samples must not.
        sampled = sample_clip(spin_clip(duration=8, loop=False), FramePlan(4, 8.0, 0.0, 32))
        self.assertEqual([index / 4 for index in range(32)], sampled.times)
        (channel,) = sampled.channels
        self.assertEqual({"node", "rotation"}, set(channel))
        rotations = channel["rotation"]
        for index in range(4, len(rotations), 4):
            dot = sum(a * b for a, b in zip(rotations[index - 4:index], rotations[index:index + 4]))
            self.assertGreater(dot, 0, f"sample {index // 4} flipped hemisphere")
        # glTF is Y-up: CAD +Z is glTF +Y, so the spin is about +Y.
        self.assertAlmostEqual(math.sin(math.radians(45)), abs(rotations[4 * 4 + 1]), places=6)
        self.assertEqual({"translation": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0], "scale": None},
                         sampled.rest["o1.2"])

    def test_a_translation_is_metres_in_the_y_up_frame(self):
        clip = {"id": "lift", "label": "Lift", "duration": 1, "loop": False, "tracks": [{
            "targets": ["o1.1"], "times": [0, 1], "pivot": [0, 0, 0],
            "transform": [[0, 0, 0, 0, 0, 0, 1] + [0] * 6, [0, 10, 20, 0, 0, 0, 1] + [0] * 6]}]}
        sampled = sample_clip(clip, resolve_frame_plan({"fps": 2, "seconds": 1.5}, clip))
        (channel,) = sampled.channels
        # The last sample is past the end of a clip that holds: the final pose, (x, z, -y) m.
        self.assertEqual([0.0, 0.02, -0.01], [round(value, 6) for value in channel["translation"][-3:]])
        self.assertNotIn("rotation", channel)

    def test_an_occurrence_that_never_moves_gets_no_channel_and_a_constant_offset_only_a_rest_pose(self):
        held = {"targets": ["o1.3"], "times": [0], "pivot": [0, 0, 0], "transform": [spin_key(90, 0)]}
        still = {"targets": ["o1.4"], "times": [0], "pivot": [0, 0, 0], "transform": [spin_key(0, 0)]}
        sampled = sample_clip(spin_clip(extra=[held, still]), FramePlan(10, 1.0, 0.0, 10))
        self.assertEqual(["o1.2"], [channel["node"] for channel in sampled.channels])
        self.assertIn("o1.3", sampled.rest)
        self.assertNotIn("o1.4", sampled.rest)
        self.assertAlmostEqual(math.sin(math.radians(45)), sampled.rest["o1.3"]["rotation"][1], places=6)

    def test_an_effect_gltf_cannot_animate_is_refused_unless_dropped_then_baked_at_start(self):
        clip = spin_clip(extra=[
            {"targets": ["o1.1"], "times": [0, 4], "opacity": [0.5, 1]},
            {"targets": ["o1.2", "o1.3"], "times": [0, 1], "visible": [False, True]},
        ])
        plan = FramePlan(10, 1.0, 0.0, 10)
        with self.assertRaisesRegex(ValueError, r'animates \.opacity\(\) on o1\.1.*drop: \["opacity"\]'):
            sample_clip(clip, plan)
        with self.assertRaisesRegex(ValueError, r"animates \.visible\(\) on o1\.2, o1\.3"):
            sample_clip(clip, plan, drop=["opacity"])
        sampled = sample_clip(clip, plan, drop=["opacity", "visible"])
        self.assertEqual({"o1.1": 0.5}, sampled.opacity)
        self.assertEqual({"o1.2", "o1.3"}, sampled.hidden)
        # Hidden at start is not in the file, so its motion goes too -- by name.
        self.assertEqual([], sampled.channels)
        self.assertEqual(3, len(sampled.warnings))
        self.assertIn("o1.2 moves in this clip and is hidden at start", sampled.warnings[2])

    def test_a_channel_for_an_occurrence_with_no_geometry_is_dropped_by_name(self):
        sampled = sample_clip(spin_clip(), FramePlan(10, 1.0, 0.0, 10))
        self.assertIs(sampled, restrict_to_nodes(sampled, {"o1.2"}))
        narrowed = restrict_to_nodes(sampled, {"o1.1"})
        self.assertEqual([], narrowed.channels)
        self.assertEqual({}, narrowed.rest)
        self.assertIn("o1.2 moves in this clip but has no geometry in the export", narrowed.warnings[-1])

    def test_a_clip_is_found_by_id_or_refused_with_the_ones_there_are(self):
        animation = {"clips": [spin_clip()]}
        self.assertEqual("spin", find_clip(animation, "spin")["id"])
        with self.assertRaisesRegex(ValueError, "Unknown animation clip: spun. This model declares: spin"):
            find_clip(animation, "spun")


MODEL = textwrap.dedent("""\
    import cadgen
    from cadgen import build123d as bd
    from cadgen import step


    def turn(t, m):
        m.get("#lever").rotate((0, 0, 1), 90 * t)


    @step(out="arm.step", animation={"turn": cadgen.clip(turn, duration=1, loop=False, fps=10)})
    def arm():
        base = bd.Box(10, 10, 2)
        base.label = "base"
        lever = bd.Pos(10, 0, 3) * bd.Box(20, 2, 2)
        lever.label = "lever"
        return bd.Compound(children=[base, lever], label="assembly")


    if __name__ == "__main__":
        arm()
    """)


class ARealDocumentPlaysItsClip(unittest.TestCase):
    """The door end to end: a built document's clip, through the store's meshes, into a GLB."""

    def test_the_exported_file_moves_the_part_the_clip_moves(self):
        with tempfile.TemporaryDirectory(prefix="glb-animation-") as folder:
            root = Path(folder).resolve()
            (root / "arm.py").write_text(MODEL, encoding="utf-8")
            env = {**os.environ, "CADGEN_DAEMON": "0", "CADGEN_COMPONENT_WORKERS": "1",
                   "CADGEN_CACHE_DIR": str(root / "store"), "PYTHONPATH": str(REPO / "packages/cadgen/src")}

            def run(*argv: str) -> subprocess.CompletedProcess:
                proc = subprocess.run([sys.executable, *argv], cwd=root, env=env, capture_output=True,
                                      text=True, timeout=600)
                self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
                return proc

            run("arm.py")
            door = run("-m", "cadgen.cli", "glb", "build", "arm.step", "arm-turn.glb", "--animation",
                       json.dumps({"clip": "turn", "fps": 10}), "--json")
            (entry,) = json.loads(door.stdout.strip().splitlines()[-1])["files"]
            self.assertEqual({"clip": "turn", "fps": 10, "samples": 10, "seconds": 1.0, "start": 0.0},
                             {key: entry["animation"][key] for key in ("clip", "fps", "samples", "seconds", "start")})

            data = (root / "arm-turn.glb").read_bytes()
            length = struct.unpack_from("<I", data, 12)[0]
            gltf = json.loads(data[20:20 + length])
            binary = data[28 + length:]
            names = {node["name"]: index for index, node in enumerate(gltf["nodes"])}
            self.assertEqual({"base", "lever"}, set(names))
            self.assertTrue(all(node["extras"]["cadOccurrenceId"].startswith("o1.") for node in gltf["nodes"]))
            (clip,) = gltf["animations"]
            rotation = [channel for channel in clip["channels"] if channel["target"]["path"] == "rotation"]
            self.assertEqual([names["lever"]], [channel["target"]["node"] for channel in rotation])
            output = gltf["accessors"][clip["samplers"][rotation[0]["sampler"]]["output"]]
            view = gltf["bufferViews"][output["bufferView"]]
            values = struct.unpack_from(f"<{output['count'] * 4}f", binary, view["byteOffset"])
            # The last sample is 0.9 s in: 81 degrees about CAD +Z, which is glTF +Y.
            x, y, z, w = values[-4:]
            self.assertAlmostEqual(math.sin(math.radians(40.5)), abs(y), places=4)
            self.assertAlmostEqual(math.cos(math.radians(40.5)), abs(w), places=4)
            self.assertLess(max(abs(x), abs(z)), 1e-4)


if __name__ == "__main__":
    unittest.main()
