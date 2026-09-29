#!/usr/bin/env python3
"""Check both plugin archives, then launch the native wheel-backed MCP."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def fail(message: str) -> None:
    raise AssertionError(message)


def checked_archive(path: Path, destination: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if not names or len(names) != len(set(names)):
            fail(f"empty or duplicate archive members: {path}")
        for name in names:
            parts = Path(name).parts
            if name.startswith("/") or ".." in parts or "\\" in name:
                fail(f"unsafe archive member: {name}")
        archive.extractall(destination)


def server_config(root: Path) -> tuple[dict, dict]:
    marketplace = json.loads((root / ".agents/plugins/marketplace.json").read_text())
    entries = [entry for entry in marketplace["plugins"] if entry.get("name") == "cad"]
    if len(entries) != 1 or entries[0]["source"] != {"source": "local", "path": "./"}:
        fail("archive cannot be installed as its own local marketplace")
    manifest = json.loads((root / ".codex-plugin/plugin.json").read_text())
    if manifest.get("skills") != "./skills/" or manifest.get("mcpServers") != "./.mcp.json":
        fail("plugin manifest lost its canonical skills or MCP reference")
    if not (root / "skills/cad/SKILL.md").is_file():
        fail("the canonical CAD skill is missing")
    if not (root / ".codex-plugin/assets/logo-cad.png").is_file():
        fail("plugin logo is missing")
    portable = json.loads((root / "mcp.json").read_text())["mcpServers"]["cad_viewer"]
    native = json.loads((root / ".mcp.json").read_text())["mcpServers"]["cad_viewer"]
    return portable, native


async def smoke(root: Path, server: dict, work: Path, expected_html: str, version: str) -> None:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    if shutil.which(server["command"]) is None:
        fail("uvx is required for installed plugin MCP smoke testing")
    args = [arg.replace("${PLUGIN_ROOT}", str(root)) for arg in server["args"]]
    env = os.environ.copy()
    for key in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"):
        env.pop(key, None)
    # Keep the resolved dependency cache across checks in this CI job, while
    # each extracted plugin and spawned tool environment remains independent.
    env.setdefault("UV_CACHE_DIR", str(Path(tempfile.gettempdir()) / "cad-plugin-uv-cache"))
    env["UV_TOOL_DIR"] = str(work / "uv-tools")
    env["UV_NO_MANAGED_PYTHON"] = "1"
    env["CADGEN_STATE_DIR"] = str(work / "cad-state")
    env["CADGEN_CACHE_DIR"] = str(work / "cad-cache")
    env["CADGEN_MCP_UI_CACHE_DIR"] = str(work / "ui-cache")
    env["CADGEN_DAEMON_STATE_DIR"] = str(work / "daemon-state")
    env["CADGEN_DAEMON"] = "0"
    # Codex resolves native `cwd: "."` to the installed plugin root. The
    # review wheel is addressed relative to that root, independent of the
    # checkout and of the process that invoked this smoke test.
    if server["cwd"] != "." or server["startup_timeout_sec"] != 300:
        fail("native MCP config lacks its plugin-root cwd or cold-start timeout")
    parameters = StdioServerParameters(
        command=server["command"], args=args, env=env, cwd=root
    )
    with (work / "mcp-stderr.log").open("w+") as errors:
        try:
            async with asyncio.timeout(300):
                async with stdio_client(parameters, errlog=errors) as (reader, writer):
                    async with ClientSession(reader, writer) as client:
                        await client.initialize()
                        tools = {tool.name: tool for tool in (await client.list_tools()).tools}
                        if {"cad_open", "cad_request", "cad_library", "cad_handshake"} - tools.keys():
                            fail(f"wheel-backed MCP tools missing: {sorted(tools)}")
                        handshake = await client.call_tool("cad_handshake", {"apiVersion": 2})
                        identity = handshake.structuredContent
                        if handshake.isError or identity["serverVersion"] != version:
                            fail(f"MCP server version differs from packaged wheel: {identity}")
                        resource_uri = tools["cad_open"].meta["ui"]["resourceUri"]
                        resource = (await client.read_resource(resource_uri)).contents[0]
                        if resource.text != expected_html:
                            fail("MCP resource differs from UI in the exact packaged wheel")
                        if (identity["uiResourceUri"] != resource_uri or
                            identity["uiDigest"] != hashlib.sha256(expected_html.encode()).hexdigest()):
                            fail("MCP handshake does not identify the served UI")
                        outside = work / "elsewhere"
                        outside.mkdir()
                        stl = outside / "sample.stl"
                        stl_bytes = (b"solid sample\nfacet normal 0 0 1\nouter loop\n"
                                     b"vertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n"
                                     b"endloop\nendfacet\nendsolid sample\n")
                        stl.write_bytes(stl_bytes)
                        opened = await client.call_tool("cad_open", {"apiVersion": 2, "path": str(stl)})
                        if opened.isError:
                            fail(f"isolated CAD file open failed: {opened.structuredContent}")
                        document = opened.structuredContent["document"]
                        from urllib.parse import urlencode
                        asset = await client.call_tool("cad_request", {
                            "apiVersion": 2, "document": document,
                            "path": "/__cad/asset?" + urlencode({"file": str(stl)}),
                        })
                        if asset.isError or base64.b64decode(asset.structuredContent["body"]) != stl_bytes:
                            fail("wheel-backed MCP could not serve the opened STL")
                        print(f"Wheel-backed stdio served {resource_uri} and an isolated STL")
        except BaseException:
            errors.flush()
            errors.seek(0)
            print(errors.read()[-6000:], file=sys.stderr)
            raise
    missing = subprocess.run(
        [server["command"], *args, "--ui", str(work / "missing-app.html")],
        cwd=root, env=env, text=True, capture_output=True, timeout=60,
        check=False,
    )
    if missing.returncode == 0 or missing.stdout or "CAD extension UI is missing" not in missing.stderr:
        fail("missing bundled UI did not produce a clean, actionable startup error")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", required=True, type=Path)
    parser.add_argument("--archives-dir", required=True, type=Path)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    wheel = args.wheel.resolve(strict=True)
    version = wheel.name.split("-")[1]
    base = args.archives_dir
    production = base / f"cad-{version}-plugin.zip"
    local = base / f"cad-{version}-plugin-local-review.zip"
    with tempfile.TemporaryDirectory(prefix="cad-plugin-test-") as temp:
        work = Path(temp)
        production_root, local_root = work / "production", work / "local"
        checked_archive(production, production_root)
        checked_archive(local, local_root)
        prod_portable, prod_server = server_config(production_root)
        local_portable, local_server = server_config(local_root)
        required = ["--isolated", "--from", f"cadgen[mcp]=={version}", "cadgen", "mcp"]
        if prod_portable != {"type": "stdio", "command": "uvx", "args": required}:
            fail("production plugin does not pin cadgen[mcp] to wheel version")
        if prod_server != {"command": "uvx", "args": required, "cwd": ".",
                           "startup_timeout_sec": 300}:
            fail("production native MCP config has wrong runtime or timeout")
        if any((production_root / "runtime").rglob("*.whl")):
            fail("production plugin unexpectedly contains a wheel")
        bundled = local_root / "runtime" / wheel.name
        if not bundled.is_file() or bundled.read_bytes() != wheel.read_bytes():
            fail("local-review plugin does not contain the exact verified wheel")
        expected_local = required.copy()
        expected_local[2] = f"${{PLUGIN_ROOT}}/runtime/{wheel.name}[mcp]"
        if local_portable != {"type": "stdio", "command": "uvx", "args": expected_local}:
            fail("local-review plugin does not resolve its packaged wheel")
        expected_native = expected_local.copy()
        expected_native[2] = f"./runtime/{wheel.name}[mcp]"
        if local_server != {"command": "uvx", "args": expected_native, "cwd": ".",
                            "startup_timeout_sec": 300}:
            fail("local-review native MCP config has wrong wheel path or timeout")
        with zipfile.ZipFile(wheel) as archive:
            html = archive.read("cadgen/_runtime/chatgpt/index.html").decode()
        print(f"Both CAD {version} plugin ZIPs contain the expected metadata and wheel")
        if not args.validate_only:
            asyncio.run(smoke(local_root, local_server, work, html, version))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, AssertionError) as error:
        sys.exit(f"plugin package check failed: {error}")
