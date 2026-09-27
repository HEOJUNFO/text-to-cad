"""The public ``implicit`` namespace: parts as signed distance fields.

Every shape is a function from a point to its signed distance (negative
inside), booleans are arithmetic on those distances, and a spatial question
("how far apart", "how thick", "do they touch") is an expression over the
same fields the part is made of. A part is a Python script:

    from cadgen import implicit as im

    @im.part(out="GLB/housing.glb", resolution=0.5)
    def housing():
        body = im.box((30, 30, 20), radius=2).named("body")
        bore = im.cylinder(radius=8, height=40).named("bore")
        return body - bore

    if __name__ == "__main__":
        housing()

Running the script contours the field with surface nets and writes the
declared mesh(es) plus a *tape* (``<stem>.implicit.json``: the field as
data) beside them. Two verbs, each mirrored by a generated CLI, work on a
tape afterwards: ``build`` re-meshes it, ``measure`` reports volume, area,
wall thickness and point probes, and ``step`` writes the B-rep of the tree's
exact subset (primitives, sharp booleans, rigid transforms, offsets) as STEP. Every mesh vertex knows the *leaf* (the
primitive in the author's code) it belongs to; the GLB is one node per leaf.

Import discipline: numpy only, and lazily at the verbs. Nothing here may
pull in the CAD kernel -- ``--help`` must stay cheap.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Sequence

from cadgen.results import ImplicitBuildResult, ImplicitMeasureResult, ImplicitStepResult

if TYPE_CHECKING:  # pragma: no cover - typing only
    from cadgen._internal.implicit.field import Bounds, Field, Profile

# The namespace's VERBS, the ones `cadgen implicit <verb>` mirrors. The DSL below
# (primitives, booleans, questions, the @part decorator) is the library half:
# reached as `im.box(...)` after `from cadgen import implicit as im`, and kept
# out of __all__ because a namespace exports exactly its verbs.
__all__ = ["build", "measure", "step"]


# --------------------------------------------------------------------------- #
# The DSL. Thin factories over the engine's classes, so an author's script reads
# as geometry and the class names stay an implementation detail.
# --------------------------------------------------------------------------- #


def sphere(radius: float, *, label: str | None = None) -> Field:
    """A sphere of ``radius`` at the origin."""
    from cadgen._internal.implicit.field import Sphere

    return Sphere(radius, label=label)


def box(size: Sequence[float] | float, radius: float = 0.0, *, label: str | None = None) -> Field:
    """A box of ``size`` (one number or three) centred at the origin; ``radius`` rounds every edge."""
    from cadgen._internal.implicit.field import Box

    return Box(size, radius, label=label)


def cylinder(radius: float, height: float, radius_edge: float = 0.0, *, label: str | None = None) -> Field:
    """A cylinder along Z, centred; ``radius_edge`` rounds the two rims."""
    from cadgen._internal.implicit.field import Cylinder

    return Cylinder(radius, height, radius_edge, label=label)


def capsule(a: Sequence[float], b: Sequence[float], radius: float, *, label: str | None = None) -> Field:
    """A sphere-swept segment from ``a`` to ``b``."""
    from cadgen._internal.implicit.field import Capsule

    return Capsule(a, b, radius, label=label)


def cone(radius_bottom: float, radius_top: float, height: float, *, label: str | None = None) -> Field:
    """A truncated cone along Z, centred: ``radius_bottom`` at the base, ``radius_top`` at the top."""
    from cadgen._internal.implicit.field import Cone

    return Cone(radius_bottom, radius_top, height, label=label)


def torus(radius: float, tube: float, *, label: str | None = None) -> Field:
    """A torus in the XY plane: ``radius`` to the tube's centre line, ``tube`` its radius."""
    from cadgen._internal.implicit.field import Torus

    return Torus(radius, tube, label=label)


def half_space(normal: Sequence[float] = (0.0, 0.0, 1.0), origin: Sequence[float] = (0.0, 0.0, 0.0), *, label: str | None = None) -> Field:
    """The half of space ``normal`` points into, from the plane through ``origin``: a cutting tool, never a part on its own.

    ``part - half_space((0, 0, 1), (0, 0, 10))`` removes everything above z = 10.
    """
    from cadgen._internal.implicit.field import HalfSpace

    return HalfSpace(normal, origin, label=label)


def extrude(profile: Profile, height: float, *, label: str | None = None) -> Field:
    """A 2D profile extruded along Z by ``height``, centred."""
    from cadgen._internal.implicit.field import Extrude

    return Extrude(profile, height, label=label)


def revolve(profile: Profile, *, label: str | None = None) -> Field:
    """A 2D profile drawn in the (radius, z) half-plane, revolved about Z."""
    from cadgen._internal.implicit.field import Revolve

    return Revolve(profile, label=label)


def custom(fn, bounds, *, label: str | None = None) -> Field:
    """Any distance function ``fn(points (N, 3)) -> (N,)`` with declared ``bounds`` ((min), (max)).

    It meshes and measures like a primitive, but cannot be written to a tape.
    """
    from cadgen._internal.implicit.field import Custom

    return Custom(fn, bounds, label=label)


def from_step(path, *, label: str | None = None) -> Field:
    """A STEP (or STP) as a leaf: the way an existing part enters the field.

    Its distance is evaluated from the B-rep's surface, exact to a small
    fraction of the grid cell; the B-rep itself is kept, so a sharp boolean
    with it leaves as an exact STEP through ``step``/``to_brep``. The tape
    records the file, relative to itself, so keep them together.
    """
    from cadgen import build123d as bd
    from cadgen._internal.implicit.field import Brep

    return Brep(bd.import_step(str(path)), source=str(path), label=label)


def from_shape(shape, *, label: str | None = None) -> Field:
    """A build123d shape as a leaf (a ``$cad`` model's result, say). Not tapeable: it has no file."""
    from cadgen._internal.implicit.field import Brep

    return Brep(shape, label=label)


def circle(radius: float) -> Profile:
    from cadgen._internal.implicit.field import Circle

    return Circle(radius)


def rect(width: float, height: float, radius: float = 0.0) -> Profile:
    """A ``width`` by ``height`` rectangle centred at the origin, corners rounded by ``radius``."""
    from cadgen._internal.implicit.field import Rect

    return Rect(width, height, radius)


def polygon(points: Sequence[Sequence[float]]) -> Profile:
    """A simple polygon from ``(x, y)`` vertices in either winding."""
    from cadgen._internal.implicit.field import Polygon

    return Polygon(points)


def regular_polygon(sides: int, radius: float) -> Profile:
    """``sides`` sides with a vertex at ``(radius, 0)`` (a hex socket is ``regular_polygon(6, r)``)."""
    from cadgen._internal.implicit.field import RegularPolygon

    return RegularPolygon(sides, radius)


def union(*fields: Field, round: float = 0.0, chamfer: float = 0.0) -> Field:
    """The union of the fields (``a | b``); ``round`` fillets the joins by that radius, ``chamfer`` bevels them."""
    from cadgen._internal.implicit import field as engine

    return engine.union(*fields, round=round, chamfer=chamfer)


def intersect(*fields: Field, round: float = 0.0, chamfer: float = 0.0) -> Field:
    """The intersection of the fields (``a & b``)."""
    from cadgen._internal.implicit import field as engine

    return engine.intersect(*fields, round=round, chamfer=chamfer)


def subtract(base: Field, *tools: Field, round: float = 0.0, chamfer: float = 0.0) -> Field:
    """``base`` with every tool removed (``a - b``); ``round`` fillets the cut edges."""
    from cadgen._internal.implicit import field as engine

    return engine.subtract(base, *tools, round=round, chamfer=chamfer)


def clearance(a: Field, b: Field, *, resolution: float | None = None) -> dict:
    """The least distance from ``a``'s surface to ``b``; negative means they interpenetrate by that much."""
    from cadgen._internal.implicit.measure import clearance as _clearance

    return _clearance(a, b, resolution=resolution)


def interference(a: Field, b: Field, *, resolution: float | None = None) -> dict:
    """The volume two solids share and where it is; zero when they are apart."""
    from cadgen._internal.implicit.measure import interference as _interference

    return _interference(a, b, resolution=resolution)


def thickness(field: Field, *, resolution: float | None = None) -> dict:
    """Wall thickness: the thinnest and thickest walls and where they are."""
    from cadgen._internal.implicit.measure import thickness as _thickness

    return _thickness(field, resolution=resolution)


def probe(field: Field, points) -> list[dict]:
    """Signed distance, owning leaf and normal at each point."""
    from cadgen._internal.implicit.measure import probe as _probe

    return _probe(field, points)


def contour(field: Field, *, resolution: float | None = None, crease_deg: float = 35.0) -> Mesh:
    """Mesh the field (surface nets); the same call every output goes through."""
    from cadgen._internal.implicit.mesh import contour as _contour

    return _contour(field, resolution=resolution, crease_deg=crease_deg)


def to_brep(field: Field, *, blends: str = "fillet"):
    """The build123d shape of a field, for a ``$cad`` model to compose or export.

    Primitives, sharp booleans, translate/rotate/scale/mirror/repeat, offset and
    shell translate exactly. A boolean's ``round``/``chamfer`` becomes an OCC
    fillet or chamfer on the edges the boolean made (``blends="fillet"``, the
    default; a refused fillet is retried smaller, then per tool, then left
    sharp), is left sharp (``"drop"``), or is refused naming the node
    (``"refuse"``). ``elongate`` and ``custom`` are always refused.
    """
    from cadgen._internal.implicit.brep import to_brep as _to_brep

    return _to_brep(field, blends=blends)


def part(func=None, *, out=None, resolution: float | None = None, crease_deg: float = 35.0):
    """Declare an implicit part: the decorated function returns a Field.

    A top-level call writes the declared ``out`` files and a tape beside the
    mesh; a call from another part's body returns the field to compose with.
    ``out`` is ``.glb`` or ``.stl`` (one or a list), plus ``.step`` for the
    part's B-rep with the blends as fillets; omitted, ``<stem>.glb`` beside
    the script. ``resolution`` is the grid cell size.
    """
    from cadgen._internal.implicit.authoring import part as _part

    return _part(func, out=out, resolution=resolution, crease_deg=crease_deg)


def __getattr__(name: str):
    if name in {"Field", "Bounds", "Profile"}:
        from cadgen._internal.implicit import field as engine

        return getattr(engine, name)
    if name == "Mesh":
        from cadgen._internal.implicit.mesh import Mesh

        return Mesh
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# --------------------------------------------------------------------------- #
# The verbs (mirrored by `cadgen implicit build` / `cadgen implicit measure`).
# --------------------------------------------------------------------------- #


def build(
    tape: Path,
    out: Path | None = None,
    *,
    resolution: float | None = None,
    crease_deg: float = 35.0,
    verbose: bool = False,
) -> ImplicitBuildResult:
    """Re-mesh a saved implicit part from its tape.

    tape: the part's ``.implicit.json``, written beside its mesh by the script.
    out: the mesh to write, ``.glb`` or ``.stl``. Omitted, ``<tape stem>.glb``
        beside the tape (overwriting what the script wrote).
    resolution: grid cell size in the part's units. Omitted, the tape's own.
    crease_deg: the normal angle past which an edge shades sharp.
    verbose: show timings on stderr.
    """
    import sys
    import time

    from cadgen._internal.implicit.mesh import contour as _contour
    from cadgen._internal.implicit.tape import TAPE_SUFFIX, read_tape
    from cadgen._internal.implicit.writers import write_glb, write_stl
    from cadgen.results import ImplicitOutput

    tape = Path(tape)
    if not tape.name.endswith(TAPE_SUFFIX):
        raise ValueError(f"expected a tape ({TAPE_SUFFIX}), got {tape.name}")
    field, header = read_tape(tape)
    name = str(header.get("name") or tape.name[: -len(TAPE_SUFFIX)])
    if out is None:
        out = tape.with_name(tape.name[: -len(TAPE_SUFFIX)] + ".glb")
    out = Path(out)
    fmt = out.suffix.lower()[1:]
    if fmt not in ("glb", "stl"):
        raise ValueError(f"out must be .glb or .stl, got {out.suffix!r}")
    cell = resolution if resolution is not None else header.get("resolution")
    t0 = time.perf_counter()
    mesh = _contour(field, resolution=cell, crease_deg=crease_deg)
    (write_glb if fmt == "glb" else write_stl)(mesh, out, name=name)
    if verbose:
        print(f"[cadgen] contoured {name} in {mesh.timings.get('total_s', 0):.2f}s on a {mesh.grid} grid", file=sys.stderr)
    warnings = () if mesh.triangle_count else ("the field has no surface inside its bounds: nothing was contoured",)
    return ImplicitBuildResult(
        ok=mesh.triangle_count > 0,
        name=name,
        outputs=(ImplicitOutput(path=out, fmt=fmt),),
        tape=tape,
        resolution=mesh.resolution,
        grid=mesh.grid,
        triangles=mesh.triangle_count,
        vertices=mesh.vertex_count,
        leaves=tuple(header.get("leaves", ())),
        bounds={"min": list(mesh.bounds.min), "max": list(mesh.bounds.max)} if mesh.bounds else {},
        timings={**mesh.timings, "total_s": time.perf_counter() - t0},
        warnings=warnings,
    )


def measure(
    tape: Path,
    *,
    resolution: float | None = None,
    at: tuple[str, ...] = (),
    walls: bool = False,
    verbose: bool = False,
) -> ImplicitMeasureResult:
    """Measure a saved implicit part: bounds, volume, area, centroid, its leaves, and point probes.

    tape: the part's ``.implicit.json``.
    resolution: the grid cell size the answers are taken at. Omitted, the tape's own.
    at: a point to probe as ``x,y,z`` (repeatable): its signed distance to the
        part, whether it is inside, and which leaf's surface is nearest.
    walls: also search for the thinnest and thickest walls (slower).
    verbose: show timings on stderr.
    """
    import sys

    from cadgen._internal.implicit.measure import measure as _measure
    from cadgen._internal.implicit.measure import probe as _probe
    from cadgen._internal.implicit.measure import thickness as _thickness
    from cadgen._internal.implicit.tape import TAPE_SUFFIX, read_tape

    tape = Path(tape)
    field, header = read_tape(tape)
    name = str(header.get("name") or tape.name)
    cell = resolution if resolution is not None else header.get("resolution")
    points = []
    for text in at:
        parts = [p.strip() for p in str(text).replace(";", ",").split(",")]
        if len(parts) != 3:
            raise ValueError(f"--at expects x,y,z, got {text!r}")
        points.append([float(p) for p in parts])
    facts = _measure(field, resolution=cell)
    if verbose:
        print(f"[cadgen] measured {name} on {facts['triangles']} triangles at {facts['resolution']:g}", file=sys.stderr)
    walls_facts = _thickness(field, resolution=cell) if walls else {}
    probes = _probe(field, points) if points else []
    return ImplicitMeasureResult(
        ok=True,
        tape=tape,
        name=name,
        resolution=float(facts["resolution"]),
        bounds=facts["bounds"],
        volume=float(facts["volume"]),
        surface_area=float(facts["surface_area"]),
        centroid=tuple(facts["centroid"]),
        leaves=tuple(facts["leaves"]),
        thickness=walls_facts,
        probes=tuple(probes),
    )


def step(
    tape: Path,
    out: Path | None = None,
    *,
    blends: str = "fillet",
    verbose: bool = False,
) -> ImplicitStepResult:
    """Write a saved implicit part as STEP: its B-rep, with the field's blends as fillets.

    Primitives, sharp booleans, rigid transforms, uniform scale, mirror,
    repeat, offset and shell translate exactly (the STEP's volume matches the
    mesh's). A boolean's round or chamfer becomes an OCC fillet or chamfer on
    the edges that boolean made; ``elongate`` and a custom field are refused.

    tape: the part's ``.implicit.json``.
    out: the ``.step`` to write. Omitted, ``<tape stem>.step`` beside the tape.
    blends: fillet (round each blended join with OCC, retrying smaller, then
        per tool, then leaving it sharp with a warning), drop (leave every
        blend sharp and list them), or refuse (fail naming the node).
    verbose: show progress on stderr.
    """
    import sys

    from cadgen._internal.implicit.brep import BrepReport, solids_of, to_brep as _to_brep, volume_of
    from cadgen._internal.implicit.tape import TAPE_SUFFIX, read_tape

    tape = Path(tape)
    field, header = read_tape(tape)
    name = str(header.get("name") or tape.name[: -len(TAPE_SUFFIX)])
    if out is None:
        out = tape.with_name(tape.name[: -len(TAPE_SUFFIX)] + ".step")
    out = Path(out)
    if out.suffix.lower() not in (".step", ".stp"):
        raise ValueError(f"out must be .step or .stp, got {out.suffix!r}")
    report = BrepReport()
    if verbose:
        print(f"[cadgen] building the B-rep of {name}", file=sys.stderr)
    shape = _to_brep(field, blends=blends, report=report)
    from cadgen import build123d as bd

    shape.label = name
    out.parent.mkdir(parents=True, exist_ok=True)
    bd.export_step(shape, str(out))
    solids = solids_of(shape)
    warnings = list(report.warnings)
    if not solids:
        warnings.append("the B-rep has no solid: the tree describes nothing, or its booleans cancel")
    return ImplicitStepResult(
        ok=solids > 0,
        tape=tape,
        name=name,
        step=out,
        solids=solids,
        volume=volume_of(shape),
        filleted_blends=tuple(report.filleted_blends),
        dropped_blends=tuple(report.dropped_blends),
        warnings=tuple(warnings),
    )
