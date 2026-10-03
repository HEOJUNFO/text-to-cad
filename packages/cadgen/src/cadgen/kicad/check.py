"""KiCad's verdict on a board: fill its zones, run ERC and DRC, keep the result.

:func:`build_board` is what an ``@pcb`` build runs. It stages the project's
three documents in a temporary folder and asks ``kicad-cli`` for:

- the ERC of the schematic;
- the DRC of the board, with the schematic-to-board parity check, after
  refilling every zone (``--refill-zones --save-board``).

KiCad's saved board is read back for one thing only, the copper it filled each
zone with (``filled_polygon``), which is merged into cadgen's own tree by zone
UUID. The board cadgen writes is therefore cadgen's bytes plus KiCad's fill:
the same board always writes the same file.

:func:`check_project` runs the same checks on any KiCad project, a person's
included, for ``cadgen pcb validate``.

Positions in findings are in the board script's coordinates: millimetres, y
up, from the board's drill/place origin (where cadgen puts the script's
origin; on a board KiCad's GUI drew, wherever its author left that origin).
"""

from __future__ import annotations

import copy
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from cadgen.kicad import sexpr
from cadgen.kicad.cli import Finding, drc_findings, erc_findings, run_kicad_cli
from cadgen.kicad.design import Board
from cadgen.kicad.install import KicadInstall, find_kicad
from cadgen.kicad.project import project_texts

__all__ = ["BoardBuild", "ProjectCheck", "build_board", "check_project", "is_blocking"]


def is_blocking(finding: Finding) -> bool:
    """An error stops a build; an unrouted connection only makes the board a draft."""
    return finding.severity == "error" and finding.check != "unconnected"


@dataclass(frozen=True)
class ProjectCheck:
    findings: tuple[Finding, ...]

    @property
    def errors(self) -> list[Finding]:
        return [finding for finding in self.findings if is_blocking(finding)]

    @property
    def warnings(self) -> list[Finding]:
        return [finding for finding in self.findings if finding.severity == "warning"]

    @property
    def unrouted(self) -> int:
        return sum(1 for finding in self.findings if finding.check == "unconnected")

    @property
    def ok(self) -> bool:
        return not self.errors


@dataclass(frozen=True)
class BoardBuild(ProjectCheck):
    name: str = ""
    pro: str = ""
    sch: str = ""
    pcb: str = ""


def _origin(pcb_tree: list) -> tuple[float, float]:
    setup = sexpr.find(pcb_tree, "setup")
    origin = sexpr.find(setup, "aux_axis_origin") if setup is not None else None
    if origin is None or len(origin) < 3:
        return 0.0, 0.0
    return float(origin[1]), float(origin[2])


def _to_script(origin: tuple[float, float]):
    def convert(x: float, y: float) -> tuple[float, float]:
        return round(x - origin[0], 4), round(origin[1] - y, 4)

    return convert


def _merge_fills(ours: list, kicad_text: str) -> list:
    theirs = sexpr.parse(kicad_text)
    fills: dict[str, tuple[list | None, list[list]]] = {}
    for zone in sexpr.find_all(theirs, "zone"):
        fills[str(sexpr.value(zone, "uuid"))] = (sexpr.find(zone, "fill"), list(sexpr.find_all(zone, "filled_polygon")))
    merged = copy.deepcopy(ours)
    for zone in sexpr.find_all(merged, "zone"):
        found = fills.get(str(sexpr.value(zone, "uuid")))
        if found is None:
            continue
        fill, polygons = found
        if fill is not None:
            for index, child in enumerate(zone):
                if isinstance(child, list) and child and child[0] == "fill":
                    zone[index] = fill
                    break
        zone.extend(polygons)
    return merged


def build_board(board: Board, *, name: str, install: KicadInstall | None = None) -> BoardBuild:
    """The board's documents, its zones filled by KiCad, and KiCad's findings."""
    install = install or find_kicad()
    texts = project_texts(board, name=name)
    with tempfile.TemporaryDirectory(prefix="cadgen-pcb-") as folder:
        stage = Path(folder)
        (stage / f"{name}.kicad_pro").write_text(texts.pro)
        (stage / f"{name}.kicad_sch").write_text(texts.sch)
        (stage / f"{name}.kicad_pcb").write_text(texts.pcb)
        run_kicad_cli(install, ["sch", "erc", "--format", "json", "-o", "erc.json", f"{name}.kicad_sch"], cwd=stage)
        run_kicad_cli(
            install,
            ["pcb", "drc", "--format", "json", "--schematic-parity", "--refill-zones", "--save-board", "-o", "drc.json", f"{name}.kicad_pcb"],
            cwd=stage,
        )
        findings = erc_findings(stage / "erc.json") + drc_findings(stage / "drc.json", to_script=_to_script(_origin(texts.pcb_tree)))
        filled = _merge_fills(texts.pcb_tree, (stage / f"{name}.kicad_pcb").read_text())
    return BoardBuild(findings=tuple(findings), name=name, pro=texts.pro, sch=texts.sch, pcb=sexpr.dumps(filled))


def check_project(path: Path, *, install: KicadInstall | None = None) -> ProjectCheck:
    """ERC and DRC of the KiCad project ``path`` (its ``.kicad_pcb``, ``.kicad_sch`` or ``.kicad_pro``).

    The project's KiCad files are copied to a temporary folder first, so
    checking a project never writes into it.
    """
    install = install or find_kicad()
    path = Path(path).expanduser().resolve()
    if path.suffix not in {".kicad_pcb", ".kicad_sch", ".kicad_pro"}:
        raise ValueError(f"{path.name} is not a KiCad project file (.kicad_pcb, .kicad_sch or .kicad_pro)")
    if not path.is_file():
        raise FileNotFoundError(f"{path} does not exist")
    stem, folder = path.stem, path.parent
    pcb, sch = folder / f"{stem}.kicad_pcb", folder / f"{stem}.kicad_sch"
    if not pcb.is_file() and not sch.is_file():
        raise FileNotFoundError(f"{folder} has neither {stem}.kicad_pcb nor {stem}.kicad_sch")
    findings: list[Finding] = []
    with tempfile.TemporaryDirectory(prefix="cadgen-pcb-check-") as staging:
        stage = Path(staging)
        for entry in folder.iterdir():
            if entry.is_file() and (entry.suffix.startswith(".kicad_") or entry.name.endswith("-lib-table")):
                shutil.copy2(entry, stage / entry.name)
        if sch.is_file():
            run_kicad_cli(install, ["sch", "erc", "--format", "json", "-o", "erc.json", sch.name], cwd=stage)
            findings.extend(erc_findings(stage / "erc.json"))
        if pcb.is_file():
            args = ["pcb", "drc", "--format", "json", "--refill-zones", "-o", "drc.json", pcb.name]
            if sch.is_file():
                args.insert(4, "--schematic-parity")
            run_kicad_cli(install, args, cwd=stage)
            origin = _origin(sexpr.parse(pcb.read_text(encoding="utf-8")))
            findings.extend(drc_findings(stage / "drc.json", to_script=_to_script(origin)))
    return ProjectCheck(findings=tuple(findings))
