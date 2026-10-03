"""The public ``bom`` namespace: the ``@bom`` decorator and its verb.

``@bom`` declares a manufacturing export on a ``@pcb`` board or a ``@harness``,
stacked above it; ``bom.build(...)`` writes the bill of materials (CSV) for a saved
``.kicad_pcb`` (JLCPCB columns) or ``.harness.yml`` (WireViz's list of its parts). They are the same object -- this module is callable (see
:mod:`cadgen._internal.format_namespace`) -- and ``cadgen bom build`` is
``build`` with a parser derived from its signature.

Import discipline: nothing here touches KiCad or WireViz at module scope.
"""

from __future__ import annotations

from pathlib import Path

from cadgen._internal.format_namespace import callable_namespace
from cadgen.results import FabExportResult

__all__ = ["build"]


def build(target: Path, out: Path | None = None, *, verbose: bool = False) -> FabExportResult:
    """Write the bill of materials (CSV) of the board or harness TARGET.

    A board's has JLCPCB's columns; a harness's is WireViz's list of its connectors,
    terminals, cables and wires (WireViz must be installed).

    target: the .kicad_pcb board or .harness.yml harness to export.
    out: destination file. Omitted, writes the sibling <name>.bom.csv beside TARGET.
    verbose: narrate the target on stderr.
    """
    from cadgen._internal.fab_door import fab_build

    return fab_build("bom", target, out, verbose=verbose)


def __getattr__(name: str):
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


callable_namespace(__name__, "bom")
