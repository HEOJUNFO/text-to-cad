# Meshing, the tape, and review

Read this when choosing a resolution, re-meshing a saved part, or explaining
what the written files contain.

## How a part becomes a mesh

The field is sampled on a grid of cells of size `resolution` over the part's
bounds (padded by two cells), and contoured with surface nets: one vertex per
cell the surface crosses, placed where the tangent planes at the cell's edge
crossings meet (dual contouring's placement), so box edges and hole rims come
out sharp; one quad per crossed grid edge. The mesh is closed and outward
facing by construction. Normals come from the field's gradient, so curved
surfaces shade smoothly at any grid size; an edge whose two faces disagree by
more than `crease_deg` (35° by default) is creased.

The cost is the grid: halving the resolution multiplies samples by eight. A
30 mm part at 0.5 mm is about 100k samples and a fraction of a second; at
0.1 mm it is 30M samples and many seconds. The engine refuses a grid over
40M samples and says which resolution would fit.

**Choosing a resolution**

| Need | Cell size |
| --- | --- |
| a quick look | the default (diagonal / 120) |
| holes and walls read true | ≤ a third of the smallest hole radius or wall |
| a print-ready STL | 0.2–0.3 mm for FDM, finer only for resin |

Set it in the decorator for the maintained output; override for one run with
`python part.py --resolution R`, or re-mesh from the tape.

## The tape

Running a part writes `<stem>.implicit.json` beside its first output: the
field as data (every leaf, transform and boolean with its numbers), the
bounds, the resolution used, and the leaf table. It stands alone: a tape can
be re-meshed, measured and probed with no source present.

```bash
cadgen implicit build GLB/housing.implicit.json                         # re-mesh in place at the tape's resolution
cadgen implicit build GLB/housing.implicit.json STL/housing.stl --resolution 0.25
cadgen implicit build GLB/housing.implicit.json --crease-deg 20 --json
```

A part that uses `im.custom(...)` carries a Python function and writes no
tape; its script is the only way to re-mesh it, and the build result says so.

## What the files hold

- **GLB**: Y-up glTF, one node per leaf, named by the leaf's label (else
  `<kind>@<file:line>`), each with its own colour, plus extras naming the leaf
  id, kind, label and source line. The viewer lists those nodes and shows the
  colours; picking one names the code that made it.
- **STL**: binary, flat-shaded, one solid. No names or colours survive an STL.
- **Tape**: see above. Keep it beside the GLB; it is the part's editable form
  once the script is gone.

`cadgen stl build` / `glb build` are STEP doors and do not apply here; use
`cadgen implicit build` for another format or resolution.

## STEP

A field has no faces, but its tree describes a B-rep, and the part writes
one when asked: add a `.step` to `out` and the script builds the B-rep with
build123d beside the mesh, with the field's blends as OCC fillets. This is
the form to use when the user wants faces and edges in the viewer, the
STEP tools (face selection, measure, references), or a file for CNC and
drawings.

```python
@im.part(out=["GLB/housing.glb", "STEP/housing.step"], resolution=0.5)
```

```bash
cadgen implicit step GLB/housing.implicit.json                      # from a saved tape: <stem>.step beside it
cadgen implicit step GLB/housing.implicit.json STEP/housing.step --blends drop
```

Translated exactly: every primitive (a box's `radius` and a cylinder's
`radius_edge` become fillets), sharp `|`/`&`/`-`, translate, rotate, scale,
mirror, repeat, offset and shell (OpenCascade's offset, which can refuse a
shape it dislikes; the error names the node). A boolean's `round`/`chamfer`
becomes a fillet or chamfer on the edges that boolean made; when OpenCascade
refuses it the radius is halved up to three times, then each tool's edges
are tried alone, and a join it still refuses is left sharp with a warning
that names it. `--blends drop` leaves every blend sharp and lists them;
`--blends refuse` fails instead. Refused always, naming the node: `elongate`
and `custom`. Read the warnings: a STEP with a dropped blend differs from
the mesh at that join, and the report must say so.

Building the B-rep costs what a `$cad` build costs (a few seconds, mostly
the kernel import), so declare the STEP when the user wants one rather than
on every part.

In a `$cad` model, `im.to_brep(field)` returns the build123d shape, so an
implicit part can be composed into a STEP assembly or filleted with B-rep
tools from there.

## Reviewing

```bash
cadgen glb snapshot GLB/housing.glb tmp/housing.png
cadgen glb snapshot GLB/housing.glb tmp/housing-under.png --camera bottom
cadgen stl snapshot STL/housing.stl tmp/housing-stl.png
```

Look for: a feature that vanished (resolution too coarse), a faceted curve
(too coarse for the radius), a stray shell or floating piece (a boolean that
did not join — check `round` reach, or that a translated feature overlaps its
base), and the leaf colours landing where the request said. Then hand the GLB
to `$cad-viewer`.
