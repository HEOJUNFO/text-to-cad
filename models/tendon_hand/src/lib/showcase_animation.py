"""The R13 showcase: the tendons driving every motion, replayed from its solve.

The choreography is SOLVED, not authored. `validation/write_showcase_presentation.py`
samples the poses on one 4 Hz grid and solves everything else on that same grid:
the 48 posed tendon routes, the capstan payout that keeps each cord's length,
and the rigid motion of every guide that bridges two frames. Those numbers are
generated output -- megabytes of them -- so the generator writes them to the
ignored ``validation/<model>_showcase.json``, and this module turns them into
the model's clips when it builds.

A clip's ``update(t, m)`` brackets ``t`` between two solved keyframes and blends
everything at once -- pose, payout, guides and cords -- so the cords cannot
drift out of step with the fingers. What moves each body is the hand's own
kinematics: ``lib.layout.assembled_transforms`` places the frames and
``lib.actuator_kinematics.actuator_transform`` turns the drive train, the same
functions that placed those bodies, so nothing is re-derived here.
"""
import json
import math
from bisect import bisect_left
from pathlib import Path

import cadgen
from cadgen.animation import DEFAULT_FPS
from lib.actuator_kinematics import actuator_transform
from lib.layout import TENDONS, assembled_transforms

VALIDATION = Path(__file__).resolve().parents[2] / 'validation'
GENERATOR = 'write_showcase_presentation.py'

# Longitudinal refinement, in mm. A tendon bends only where it crosses a joint,
# but refinement is one-time and covers the whole tube, so this trades vertices
# on the straight runs for a smooth bend at the knuckles.
#
# It is also the lever that decides whether a morph bake fits on a GPU. Every
# refined vertex costs one RGBA32F texel per morph target per attribute, so at
# 3 mm the 48 cords came to 697,924 refined vertices and 694.6 MiB of morph
# texture for one 6 s clip -- past cadgen's 512 MiB playback ceiling, and the
# export refuses. 9 mm cuts the vertex count by a third, and it is the RIGHT
# lever: chord and angular tolerance shrink a cord's circumference, which is
# what the morph texture is priced on, so tightening them makes cord FIDELITY
# worse, not better. Longitudinal facets barely show on a 0.6 mm tube; a path
# error of a few mm shows as the cord sinking through a drum. Trade the first
# for the second and keep the path tolerance at 1 mm, which is the right way
# round: a cord's SHAPE error is far more visible than its facet count, since
# the tube is only 0.6 mm across.
TUBE_REFINEMENT = 9
BRAID = {'pitch': .8, 'depth': .022, 'strands': 8}

# Samples a second for the clips that play the `drive` sweep. There every joint
# goes to 0.9 of its range, and a few guides fitted to (nearly) planar spans --
# little_mcp_flexion_negative_cup_reaction, middle_dip_negative_mcp_reaction and
# middle_pip_negative_mcp_reaction -- come out of the generator's Kabsch fit
# turned ~170 degrees at one keyframe and back at the next. The blend below
# snaps such a guide round at up to ~20,400 degrees a second, and a build
# refuses a part that turns more than 90 degrees between two samples, so these
# clips sample at 240 a second (85 degrees at the snap) rather than the
# default 60.
SNAP_FPS = 240
SNAPPING_MOTIONS = {'drive'}


def data_path(model):
    """The generated numbers for the model named ``model`` (`src/<model>.py`)."""
    return VALIDATION / f'{model}_showcase.json'


def load_showcase(model_file):
    """The solved choreography, or say which command writes it."""
    path = data_path(Path(model_file).stem)
    if not path.is_file():
        raise FileNotFoundError(
            f'{path} is missing. It is generated output, not source: run '
            f'`python validation/{GENERATOR}` from models/tendon_hand to write it.')
    data = json.loads(path.read_text(encoding='utf-8'))
    if 'keyframes' not in data:
        raise ValueError(f'{path} holds no solved timeline; regenerate it with `python validation/{GENERATOR}`.')
    return data


# --- small vector helpers ---------------------------------------------------

def _sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def _scale(a, k):
    return [a[0] * k, a[1] * k, a[2] * k]


def _norm(a):
    return math.hypot(a[0], a[1], a[2])


def interpolate(low, high, alpha):
    """A held keyframe keeps its exact numbers.

    The weighted sum can round identical endpoints differently as alpha
    advances, which would move a cord whose mechanism has not moved.
    """
    return low if low == high else low * (1 - alpha) + high * alpha


def is_moving(matrix):
    trace = matrix[0][0] + matrix[1][1] + matrix[2][2]
    angle = math.acos(min(1., max(-1., (trace - 1) / 2)))
    return angle >= 1e-9 or math.hypot(matrix[0][3], matrix[1][3], matrix[2][3]) > 1e-9


# --- cords ------------------------------------------------------------------

def _end_tangent(segment):
    if segment['kind'] == 'bezier':
        return _sub(segment['points'][3], segment['points'][2])
    return _sub(segment['end'], segment['start'])


def _start_tangent(segment):
    if segment['kind'] == 'bezier':
        return _sub(segment['points'][1], segment['points'][0])
    return _sub(segment['end'], segment['start'])


def seal_tangents(segments):
    """Turn the two handles at each join back onto one line.

    Blending two solved routes number by number keeps every JOIN exact -- a
    shared endpoint is one number blended once -- but not every TANGENT: two
    segments meeting in line at both keyframes generally meet at a slight angle
    in between, and a tube path must be tangent-continuous. So each join's two
    handles turn onto their bisector, keeping the shared point and both handle
    lengths. The correction is the misalignment itself -- thousandths of a
    degree at this keyframe rate -- and it moves a control point, never an
    endpoint.
    """
    for index in range(1, len(segments)):
        before, after = segments[index - 1], segments[index]
        # A line's direction is its endpoints, which are joins and must not
        # move. Two lines in a row therefore cannot be sealed -- and never occur
        # in these routes, so the tube refusing them is the right outcome.
        if before['kind'] != 'bezier' and after['kind'] != 'bezier':
            continue
        incoming, outgoing = _end_tangent(before), _start_tangent(after)
        in_length, out_length = _norm(incoming), _norm(outgoing)
        if not in_length > 0 or not out_length > 0:
            continue
        in_unit, out_unit = _scale(incoming, 1 / in_length), _scale(outgoing, 1 / out_length)
        if before['kind'] != 'bezier':
            direction = in_unit
        elif after['kind'] != 'bezier':
            direction = out_unit
        else:
            bisector = _add(in_unit, out_unit)
            length = _norm(bisector)
            if not length > 0:
                continue
            direction = _scale(bisector, 1 / length)
        if before['kind'] == 'bezier':
            before['points'][2] = _sub(before['points'][3], _scale(direction, in_length))
        if after['kind'] == 'bezier':
            after['points'][1] = _add(after['points'][0], _scale(direction, out_length))
    return segments


def rope_path(template, normal, numbers):
    """One cord's centerline, poured back into the segment kinds the generator
    flattened its route into. Only Beziers and lines reach here: an arc's
    center, axis, start and sweep do not survive a blend between two keyframes,
    while a Bezier's explicit endpoints blend to the same place from either side
    of a join and keep the chain joined."""
    segments = []
    at = 0
    for kind in template:
        if kind == 'bezier':
            segments.append({'kind': kind, 'points': [numbers[at:at + 3], numbers[at + 3:at + 6],
                                                      numbers[at + 6:at + 9], numbers[at + 9:at + 12]]})
            at += 12
        elif kind == 'line':
            segments.append({'kind': kind, 'start': numbers[at:at + 3], 'end': numbers[at + 3:at + 6]})
            at += 6
        else:
            raise ValueError(f'unexpected segment kind {kind}: the generator flattens arcs')
    return {'normal': normal, 'segments': seal_tangents(segments)}


# --- the clips --------------------------------------------------------------

def showcase_animation(model_file):
    """The `animation=` of the showcase model: one clip per solved motion, the
    whole tour, and the braided routing at rest. None for a placeholder."""
    return showcase_clips(load_showcase(model_file))


def showcase_clips(data):
    """The clips one solved timeline plays, or None for an empty one."""
    keyframes = data['keyframes']
    if not keyframes:
        return None
    times = [keyframe['t'] for keyframe in keyframes]
    last = len(keyframes) - 1

    frames = {frame: tuple(f'#{name}' for name in names) for frame, names in data['frames'].items()}
    actuators = [(f'#{name}', index, role) for name, (index, role) in data['actuatorBodies'].items()]
    hidden = tuple(f'#{name}' for name in data['hiddenBodies'])
    guides = [f'#{name}' for name in data['guides']]
    ropes = [f'#{name}' for name in data['ropeNames']]
    templates, normals = data['ropeTemplates'], data['ropeNormals']
    base, varying = data['ropeBase'], data['ropeVarying']
    # The neutral centerline each cord's swept solid was built on; deformation
    # maps normalized arc length from it onto the posed one.
    rests = [rope_path(templates[index], normals[index], list(numbers)) for index, numbers in enumerate(base)]
    # Where each cord's moving numbers start inside a keyframe's flat `v`.
    offsets = [0]
    for positions in varying:
        offsets.append(offsets[-1] + len(positions))

    def bracket(t):
        clamped = min(times[last], max(0, t))
        high = bisect_left(times, clamped, 1, last)
        low = high - 1
        span = times[high] - times[low]
        return keyframes[low], keyframes[high], (clamped - times[low]) / span if span > 0 else 0

    def pose_between(low, high, alpha):
        return {key: interpolate(low['pose'].get(key) or 0, high['pose'].get(key) or 0, alpha)
                for key in {**low['pose'], **high['pose']}}

    def move_frames(m, pose):
        # The artifact is written at pose zero, so a frame's transform at a pose
        # IS its motion from rest.
        transforms = assembled_transforms(pose)
        for frame, targets in frames.items():
            matrix = transforms[frame]
            if is_moving(matrix):
                m.get(*targets).transform(matrix)

    def turn_actuators(m, rotations):
        for target, index, role in actuators:
            q = rotations[index]
            if abs(q) < 1e-9:
                continue
            matrix = actuator_transform(TENDONS[index], role, q)
            if matrix is not None:
                m.get(target).transform(matrix)

    def seat_guides(m, low, high, alpha):
        # A guide that bridges two frames is placed by the routing, so the
        # generator fits the rigid motion of the span it guides and stores it
        # here. A blend of two rotations element by element is not itself a
        # rotation, so the 3x3 is re-orthogonalized before it is applied -- a
        # hair at this keyframe rate, and a squashed pulley without it.
        for index, target in enumerate(guides):
            at = index * 12
            blended = [interpolate(low['g'][at + i], high['g'][at + i], alpha) for i in range(12)]
            rows = [blended[0:3], blended[4:7], blended[8:11]]
            r0 = _scale(rows[0], 1 / (_norm(rows[0]) or 1))
            r1 = _sub(rows[1], _scale(r0, r0[0] * rows[1][0] + r0[1] * rows[1][1] + r0[2] * rows[1][2]))
            r1 = _scale(r1, 1 / (_norm(r1) or 1))
            r2 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]]
            m.get(target).transform([[*r0, blended[3]], [*r1, blended[7]], [*r2, blended[11]], [0, 0, 0, 1]])

    def bend_cords(m, low, high, alpha):
        for index, target in enumerate(ropes):
            numbers = list(base[index])
            offset = offsets[index]
            for i, position in enumerate(varying[index]):
                numbers[position] = interpolate(low['v'][offset + i], high['v'][offset + i], alpha)
            m.get(target).deform_tube(rest=rests[index], path=rope_path(templates[index], normals[index], numbers),
                                      max_segment_length=TUBE_REFINEMENT, braid=BRAID)

    def apply_at(m, t):
        # The planetary internals are sealed inside their gearbox housings and
        # never visible, while costing 59% of the model's triangles: hidden
        # every frame, so an export asked to drop hidden parts leaves them out.
        if hidden:
            m.get(*hidden).visible(False)
        low, high, alpha = bracket(t)
        move_frames(m, pose_between(low, high, alpha))
        turn_actuators(m, [interpolate(value, high['q'][index], alpha) for index, value in enumerate(low['q'])])
        seat_guides(m, low, high, alpha)
        bend_cords(m, low, high, alpha)

    def showcase(t, m):
        apply_at(m, t)

    def motion_clip(start, seconds):
        def motion(t, m):
            apply_at(m, start + min(seconds, max(0, t)))
        return motion

    def presentation(t, m):
        apply_at(m, 0)

    tour = sum(motion['seconds'] for motion in data['motions'])
    clips = {'showcase': cadgen.clip(showcase, duration=tour, loop=True, fps=SNAP_FPS,
                                     label='Showcase — the tendons driving every motion')}
    start = 0
    for motion in data['motions']:
        clips[motion['id']] = cadgen.clip(motion_clip(start, motion['seconds']), duration=motion['seconds'],
                                          loop=True, label=motion['label'],
                                          fps=SNAP_FPS if motion['id'] in SNAPPING_MOTIONS else DEFAULT_FPS)
        start += motion['seconds']
    clips['presentation'] = cadgen.clip(presentation, duration=1, loop=False, label='Braided routing at rest')
    return clips
