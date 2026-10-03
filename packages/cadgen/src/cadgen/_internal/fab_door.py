"""What the ``gerber``/``bom``/``pos`` doors share: one manufacturing file of a saved board.

A door takes a ``.kicad_pcb`` DOCUMENT -- one a ``@pcb`` model wrote, or one a
person drew in KiCad -- and writes only its own file, through the same exporter
a model's ``@gerber``/``@bom``/``@pos`` declaration uses, so a door and a model
run cannot write different bytes. It never runs a script. Gerbers and the
placement file are refused for a board with unrouted connections or DRC errors.
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
    if board.suffix.lower() != ".kicad_pcb":
        raise ValueError(f"{board.name} is not a KiCad board: cadgen {fmt} build takes a .kicad_pcb")
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
