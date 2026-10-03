"""The public ``bom`` namespace: the ``@bom`` decorator and its verb.

``@bom`` declares a manufacturing export on a ``@pcb`` board, stacked above
``@pcb``; ``bom.build(...)`` writes the bill of materials (CSV, JLCPCB columns) for a saved
``.kicad_pcb``. They are the same object -- this module is callable (see
:mod:`cadgen._internal.format_namespace`) -- and ``cadgen bom build`` is
``build`` with a parser derived from its signature.

Import discipline: nothing here touches KiCad at module scope.
"""

from __future__ import annotations

from pathlib import Path

from cadgen._internal.format_namespace import callable_namespace
from cadgen.results import FabExportResult

__all__ = ["build"]


def build(target: Path, out: Path | None = None, *, verbose: bool = False) -> FabExportResult:
    """Write the bill of materials (CSV, JLCPCB columns) of the board TARGET.

    target: the .kicad_pcb board to export.
    out: destination file. Omitted, writes the sibling <board>.bom.csv beside TARGET.
    verbose: narrate the target on stderr.
    """
    from cadgen._internal.fab_door import fab_build

    return fab_build("bom", target, out, verbose=verbose)


def __getattr__(name: str):
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


callable_namespace(__name__, "bom")
