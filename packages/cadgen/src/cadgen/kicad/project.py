"""A board as its three KiCad documents: ``.kicad_pro``, ``.kicad_sch``, ``.kicad_pcb``.

:func:`project_texts` is the pure half of writing a board: the same board gives
the same three texts. Filling zones and checking the result is KiCad's, in
:mod:`cadgen.kicad.check`.
"""

from __future__ import annotations

from dataclasses import dataclass

from cadgen.kicad import sexpr
from cadgen.kicad.board_writer import Frame, board_document
from cadgen.kicad.design import Board, DesignError, Part
from cadgen.kicad.ids import Ids
from cadgen.kicad.project_writer import project_document
from cadgen.kicad.schematic_writer import schematic_document

__all__ = ["ProjectTexts", "project_texts"]


@dataclass(frozen=True)
class ProjectTexts:
    name: str
    pro: str
    sch: str
    pcb: str
    pcb_tree: list


def project_texts(board: Board, *, name: str) -> ProjectTexts:
    """The project's documents, or :class:`DesignError` naming what to fix first."""
    if not isinstance(board, Board):
        raise DesignError(f"a @pcb function returns a pcb.Board, got {type(board).__name__}")
    problems = board.problems()
    if problems:
        raise DesignError("the board is not ready to write:\n  - " + "\n  - ".join(problems))

    def net_of_pin(part: Part, number: str) -> str | None:
        net = board._pin_nets.get((part._index, number))
        return net.name if net is not None else None

    power_flag_nets = [net.name for net in board.nets if net.power_flag]
    frame = Frame.for_outline(board.outline)
    sch_tree, paths = schematic_document(board, project=name, net_of_pin=net_of_pin, power_flag_nets=power_flag_nets)
    pcb_tree = board_document(board, project=name, frame=frame, symbol_paths=paths)
    pro = project_document(board, project=name, root_uuid=Ids(name).of("sheet:/"))
    return ProjectTexts(name=name, pro=pro, sch=sexpr.dumps(sch_tree), pcb=sexpr.dumps(pcb_tree), pcb_tree=pcb_tree)
