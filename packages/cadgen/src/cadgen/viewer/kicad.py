"""``GET /__cad/kicad``: a KiCad board or schematic as the picture KiCad draws.

This module is the route's two decisions -- what may be opened, and what the
HTTP answer is. The payload is cadgen's (``cadgen.kicad.plot``), imported
inside the handler so nothing KiCad-related loads at ``cadgen.viewer`` import
time; a cached plot never runs ``kicad-cli`` at all.

The document is named by its absolute path, through the drawing route's
helper: a ref that is not an absolute path, or neither a ``.kicad_pcb`` nor a
``.kicad_sch``, is 400, a missing file 404. A document KiCad cannot plot, or a
machine with no KiCad, is 400 with the teaching message.
"""

from __future__ import annotations

from .drawings import resolve_drawing_path

__all__ = ["KICAD_ROUTE_PATH", "KICAD_SUFFIXES", "kicad_payload_response"]

KICAD_ROUTE_PATH = "/__cad/kicad"
KICAD_SUFFIXES = (".kicad_pcb", ".kicad_sch")


def kicad_payload_response(file_ref) -> tuple[int, bytes | dict]:
    """``(status, body)``: the plot payload's bytes at 200, or a JSON error dict."""
    candidate = resolve_drawing_path(
        file_ref, suffixes=KICAD_SUFFIXES, route=KICAD_ROUTE_PATH, noun="KiCad boards and schematics"
    )
    if candidate is None:
        return 404, {"error": "Not found"}
    from cadgen.kicad.install import KicadMissingError
    from cadgen.kicad.plot import PlotError, plot_payload_bytes

    try:
        return 200, plot_payload_bytes(candidate)
    except KicadMissingError as error:
        raise PlotError(str(error)) from None
