# Tube deformation and morph export

Read this reference for flexible swept bodies in an animation clip, or for
exporting that deformation into GLB. The [motion reference](kinematics.md)
covers ordinary joints, poses, clip declarations and video rendering.

## Deforming an existing tube

Call `.deform_tube()` on a clip's handle for a continuous swept STEP body:

```python
# Inside a clip's update(t, m), with rest_path and posed_path built for this t:
m.get("#tendon").deform_tube(
    rest=rest_path,
    path=posed_path,
    twist_deg=0,
    max_segment_length=1,
)
```

Both paths are `{"normal": [x, y, z], "segments": [...]}` dicts in assembly
coordinates. `normal` is a required transverse frame seed on each path.
Segments must connect tangentially:

| Segment | Fields |
| --- | --- |
| Line | `{"kind": "line", "start": ..., "end": ...}` |
| Arc | `{"kind": "arc", "center": ..., "axis": ..., "start": ..., "sweepDeg": ...}` |
| Cubic Bezier | `{"kind": "bezier", "points": [p0, p1, p2, p3]}` |

Positions are `[x, y, z]` millimetres; angles are degrees. Normalized arc length
maps the rest path to the posed path. Check tendon length, bend radius and
collisions separately: deformation does not solve those constraints.
`twist_deg` rotates authored cross-sections; it does not calculate spool payout.

Only `path` and `twist_deg` move during a clip: `rest`, `max_segment_length`
and `braid` stay the same in every sample that deforms the tube, and the build
refuses a clip that changes them. Use `.rotate()` or `.translate()` for rigid
motion. A sample that does not call `.deform_tube()` shows the tube at rest.
Between keyframes the path's numbers blend while its segments keep their kinds;
a change of segment kinds (a line becoming an arc) switches between two samples.

A path that is its rest under one affine map is stored as that map, twelve
numbers a keyframe, rather than as a copy of the whole centerline. A coil spring
built from lines and Beziers whose turns all close up alike as it compresses
gets this automatically. Arcs never map, and a spring whose end turns hold still
while its middle closes stores whole paths, many times larger.

`max_segment_length` controls one-time longitudinal mesh refinement in
millimetres (default `1`, minimum `0.05`). The rest mesh, normals and topology
remain continuous, and shared source buffers remain immutable.

Optional `braid={"pitch": 0.8, "depth": 0.02, "strands": 8}` adds procedural
fiber color and normal relief over the swept core. Pitch and depth are
millimetres; the strand count must be even. This is a surface finish, not
additional CAD or collision geometry.

## Exporting deformation to GLB

Animated GLB refuses tube deformation by default. Request morph targets explicitly:

```bash
cadgen glb build STEP/hand.step GLB/animated/hand.glb \
  --animation '{"clip": "fist", "fps": 24, "seconds": 6,
                "deform": "morph", "deformTolerance": 1.0}'
```

Each deforming node gets per-vertex position and normal deltas against one base
mesh, plus a weights channel. Morph weights blend whole poses, so between baked
poses the file can differ from the clip's own deformation. The exporter fits
targets per occurrence against `deformTolerance` (millimetres, default `1.0`,
range `0.01`..`10`), checking a grid four times finer than `fps`, at least
96 Hz. This sampled check is not a continuous-time error guarantee. The export
summary reports `targets`, `bytes`, `runtimeBytes`, `deviationMm` and
`fitGridHz`.

The exporter refuses a bake exceeding 512 MiB of estimated morph playback
memory: 32 bytes per vertex per target, or 16 without normals. To reduce it,
relax `deformTolerance`, shorten `seconds`, increase `--mesh-tolerance`, or
increase the clip's `max_segment_length`, as the required fidelity permits.

Limitations:

- Procedural braid shading is not exported. The GLB retains the tube's geometry
  and motion with a smooth surface.
- A tube held in a constant deformed pose exports in that pose without morph
  targets. `"deform": "rest"` instead explicitly freezes tubes at rest and warns;
  use it only when that is the intended output.

The CAD Viewer plays a GLB's morph animation; the braid finish stays with the
STEP and its sidecar. Render a video when the output needs effects GLB cannot
carry; see [motion review](kinematics.md#reviewing-motion).
