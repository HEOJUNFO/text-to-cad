# Flexible tube animation

A tube track animates a continuous tube or hollow sheath already present as a
swept STEP body. The model's Python clip authors it with
`m.get(target).deform_tube(rest=..., path=..., twist_deg=0, max_segment_length=1, braid=None)`,
and the build bakes it into the sidecar as a `tube` track: one `{path, twistDeg}`
(or `null`, the rest shape) per key, with the track's `rest`, `maxSegmentLength`
and optional `braid`, which stay constant through a clip. A key's path is its
own `{normal, segments}`, or `{normal, map}` when the clip's path is the rest
under one affine map, as a coil spring compressing along its axis is: `map` is
that map's three rows `[a, a, a, b]` in turn, twelve numbers in place of the
whole centerline, and the runtime maps the rest's points with it before it
interpolates. Arcs never map. The runtime deforms
the original surface and its CAD edge lines in the same shared pass used by CAD
Viewer and snapshots. It does not create a replacement rope or change the STEP
artifact. Subsequent rigid occurrence transforms act on the deformed result.
The paths use assembly coordinates before those transforms.

```python
rest = {"normal": [0, 0, 1], "segments": [{"kind": "line", "start": [0, 0, 0], "end": [10, 0, 0]}]}
bent = {
    "normal": [0, 0, 1],
    "segments": [{"kind": "arc", "center": [0, 5, 0], "axis": [0, 0, 1], "start": [0, 0, 0], "sweepDeg": 90}],
}


def bend(t, m):  # a clip's update(t, m)
    m.get("#tendon").deform_tube(rest=rest, path=bent, twist_deg=360 * t)
```

Each path is `{normal, segments}`. `normal` is REQUIRED on both the rest and
the posed path: it seeds the transverse frame at the first point (projected
perpendicular to the first tangent; later frames use parallel transport). There
is no default — a guessed seed would flip as the first tangent turns during an
animation and twist the tube by 90 degrees in one frame — so an omitted or
tangent-parallel `normal` throws. Every segment must meet the next at the same
position and tangent. Discontinuities and corners throw a teaching error.

The closed segment vocabulary is:

- `{kind:'line', start:[x,y,z], end:[x,y,z]}`
- `{kind:'arc', center:[x,y,z], axis:[x,y,z], start:[x,y,z], sweepDeg}`.
  Axis is a nonzero normal. Sweep is signed, nonzero, and at most 360 degrees.
  Start lies in the circle plane and determines its radius.
- `{kind:'bezier', points:[p0,p1,p2,p3]}`. This is a cubic Bézier with four
  finite vec3 control points. It uses adaptive five-point quadrature for length
  and numerical parallel transport; stationary tangents and cusps are errors.

The runtime projects each original mesh vertex onto the analytic rest
centerline and retains its longitudinal coordinate and transverse offsets.
Normalized arc length maps to the posed path; length changes therefore stretch
or contract the visible tube. This is a display mapping, **not a tendon tension,
spool payout, friction, collision, or constant-length solver**. An author must
solve those mechanics and pass the resulting centerline. Tube thickness remains
unchanged. `twistDeg` rotates each cross-section in its transported frame; it can
show phase travel in an authored helical braid without moving the centerline.
It does not itself simulate material payout.

The source STEP tessellation is immutable. Each occurrence retains a rest
mesh and one reusable displayed mesh; unchanged component buffers remain shared.
Straight STEP surfaces may contain only
end rings, so the runtime first splits their existing triangles into bands of
at most `maxSegmentLength` mm in rest arc length. This preserves the exact rest
surface, interpolates attributes, preserves CAD face picking, and prevents an
animated bend becoming a single end-to-end chord. The default is 1 mm; values
below 0.05 mm are rejected. A per-occurrence 700,000-triangle ceiling throws
instead of exhausting memory. Refinement is cached until the rest path or band
length changes. Original smooth normals are transformed by the deformation's
local inverse-transpose; silhouettes and technical edges follow the surface.

Every evaluation starts from rest. A `null` key (a sample that bent no tube)
or clearing animation restores the rest shape. Between two keys whose paths
have the same segment kinds, every number of the path and the twist is
interpolated linearly; otherwise the earlier key holds. Shared component meshes
are never mutated. A changed centerline can be independently inspected without
a renderer: `evaluateAnimationClip(THREE, clip, t)` returns `deformations`,
keyed by occurrence ID. A deformation is the NUMBERS — `restSpec`, `pathSpec`,
`twistDeg`, `maxSegmentLength`, `braid` — validated and owned, never the
sidecar's arrays and never a compiled path: a morph bake fits on a 96 Hz grid,
and a sample that held its two arc-length tables would hold hundreds of KB per
tube per grid sample.
`compileDeformation` resolves the two paths through a bounded LRU, for as long
as the caller is posing with them; `sameTubeDeformation` and `sameTubeRestShape`
compare two deformations by value. `compileTubePath`, `sampleTubePath`, and
`projectTubePath` are exported from `common/tubeDeformation.js`. Line and circle lengths/curvature are analytic;
`minRadius` for a Bézier is a sampled diagnostic and must not substitute for an
independent curvature gate. As with any CAD tessellation, a finite surface mesh
approximates the analytic posed centerline between its vertices.

For a smooth CAD core, `braid:{pitch:0.8, depth:0.02, strands:8}` adds a
procedural braided surface finish. Pitch and normal-relief depth are millimetres;
strands is an even carrier count from 2 to 64. Crossing helices, fine fiber
lines and lighting relief use rest material coordinates and follow
`twistDeg` as the tube deforms. This is a GPU normal/color finish, **not added
CAD fiber bodies or collision geometry**; it remains inside the nominal core's
rendered envelope. No image texture is fetched and no helical solids are
created. The finish is scoped to that occurrence's material and disabled when
the effect is omitted. The original material's source color and shader hooks
remain in force. Both shader stages — the GPU vertex transport and the braid
finish — install through one shared hook (`tubeMaterialShader.js`) that runs
them in a fixed order and hands the braid its rest coordinates through one
varying, so enabling the braid on a later frame than the deformation renders
the same as enabling both at once.

## The runtime is a lazy chunk

A tube track is the only producer of a tube deformation anywhere in this
package — a step module's effects carry only what an animation frame already
put there — so a document whose clips have no tube track can never reach this
code and must never download it. `common/tubeDeformationChunk.js` is the
boundary: `tubeDeformation.js`, `tubeGpuDeformation.js`, `tubeBraidMaterial.js`
and `tubeMaterialShader.js` load behind one dynamic import, ~29 kB out of the
CAD Viewer's initial bundle.

The load happens at the single async door every clip passes through:
`loadSourceAnimation` (which `mesh-export.mjs` uses too) awaits it, once, when
some clip of the document has a tube track, before a clip exists to be
evaluated. The keyframes say up front whether a tube ever bends, so a frame
never falls back to the rest pose while the chunk loads. Evaluation itself
stays synchronous and always sees a loaded runtime.

Callers outside the animation path — the scene's effect resets, the display
edge-line pass — go through `tubeDeformation()`, which answers `null` until the
chunk lands. That is exact rather than merely tolerant: every one of those
calls is a reset or a replay, and a record can only hold tube state after a
deformation was applied. A tube track's evaluation cannot no-op, so it throws
through `requireTubeDeformation` instead. Code that builds clips by hand rather
than through `loadSourceAnimation` — tests, mostly — awaits
`loadTubeDeformation()` first.
