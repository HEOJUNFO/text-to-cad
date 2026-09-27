---
name: implicit
description: Model parts as signed distance fields with cadgen — every shape is a function of distance, booleans are min/max, fillets and shells are offsets — mesh them to GLB/STL for printing, and answer wall-thickness, clearance and interference questions on the field itself. Use for organic or blended shapes, lattice-like repeats, shells, "smooth union", "SDF geometry", "implicit modeling", or when a boolean-heavy part keeps failing in B-rep CAD. Not for STEP output (use $cad) and not for SDFormat robot files (use $sdf).
---

# Implicit: parts as signed distance fields

Provenance: maintained in [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad).
Use the installed local skill files as the runtime source of truth.

A part is a Python script that returns a **field**: for any point, the signed
distance to the part's surface (negative inside, positive outside). Primitives
are exact distances, booleans are arithmetic on them (union is `min`,
intersection `max`, subtraction `max(a, -b)`), and a fillet, a shell or an
offset is a number added to the field. Nothing can fail the way a B-rep boolean
fails: every combination of fields is a field. The price is that the output is
a **mesh**, not a STEP — it prints, renders and measures, and it never carries
exact faces or edges.

Every primitive in the script is a **leaf**, and every point on the part knows
which leaf's surface it is on. The written GLB has one node per leaf, named by
the label you gave it and carrying the script line that made it, so a face the
user picks in the viewer maps back to your code.

## Start with the task

| Task | First action | Reference |
| --- | --- | --- |
| **Create or edit a part** | Write or edit the decorated script below; run `python <part>.py`. | [Modeling](references/modeling.md) |
| **Measure walls, clearance, interference** | Ask the field in Python, or run `cadgen implicit measure` on the saved tape. | [Questions](references/questions.md) |
| **Re-mesh finer or coarser, or as STL** | `cadgen implicit build <tape> [OUT] --resolution R` — no source needed. | [Meshing](references/meshing.md) |
| **Review the result** | Snapshot the GLB; hand it to `$cad-viewer`. | [Meshing](references/meshing.md#reviewing) |
| **Need a STEP, faces and edges in the viewer, or a drawing** | Add a `.step` to the part's `out`, or run `cadgen implicit step <tape>`: the B-rep is built with the field's blends as fillets. Edits on faces after that are `$cad` work. | [Meshing](references/meshing.md#step) |

## Setup

`requirements.txt` pins `cadgen`; install it with the project interpreter.
The implicit engine needs nothing beyond that (numpy only), so it runs in every
cadgen install. Snapshots need Chromium (`python -m playwright install chromium`).

Units are whatever the script uses — millimetres by convention. Z is up. A
resolution is the size of one grid cell in those units.

## Create or edit a part

```python
from cadgen import implicit as im


@im.part(out="GLB/housing.glb", resolution=0.5)
def housing():
    body = im.box((30, 30, 20), radius=2).named("body")
    bore = im.cylinder(radius=8, height=40).named("bore")
    boss = im.cylinder(radius=5, height=8).translate(0, 0, 14).named("boss")
    holes = im.cylinder(radius=1.6, height=30).translate(11, 11, 0).mirror("x").mirror("y").named("holes")
    return im.union(body - bore, boss, round=1.5) - holes


if __name__ == "__main__":
    housing()
```

```bash
python src/housing.py                       # writes GLB/housing.glb and GLB/housing.implicit.json
python src/housing.py --resolution 0.25     # finer, this run only
python src/housing.py --json                # the build result as one JSON line
```

- **One decorated part per script**, its `out` sharing the script's stem.
  `out` is `.glb` or `.stl`, or a list, relative to the script; omitted,
  `<stem>.glb` beside it. Add a `.step` to the list when the user wants a
  B-rep (faces and edges in the viewer, a file for CNC). A **tape**
  (`<stem>.implicit.json`, the field as data) is written beside the first mesh.
- **Name every leaf you would want to point at** with `.named("...")`: the
  name becomes the GLB node the user sees and selects. Naming a moved or
  unioned group names every unnamed leaf inside it.
- **Choose the resolution from the smallest feature**: a cell should be at
  most a third of the smallest wall or hole radius. The default is a 1/120th of
  the part's diagonal. Finer costs cubically; re-mesh finer from the tape only
  when the review needs it.
- **Compose** by calling another part's decorated function inside a body: it
  returns that part's field. A field is immutable; every method returns a new one.
- Keep dimensions as named constants at the top, as in `$cad`.

The field vocabulary — primitives, 2D profiles for extrude and revolve,
placement, offsets, shells, rounds, chamfers and repeats — is in
[modeling.md](references/modeling.md).

## Verify and hand off

After writing or changing a part:

1. Run the script and read its result lines: triangle count, cell size, the
   leaf table. A warning that nothing was contoured means the field has no
   surface inside its bounds (a half space used alone, a custom field with wrong
   bounds, an intersection that misses).
2. Measure what the request specified. Wall thickness, clearance to another
   field and enclosed volume are all one call each; see
   [questions.md](references/questions.md).

   ```bash
   cadgen implicit measure GLB/housing.implicit.json --walls --at 0,0,0
   ```

3. Snapshot and look:

   ```bash
   cadgen glb snapshot GLB/housing.glb tmp/housing.png
   ```

4. Hand `GLB/housing.glb` to `$cad-viewer` when installed and include its link.

Report the output files, the resolution, the measurements you took with their
resolution (every number is exact only to a cell), and, when a STEP was
written, any blend it left sharp (the build result's warnings say which).

## Commands

Run `cadgen` from the environment `requirements.txt` was installed into
(`python -m cadgen.cli <verb>` is the PATH-independent form). Both verbs work
on a saved tape, never on the script:

```bash
cadgen implicit build GLB/housing.implicit.json                     # re-mesh in place
cadgen implicit build GLB/housing.implicit.json STL/housing.stl --resolution 0.25
cadgen implicit measure GLB/housing.implicit.json --walls --at 14,14,0 --json
cadgen implicit step GLB/housing.implicit.json STEP/housing.step    # the B-rep, blends as fillets
```

`--help` on either lists the current flags.

## References

- Field vocabulary and modeling patterns: [modeling.md](references/modeling.md)
- Questions on the field (thickness, clearance, interference, probes): [questions.md](references/questions.md)
- Meshing, resolution, the tape, GLB nodes, review: [meshing.md](references/meshing.md)
