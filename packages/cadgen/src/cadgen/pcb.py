"""The public ``pcb`` namespace: the ``@pcb`` decorator, the board API, and its verbs.

``@pcb`` DECLARES a printed circuit board model; ``pcb.Board`` is what its
function builds and returns; ``pcb.validate(...)`` checks any KiCad project.
They are the same object -- this module is callable (see
:mod:`cadgen._internal.format_namespace`) -- so ``from cadgen import pcb``
gives a model script all three.

A board is written as a KiCad project: ``<name>.kicad_pro``,
``<name>.kicad_sch``, ``<name>.kicad_pcb`` and its custom design rules,
``<name>.kicad_dru``. KiCad itself (its command line, ``kicad-cli``) fills the
zones and runs the electrical and design rule checks inside every build; a
build with errors writes nothing.

``pcb.Testbench`` simulates a board's subcircuits with ngspice, the simulator
KiCad ships: a circuit like a board, built by the same functions, whose runs
are facts for a script to assert (``pcb.SimulationError`` when ngspice cannot
solve it).

Import discipline: nothing here pulls in OCP or touches KiCad at module scope.
"""

from __future__ import annotations

from pathlib import Path

from cadgen._internal.format_namespace import callable_namespace
from cadgen._internal.snapshot_door import plot_snapshot_verb
from cadgen.results import ValidationResult

__all__ = [
    "Board",
    "DesignError",
    "JLCPCB",
    "Net",
    "NetClass",
    "Part",
    "Pin",
    "Rules",
    "SimulationError",
    "Testbench",
    "find_footprints",
    "find_symbols",
    "snapshot",
    "validate",
]

_DESIGN = {"Board", "DesignError", "JLCPCB", "Net", "NetClass", "Part", "Pin", "Rules"}
_SIMULATION = {"SimulationError", "Testbench"}

_SUFFIXES = (".kicad_pcb", ".kicad_sch", ".kicad_pro")

#: ``cadgen pcb snapshot``'s verb: a board or schematic drawn as KiCad plots it, as the viewer draws it.
snapshot = plot_snapshot_verb("pcb")


def validate(path: Path, *, strict: bool = False, verbose: bool = False) -> ValidationResult:
    """Check one KiCad project with KiCad's own ERC and DRC.

    The project's files are copied aside first, so checking never writes into
    the project. The DRC refills zones and, when the project has a schematic,
    compares it with the board. Unrouted connections are reported; they block
    like any other error. Positions are millimetres from the board's
    drill/place origin, y up.

    path: the project's .kicad_pcb, .kicad_sch or .kicad_pro.
    strict: treat warnings as blocking.
    verbose: narrate the target on stderr.
    """
    import sys

    from cadgen._internal.validation_door import display_path, failed, resolved_target
    from cadgen.results import ValidationIssue

    target = resolved_target(path, label="pcb")
    if verbose:
        print(f"[pcb] validating {target}", file=sys.stderr)
    if target.suffix.lower() not in _SUFFIXES:
        return failed(target, "target must be a KiCad project file (.kicad_pcb, .kicad_sch or .kicad_pro)")
    if not target.is_file():
        return failed(target, "file not found")
    from cadgen.kicad.check import check_project
    from cadgen.kicad.install import KicadMissingError

    try:
        report = check_project(target)
    except KicadMissingError as error:
        return failed(target, str(error), code="kicad_missing")
    issues = []
    for finding in sorted(report.findings, key=lambda finding: (finding.severity != "error", finding.check, finding.type)):
        located = [text + (f" at ({position[0]:g}, {position[1]:g})" if position is not None else "") for text, position in finding.items]
        issues.append(
            ValidationIssue(
                severity=finding.severity,
                message=finding.description + (": " + "; ".join(located) if located else ""),
                code=f"{finding.check}.{finding.type}",
            )
        )
    errors = sum(1 for finding in report.findings if finding.severity == "error")
    warnings = sum(1 for finding in report.findings if finding.severity == "warning")
    blocking = bool(errors or (strict and warnings))
    return ValidationResult(
        ok=not blocking,
        path=target,
        issues=tuple(issues),
        summary="" if blocking else f"OK {display_path(target)}: ERC and DRC clean ({warnings} warning(s))",
    )


def __getattr__(name: str):
    if name in _DESIGN:
        from cadgen.kicad import design

        return getattr(design, name)
    if name in _SIMULATION:
        from cadgen.kicad import sim

        return getattr(sim, name)
    if name in {"find_symbols", "find_footprints"}:
        from cadgen.kicad import library

        return getattr(library, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


callable_namespace(__name__, "pcb")
