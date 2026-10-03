# Manufacturing: Gerbers, BOM, placement

A finished board (no DRC error, nothing unrouted) declares what the fab needs:

```python
from cadgen import pcb


@pcb(gerber=True, bom=True, pos=True)
def controller():
    ...
```

`python controller.py` then writes, beside the KiCad project:

- `controller.gerbers.zip`: Gerber X2 files for every copper, mask, paste and silkscreen
  layer and the outline, and Excellon drill files (plated and unplated apart). This is the
  file a fab's upload form takes.
- `controller.bom.csv`: `Comment, Designator, Footprint, Quantity, LCSC Part #, MPN,
  Manufacturer`, one row per distinct part; DNP parts left out.
- `controller.pos.csv`: `Designator, Val, Package, Mid X, Mid Y, Rotation, Layer`, one row
  per placed part, millimetres from the script's origin; DNP parts left out.

A path instead of `True` moves a file (`@pcb(gerber="../fab/controller.zip")`). The same
board always writes the same bytes. `gerber=` and `pos=` refuse a draft: the build fails and
lists what is left to route. For a board drawn elsewhere, the doors take the `.kicad_pcb`:

```bash
cadgen pcb gerber board.kicad_pcb fab/board.gerbers.zip
cadgen pcb bom board.kicad_pcb       # needs board.kicad_sch beside it
cadgen pcb pos board.kicad_pcb
```

## Ordering from JLCPCB

1. Upload `*.gerbers.zip` on the PCB order page; the board's size and layer count are read
   from it. Defaults suit `pcb.JLCPCB` rules: 1.6 mm, HASL or ENIG, 1 oz.
2. For assembly, upload `*.bom.csv` and `*.pos.csv`. Parts need an `LCSC` field
   (`properties={"LCSC": "C25804"}`): JLCPCB matches rows by it. Check the part
   previews: a footprint whose zero rotation differs from JLCPCB's model shows up rotated
   there, and is corrected on their page.
3. Prefer JLCPCB "basic" parts (no setup fee) for passives and common ICs.

Never order on the user's behalf: hand them the files and the steps.

## Before handing off

- The build's last line says `built`, not `draft`, and there were no warnings you did not
  read.
- Every part has a value, and parts to be assembled have an LCSC or MPN field.
- The silkscreen labels connectors and polarity (pin 1, +/-, LED and diode orientation).
- Mounting holes and connectors match the enclosure (compose the board with `@step` into
  the case and look at it).
