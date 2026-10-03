"""KiCad: the PCB kernel cadgen drives, as build123d drives OpenCascade.

``@pcb`` models are written in Python (``cadgen.pcb``); this package turns
them into KiCad documents and asks KiCad's own command line, ``kicad-cli``, for
the operations cadgen must never reimplement: filling copper zones, the
electrical and design rule checks, plots and fabrication exports. Nothing here
talks to a running KiCad or imports KiCad's Python bindings; the documents
are files, and ``kicad-cli`` is a program cadgen runs.

Modules, each importing nothing heavy at module scope:

- ``sexpr``: read and write the S-expression syntax every KiCad file uses.
- ``install``: find ``kicad-cli`` and the symbol/footprint/3D libraries.
- ``library``: load a symbol or footprint by its ``Library:Name``.
- ``design``: the authoring model (``Board``, parts, nets, copper).
- ``board_writer`` / ``schematic_writer`` / ``project_writer``: the
  documents.
- ``cli``: run ``kicad-cli`` and read its JSON reports.
"""
