import { atan2, cos, sin } from "../lib/surf/trig.js";
import { loadTubeDeformation, requireTubeDeformation } from "./tubeDeformationChunk.js";
import { normalizeSourceAnimation } from "./sourceSidecar.js";

// The choreography half: play the clips a document's sidecar carries. A clip is
// KEYFRAMES, baked when its model built (cadgen.clip in Python, sampled by
// cadgen/_internal/animation_bake.py); this module interpolates them into raw
// per-occurrence transforms. It runs no model code, and knows nothing of mates,
// DOFs, presets, or the Pose tab: it pushes matrices and styles through the same
// effect records the viewer already composes.
//
// The section is {clips: [clip, ...]} in the model's declared order; a clip is
// {id, label, duration, loop, tracks}. A track drives ONE channel of
// the occurrences it lists (document leaf ids), with one value per time; before
// its first time and after its last it holds the end value:
//   transform  [dx, dy, dz, qx, qy, qz, qw, d'x, d'y, d'z, wx, wy, wz]: the
//              track's pivot moves by d while the part turns by q about it,
//              T(pivot + d) R(q) T(-pivot); d' is d's rate (mm/s) and w the
//              angular velocity (rad/s, world). Between keys d, and the turn
//              from the first key as a rotation vector, are cubic Hermite
//              curves: a constant spin is exact.
//   opacity    0..1, or null for the material's own; lerps between numbers.
//   visible    true, false, or null for the rest state; held.
//   tube       {path, twistDeg}, or null for the rest shape. The path is
//              {normal, segments}, or {normal, map}: the track's rest under the
//              affine map p -> A p + b, its rows [a, a, a, b] in turn (a spring
//              compressing along its axis is one; never over arcs). The path's
//              numbers lerp while its segment kinds match, and hold otherwise. The
//              track carries the tube's rest path, maxSegmentLength and braid.
// Every evaluation starts from rest: a clip is a pure function of t, so scrub,
// loop and seek are free.

/** The clips of a validated animation section, by id. `order` is each clip's
 * place in the model's declaration (the first is the one a viewer opens on): an
 * object lists integer-like keys first, whatever order they were added in. */
export function normalizeAnimationClips(block) {
  const clips = {};
  for (const [order, clip] of (block?.clips || []).entries()) {
    clips[clip.id] = {
      id: clip.id, label: clip.label || clip.id, duration: clip.duration, loop: clip.loop !== false,
      tracks: clip.tracks, order
    };
  }
  return clips;
}

/** Whether `clip` is a playable clip record. */
export function isAnimationClip(clip) {
  return Array.isArray(clip?.tracks);
}

/** Load a sidecar's clips: `{clips}`, or null when it declares none. A clip that
 * bends a tube needs the lazy tube runtime, so this waits for it once, here,
 * and evaluation stays synchronous. */
export async function loadSourceAnimation(sidecar, { signal } = {}) {
  signal?.throwIfAborted();
  const animation = normalizeSourceAnimation(sidecar?.animation);
  if (!animation) return null;
  const clips = normalizeAnimationClips(animation);
  if (Object.values(clips).some((clip) => clip.tracks.some((track) => track.tube))) {
    await loadTubeDeformation();
    signal?.throwIfAborted();
  }
  return { clips };
}

// (index of the key at or before t, fraction of the way to the next key)
function bracket(times, t) {
  const last = times.length - 1;
  if (t >= times[last]) return [last, 0];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return [lo, (t - times[lo]) / (times[hi] - times[lo])];
}

function qmul([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

// Exactly specified arithmetic only (lib/surf/trig.js, and sqrt rather than
// Math.hypot): a GLB export samples these, and its bytes must not depend on
// which engine ran it.
const norm = (...values) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));

// The rotation vector (axis * radians, world frame) that turns quaternion a into b.
function turnVector(a, b) {
  let [x, y, z, w] = qmul(b, [-a[0], -a[1], -a[2], a[3]]);
  if (w < 0) [x, y, z, w] = [-x, -y, -z, -w];
  const s = norm(x, y, z);
  if (s < 1e-12) return [2 * x, 2 * y, 2 * z];
  const angle = 2 * atan2(s, w);
  return [x / s * angle, y / s * angle, z / s * angle];
}

// Quaternion q turned further by the rotation vector v.
function turned(v, q) {
  const angle = norm(v[0], v[1], v[2]);
  const s = angle < 1e-12 ? 0.5 : sin(angle / 2) / angle;
  const out = qmul([v[0] * s, v[1] * s, v[2] * s, cos(angle / 2)], q);
  const n = norm(out[0], out[1], out[2], out[3]);
  return [out[0] / n, out[1] / n, out[2] / n, out[3] / n];
}

// A transform key's (d, q) at fraction u toward the next key, span seconds away.
// d is a cubic Hermite curve through the keys' values and rates; the turn from
// the first key is one through the zero vector and the turn to the second, with
// the keys' angular velocities, so a constant spin is a straight line there.
function transformPose(a, b, span, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = 3 * u2 - 2 * u3;
  const h11 = u3 - u2;
  const turn = turnVector(a.slice(3, 7), b.slice(3, 7));
  const d = [0, 1, 2].map((n) => h00 * a[n] + h10 * span * a[7 + n] + h01 * b[n] + h11 * span * b[7 + n]);
  const v = [0, 1, 2].map((n) => h10 * span * a[10 + n] + h01 * turn[n] + h11 * span * b[10 + n]);
  return [d, turned(v, a.slice(3, 7))];
}

function transformAt(THREE, track, index, u) {
  const key = track.transform[index];
  const [d, q] = u > 0
    ? transformPose(key, track.transform[index + 1], track.times[index + 1] - track.times[index], u)
    : [key.slice(0, 3), key.slice(3, 7)];
  const n = norm(q[0], q[1], q[2], q[3]);
  const [x, y, z, w] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
  ];
  const [px, py, pz] = track.pivot;
  const t = [0, 1, 2].map((axis) => (
    track.pivot[axis] + d[axis] - (r[axis * 3] * px + r[axis * 3 + 1] * py + r[axis * 3 + 2] * pz)
  ));
  return new THREE.Matrix4().set(
    r[0], r[1], r[2], t[0],
    r[3], r[4], r[5], t[1],
    r[6], r[7], r[8], t[2],
    0, 0, 0, 1
  );
}

const lerp = (a, b, u) => a + (b - a) * u;
const lerp3 = (a, b, u) => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];

function samePathShape(a, b) {
  return a.segments.length === b.segments.length
    && a.segments.every((segment, index) => segment.kind === b.segments[index].kind);
}

function lerpPath(a, b, u) {
  return {
    normal: lerp3(a.normal, b.normal, u),
    segments: a.segments.map((segment, index) => {
      const other = b.segments[index];
      const out = { kind: segment.kind };
      for (const [key, value] of Object.entries(segment)) {
        if (key === "kind") continue;
        out[key] = typeof value === "number" ? lerp(value, other[key], u)
          : Array.isArray(value[0]) ? value.map((point, n) => lerp3(point, other[key][n], u))
            : lerp3(value, other[key], u);
      }
      return out;
    })
  };
}

// A key's centerline: its own segments, or the track's rest under the key's
// affine map (its three rows, each a, a, a, b), worked out once per key. A line
// or a Bezier maps to the line or Bezier through the images of its points.
const mappedPaths = new WeakMap();

function keyPath(track, key) {
  if (!key.path.map) return key.path;
  let path = mappedPaths.get(key);
  if (!path) {
    const m = key.path.map;
    const image = (p) => [0, 1, 2].map((i) => m[4 * i] * p[0] + m[4 * i + 1] * p[1] + m[4 * i + 2] * p[2] + m[4 * i + 3]);
    path = {
      normal: key.path.normal,
      segments: track.rest.segments.map((segment) => (segment.kind === "line"
        ? { kind: "line", start: image(segment.start), end: image(segment.end) }
        : { kind: "bezier", points: segment.points.map(image) }))
    };
    mappedPaths.set(key, path);
  }
  return path;
}

// A held key's deformation, normalized once: a tube that rests between moves
// (a valve spring, most of an engine cycle) costs nothing per frame.
const heldTubes = new WeakMap();

function tubeAt(track, index, u) {
  const a = track.tube[index];
  if (!a) return null;
  const b = u > 0 ? track.tube[index + 1] : null;
  const runtime = requireTubeDeformation("a tube animation track");
  const spec = { rest: track.rest, maxSegmentLength: track.maxSegmentLength, ...(track.braid ? { braid: track.braid } : {}) };
  const from = keyPath(track, a);
  const to = b && keyPath(track, b);
  if (!to || !samePathShape(from, to)) {
    let held = heldTubes.get(a);
    if (!held) {
      held = runtime.normalizeTubeDeformation({ ...spec, path: from, twistDeg: a.twistDeg });
      heldTubes.set(a, held);
    }
    return held;
  }
  return runtime.normalizeTubeDeformation({ ...spec, path: lerpPath(from, to, u), twistDeg: lerp(a.twistDeg, b.twistDeg, u) });
}

/** Evaluate one clip at time t: `{matrices, styles, deformations}`, each keyed by
 * occurrence id. A looping clip wraps t; one that does not holds its end. */
export function evaluateAnimationClip(THREE, clip, t) {
  const duration = clip.duration || 1;
  let localT = Math.max(0, Number(t) || 0);
  localT = clip.loop !== false ? localT % duration : Math.min(localT, duration);
  const matrices = new Map();
  const styles = new Map();
  const deformations = new Map();
  const style = (id, key, value) => {
    const current = styles.get(id) || {};
    current[key] = value;
    styles.set(id, current);
  };
  for (const track of clip.tracks) {
    const [index, u] = bracket(track.times, localT);
    if (track.transform) {
      const matrix = transformAt(THREE, track, index, u);
      for (const id of track.targets) matrices.set(id, matrix);
    } else if (track.opacity) {
      const a = track.opacity[index];
      const b = u > 0 ? track.opacity[index + 1] : null;
      if (a === null) continue;
      const value = b === null ? a : lerp(a, b, u);
      for (const id of track.targets) style(id, "opacity", value);
    } else if (track.visible) {
      const value = track.visible[index];
      if (value === null) continue;
      for (const id of track.targets) style(id, "visible", value);
    } else if (track.tube) {
      const deformation = tubeAt(track, index, u);
      if (!deformation) continue;
      for (const id of track.targets) deformations.set(id, deformation);
    }
  }
  return { matrices, styles, deformations };
}

// Merge an evaluated frame into the viewer's per-part effect records — the same
// records the kinematics module writes through ctx.effects, so animation
// COMPOSES OVER pose without either system knowing about the other. The
// animation matrix premultiplies whatever is already there (pose first, then
// choreography on top, in world space). Returns the number of parts whose
// transform the frame touched, which is what tells the caller its edge runtimes
// need re-deriving.
export function applyAnimationFrameToEffects(THREE, effectsByPartId, frame) {
  if (!effectsByPartId || !frame) {
    return 0;
  }
  const ensureEffect = (partId) => {
    const id = String(partId || "").trim();
    if (!id) {
      return null;
    }
    const current = effectsByPartId.get(id) || {
      matrix: null,
      style: null,
      visible: null,
      highlighted: false
    };
    effectsByPartId.set(id, current);
    return current;
  };
  let transformCount = 0;
  for (const [partId, matrix] of frame.matrices || []) {
    const effect = ensureEffect(partId);
    if (!effect) {
      continue;
    }
    effect.matrix = effect.matrix
      ? new THREE.Matrix4().multiplyMatrices(matrix, effect.matrix)
      : matrix.clone();
    transformCount += 1;
  }
  for (const [partId, deformation] of frame.deformations || []) {
    const effect = ensureEffect(partId);
    if (effect) { effect.deformation = deformation; transformCount += 1; }
  }
  for (const [partId, style] of frame.styles || []) {
    const effect = ensureEffect(partId);
    if (!effect) {
      continue;
    }
    if (style && Object.hasOwn(style, "opacity")) {
      effect.style = { ...(effect.style || {}), opacity: style.opacity };
    }
    if (style && Object.hasOwn(style, "visible")) {
      effect.visible = style.visible !== false;
    }
  }
  return transformCount;
}
