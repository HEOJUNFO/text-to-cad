"""What the ``gerber``/``bom``/``pos`` doors share: one manufacturing file of a saved board.

A door takes a ``.kicad_pcb`` DOCUMENT -- one a ``@pcb`` model wrote, or one a
person drew in KiCad -- and writes only its own file, through the same exporter
a model's ``@gerber``/``@bom``/``@pos`` declaration uses, so a door and a model
run cannot write different bytes. It never runs a script. Gerbers and the
placement file are refused for a board with unrouted connections or DRC errors.

``cadgen bom build`` also takes a wiring harness's ``.harness.yml``: its BOM is
WireViz's list of the document's parts (``cadgen.wireviz.bom``), the exporter a
``@bom`` above ``@harness`` writes through.
"""

from __future__ import annotations

from pathlib import Path

from cadgen.results import FabExportFile, FabExportResult


def fab_build(fmt: str, target: Path, out: Path | None, *, verbose: bool = False) -> FabExportResult:
    import sys

    from cadgen._internal.atomic_replace import write_bytes_atomic
    from cadgen.kicad.fab import MANUFACTURING, export, require_finished
    from cadgen.metadata import FAB_SUFFIX

    board = Path(target).expanduser()
    board = (board if board.is_absolute() else Path.cwd() / board).resolve()
    if board.name.lower().endswith(".harness.yml"):
        if fmt != "bom":
            raise ValueError(f"{board.name} is a wiring harness, which has a BOM but no {fmt} file: cadgen {fmt} build takes a .kicad_pcb")
        return _harness_bom(board, out, verbose=verbose)
    if board.suffix.lower() != ".kicad_pcb":
        takes = "a .kicad_pcb or a .harness.yml" if fmt == "bom" else "a .kicad_pcb"
        raise ValueError(f"{board.name} is not a KiCad board: cadgen {fmt} build takes {takes}")
    if not board.is_file():
        raise FileNotFoundError(f"no board at {board}")
    stem = board.name[: -len(".kicad_pcb")]
    destination = Path(out).expanduser() if out is not None else board.with_name(stem + FAB_SUFFIX[fmt])
    destination = (destination if destination.is_absolute() else Path.cwd() / destination).resolve()
    if verbose:
        print(f"[{fmt}] {board} -> {destination}", file=sys.stderr)
    if fmt in MANUFACTURING:
        require_finished(board, fmt=fmt)
    data = export(fmt, board)
    destination.parent.mkdir(parents=True, exist_ok=True)
    write_bytes_atomic(destination, data)
    return FabExportResult(ok=True, files=(FabExportFile(path=destination, fmt=fmt),))


def _harness_bom(document: Path, out: Path | None, *, verbose: bool) -> FabExportResult:
    """A harness document's BOM, through the exporter ``@bom`` above ``@harness`` uses."""
    import sys

    from cadgen._internal.atomic_replace import write_bytes_atomic
    from cadgen.metadata import FAB_SUFFIX
    from cadgen.wireviz.bom import harness_bom

    if not document.is_file():
        raise FileNotFoundError(f"no harness at {document}")
    stem = document.name[: -len(".harness.yml")]
    destination = Path(out).expanduser() if out is not None else document.with_name(stem + FAB_SUFFIX["bom"])
    destination = (destination if destination.is_absolute() else Path.cwd() / destination).resolve()
    if verbose:
        print(f"[bom] {document} -> {destination}", file=sys.stderr)
    data = harness_bom(document.read_bytes(), label=document.name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    write_bytes_atomic(destination, data)
    return FabExportResult(ok=True, files=(FabExportFile(path=destination, fmt="bom"),))
