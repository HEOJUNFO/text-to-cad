"""MCP protocol and shared-viewer contract, with tiny test-owned documents."""
from __future__ import annotations

import base64
from contextlib import closing
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

from cadgen.mcp.backend import CHUNK_BYTES, ViewerBridge
from cadgen.mcp.library import RecentLibrary
from cadgen.mcp import server as mcp_server
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
        self.bridge = ViewerBridge({"id": "test-document", "path": str(self.file)})
        self.addCleanup(self.bridge.close)
    def test_asset_bytes_catalog_and_replacement_use_the_existing_viewer(self):
        path = "/__cad/asset?" + urlencode({"file": str(self.file)})
        response = self.bridge.request(path)
        self.assertEqual(response["status"], 200)
        self.assertEqual(base64.b64decode(response["body"]), self.file.read_bytes())
        self.assertEqual(self.bridge.request(path, "HEAD")["body"], "")
        catalog = self.bridge.request("/__cad/catalog?" + urlencode({"file": str(self.file)}))
        payload = json.loads(base64.b64decode(catalog["body"]))
        self.assertEqual(payload["scopeId"], "test-document")
        self.assertEqual(payload["entries"][0]["file"], str(self.file))
        self.assertNotIn("rootRelativeFile", payload["entries"][0])
        self.file.write_bytes(b"solid revised\nendsolid revised\n")
        self.assertEqual(base64.b64decode(self.bridge.request(path)["body"]), self.file.read_bytes())

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
            if route == "asset":
                result = self.bridge.request(f"/__cad/{route}?" + urlencode({"file": str(outside)}), method)
                self.assertEqual(result["status"], 403)
            else:
                with self.assertRaisesRegex(ValueError, "different CAD document"):
                    self.bridge.request(f"/__cad/{route}?" + urlencode({"file": str(outside)}), method)
        source = self.root / "model.py"
        source.write_text("raise RuntimeError('MUST NOT RUN')", encoding="utf-8")
        result = self.bridge.request("/__cad/asset?" + urlencode({"file": str(source)}))
        self.assertEqual(result["status"], 403)

    def test_only_explicit_glb_dependencies_can_cross_parent(self):
        import struct
        dependency = Path(self.tmp.name, "texture.png").resolve()
        dependency.write_bytes(b"declared texture")
        file = self.root / "part.glb"
        metadata = json.dumps({"asset": {"version": "2.0"}, "images": [{"uri": "../texture.png"}]}).encode()
        metadata += b" " * (-len(metadata) % 4)
        file.write_bytes(struct.pack("<4sIIII", b"glTF", 2, 20 + len(metadata), len(metadata), 0x4e4f534a) + metadata)
        bridge = ViewerBridge({"id": "glb", "path": str(file)})
        self.addCleanup(bridge.close)
        result = bridge.request("/__cad/asset?" + urlencode({"file": str(dependency)}))
        self.assertEqual(base64.b64decode(result["body"]), b"declared texture")
        result = bridge.request("/__cad/asset?" + urlencode({"file": str(self.file)}))
        self.assertEqual(result["status"], 403)

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
        bridge = ViewerBridge({"id": "step", "path": str(step)})
        self.addCleanup(bridge.close)
        with mock.patch.object(bridge.app.ops, "build_artifact", return_value={"ok": True}) as compile_document:
            result = bridge.request("/__cad/artifact?" + urlencode({"file": str(step)}), "POST")
        self.assertEqual(result["status"], 200)
        compile_document.assert_called_once_with(str(step), force=False)
        catalog = json.loads(base64.b64decode(result["body"]))["catalog"]
        self.assertEqual(catalog["scopeId"], "step")
        self.assertNotIn("rootId", catalog)

    def test_step_sidecar_catalog_uses_shared_saved_document_metadata(self):
        from tests.python.support.store_fixtures import seed_result
        step = self.root / "sidecar.step"
        step.write_bytes(b"test-owned document bytes")
        seed_result(step, {"kind": "assembly-package", "components": {"c0": {}}})
        sidecar = Path(str(step) + ".json")
        sidecar.write_text(json.dumps({"schemaVersion": 9, "documentHash": hashlib.sha256(step.read_bytes()).hexdigest(),
                                      "kinematics": {}}))
        bridge = ViewerBridge({"id": "sidecar", "path": str(step)})
        self.addCleanup(bridge.close)
        with mock.patch("cadgen.viewer.scanner._collect_cad_source_files", side_effect=AssertionError("must not scan")):
            catalog = json.loads(base64.b64decode(bridge.request("/__cad/catalog")["body"]))
        entry = catalog["entries"][0]
        self.assertEqual(entry["file"], str(step))
        self.assertEqual(entry["sourceUrl"], entry["poseUrl"])
        data = bridge.request(entry["sourceUrl"])
        self.assertEqual(base64.b64decode(data["body"]), sidecar.read_bytes())

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
    def test_canonical_aliases_and_deleted_history_keep_document_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "part.stl"
            file.write_bytes(b"solid part\nendsolid part\n")
            alias = root / "alias.stl"
            alias.symlink_to(file)
            library = RecentLibrary(root / "library.sqlite3")
            document = library.record(str(file))
            self.assertEqual(library.record(str(alias))["id"], document["id"])
            library.update("remove", document["id"])
            self.assertEqual(RecentLibrary(library.path).get(document["id"])["path"], str(file))
            self.assertEqual(library.list(), {"items": []})
            self.assertEqual(library.record(str(file))["id"], document["id"])

    def test_replaced_registered_path_requires_explicit_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file, replacement = root / "part.stl", root / "replacement.stl"
            file.write_bytes(b"original")
            replacement.write_bytes(b"replacement")
            library = RecentLibrary(root / "library.sqlite3")
            document = library.record(str(file))
            file.unlink()
            file.symlink_to(replacement)
            with self.assertRaisesRegex(ValueError, "reopen its absolute path"):
                library.get(document["id"])
            new_document = library.record(str(file))
            self.assertNotEqual(new_document["id"], document["id"])
            self.assertEqual(new_document["path"], str(replacement))

    def test_pins_identity_thumbnail_revisions_and_removal_persist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "part.stl"
            file.write_bytes(b"solid part\nendsolid part\n")
            path = root / "state/library.sqlite3"
            first = RecentLibrary(path)
            item = first.record(str(file))
            second = RecentLibrary(path)
            self.assertEqual(second.record(str(file))["id"], item["id"])
            pinned = first.update("pin", item["id"], pinned=True)
            self.assertTrue(pinned["items"][0]["pinned"])
            from PIL import Image
            image = io.BytesIO()
            Image.new("RGB", (1, 1)).save(image, format="PNG")
            png = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode("ascii")
            second.update("thumbnail", item["id"], thumbnail=png, revision=item["revision"])
            self.assertEqual(first.update("thumbnail", item["id"])["thumbnail"], png)
            thumbnail_revision = first.update("thumbnail", item["id"])["revision"]
            self.assertEqual(first.list()["items"][0]["thumbnailRevision"], thumbnail_revision)
            replacement = io.BytesIO()
            Image.new("RGB", (1, 1), "red").save(replacement, format="PNG")
            replacement_png = "data:image/png;base64," + base64.b64encode(replacement.getvalue()).decode("ascii")
            updated = second.update("thumbnail", item["id"], thumbnail=replacement_png, revision=item["revision"])
            self.assertNotEqual(updated["revision"], thumbnail_revision)
            self.assertEqual(first.list()["items"][0]["thumbnailRevision"], updated["revision"])
            self.assertEqual(first.update("thumbnail", item["id"])["thumbnail"], replacement_png)
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

    def test_existing_library_gains_thumbnail_content_revision(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "part.stl"
            file.write_bytes(b"solid part\nendsolid part\n")
            database = root / "library.sqlite3"
            from cadgen.mcp.library import file_revision
            preview = "data:image/png;base64,cHJldmlldw=="
            with closing(sqlite3.connect(database)) as db, db:
                db.execute("""CREATE TABLE recent_models (
                    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, root TEXT NOT NULL,
                    opened REAL NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
                    thumbnail TEXT, thumbnail_revision TEXT
                )""")
                db.execute("INSERT INTO recent_models VALUES(?,?,?,?,?,?,?)",
                           ("saved", str(file), str(root), 1.0, 1, preview, file_revision(str(file))))
                db.execute("""CREATE TABLE model_roots (
                    recent_id TEXT NOT NULL, root_id TEXT NOT NULL, root TEXT NOT NULL,
                    PRIMARY KEY (recent_id, root_id)
                )""")
                db.execute("INSERT INTO model_roots VALUES(?,?,?)", ("saved", "bound-root", str(root)))
            library = RecentLibrary(database)
            item = library.list()["items"][0]
            self.assertTrue(item["pinned"])
            self.assertEqual(item["thumbnailRevision"], hashlib.sha256(preview.encode("ascii")).hexdigest())
            self.assertEqual(library.update("thumbnail", "saved"),
                             {"thumbnail": preview, "revision": item["thumbnailRevision"]})
            library.update("remove", "saved")
            self.assertEqual(RecentLibrary(database).get("saved"), {"id": "saved", "path": str(file)})
            with closing(sqlite3.connect(database)) as db, db:
                self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='model_roots'").fetchone())
            self.assertEqual(library.list(), {"items": []})

    def test_repair_preserves_live_old_schema_and_does_not_resurrect_removed_history(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "part.stl"
            file.write_bytes(b"solid original")
            database = root / "state.sqlite3"
            # Reproduce the document-registry release's surviving tables.
            with closing(sqlite3.connect(database)) as db, db:
                db.executescript("""CREATE TABLE documents(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE);
                    CREATE TABLE recents(id TEXT PRIMARY KEY,opened REAL,pinned INTEGER,
                        thumbnail TEXT,thumbnail_revision TEXT,thumbnail_hash TEXT);""")
                db.execute("INSERT INTO documents VALUES(?,?)", ("old-id", str(file)))
                db.execute("INSERT INTO recents VALUES(?,?,?,?,?,?)", ("old-id", 1., 1, "preview", "source", "image"))
            library = RecentLibrary(database)
            with closing(sqlite3.connect(database)) as old_process, old_process:
                self.assertEqual(old_process.execute("SELECT pinned,thumbnail FROM recent_models WHERE id='old-id'").fetchone(), (1, "preview"))
                old_process.execute("UPDATE recent_models SET pinned=0 WHERE id='old-id'")
                old_process.commit()
                self.assertFalse(library.list()["items"][0]["pinned"])
                RecentLibrary(database)
                old_process.execute("INSERT INTO model_roots VALUES(?,?,?,?)", ("old-id", "old-root", str(root), str(file)))
                old_process.commit()
                self.assertEqual(old_process.execute("SELECT root FROM model_roots").fetchone(), (str(root),))
            library.update("remove", "old-id")
            self.assertEqual(RecentLibrary(database).list(), {"items": []})
            self.assertEqual(library.get("old-id")["path"], str(file))

    def test_independent_processes_preserve_concurrent_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "state/library.sqlite3"
            code = (
                "from cadgen.mcp.library import RecentLibrary; import sys; "
                "library=RecentLibrary(sys.argv[1]); "
                "[library.record(str(__import__('pathlib').Path(sys.argv[2]) / (sys.argv[3] + str(i) + '.stl'))) for i in range(10)]"
            )
            for prefix in ("a", "b"):
                for index in range(10):
                    (root / f"{prefix}{index}.stl").write_bytes(b"solid part")
            processes = [subprocess.Popen([sys.executable, "-c", code, str(path), str(root), prefix],
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                         for prefix in ("a", "b")]
            for process in processes:
                _, error = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, error)
            self.assertEqual(len(RecentLibrary(path).list()["items"]), 20)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        env = mock.patch.dict(os.environ, {name: str(self.root / name) for name in
                              ("CADGEN_CACHE_DIR", "CADGEN_STATE_DIR", "CADGEN_MCP_UI_CACHE_DIR")})
        env.start()
        self.addCleanup(env.stop)
        self.ui = self.root / "viewer.html"
        self.ui.write_text("<!doctype html><title>CAD test fixture</title>")

    async def test_absolute_documents_survive_cross_session_native_handoff_and_history_removal(self):
        files = []
        for folder in ("workspace", "other"):
            directory = self.root / folder
            directory.mkdir()
            file = directory / "same.stl"
            file.write_bytes(folder.encode())
            files.append(file)
        first, second = create_server(ui_path=self.ui), create_server(ui_path=self.ui)
        async with create_connected_server_and_client_session(first) as client:
            opened = await client.call_tool("cad_open", {"path": str(files[0])})
            original = opened.structuredContent["document"]
            self.assertEqual(original["path"], str(files[0]))
            self.assertEqual(set(original), {"id", "path", "name", "revision"})
        # An already-open API-1 view carries its old database UUID, not a v2 hash.
        import sqlite3
        from cadgen.mcp.library import library_path
        with closing(sqlite3.connect(library_path())) as db, db:
            db.execute("UPDATE documents SET id='old-view-uuid' WHERE path=?", (original["path"],))
        async with create_connected_server_and_client_session(second) as client:
            legacy = await client.call_tool("cad_request", {"apiVersion": 1, "documentId": "old-view-uuid", "path": "/__cad/catalog"})
            self.assertFalse(legacy.isError)
            self.assertEqual(json.loads(base64.b64decode(legacy.structuredContent["body"]))["scopeId"], "old-view-uuid")
            native = await client.call_tool("cad_open", {"file": {"name": "same.stl", "resourceUri": "file://opaque"}},
                                          meta={"openai/resource": {"path": str(files[1])}})
            self.assertNotEqual(original["id"], native.structuredContent["document"]["id"])
            await client.call_tool("cad_library", {"action": "remove", "documentId": original["id"]})
            data = await client.call_tool("cad_request", {"documentId": original["id"],
                "path": "/__cad/asset?" + urlencode({"file": original["path"]})},
                meta={"openai/resource": {"path": str(files[1])}})
            self.assertFalse(data.isError)
            self.assertEqual(base64.b64decode(data.structuredContent["body"]), files[0].read_bytes())
            catalog = await client.call_tool("cad_request", {"documentId": original["id"], "path": "/__cad/catalog"})
            payload = json.loads(base64.b64decode(catalog.structuredContent["body"]))
            self.assertEqual([entry["file"] for entry in payload["entries"]], [original["path"]])
            self.assertEqual(payload["scopeId"], original["id"])
            history = (await client.call_tool("cad_library", {})).structuredContent["items"]
            self.assertEqual([item["id"] for item in history], [native.structuredContent["document"]["id"]])
            self.assertEqual(set(history[0]), {"id", "path", "name", "lastOpened", "pinned", "missing", "revision", "thumbnailRevision"})
            forged = await client.call_tool("cad_request", {"documentId": "forged", "path": "/__cad/catalog"})
            self.assertTrue(forged.isError)
            for route in ("catalog", "artifact", "preview"):
                denied = await client.call_tool("cad_request", {"documentId": original["id"],
                    "path": "/__cad/" + route + "?" + urlencode({"file": str(files[1])})})
                self.assertTrue(denied.isError)
            reopened = await client.call_tool("cad_open", {"documentId": original["id"]})
            self.assertEqual(reopened.structuredContent["document"]["id"], original["id"])
            files[0].unlink()
            missing = await client.call_tool("cad_open", {"documentId": original["id"]})
            self.assertTrue(missing.isError)
            self.assertIn("missing or unreadable", missing.content[0].text)

    async def test_discovery_resources_and_teaching_errors(self):
        server = create_server(ui_path=self.ui)
        async with create_connected_server_and_client_session(server) as client:
            tools = {tool.name: tool for tool in (await client.list_tools()).tools}
            self.assertEqual(tools["cad_request"].meta["ui"]["visibility"], ["app"])
            self.assertEqual(tools["cad_request"].inputSchema["required"], ["path"])
            self.assertTrue(tools["cad_library"].annotations.destructiveHint)
            tool = tools["cad_open"]
            self.assertEqual(tool.title, "CAD")
            self.assertEqual(base64.b64decode(tool.icons[0].src.split(",", 1)[1]),
                             Path(mcp_server.__file__).with_name("logo-c.svg").read_bytes())
            self.assertEqual(tool.meta["openai/ui"]["entrypoints"], [{"type": "global"},
                {"type": "file", "extensions": [".step", ".stp", ".stl", ".glb", ".3mf"]}])
            home = await client.call_tool("cad_open", {})
            self.assertEqual(home.structuredContent, {"apiVersion": 2, "document": None})
            opaque = await client.call_tool("cad_open", {"file": {"name": "part.stl", "resourceUri": "file://opaque"}})
            self.assertEqual(opaque.structuredContent, {"apiVersion": 2, "document": None, "resourceUri": "file://opaque"})
            for path, hint in (("relative.stl", "absolute local"), (str(self.root / "source.py"), "supported format"),
                               (str(self.root / "missing.stl"), "missing or unreadable")):
                result = await client.call_tool("cad_open", {"path": path})
                self.assertTrue(result.isError)
                self.assertIn(hint, result.content[0].text)
            uri = tool.meta["ui"]["resourceUri"]
            self.assertEqual(uri, f"ui://cad/viewer/v2/{hashlib.sha256(self.ui.read_bytes()).hexdigest()}.html")
            resource = (await client.read_resource(uri)).contents[0]
            self.assertEqual(resource.text, self.ui.read_text())
            self.assertEqual(resource.mimeType, UI_MIME_TYPE)
            self.assertEqual(resource.meta["ui"]["permissions"], {"clipboardWrite": {}})
            self.assertEqual(resource.meta["ui"]["csp"], {"connectDomains": ["data:", "blob:"], "resourceDomains": ["data:", "blob:"]})
            self.assertEqual((await client.list_resources()).resources[0].icons, tool.icons)

    async def test_v2_document_access_and_handshake_do_not_require_history(self):
        file = self.root / "part.stl"
        file.write_bytes(b"solid independent")
        blocked = self.root / "not-a-directory"
        blocked.write_bytes(b"block state creation")
        with mock.patch("cadgen.mcp.server.RecentLibrary", side_effect=AssertionError("startup touched history")):
            server = create_server(ui_path=self.ui, library_path=blocked / "history.sqlite3")
            async with create_connected_server_and_client_session(server) as client:
                handshake = await client.call_tool("cad_handshake", {"apiVersion": 2})
                self.assertFalse(handshake.isError)
                self.assertEqual(handshake.structuredContent["documentTransport"], "descriptor")
                self.assertTrue(handshake.structuredContent["serverVersion"])
                self.assertEqual(handshake.structuredContent["uiDigest"], hashlib.sha256(self.ui.read_bytes()).hexdigest())
                home = await client.call_tool("cad_open", {"apiVersion": 2})
                self.assertIsNone(home.structuredContent["document"])
        async with create_connected_server_and_client_session(server) as client:
            opened = await client.call_tool("cad_open", {"apiVersion": 2, "path": str(file)})
            self.assertFalse(opened.isError)
            self.assertEqual(opened.structuredContent["warnings"][0]["code"], "HISTORY_UNAVAILABLE")
            document = opened.structuredContent["document"]
        # Another process needs neither the original connection nor its database.
        other = create_server(ui_path=self.ui, library_path=blocked / "different.sqlite3")
        async with create_connected_server_and_client_session(other) as client:
            response = await client.call_tool("cad_request", {"apiVersion": 2, "document": document,
                "path": "/__cad/asset?" + urlencode({"file": str(file)})})
            self.assertFalse(response.isError)
            self.assertEqual(base64.b64decode(response.structuredContent["body"]), file.read_bytes())
            unsupported = await client.call_tool("cad_handshake", {"apiVersion": 99})
            self.assertEqual(unsupported.structuredContent["error"]["code"], "API_VERSION_UNSUPPORTED")
            invalid = await client.call_tool("cad_request", {"apiVersion": 2,
                "document": {**document, "id": "forged"}, "path": "/__cad/catalog"})
            self.assertTrue(invalid.isError)
            self.assertEqual(invalid.structuredContent["error"]["code"], "INVALID_DOCUMENT")
            history = await client.call_tool("cad_library", {"apiVersion": 2})
            self.assertEqual(history.structuredContent["error"]["code"], "HISTORY_UNAVAILABLE")

    async def test_real_stdio_protocol(self):
        params = StdioServerParameters(command=sys.executable, args=["-m", "cadgen.cli.mcp", "--ui", str(self.ui)],
                                       env=dict(os.environ))
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                home = await client.call_tool("cad_open", {})
                self.assertEqual(home.structuredContent, {"apiVersion": 2, "document": None})

    async def test_ui_resource_cache_key_tracks_content_and_serves_immutable_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            ui = root / "viewer.html"
            original = b"<!doctype html>\r\n<title>CAD first</title>"
            ui.write_bytes(original)
            first = create_server(ui_path=ui)
            same = create_server(ui_path=ui)
            ui.write_bytes(b"<!doctype html><title>CAD rebuilt</title>")
            changed = create_server(ui_path=ui)
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
                create_server(ui_path=missing)
            self.assertIn(str(missing), str(caught.exception))
            cli = subprocess.run(
                [sys.executable, "-m", "cadgen.cli.mcp", "--ui", str(missing)],
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
        self.assertNotIn("--root", result.stdout)


if __name__ == "__main__":
    unittest.main()
