"""MCP protocol and shared-viewer contract, with tiny test-owned documents."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import urlencode

from mcp.shared.memory import create_connected_server_and_client_session
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from cadgen.mcp.backend import CHUNK_BYTES, ViewerBridge, ViewerRoots
from cadgen.mcp.library import RecentLibrary
from cadgen.assets import AssetMissing
from cadgen.mcp.server import UI_MIME_TYPE, create_server
from cadgen.viewer.backend import ForbiddenAssetError


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name, "project").resolve()
        self.root.mkdir()
        self.file = self.root / "small.stl"
        self.file.write_bytes(b"solid test\nendsolid test\n")
        self.cache = mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(Path(self.tmp.name, "cache"))})
        self.cache.start()
        self.addCleanup(self.cache.stop)
        self.bridge = ViewerBridge(self.root)
        self.addCleanup(self.bridge.close)
        # Drive catalog hydration synchronously so test cleanup owns every read.
        hydration = mock.patch.object(self.bridge.app.backend, "_start_catalog_hydration", self.bridge.app.backend._hydrate_catalog)
        hydration.start()
        self.addCleanup(hydration.stop)

    def test_asset_bytes_catalog_and_replacement_use_the_existing_viewer(self):
        path = "/__cad/asset?" + urlencode({"file": str(self.file)})
        response = self.bridge.request(path)
        self.assertEqual(response["status"], 200)
        self.assertEqual(base64.b64decode(response["body"]), self.file.read_bytes())
        self.assertEqual(self.bridge.request(path, "HEAD")["body"], "")
        catalog = self.bridge.request("/__cad/catalog?" + urlencode({"file": str(self.file)}))
        payload = json.loads(base64.b64decode(catalog["body"]))
        self.assertEqual(payload["rootId"], self.bridge.app.root_id)
        self.assertEqual(payload["entries"][0]["rootRelativeFile"], "small.stl")
        self.file.write_bytes(b"solid revised\nendsolid revised\n")
        self.assertEqual(base64.b64decode(self.bridge.request(path)["body"]), self.file.read_bytes())

    def test_open_checks_root_hidden_paths_extensions_and_host_priority(self):
        self.assertEqual(self.bridge.open(path="small.stl")["file"], "small.stl")
        self.assertEqual(self.bridge.open(path=str(self.file))["file"], "small.stl")
        self.assertEqual(self.bridge.open(path="wrong.step", resource_path=str(self.file))["file"], "small.stl")
        for path in ("../outside.step", str(Path(self.tmp.name, "outside.step"))):
            with self.subTest(path=path), self.assertRaises(ForbiddenAssetError):
                self.bridge.open(path=path)
        for path in ("model.py", ".hidden.stl", "missing.step"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.bridge.open(path=path)

    def test_bridge_cannot_reach_native_actions_sources_or_outside_documents(self):
        for path, method in (
            ("https://example.com/__cad/catalog", "GET"),
            ("//example.com/__cad/catalog", "GET"),
            ("/__cad/clipboard", "POST"), ("/__cad/reveal", "POST"),
            ("/__cad/asset", "DELETE"), ("/index.html", "GET"),
            ("/__cad/../__cad/asset", "GET"),
        ):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.bridge.request(path, method)
        outside = Path(self.tmp.name, "outside.step")
        outside.write_bytes(b"outside")
        for route, method in (("asset", "GET"), ("artifact", "GET"), ("artifact", "POST")):
            result = self.bridge.request(f"/__cad/{route}?" + urlencode({"file": str(outside)}), method)
            self.assertEqual(result["status"], 403)
        source = self.root / "model.py"
        source.write_text("raise RuntimeError('MUST NOT RUN')", encoding="utf-8")
        result = self.bridge.request("/__cad/asset?" + urlencode({"file": str(source)}))
        self.assertEqual(result["status"], 404)

    def test_explicit_root_preserves_viewer_symlink_library_contract(self):
        outside = Path(self.tmp.name, "outside.stl")
        outside.write_bytes(b"secret")
        alias = self.root / "alias.stl"
        try:
            alias.symlink_to(outside)
        except OSError:
            self.skipTest("symlinks unavailable")
        self.assertEqual(self.bridge.open(path="alias.stl")["file"], "alias.stl")
        result = self.bridge.request("/__cad/asset?" + urlencode({"file": str(alias)}))
        self.assertEqual(result["status"], 200)

    def test_body_errors_and_bounded_response_are_explicit(self):
        with self.assertRaisesRegex(ValueError, "base64"):
            self.bridge.request("/__cad/surfaces", "POST", "!!!")
        with self.assertRaisesRegex(ValueError, "must not carry"):
            self.bridge.request("/__cad/catalog", "GET", "eA==")
        self.file.write_bytes(b"x" * 300)
        with mock.patch("cadgen.mcp.backend.MAX_BYTES", 128):
            result = self.bridge.request("/__cad/asset?" + urlencode({"file": str(self.file)}))
        self.assertNotEqual(result["status"], 200)

    def test_compilation_uses_existing_document_operation(self):
        step = self.root / "part.step"
        step.write_text("test-owned STEP placeholder", encoding="utf-8")
        with mock.patch.object(self.bridge.app.ops, "build_artifact", return_value={"ok": True}) as compile_document:
            result = self.bridge.request("/__cad/artifact?" + urlencode({"file": str(step)}), "POST")
        self.assertEqual(result["status"], 200)
        compile_document.assert_called_once_with(str(step), force=False)

    def test_large_file_chunks_reassemble_and_detect_replacement(self):
        # A real multi-message binary response, without a CAD kernel or fixtures.
        content = b"a" * CHUNK_BYTES + b"second-chunk\x00\xff"
        self.file.write_bytes(content)
        path = "/__cad/asset?" + urlencode({"file": str(self.file)})
        first = self.bridge.request(path)
        self.assertEqual(first["transfer"]["offset"], 0)
        self.assertEqual(first["transfer"]["totalBytes"], len(content))
        self.assertEqual(first["headers"]["content-length"], str(len(content)))
        self.assertLess(len(json.dumps(first)), 10 * 1024 * 1024)
        head = self.bridge.request(path, "HEAD")
        self.assertEqual(head["body"], "")
        self.assertNotIn("transfer", head)
        second = self.bridge.request(path, offset=CHUNK_BYTES, revision=first["transfer"]["revision"])
        self.assertEqual(second["transfer"]["offset"], CHUNK_BYTES)
        self.assertEqual(base64.b64decode(first["body"]) + base64.b64decode(second["body"]), content)
        self.file.write_bytes(b"new bytes")
        rejected = self.bridge.request(path, offset=CHUNK_BYTES, revision=first["transfer"]["revision"])
        self.assertEqual(rejected["status"], 400)
        self.assertIn("changed during transfer", base64.b64decode(rejected["body"]).decode())
        self.assertEqual(base64.b64decode(self.bridge.request(path)["body"]), b"new bytes")
        with self.assertRaisesRegex(ValueError, "requires its revision"):
            self.bridge.request(path, offset=CHUNK_BYTES)


class LibraryTests(unittest.TestCase):
    def test_recent_authority_rejects_replaced_root_symlink(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": directory}):
            base = Path(directory).resolve()
            root = base / "project"
            root.mkdir()
            (root / "part.stl").write_bytes(b"solid part\nendsolid part\n")
            library = RecentLibrary(base / "library.sqlite3")
            recent = library.record(str(root), "part.stl")
            record = library.get(recent["id"])
            moved = base / "elsewhere"
            root.rename(moved)
            try:
                root.symlink_to(moved, target_is_directory=True)
            except OSError:
                self.skipTest("symlinks unavailable")
            with mock.patch("cadgen.mcp.backend.Path.cwd", return_value=base):
                roots = ViewerRoots(None)
            try:
                with self.assertRaisesRegex(ValueError, "directory has moved"):
                    roots.for_recent(record)
            finally:
                roots.close()

    def test_pins_identity_thumbnail_revisions_and_removal_persist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "part.stl"
            file.write_bytes(b"solid part\nendsolid part\n")
            path = root / "state/library.sqlite3"
            first = RecentLibrary(path)
            item = first.record(str(root), file.name)
            second = RecentLibrary(path)
            self.assertEqual(second.record(str(root), file.name)["id"], item["id"])
            pinned = first.update("pin", item["id"], pinned=True)
            self.assertTrue(pinned["items"][0]["pinned"])
            from PIL import Image
            image = io.BytesIO()
            Image.new("RGB", (1, 1)).save(image, format="PNG")
            png = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode("ascii")
            second.update("thumbnail", item["id"], thumbnail=png, revision=item["revision"])
            self.assertEqual(first.update("thumbnail", item["id"])["thumbnail"], png)
            self.assertEqual(first.list()["items"][0]["thumbnailRevision"], item["revision"])
            file.write_bytes(b"solid updated part\nendsolid part\n")
            self.assertIsNone(first.list()["items"][0]["thumbnailRevision"])
            self.assertIsNone(first.update("thumbnail", item["id"])["thumbnail"])
            with self.assertRaisesRegex(ValueError, "changed"):
                first.update("thumbnail", item["id"], thumbnail=png, revision=item["revision"])
            with self.assertRaisesRegex(ValueError, "PNG"):
                first.update("thumbnail", item["id"], thumbnail="data:image/svg+xml;base64,PHN2Zz4=")
            with self.assertRaisesRegex(ValueError, "256 KiB"):
                first.update("thumbnail", item["id"], thumbnail="data:image/png;base64," + "A" * 400000)
            with self.assertRaisesRegex(ValueError, "valid PNG"):
                corrupt = "data:image/png;base64," + base64.b64encode(image.getvalue()[:-8]).decode("ascii")
                first.update("thumbnail", item["id"], thumbnail=corrupt)
            self.assertEqual(first.update("remove", item["id"]), {"items": []})
            self.assertTrue(file.is_file())
            self.assertEqual(second.list(), {"items": []})

    def test_independent_processes_preserve_concurrent_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "state/library.sqlite3"
            code = (
                "from cadgen.mcp.library import RecentLibrary; import sys; "
                "library=RecentLibrary(sys.argv[1]); "
                "[library.record(sys.argv[2],sys.argv[3] + str(i) + '.stl') for i in range(10)]"
            )
            processes = [subprocess.Popen([sys.executable, "-c", code, str(path), str(root), prefix],
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                         for prefix in ("a", "b")]
            for process in processes:
                _, error = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, error)
            self.assertEqual(len(RecentLibrary(path).list()["items"]), 20)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        cache_directory = tempfile.TemporaryDirectory()
        self.addCleanup(cache_directory.cleanup)
        cache_environment = mock.patch.dict(os.environ, {
            "CADGEN_CACHE_DIR": str(Path(cache_directory.name, "cache")),
            "CADGEN_STATE_DIR": str(Path(cache_directory.name, "state")),
            "CADGEN_MCP_UI_CACHE_DIR": str(Path(cache_directory.name, "ui-cache")),
        })
        cache_environment.start()
        self.addCleanup(cache_environment.stop)

    async def test_host_grants_file_parent_without_trusting_an_app_supplied_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            granted = root / "part.stl"
            granted.write_bytes(b"solid part\nendsolid part\n")
            default_root = root / "default-project"
            default_root.mkdir()
            ui = root / "viewer.html"
            ui.write_text("<!doctype html><title>CAD</title>", encoding="utf-8")
            with mock.patch("cadgen.mcp.backend.Path.cwd", return_value=default_root):
                server = create_server(ui_path=ui)
            meta = {"openai/resource": {"path": str(granted)}}
            args = {"file": {"name": granted.name, "resourceUri": "host-resource://part"}}
            async with create_connected_server_and_client_session(server) as client:
                opened = await client.call_tool("cad_open", args, meta=meta)
                self.assertFalse(opened.isError)
                self.assertEqual(opened.structuredContent["rootPath"], str(root))
                path = "/__cad/asset?" + urlencode({"file": str(granted)})
                authorized = await client.call_tool("cad_request", {"path": path}, meta=meta)
                self.assertEqual(authorized.structuredContent["status"], 200)
                ungranted = await client.call_tool("cad_request", {"path": path})
                self.assertEqual(ungranted.structuredContent["status"], 403)

    async def test_stdio_cli_initializes_and_opens_document(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "part.stl").write_bytes(b"solid part\nendsolid part\n")
            ui = root / "viewer.html"
            ui.write_text("<!doctype html><title>CAD</title>", encoding="utf-8")
            params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "cadgen.cli.mcp", "--root", str(root), "--ui", str(ui)],
                env={**os.environ, "CADGEN_CACHE_DIR": str(root / "cache")},
            )
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as client:
                    initialized = await client.initialize()
                    self.assertEqual(initialized.serverInfo.name, "CAD")
                    opened = await client.call_tool("cad_open", {"path": "part.stl"})
                    self.assertFalse(opened.isError)
                    self.assertEqual(opened.structuredContent["file"], "part.stl")

    async def test_library_reopens_recorded_authority_across_servers_and_obeys_explicit_root(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            project = base / "project"
            project.mkdir()
            selected = project / "part.stl"
            selected.write_bytes(b"solid part\nendsolid part\n")
            other = base / "other"
            other.mkdir()
            ui = base / "viewer.html"
            ui.write_text("<!doctype html><title>CAD</title>", encoding="utf-8")
            state = base / "user-state.sqlite3"
            with mock.patch("cadgen.mcp.backend.Path.cwd", return_value=other):
                first = create_server(ui_path=ui, library_path=state)
                second = create_server(ui_path=ui, library_path=state)
            async with create_connected_server_and_client_session(first) as client:
                opened = await client.call_tool("cad_open", {}, meta={"openai/resource": {"path": str(selected)}})
                recent_id = opened.structuredContent["recentId"]
                self.assertIsNotNone(opened.structuredContent["revision"])
            async with create_connected_server_and_client_session(second) as client:
                listed = await client.call_tool("cad_library", {})
                self.assertEqual(listed.structuredContent["items"][0]["id"], recent_id)
                opened = await client.call_tool("cad_open", {"recentId": recent_id})
                self.assertFalse(opened.isError)
                self.assertEqual(opened.structuredContent["rootPath"], str(project))
                result = await client.call_tool("cad_request", {
                    "path": "/__cad/asset?" + urlencode({"file": str(selected)}), "recentId": recent_id,
                })
                self.assertEqual(result.structuredContent["status"], 200)
                unknown = await client.call_tool("cad_open", {"recentId": "unrecorded"})
                self.assertTrue(unknown.isError)
                selected.unlink()
                listed = await client.call_tool("cad_library", {})
                self.assertTrue(listed.structuredContent["items"][0]["missing"])
                missing = await client.call_tool("cad_open", {"recentId": recent_id})
                self.assertTrue(missing.isError)
            restricted = create_server(other, ui_path=ui, library_path=state)
            async with create_connected_server_and_client_session(restricted) as client:
                listed = await client.call_tool("cad_library", {})
                self.assertEqual(listed.structuredContent["items"], [])
                denied = await client.call_tool("cad_open", {"recentId": recent_id})
                self.assertTrue(denied.isError)

    async def test_discovery_resource_and_host_scoped_open_over_real_sdk(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "small.stl").write_bytes(b"solid x\nendsolid x\n")
            ui = root / "viewer.html"
            ui.write_text("<!doctype html><title>CAD test fixture</title>", encoding="utf-8")
            server = create_server(root, ui_path=ui)
            async with create_connected_server_and_client_session(server) as client:
                listed = (await client.list_tools()).tools
                tools = {tool.name: tool for tool in listed}
                self.assertEqual(tools["cad_request"].meta["ui"]["visibility"], ["app"])
                self.assertTrue(tools["cad_library"].annotations.destructiveHint)
                ui_uri = tools["cad_open"].meta["ui"]["resourceUri"]
                self.assertEqual(ui_uri, f"ui://cad/viewer/{hashlib.sha256(ui.read_bytes()).hexdigest()}.html")
                self.assertEqual(tools["cad_open"].title, "CAD")
                self.assertEqual(tools["cad_open"].icons[0].mimeType, "image/svg+xml")
                self.assertEqual(tools["cad_open"].meta["openai/ui"]["entrypoints"], [
                    {"type": "global"},
                    {"type": "file", "extensions": [".step", ".stp", ".stl", ".glb", ".3mf"]},
                ])
                sidebar = await client.call_tool("cad_open", {})
                self.assertFalse(sidebar.isError)
                self.assertIsNone(sidebar.structuredContent["file"])
                self.assertEqual(sidebar.structuredContent["rootPath"], str(root))
                resource = (await client.read_resource(ui_uri)).contents[0]
                self.assertEqual(resource.mimeType, UI_MIME_TYPE)
                self.assertEqual(resource.text, ui.read_text(encoding="utf-8"))
                self.assertEqual(resource.meta["ui"]["csp"], {
                    "connectDomains": ["data:", "blob:"],
                    "resourceDomains": ["data:", "blob:"],
                })
                self.assertEqual(resource.meta["ui"]["permissions"], {"clipboardWrite": {}})
                listed_resource = (await client.list_resources()).resources[0]
                self.assertEqual(str(listed_resource.uri), ui_uri)
                self.assertEqual(listed_resource.meta, resource.meta)
                opened = await client.call_tool("cad_open", {"path": "small.stl"})
                self.assertFalse(opened.isError)
                self.assertEqual(opened.structuredContent["file"], "small.stl")
                opaque_file = {"file": {"name": "wrong.step", "resourceUri": "host-resource://opaque"}}
                initial = await client.call_tool("cad_open", opaque_file)
                self.assertIsNone(initial.structuredContent["file"])
                resolved = await client.call_tool("cad_open", opaque_file, meta={"openai/resource": {"path": str(root / "small.stl")}})
                self.assertEqual(resolved.structuredContent["file"], "small.stl")
                denied = await client.call_tool("cad_open", {"path": "small.stl"}, meta={"openai/resource": {"path": str(root.parent / "outside.step")}})
                self.assertTrue(denied.isError)
                data = await client.call_tool("cad_request", {"path": "/__cad/asset?" + urlencode({"file": str(root / "small.stl")})})
                self.assertFalse(data.isError)
                self.assertEqual(base64.b64decode(data.structuredContent["body"]), (root / "small.stl").read_bytes())

    async def test_ui_resource_cache_key_tracks_content_and_serves_immutable_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            ui = root / "viewer.html"
            original = b"<!doctype html>\r\n<title>CAD first</title>"
            ui.write_bytes(original)
            first = create_server(root, ui_path=ui)
            same = create_server(root, ui_path=ui)
            ui.write_bytes(b"<!doctype html><title>CAD rebuilt</title>")
            changed = create_server(root, ui_path=ui)
            uris = []
            for server, expected in ((first, original), (same, original), (changed, ui.read_bytes())):
                async with create_connected_server_and_client_session(server) as client:
                    tool = next(tool for tool in (await client.list_tools()).tools if tool.name == "cad_open")
                    uri = tool.meta["ui"]["resourceUri"]
                    uris.append(uri)
                    resource = (await client.read_resource(uri)).contents[0]
                    self.assertEqual(resource.text.encode("utf-8"), expected)
            self.assertEqual(uris[0], uris[1])
            self.assertNotEqual(uris[0], uris[2])

    def test_missing_ui_fails_startup_with_actionable_hint(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "absent.html"
            with self.assertRaisesRegex(AssetMissing, "CAD extension UI is missing") as caught:
                create_server(directory, ui_path=missing)
            self.assertIn(str(missing), str(caught.exception))
            cli = subprocess.run(
                [sys.executable, "-m", "cadgen.cli.mcp", "--root", directory, "--ui", str(missing)],
                capture_output=True, text=True,
            )
            self.assertEqual(cli.returncode, 1)
            self.assertIn("CAD MCP: CAD extension UI is missing", cli.stderr)
            self.assertNotIn("Traceback", cli.stderr)

    def test_cli_help_and_server_import_do_not_load_kernel(self):
        code = (
            "import sys; from cadgen.cli import main; "
            "assert main(['mcp', '--help']) == 0; "
            "import cadgen.mcp.server; "
            "assert not any(x == 'OCP' or x.startswith('OCP.') or x == 'build123d' "
            "or x.startswith('build123d.') for x in sys.modules)"
        )
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--root", result.stdout)


if __name__ == "__main__":
    unittest.main()
