"""A clip, sampled into glTF node animation: the GLB export's half of choreography.

The viewer and the video renderer DRIVE a clip: they evaluate its keyframes every
frame (``@text-to-cad/core`` ``common/animationRuntime.js``). A GLB carries no
evaluator, so an exported clip becomes data: per-occurrence translation and
rotation keyframes on one shared time line, sampled at the schedule
:func:`resolve_frame_plan` works out. The interpolation here is that runtime's,
step for step, so a file and the viewer agree about where a part is at each
sample. What maps, and how (the sidecar's channels, ``animation_bake``):

  transform  exact. Each key's pivot move ``d`` and the turn from the first key
             are cubic Hermite curves; the posed matrix is rigid, so it is carried
             into glTF's Y-up metres as a translation and a quaternion with no
             residue.
  opacity    glTF has no animated channel for it. Refused unless the request
             drops it, and then baked STATIC at ``start`` as a material alpha.
  visible    the same: refused, or dropped by leaving out what is hidden at start.
  tube       per-VERTEX motion, not a node transform. The request's ``deform``
             decides: refused by default, shipped at rest, or collected on a
             finer grid for ``tube_morph`` to bake into morph targets.

Pure: no filesystem, no kernel. A clip's tracks name document occurrence ids,
the same ids the export's per-occurrence nodes carry.
"""

from __future__ import annotations

import dataclasses
import math
import struct
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from cadgen._internal import tube_deformation as td
from cadgen._internal.animation_bake import _lerp_path, key_path
from cadgen._internal.mesh_animation import DEFORM_MODES, DROPPABLE_EFFECTS, MAX_ANIMATION_SAMPLES

# A matrix this close to identity in every element has not moved: slack enough for
# the trig of a full turn, far tighter than any motion worth a keyframe.
IDENTITY_EPSILON = 1e-12
# glTF is Y-up metres, a document Z-up millimetres: vertices go (x, y, z) ->
# (x, z, -y) times 1e-3 (mesh_formats), so a pose goes through the same change of
# basis, C M C^-1. The scale cancels in the rotation and survives in the
# translation: an occurrence that travels 40 mm travels 0.04 m.
CAD_TO_GLB_SCALE = 0.001
# How much finer than the export's own frame rate a morph bake MEASURES its fit.
# Morph weights interpolate the RESULT of two poses while the clip interpolates its
# own numbers and rebuilds the path from them, so the two agree only AT sampled
# instants, and a fit measured on the frame grid certifies nothing between frames,
# which is most of the playback. Four times finer bounds the residual between grid
# samples at about 1/16 of the one between neighbours (chord error falls as dt^2);
# the floor keeps an 8 fps preview from certifying itself on an 8 Hz grid.
MORPH_FIT_GRID_MULTIPLE = 4
MORPH_FIT_GRID_MIN_HZ = 96


def _seconds(value: float) -> str:
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return f"{text or '0'}s"


@dataclass(frozen=True)
class FramePlan:
    """The schedule a ``{fps, seconds, start}`` request implies over one clip."""

    fps: int
    seconds: float
    start: float
    frame_count: int
    warnings: tuple[str, ...] = ()

    def elapsed(self, index: float) -> float:
        """The moment of the CLIP that sample ``index`` falls on."""
        return self.start + index / self.fps


@dataclass(frozen=True)
class FitGrid:
    """The schedule a clip is evaluated on: the plan's frames, or under ``morph`` a
    whole multiple of them, so every export frame is a grid sample."""

    multiple: int
    hz: float
    count: int


def fit_grid(plan: FramePlan, deform: str) -> FitGrid:
    if deform != "morph":
        return FitGrid(1, plan.fps, plan.frame_count)
    multiple = max(MORPH_FIT_GRID_MULTIPLE, math.ceil(MORPH_FIT_GRID_MIN_HZ / plan.fps))
    return FitGrid(multiple, plan.fps * multiple, (plan.frame_count - 1) * multiple + 1)


def resolve_frame_plan(request: Mapping[str, Any], clip: Mapping[str, Any]) -> FramePlan:
    """``seconds`` defaults to the span the clip still HAS from ``start`` (a whole
    cycle for a looping clip), and the sample count is ``seconds * fps`` rounded,
    so the last sample sits one interval BEFORE ``start + seconds``: a looping
    clip's sample at its end is its sample at its start again, and baking both
    stutters on every repeat. The snapshot video renders the same span through
    the same arithmetic (``common/framePlan.js``)."""
    fps = int(request.get("fps", 30))
    start = float(request.get("start") or 0.0)
    duration = max(float(clip.get("duration") or 0.0), 0.001)
    if start >= duration:
        raise ValueError(
            f"animation start {_seconds(start)} is at or past the end of a {_seconds(duration)} clip: "
            "every frame would be the same one"
        )
    looping = clip.get("loop") is not False
    raw_seconds = request.get("seconds")
    seconds = (duration if looping else duration - start) if raw_seconds is None else float(raw_seconds)
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError(f"animation seconds must be a positive number, got {raw_seconds!r}")
    frame_count = max(1, math.floor(seconds * fps + 0.5))
    if frame_count > MAX_ANIMATION_SAMPLES:
        raise ValueError(
            f"animation {_seconds(seconds)} at {fps} fps schedules {frame_count} frames, "
            f"past the {MAX_ANIMATION_SAMPLES}-frame ceiling"
        )
    warnings = []
    # An explicit span that overruns a clip which does not loop is the caller's to
    # make, but every sample past the end is the final pose, and the file cannot say so.
    if not looping and (start + seconds) - duration > 1e-9:
        warnings.append(
            f"animation covers {_seconds(start)}..{_seconds(start + seconds)} of a {_seconds(duration)} "
            "clip that does not loop: every frame past its end is the same final pose"
        )
    return FramePlan(fps, seconds, start, frame_count, tuple(warnings))


# --- evaluating a clip (animationRuntime.js, step for step) ------------------------


def _bracket(times: Sequence[float], t: float) -> tuple[int, float]:
    """(index of the key at or before t, fraction of the way to the next key)"""
    last = len(times) - 1
    if t >= times[last]:
        return last, 0.0
    lo, hi = 0, last
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if times[mid] <= t:
            lo = mid
        else:
            hi = mid
    return lo, (t - times[lo]) / (times[hi] - times[lo])


def _qmul(a: Sequence[float], b: Sequence[float]) -> tuple[float, float, float, float]:
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def _norm(*values: float) -> float:
    total = 0.0
    for value in values:
        total += value * value
    return math.sqrt(total)


def _turn_vector(a: Sequence[float], b: Sequence[float]) -> tuple[float, float, float]:
    """The rotation vector (axis * radians, world frame) that turns ``a`` into ``b``."""
    x, y, z, w = _qmul(b, (-a[0], -a[1], -a[2], a[3]))
    if w < 0:
        x, y, z, w = -x, -y, -z, -w
    s = _norm(x, y, z)
    if s < 1e-12:
        return (2 * x, 2 * y, 2 * z)
    angle = 2 * math.atan2(s, w)
    return (x / s * angle, y / s * angle, z / s * angle)


def _turned(v: Sequence[float], q: Sequence[float]) -> tuple[float, float, float, float]:
    """``q`` turned further by the rotation vector ``v``."""
    angle = _norm(v[0], v[1], v[2])
    s = 0.5 if angle < 1e-12 else math.sin(angle / 2) / angle
    out = _qmul((v[0] * s, v[1] * s, v[2] * s, math.cos(angle / 2)), q)
    n = _norm(*out)
    return (out[0] / n, out[1] / n, out[2] / n, out[3] / n)


def _transform_pose(a: Sequence[float], b: Sequence[float], span: float, u: float):
    u2 = u * u
    u3 = u2 * u
    h00 = 2 * u3 - 3 * u2 + 1
    h10 = u3 - 2 * u2 + u
    h01 = 3 * u2 - 2 * u3
    h11 = u3 - u2
    turn = _turn_vector(a[3:7], b[3:7])
    d = [h00 * a[n] + h10 * span * a[7 + n] + h01 * b[n] + h11 * span * b[7 + n] for n in range(3)]
    v = [h10 * span * a[10 + n] + h01 * turn[n] + h11 * span * b[10 + n] for n in range(3)]
    return d, _turned(v, a[3:7])


@dataclass(frozen=True)
class _Pose:
    rotation: tuple  # row-major 3x3
    translation: tuple
    quaternion: tuple  # (x, y, z, w), unit

    def is_identity(self) -> bool:
        identity = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
        return (all(abs(value - expected) <= IDENTITY_EPSILON for value, expected in zip(self.rotation, identity))
                and all(abs(value) <= IDENTITY_EPSILON for value in self.translation))


def _transform_at(track: Mapping[str, Any], index: int, u: float) -> _Pose:
    key = track["transform"][index]
    if u > 0:
        d, q = _transform_pose(key, track["transform"][index + 1], track["times"][index + 1] - track["times"][index], u)
    else:
        d, q = key[0:3], key[3:7]
    n = _norm(q[0], q[1], q[2], q[3])
    x, y, z, w = q[0] / n, q[1] / n, q[2] / n, q[3] / n
    r = (
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    )
    px, py, pz = track["pivot"]
    t = tuple(
        track["pivot"][axis] + d[axis] - (r[axis * 3] * px + r[axis * 3 + 1] * py + r[axis * 3 + 2] * pz)
        for axis in range(3)
    )
    return _Pose(r, t, (x, y, z, w))


def _same_path_shape(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    return len(a["segments"]) == len(b["segments"]) and all(
        one["kind"] == other["kind"] for one, other in zip(a["segments"], b["segments"]))


class TubeKeys:
    """Each tube key's deformation, normalized once per clip: a tube that holds
    between moves costs nothing per sample, and one between two keys blends theirs.
    Every deformation of one track shares its one canonical rest."""

    def __init__(self) -> None:
        self._keys: dict[tuple[int, int], tuple[Mapping, td.Deformation]] = {}
        self._rests: dict[int, tuple[Mapping, dict]] = {}

    def rest(self, track: Mapping[str, Any]) -> dict:
        found = self._rests.get(id(track))
        if found is None or found[0] is not track:
            found = self._rests[id(track)] = (track, td.canonical_path_spec(track["rest"]))
        return found[1]

    def deformation(self, track: Mapping[str, Any], index: int) -> td.Deformation:
        found = self._keys.get((id(track), index))
        if found is None or found[0] is not track:
            key = track["tube"][index]
            deformation = td.normalize_tube_deformation({
                "rest": track["rest"], "maxSegmentLength": track["maxSegmentLength"],
                **({"braid": track["braid"]} if track.get("braid") else {}),
                "path": key_path(track["rest"], key["path"]), "twistDeg": key["twistDeg"],
                "mapsRest": "map" in key["path"],
            }, rest_spec=self.rest(track))
            found = self._keys[(id(track), index)] = (track, deformation)
        return found[1]


def _tube_at(track: Mapping[str, Any], index: int, u: float, keys: TubeKeys) -> td.Deformation | None:
    """A tube track's deformation, or None at rest. Between two keys of one shape
    every number lerps; otherwise, and up to a rest key, the earlier key holds.
    Between two keys that map the rest, the path compiles from their tables."""
    a = track["tube"][index]
    if a is None:
        return None
    b = track["tube"][index + 1] if u > 0 else None
    frm = key_path(track["rest"], a["path"])
    to = key_path(track["rest"], b["path"]) if b is not None else None
    if to is None or not _same_path_shape(frm, to):
        return keys.deformation(track, index)
    between = ((keys.deformation(track, index), keys.deformation(track, index + 1), u)
               if "map" in a["path"] and "map" in b["path"] else None)
    return td.normalize_tube_deformation({
        "rest": track["rest"], "maxSegmentLength": track["maxSegmentLength"],
        **({"braid": track["braid"]} if track.get("braid") else {}),
        "path": _lerp_path(frm, to, u), "twistDeg": a["twistDeg"] + (b["twistDeg"] - a["twistDeg"]) * u,
        **({"between": between} if between else {}),
    }, rest_spec=keys.rest(track))


def evaluate_clip(
    clip: Mapping[str, Any], t: float, tubes: TubeKeys | None = None,
) -> tuple[dict[str, _Pose], dict[str, dict], dict[str, td.Deformation]]:
    """``(poses, styles, deformations)`` at time ``t``, each keyed by occurrence id.
    A looping clip wraps ``t``; one that does not holds its end. ``tubes`` keeps
    the clip's normalized tube keys across calls."""
    duration = float(clip.get("duration") or 0.0) or 1.0
    local = max(0.0, float(t) if math.isfinite(float(t)) else 0.0)
    local = math.fmod(local, duration) if clip.get("loop") is not False else min(local, duration)
    tubes = TubeKeys() if tubes is None else tubes
    poses: dict[str, _Pose] = {}
    styles: dict[str, dict] = {}
    deformations: dict[str, td.Deformation] = {}
    for track in clip.get("tracks") or []:
        index, u = _bracket(track["times"], local)
        if "transform" in track:
            pose = _transform_at(track, index, u)
            for target in track["targets"]:
                poses[target] = pose
        elif "opacity" in track:
            a = track["opacity"][index]
            b = track["opacity"][index + 1] if u > 0 else None
            if a is None:
                continue
            value = a if b is None else a + (b - a) * u
            for target in track["targets"]:
                styles.setdefault(target, {})["opacity"] = value
        elif "visible" in track:
            value = track["visible"][index]
            if value is None:
                continue
            for target in track["targets"]:
                styles.setdefault(target, {})["visible"] = value
        elif "tube" in track:
            deformation = _tube_at(track, index, u, tubes)
            if deformation is None:
                continue
            for target in track["targets"]:
                deformations[target] = deformation
    return poses, styles, deformations


# --- sampling it into glTF ---------------------------------------------------------


def _summarize(ids, limit: int = 6) -> str:
    ordered = sorted(ids)
    if len(ordered) <= limit:
        return ", ".join(ordered)
    return f"{', '.join(ordered[:limit])} (and {len(ordered) - limit} more)"


@dataclass
class _Track:
    translations: list = field(default_factory=list)
    rotations: list = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.rotations) // 4

    def append(self, pose: _Pose | None) -> None:
        """One sample in glTF space; ``None`` is REST, the geometry as baked."""
        if pose is None:
            translation, rotation = (0.0, 0.0, 0.0), [0.0, 0.0, 0.0, 1.0]
        else:
            tx, ty, tz = pose.translation
            qx, qy, qz, qw = pose.quaternion
            translation = (CAD_TO_GLB_SCALE * tx, CAD_TO_GLB_SCALE * tz, -CAD_TO_GLB_SCALE * ty)
            # B R B^-1 for the proper rotation B: (x, y, z) -> (x, z, -y) turns the
            # quaternion's axis the same way and leaves its angle.
            rotation = [qx, qz, -qy, qw]
        if self.count:
            # q and -q are one rotation but not one set of numbers, and glTF
            # interpolates the numbers: keep every sample in the hemisphere of the one
            # before it, or a part goes the long way round in one frame.
            previous = self.rotations[-4:]
            if sum(p * c for p, c in zip(previous, rotation)) < 0:
                rotation = [-c for c in rotation]
        self.translations.extend(translation)
        self.rotations.extend(rotation)


def _float32_values(values: Sequence[float]) -> list[float]:
    return list(struct.unpack(f"<{len(values)}f", struct.pack(f"<{len(values)}f", *values)))


def _varies(values: Sequence[float], stride: int) -> bool:
    """Whether a track carries MOTION, compared as the float32 the file stores: a
    track whose samples all round to the same numbers is an offset, which the
    node's own transform carries."""
    return any(values[index] != values[index % stride] for index in range(stride, len(values)))


@dataclass
class TubeSamples:
    """One tube's deformation over a morph bake's grid: its FIRST deformation, whose
    rest every sample shares, and ``(grid index, deformation)`` wherever it bends."""

    rest: td.Deformation
    samples: list = field(default_factory=list)


@dataclass
class SampledClip:
    """A clip sampled over a plan, in glTF space."""

    name: str
    times: list  # float32 seconds, re-based to zero
    channels: list  # [{node, translation?, rotation?} | {node, times, weights, targetCount}]
    rest: dict  # node -> {translation, rotation, scale}: the pose at the first sample
    opacity: dict  # occurrence -> its opacity at start (dropped effects)
    hidden: set  # occurrences hidden at start (dropped effects)
    warnings: list
    # Empty unless deform is "morph": each deforming tube over the fit grid, keyed by
    # occurrence id, for tube_morph to bake.
    deformations: dict = field(default_factory=dict)
    grid: FitGrid | None = None

    def gltf(self) -> dict:
        return {"name": self.name, "times": self.times, "channels": self.channels, "rest": self.rest}


def _channel_order(channel: Mapping[str, Any]) -> tuple[str, int]:
    """By node, then a node's transform before its weights: one order, whichever the
    sampler or the bake collected first."""
    return (str(channel["node"]), 1 if "weights" in channel else 0)


def sample_clip(clip: Mapping[str, Any], plan: FramePlan, *, drop: Sequence[str] = (),
                deform: str = "refuse") -> SampledClip:
    """One clip over one plan, as per-occurrence glTF tracks.

    ``times`` is re-based to zero: ``start`` says where in the CLIP the span begins,
    and a file that kept the offset would open on a stretch of nothing. A channel
    is written only for an occurrence whose transform CHANGES over the span; every
    occurrence the clip moved carries its first sample as its ``rest`` pose. An
    effect glTF cannot animate is refused by name unless ``drop`` names it.

    ``deform`` decides what a clip that deforms tube geometry does here. "refuse"
    (the default) stops the export: a hand whose tendons silently froze is the file
    this door exists not to write. "rest" ships the tubes at their rest shape and
    says so. "morph" collects every tube's deformation at each sample of the fit
    grid (``fit_grid``) into ``deformations``, which ``tube_morph`` bakes: the clip
    is evaluated once per grid sample, and the rigid tracks read the samples that
    fall on export frames.
    """
    clip_id = str(clip.get("id"))
    dropped = {str(name).strip() for name in drop}
    unknown = sorted(dropped - set(DROPPABLE_EFFECTS))
    if unknown:
        raise ValueError(
            f"animation drop names {', '.join(unknown)}, which is not an effect this export can bake "
            f"static; droppable effects: {', '.join(DROPPABLE_EFFECTS)}"
        )
    deform = str(deform or "refuse")
    if deform not in DEFORM_MODES:
        raise ValueError(f"animation deform must be one of {', '.join(DEFORM_MODES)}, got {deform!r}")
    tracks: dict[str, _Track] = {}
    opacity_at: dict[str, float] = {}
    hidden_at: set[str] = set()
    opacity_ids: set[str] = set()
    visible_ids: set[str] = set()
    deformed_ids: set[str] = set()
    braid_ids: set[str] = set()
    deformations: dict[str, TubeSamples] = {}
    tubes = TubeKeys()
    grid = fit_grid(plan, deform)
    for grid_index in range(grid.count):
        # framePlan's own arithmetic at a fractional frame ordinal: where the samples
        # fall is the one thing the video and this export must not disagree about.
        elapsed = plan.elapsed(grid_index / grid.multiple)
        poses, styles, bent = evaluate_clip(clip, elapsed, tubes)
        for occurrence_id, deformation in bent.items():
            deformed_ids.add(occurrence_id)
            if deformation.braid:
                braid_ids.add(occurrence_id)
            if deform != "morph":
                continue
            entry = deformations.get(occurrence_id)
            if entry is None:
                entry = deformations[occurrence_id] = TubeSamples(deformation)
            elif not td.same_tube_rest_shape(entry.rest, deformation):
                # One base mesh per occurrence is what a morph target IS: deltas
                # against a shape the file states once.
                raise ValueError(
                    f"clip {clip_id} changes the REST path of {occurrence_id} at {elapsed:.4f}s, so its "
                    "geometry has no single base mesh for morph targets to be deltas against. Author "
                    "one rest path per tube for the whole clip (move the tube with .translate/.rotate "
                    f"instead), or export the clip as video (cadgen step snapshot --animation {clip_id} "
                    "--video)"
                )
            # The rest is one for the whole clip (the refusal above holds it), so every
            # sample shares the tube's ONE copy: by value a no-op, in memory half the grid.
            if deformation.rest_spec is not entry.rest.rest_spec:
                deformation = dataclasses.replace(deformation, rest_spec=entry.rest.rest_spec)
            entry.samples.append((grid_index, deformation))
        if grid_index % grid.multiple:
            continue
        index = grid_index // grid.multiple
        for occurrence_id, pose in poses.items():
            track = tracks.get(occurrence_id)
            if track is None:
                if pose.is_identity():
                    continue
                # The samples before it first MOVED are samples at rest, not a gap.
                track = tracks[occurrence_id] = _Track()
                for _ in range(index):
                    track.append(None)
            track.append(pose)
        for track in tracks.values():
            if track.count == index:  # untouched this frame: back at rest
                track.append(None)
        for occurrence_id, style in styles.items():
            if "opacity" in style:
                opacity_ids.add(occurrence_id)
                if index == 0:
                    opacity_at[occurrence_id] = style["opacity"]
            if "visible" in style:
                visible_ids.add(occurrence_id)
                if index == 0 and style["visible"] is False:
                    hidden_at.add(occurrence_id)

    warnings: list[str] = []
    for effect, ids in (("opacity", opacity_ids), ("visible", visible_ids)):
        if not ids:
            continue
        if effect not in dropped:
            raise ValueError(
                f"clip {clip_id} animates .{effect}() on {_summarize(ids)}, and glTF has no standard "
                f'animated channel for it. Pass drop: ["{effect}"] to bake the value at start into the '
                "file instead, or animate the occurrence's transform rather than its appearance"
            )
        warnings.append(
            f".{effect}() is not an animated glTF channel: {_summarize(ids)} carries its value at "
            "start, frozen for the whole clip"
        )
    if deformed_ids:
        if deform == "refuse":
            raise ValueError(
                f"clip {clip_id} deforms tube geometry on {_summarize(deformed_ids)}: that is per-vertex "
                'motion, which a node transform cannot carry. Pass deform: "morph" to bake it as '
                "morph targets (bigger file, deformTolerance sets how close they track), deform: "
                '"rest" to ship those tubes at their rest shape knowing they do not move, or export '
                f"the clip as video (cadgen step snapshot --animation {clip_id} --video)"
            )
        if deform == "morph":
            if braid_ids:
                # The braid is a shader over a per-vertex material coordinate, not
                # geometry, and glTF has nowhere to put it.
                warnings.append(
                    f"{_summarize(braid_ids)} carries a braid: the strand pattern is a shader, not geometry, "
                    "so the exported cord has the right shape and motion and a smooth surface"
                )
        else:
            warnings.append(
                f'deform: "rest" ships {_summarize(deformed_ids)} at rest shape: the clip\'s tube deformation '
                "is per-vertex motion this file does not carry"
            )
    # An occurrence `drop: ["visible"]` hid is not in the file at all, so it has no
    # node to move; the motion is unobservable, but leaving it out silently is not.
    hidden_and_moving = sorted(occurrence_id for occurrence_id in hidden_at if occurrence_id in tracks)
    if hidden_and_moving:
        for occurrence_id in hidden_and_moving:
            del tracks[occurrence_id]
        warnings.append(
            f"{_summarize(hidden_and_moving)} moves in this clip and is hidden at start: dropping "
            ".visible() omits the occurrence from the file, and a node that is not there carries no motion"
        )

    channels: list[dict] = []
    rest: dict[str, dict] = {}
    for occurrence_id, track in tracks.items():
        translations = _float32_values(track.translations)
        rotations = _float32_values(track.rotations)
        rest[occurrence_id] = {"translation": translations[0:3], "rotation": rotations[0:4], "scale": None}
        channel: dict[str, Any] = {"node": occurrence_id}
        if _varies(translations, 3):
            channel["translation"] = translations
        if _varies(rotations, 4):
            channel["rotation"] = rotations
        if len(channel) > 1:
            channels.append(channel)
    channels.sort(key=_channel_order)
    return SampledClip(
        name=clip_id,
        times=_float32_values([index / plan.fps for index in range(plan.frame_count)]),
        channels=channels, rest=rest, opacity=opacity_at, hidden=hidden_at, warnings=warnings,
        deformations=deformations, grid=grid,
    )


def with_morph_channels(sampled: SampledClip, channels: Sequence[Mapping[str, Any]]) -> SampledClip:
    """The clip with a morph bake's weights channels folded in: the sampler cannot
    know how many targets a tube needed, so the bake hands them back."""
    if not channels:
        return sampled
    return dataclasses.replace(sampled, channels=sorted([*sampled.channels, *channels], key=_channel_order))


def restrict_to_nodes(sampled: SampledClip, nodes: set[str]) -> SampledClip:
    """The clip narrowed to the nodes the file holds. An occurrence whose component
    produced no triangles is in the document and not in the file; its channel
    would target nothing, so it goes, by name."""
    missing = [channel["node"] for channel in sampled.channels if channel["node"] not in nodes]
    if not missing:
        return sampled
    return dataclasses.replace(
        sampled,
        channels=[channel for channel in sampled.channels if channel["node"] in nodes],
        rest={node: pose for node, pose in sampled.rest.items() if node in nodes},
        warnings=[*sampled.warnings, f"{_summarize(missing)} moves in this clip but has no geometry in the "
                  "export, so the file carries no node to animate for it"],
    )


def find_clip(animation: Mapping[str, Any], clip_id: str) -> Mapping[str, Any]:
    """The clip ``clip_id`` names in a sidecar ``animation`` section."""
    clips = list((animation or {}).get("clips") or [])
    for clip in clips:
        if clip.get("id") == clip_id:
            return clip
    declared = [str(clip.get("id")) for clip in clips]
    raise ValueError(
        f"Unknown animation clip: {clip_id}. This model declares: {', '.join(declared)}" if declared
        else f"Unknown animation clip: {clip_id}. This model declares no animation clips"
    )
