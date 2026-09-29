#!/usr/bin/env python3
"""Build reproducible local CAD plugin ZIPs from the verified release wheel.

The normal archive resolves cadgen[mcp] from the matching published version. The
local-review archive contains the very wheel passed here. Portable MCP metadata
uses the Agent Plugins PLUGIN_ROOT placeholder; Codex's native compatibility
metadata resolves the wheel relative to the installed plugin root.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIXED_TIME = (1980, 1, 1, 0, 0, 0)
PLUGIN_FILES = (
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".codex-plugin/assets/logo-c.svg",
    ".codex-plugin/assets/logo-c.png",
    ".codex-plugin/assets/logo-cad.png",
    "LICENSE",
    ".mcp.json",
    "mcp.json",
)


def tracked_skills() -> list[str]:
    output = subprocess.check_output(
        ["git", "ls-files", "-z", "--", "skills/"], cwd=ROOT
    )
    paths = [path.decode("utf-8") for path in output.split(b"\0") if path]
    if not paths or not any(path.endswith("/SKILL.md") for path in paths):
        raise ValueError("no tracked skills found")
    return sorted(paths)


def zip_member(name: str, content: bytes) -> tuple[zipfile.ZipInfo, bytes]:
    info = zipfile.ZipInfo(name, FIXED_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    return info, content


def read_plugin_files() -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for name in sorted((*PLUGIN_FILES, *tracked_skills())):
        path = ROOT / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(ROOT):
            raise ValueError(f"plugin member is missing, linked, or outside root: {name}")
        result[name] = path.read_bytes()
    return result


def write_zip(path: Path, members: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in sorted(members.items()):
            info, data = zip_member(name, content)
            archive.writestr(info, data)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args()
    wheel = args.wheel.resolve(strict=True)
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not wheel.name.startswith(f"cadgen-{version}-") or wheel.suffix != ".whl":
        parser.error(f"wheel must be cadgen {version}: {wheel.name}")
    with zipfile.ZipFile(wheel) as archive:
        if f"cadgen-{version}.dist-info/METADATA" not in archive.namelist():
            parser.error("wheel metadata does not match VERSION")

    members = read_plugin_files()
    mcp = json.loads(members["mcp.json"])
    server = mcp["mcpServers"]["cad_viewer"]
    expected = ["--isolated", "--from", f"cadgen[mcp]=={version}", "cadgen", "mcp"]
    if server != {"type": "stdio", "command": "uvx", "args": expected}:
        parser.error("mcp.json is not stamped for the canonical release version")
    native_mcp = json.loads(members[".mcp.json"])
    native_server = native_mcp["mcpServers"]["cad_viewer"]
    if native_server != {"command": "uvx", "args": expected,
                         "cwd": ".", "startup_timeout_sec": 300}:
        parser.error(".mcp.json must pin the same wheel and allow cold startup")

    normal = args.out_dir / f"cad-{version}-plugin.zip"
    write_zip(normal, members)

    local_members = dict(members)
    local_mcp = json.loads(local_members["mcp.json"])
    local_mcp["mcpServers"]["cad_viewer"]["args"][2] = (
        f"${{PLUGIN_ROOT}}/runtime/{wheel.name}[mcp]"
    )
    local_members["mcp.json"] = (json.dumps(local_mcp, indent=2) + "\n").encode("utf-8")
    local_native_mcp = json.loads(local_members[".mcp.json"])
    local_native_mcp["mcpServers"]["cad_viewer"]["args"][2] = (
        f"./runtime/{wheel.name}[mcp]"
    )
    local_members[".mcp.json"] = (
        json.dumps(local_native_mcp, indent=2) + "\n"
    ).encode("utf-8")
    local_members[f"runtime/{wheel.name}"] = wheel.read_bytes()
    local = args.out_dir / f"cad-{version}-plugin-local-review.zip"
    write_zip(local, local_members)
    print(f"Packaged {normal} and {local}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        sys.exit(f"plugin packaging failed: {error}")
