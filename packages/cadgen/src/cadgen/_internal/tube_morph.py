"""A clip's deforming tubes, baked into glTF MORPH TARGETS: the export half of
tube deformation.

The viewer DRIVES a deformation: every frame it recompiles the posed path and
re-emits every vertex on it (``tube_deformation`` is that runtime's headless
half). A GLB carries no evaluator, so an exported deformation becomes data: a
base mesh, a stack of per-vertex position deltas against it, and a weight
schedule that blends between them. Everything here exists to keep that blend
HONEST.

The load-bearing fact, and it is not the obvious one: morph weights blend the
RESULT of two poses, while a clip blends its own control numbers and rebuilds
the path from them, and the path -> vertex map (arc-length reparameterisation,
transported frames, stretch) is not linear. A target at every keyframe of the
clip is exact AT the keyframes and wrong between them, worst exactly where a
tendon turns hardest. So the target times are neither the clip's keys nor the
export's frames: they are FITTED, per occurrence, to a tolerance in millimetres,
on a grid four times finer than the export's frame rate
(``glb_animation.fit_grid``), and the fit is an upper bound rather than a sample
(``_fraction_boxes``), which is what makes the tolerance mean something.

Pure (no filesystem), and it re-derives nothing: every pose comes from
``tube_deformation.pose_tube_bake``, the viewer's own arithmetic, so an exported
cord and a rendered one cannot disagree.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from typing import Any, Mapping

import numpy as np

from cadgen._internal import tube_deformation as td
from cadgen._internal.glb_animation import FitGrid, TubeSamples
from cadgen._internal.mesh_animation import DEFAULT_MORPH_TOLERANCE_MM
from cadgen._internal.mesh_formats import (
    MorphCheck,
    MorphTarget,
    Primitive,
    Tessellation,
    occurrence_colors,
    occurrence_world_mesh,
)

# The ceiling, on PLAYBACK memory rather than file size: three.js uploads morph data
# as a float32 RGBA texture layer per target -- 16 bytes per vertex per target for
# positions, 32 with normals -- and that, not the bytes on disk, decides whether a
# deforming file opens. Estimated before a single delta is allocated.
MAX_MORPH_RUNTIME_BYTES = 512 * 1024 * 1024
RUNTIME_BYTES_PER_TEXEL = 16
# Below this the posed normals are close enough to the base ones to leave out: a
# tube that barely turns saves half its bytes and half its texture. MEASURED per
# occurrence (glTF requires a mesh's primitives to agree on target attributes).
MORPH_NORMAL_OMIT_DEGREES = 5
# How long the fit's open interval may grow before a key is forced: a memory and
# time bound, at most one extra target per 128 grid samples, and a target whose
# delta is identically zero is dropped anyway.
MORPH_FIT_MAX_OPEN_SAMPLES = 128
# How many of a primitive's vertices carry a posed reference into the file's own
# space for the writer's reconstruction check: a basis or scale mistake is uniform
# across a primitive, so a strided sample finds it as surely as every vertex.
MORPH_VERIFY_SAMPLE_LIMIT = 512


@dataclass
class MorphBake:
    """What a clip's tubes bake to.

    ``overrides`` replaces each deforming occurrence's primitives with its REFINED,
    POSED base mesh and its targets; ``channels`` holds one weights channel per tube
    that actually moves; ``stats`` is what the summary reports, the achieved
    deviation included. A tube the clip holds bent keeps its override and gets no
    channel: shipping the rest shape would be the silent freeze this door refuses."""

    overrides: dict = field(default_factory=dict)
    channels: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    stats: dict | None = None


def _summarize(ids, limit: int = 6) -> str:
    ordered = sorted(ids)
    if len(ordered) <= limit:
        return ", ".join(ordered)
    return f"{', '.join(ordered[:limit])} (and {len(ordered) - limit} more)"


def _format_bytes(value: float) -> str:
    if value >= 1024 ** 3:
        return f"{value / 1024 ** 3:.2f} GiB"
    return f"{value / 1024 ** 2:.1f} MiB"


@dataclass
class _Corners:
    """The corners of the (u, v, axial) box at each distinct arc fraction."""

    fractions: np.ndarray  # (f,) ascending
    owner: np.ndarray  # (c,) each corner's fraction
    uva: np.ndarray  # (c, 3)


def _fraction_boxes(values: np.ndarray) -> _Corners:
    """The BOX of (transverse u, transverse v, axial) at each distinct arc fraction.

    This turns the fit from a sample into a bound. At one arc fraction a posed
    vertex is AFFINE in (u, v, axial) -- the frame's normal, binormal and tangent
    scaled by them -- so a true pose minus a two-key blend is affine there too, and
    the norm of an affine map over a box peaks at a corner. A degenerate axis
    contributes one value, not two: a tube's vertices sit at essentially zero axial
    offset, which keeps the probe at four corners a ring rather than eight."""
    fractions, inverse = np.unique(values[:, 0], return_inverse=True)
    lows = np.full((len(fractions), 3), np.inf)
    highs = np.full((len(fractions), 3), -np.inf)
    np.minimum.at(lows, inverse, values[:, 1:4])
    np.maximum.at(highs, inverse, values[:, 1:4])
    spans = lows != highs
    combos = list(itertools.product((0, 1), repeat=3))  # u outermost, as the runtime walks them
    valid = np.stack([np.all([spans[:, axis] | (bit == 0) for axis, bit in enumerate(combo)], axis=0)
                      for combo in combos], axis=1)
    corners = np.stack([np.where(np.array(combo, dtype=bool), highs, lows) for combo in combos], axis=1)
    owner = np.broadcast_to(np.arange(len(fractions))[:, None], valid.shape)
    return _Corners(fractions, owner[valid], corners[valid])


def _pose_corners(model: _Corners, compiled: td.CompiledDeformation) -> np.ndarray:
    """Where every probe corner lands under one pose: positions, unpinched, as the
    runtime's bake bounds them."""
    path = compiled.path
    twist = compiled.twist_deg * math.pi / 180
    c = math.cos(twist)
    s = math.sin(twist)
    frames = td.sample_frames(path, model.fractions * path.length)
    f = model.owner
    u0, v0, axial = model.uva[:, 0], model.uva[:, 1], model.uva[:, 2]
    u = c * u0 - s * v0
    v = s * u0 + c * v0
    return ((frames.point[f] + frames.normal[f] * u[:, None]) + frames.binormal[f] * v[:, None]) \
        + frames.tangent[f] * axial[:, None]


class _Open:
    """The fit's open interval: each sample since the anchor as its corners relative
    to the anchor's, and an upper bound on how far it sits from the current blend.

    Checking every interior sample against every new endpoint is the runtime's
    rule, and its cost is samples x corners per grid step. The bound keeps the rule
    and skips the work: a sample ``j`` steps past the anchor sits at
    ``D - (j/s) B`` from the blend over span ``s``, and from span ``s - 1`` to ``s``
    that moves by exactly ``j (B'/(s-1) - B/s)`` -- one vector field for every
    sample, scaled by ``j``. So its distance grows by at most ``j`` times that
    field's largest norm, and only a sample whose bound reaches the tolerance is
    measured again, exactly, which also tightens its bound.

    Memory is the offsets alone, at most the open bound of them: a cut keeps only
    the newest sample, so only the newest two poses are ever needed whole."""

    def __init__(self, corners: int):
        self.indices: list[int] = []
        self.bounds: list[float] = []
        self.recent: list[np.ndarray] = []  # the newest two poses
        self.offsets = np.empty((MORPH_FIT_MAX_OPEN_SAMPLES, corners, 3))

    def append(self, index: int, pose: np.ndarray, anchor_pose: np.ndarray) -> None:
        self.offsets[len(self.indices)] = pose - anchor_pose
        self.indices.append(index)
        self.recent = [*self.recent[-1:], pose]
        # The newest sample IS the blend's endpoint: it sits on it exactly.
        self.bounds.append(0.0)

    def exceeds(self, anchor: int, tolerance: float) -> bool:
        """Whether any interior sample sits past ``tolerance`` from the blend of the
        anchor and the newest sample."""
        interior = len(self.indices) - 1
        if interior < 1:
            return False
        span = self.indices[-1] - anchor
        newest = self.offsets[interior]
        drift = self.offsets[interior - 1] / (span - 1) - newest / span
        reach = math.sqrt(float(np.max(drift[:, 0] * drift[:, 0] + drift[:, 1] * drift[:, 1] + drift[:, 2] * drift[:, 2])))
        steps = np.array(self.indices[:interior], dtype=np.float64) - anchor
        bounds = np.array(self.bounds[:interior]) + steps * reach
        doubtful = np.nonzero(bounds > tolerance)[0]
        if doubtful.size:
            # m - (a + (b - a) * alpha), with m - a held per sample.
            alpha = steps[doubtful] / span
            error = self.offsets[doubtful] - alpha[:, None, None] * newest[None]
            exact = np.sqrt(np.einsum("kcd,kcd->kc", error, error).max(axis=1))
            if float(exact.max()) > tolerance:
                return True
            bounds[doubtful] = exact
        self.bounds[:interior] = bounds.tolist()
        return False

    def cut(self, at: int) -> np.ndarray:
        """Make sample ``at`` -- the newest, or the one before it -- the anchor; return
        its pose. What survives is at most the newest sample, which sits on any blend
        that ends at it."""
        anchor_pose = self.recent[-1] if at == self.indices[-1] else self.recent[-2]
        newest = self.recent[-1]
        survivors = [index for index in self.indices if index > at]
        self.indices = survivors
        self.bounds = [0.0 for _ in survivors]
        if survivors:
            self.offsets[0] = newest - anchor_pose
        self.recent = [anchor_pose, newest] if survivors else [anchor_pose]
        return anchor_pose


def _fit_target_times(poses: list, model: _Corners, tolerance: float) -> list[int]:
    """Forward scan: the fewest grid samples whose blend stays inside ``tolerance``.

    One pass, deterministic, and every interior sample of the open interval is
    re-checked as it grows: a fit that only checked the newest sample would
    certify an interval by the one moment that is exact by construction."""
    total = len(poses)
    keys = [0]
    if total < 2:
        return keys
    anchor = 0
    anchor_pose = _pose_corners(model, td.compile_deformation(poses[0]))
    previous_pose = anchor_pose
    open_set = _Open(len(model.uva))
    uniform = True
    for index in range(1, total):
        # A pose the clip did not change poses to the same corners bit for bit.
        pose = (previous_pose if td.same_tube_deformation(poses[index], poses[index - 1])
                else _pose_corners(model, td.compile_deformation(poses[index])))
        previous_pose = pose
        open_set.append(index, pose, anchor_pose)
        # Every sample since the anchor the SAME deformation: every blend between
        # them is exact, so a tube the clip holds still costs no comparisons.
        uniform = uniform and td.same_tube_deformation(poses[index], poses[anchor])
        exceeded = not uniform and open_set.exceeds(anchor, tolerance)
        if not exceeded and len(open_set.indices) < MORPH_FIT_MAX_OPEN_SAMPLES:
            continue
        # The PREVIOUS sample is the last one that fit; the current one broke it.
        cut = index - 1 if exceeded else index
        anchor_pose = open_set.cut(cut)
        keys.append(cut)
        anchor = cut
        uniform = all(td.same_tube_deformation(poses[later], poses[anchor]) for later in open_set.indices)
    if keys[-1] != total - 1:
        keys.append(total - 1)
    return keys


def _max_normal_degrees(base: np.ndarray, posed: np.ndarray) -> float:
    a = base.astype(np.float64)
    b = posed.astype(np.float64)
    denominator = np.sqrt(np.sum(a * a, axis=1)) * np.sqrt(np.sum(b * b, axis=1))
    usable = denominator >= 1e-12
    if not np.any(usable):
        return 0.0
    cosine = np.clip(np.sum(a * b, axis=1)[usable] / denominator[usable], -1.0, 1.0)
    return float(np.max(np.arccos(cosine))) * 180 / math.pi


def _verify_sample_ids(count: int) -> np.ndarray:
    limit = max(1, min(count, MORPH_VERIFY_SAMPLE_LIMIT))
    return (np.arange(limit, dtype=np.int64) * count) // limit


@dataclass
class _Job:
    occurrence: Mapping[str, Any]
    occurrence_id: str
    tessellation: Tessellation
    entry: TubeSamples
    bake: td.PreparedTube | None = None
    triangle_range: np.ndarray | None = None
    poses: list | None = None
    keys: list | None = None


def _verify_fit(job: _Job, grid: FitGrid, base: np.ndarray, deltas: list, tolerance: float) -> float:
    """The fit's tolerance, re-checked against the EXACT poser over every vertex, at
    every export frame. Redundant by design: the corner bound is the authority,
    and this is the independent second opinion -- real poses, real vertices, the
    real weight schedule. Reports the achieved maximum either way."""
    keys = job.keys
    if len(keys) < 2:
        return 0.0
    worst = 0.0
    cursor = 0
    base64 = base.astype(np.float64)
    posed = None
    previous = None
    for sample in range(0, len(job.poses), grid.multiple):
        while cursor + 2 < len(keys) and keys[cursor + 1] <= sample:
            cursor += 1
        low, high = keys[cursor], keys[cursor + 1]
        alpha = 0.0 if high == low else (sample - low) / (high - low)
        if posed is None or not td.same_tube_deformation(job.poses[sample], previous):
            posed = td.pose_tube_bake(job.bake, td.compile_deformation(job.poses[sample]), normals=False)[0]
            posed = posed.astype(np.float64)
        previous = job.poses[sample]
        # `deltas[k]` belongs to key k + 1; key 0 is the base and has none.
        blended = base64
        if cursor >= 1:
            blended = blended + deltas[cursor - 1].astype(np.float64) * (1 - alpha)
        blended = blended + deltas[cursor].astype(np.float64) * alpha
        gap = posed - blended
        worst = max(worst, float(np.max(gap[:, 0] * gap[:, 0] + gap[:, 1] * gap[:, 1] + gap[:, 2] * gap[:, 2])))
    worst = math.sqrt(worst)
    # A micron of slack for the float32 the file stores; the bound itself is exact,
    # so anything past it is a bug, not rounding.
    if worst > tolerance + 1e-3:
        raise ValueError(
            f"morph fit for {job.occurrence_id} leaves {worst:.4f}mm between the baked targets and the "
            f"clip's own deformation, past the {tolerance:g}mm it was fitted to"
        )
    return worst


def _partitions(job: _Job, colors: list[str]) -> list[tuple[str, np.ndarray, np.ndarray]]:
    """The refined triangles grouped by the colour their source face range resolves
    to, in first-seen order: (colour, compacted indices, the refined vertex of each
    compacted one)."""
    mesh = job.bake.mesh
    triangles = mesh.indices.reshape(-1, 3)
    sources = mesh.source_triangles if mesh.source_triangles is not None else np.arange(len(triangles))
    numbering: dict[str, int] = {}
    range_code = np.array([numbering.setdefault(color, len(numbering)) for color in colors], dtype=np.int64)
    codes = range_code[job.triangle_range[sources]] if len(triangles) else np.zeros(0, dtype=np.int64)
    present, first_seen = np.unique(codes, return_index=True)
    names = list(numbering)
    out = []
    for code in present[np.argsort(first_seen, kind="stable")]:
        color = names[code]
        corners = triangles[np.nonzero(codes == code)[0]].reshape(-1)
        _unique, first, inverse = np.unique(corners, return_index=True, return_inverse=True)
        rank = np.empty(len(first), dtype=np.int64)
        rank[np.argsort(first, kind="stable")] = np.arange(len(first))
        slots = rank[inverse.reshape(-1)]
        vertex_ids = np.empty(len(first), dtype=np.int64)
        vertex_ids[slots] = corners
        out.append((color, slots.astype(np.uint32), vertex_ids))
    return out


def build_tube_morph_targets(
    descriptor: Mapping[str, Any],
    tessellations: Mapping[str, Tessellation],
    deformations: Mapping[str, TubeSamples],
    *,
    grid: FitGrid,
    tolerance_mm: float = DEFAULT_MORPH_TOLERANCE_MM,
    default_color: str | None = None,
    clip_id: str = "clip",
    max_runtime_bytes: int = MAX_MORPH_RUNTIME_BYTES,
) -> MorphBake:
    """Bake every deforming tube of a sampled clip into morph targets.

    ``deformations`` is the sampler's (``glb_animation.sample_clip`` under
    ``deform="morph"``): each tube's deformation over ``grid``."""
    tolerance = float(tolerance_mm)
    if not tolerance > 0:
        raise ValueError(f"morph deformTolerance must be a positive number of millimetres, got {tolerance_mm!r}")
    bake = MorphBake()
    if not deformations:
        return bake
    # Descriptor order, never the sampler's: the bytes must not depend on which
    # occurrence the clip happened to touch first.
    jobs: list[_Job] = []
    missing: list[str] = []
    for occurrence in descriptor.get("occurrences") or []:
        cid = str(occurrence.get("component") or "")
        occurrence_id = str(occurrence.get("id") or cid)
        entry = deformations.get(occurrence_id)
        if entry is None:
            continue
        tessellation = tessellations.get(cid)
        if tessellation is None or not len(tessellation.positions) or not len(tessellation.indices):
            missing.append(occurrence_id)
            continue
        jobs.append(_Job(occurrence, occurrence_id, tessellation, entry))
    if missing:
        bake.warnings.append(
            f"{_summarize(missing)} deforms in this clip but tessellated to nothing, so the file carries no "
            "geometry to morph for it"
        )
    if not jobs:
        return bake

    # PHASE A: prepare and fit every tube, allocating no deltas. The fit is the
    # expensive half in time and the cheap half in memory, and doing all of it
    # first lets the refusal below quote the real total.
    ceiling = min(int(max_runtime_bytes), MAX_MORPH_RUNTIME_BYTES)
    runtime_bytes = 0
    for job in jobs:
        first = job.entry.rest
        positions, normals, triangles, job.triangle_range = occurrence_world_mesh(job.occurrence, job.tessellation)
        job.bake = td.prepare_tube_bake(td.RestMesh(positions, normals, triangles.reshape(-1)),
                                        td.compile_deformation(first))
        # A grid sample the clip did not deform is the tube at REST for that moment:
        # posing the rest path against itself reproduces the rest surface exactly.
        rest_pose = td.Deformation(first.rest_spec, first.rest_spec, 0.0, first.max_segment_length, first.braid)
        job.poses = [rest_pose] * grid.count
        for index, deformation in job.entry.samples:
            job.poses[index] = deformation
        job.keys = _fit_target_times(job.poses, _fraction_boxes(job.bake.mapping.values), tolerance)
        # Conservative: normals may still be dropped, and a ceiling that assumed so
        # would refuse nothing and then allocate twice what it promised.
        runtime_bytes += job.bake.vertex_count * max(0, len(job.keys) - 1) * 2 * RUNTIME_BYTES_PER_TEXEL
    if runtime_bytes > ceiling:
        targets = sum(max(0, len(job.keys) - 1) for job in jobs)
        vertices = sum(job.bake.vertex_count for job in jobs)
        raise ValueError(
            f"clip {clip_id} needs {targets} morph targets over {len(jobs)} tubes ({vertices} refined "
            f"vertices) to hold {tolerance:g}mm, which is {_format_bytes(runtime_bytes)} of morph texture at "
            f"playback — past the {_format_bytes(ceiling)} ceiling, and it is the GPU number rather than the "
            "file size that decides whether the file opens. Raise deformTolerance (the target count falls as "
            "its square root), shorten seconds, coarsen --mesh-tolerance so the tubes carry fewer vertices, "
            "or coarsen the clip's own maxSegmentLength"
        )

    # PHASE B: pose the keys, subtract the base, partition and compact.
    stats: dict[str, Any] = {
        "toleranceMm": tolerance, "nodes": 0, "targets": 0, "bytes": 0, "runtimeBytes": 0,
        "refinedTriangles": 0, "deviationMm": 0.0, "normalsOmitted": [],
    }
    for job in jobs:
        keys = job.keys
        base_positions, base_normals = td.pose_tube_bake(job.bake, td.compile_deformation(job.poses[keys[0]]))
        # A strided handful of REFINED vertices as the poser wrote them: nothing
        # downstream derives these from the deltas, so carrying them into the file's
        # space is an independent answer to "where should this vertex be".
        reference_ids = _verify_sample_ids(job.bake.vertex_count)
        delta_positions: list[np.ndarray] = []
        delta_normals: list[np.ndarray] = []
        reference_posed: list[np.ndarray] = []
        normal_degrees = 0.0
        for key in keys[1:]:
            posed, posed_normals = td.pose_tube_bake(job.bake, td.compile_deformation(job.poses[key]))
            delta_positions.append((posed.astype(np.float64) - base_positions).astype(np.float32))
            delta_normals.append((posed_normals.astype(np.float64) - base_normals).astype(np.float32))
            reference_posed.append(posed[reference_ids])
            normal_degrees = max(normal_degrees, _max_normal_degrees(base_normals, posed_normals))
        bake_normals = normal_degrees >= MORPH_NORMAL_OMIT_DEGREES
        if not bake_normals and delta_positions:
            stats["normalsOmitted"].append(job.occurrence_id)
        # A target whose delta is identically zero is a full texture layer saying
        # nothing. Its KEY stays: an all-zero weight row is the base shape, which is
        # what that key's pose is.
        emitted = [slot for slot, delta in enumerate(delta_positions) if np.any(delta != 0)]
        target_of_key = {slot + 1: ordinal for ordinal, slot in enumerate(emitted)}
        stats["deviationMm"] = max(stats["deviationMm"], _verify_fit(job, grid, base_positions, delta_positions, tolerance))

        colors = occurrence_colors(descriptor, job.occurrence, job.tessellation, default_color)
        primitives = []
        for color, indices, vertex_ids in _partitions(job, colors):
            targets = [MorphTarget(delta_positions[slot][vertex_ids],
                                   delta_normals[slot][vertex_ids] if bake_normals else None) for slot in emitted]
            # Whichever reference vertices this colour owns, in its own numbering, so
            # the writer's check also fails if compaction moved a vertex.
            local = np.full(job.bake.vertex_count, -1, dtype=np.int64)
            local[vertex_ids] = np.arange(len(vertex_ids))
            owned = local[reference_ids]
            samples = np.nonzero(owned >= 0)[0]
            check = None
            if targets and samples.size:
                check = MorphCheck(owned[samples], [reference_posed[slot][samples] for slot in emitted])
            primitives.append(Primitive(
                color=color, positions=base_positions[vertex_ids], normals=base_normals[vertex_ids],
                indices=indices, targets=targets or None, check=check,
            ))
        bake.overrides[job.occurrence_id] = primitives
        stats["nodes"] += 1
        stats["targets"] += len(emitted)
        stats["refinedTriangles"] += len(job.bake.mesh.indices) // 3
        for primitive in primitives:
            vertices = len(primitive.positions)
            stats["bytes"] += vertices * len(emitted) * (24 if bake_normals else 12)
            stats["runtimeBytes"] += vertices * len(emitted) * (2 if bake_normals else 1) * RUNTIME_BYTES_PER_TEXEL
        if emitted:
            weights = np.zeros((len(keys), len(emitted)), dtype=np.float32)
            for position, key in enumerate(keys):
                if position in target_of_key:
                    # ONE-HOT, never cumulative: at most two targets have influence at
                    # any instant, so a loader with a fixed morph-slot budget that keeps
                    # the largest influences renders this exactly.
                    weights[position, target_of_key[position]] = 1.0
            bake.channels.append({
                "node": job.occurrence_id,
                "times": (np.array(keys, dtype=np.float64) / grid.hz).astype(np.float32).tolist(),
                "weights": weights.reshape(-1).tolist(),
                "targetCount": len(emitted),
            })
    if stats["normalsOmitted"]:
        bake.warnings.append(
            f"{_summarize(stats['normalsOmitted'])} turns by less than {MORPH_NORMAL_OMIT_DEGREES}° over this "
            "clip, so its morph targets carry positions only and its shading rides the base normals"
        )
    bake.stats = stats
    return bake
