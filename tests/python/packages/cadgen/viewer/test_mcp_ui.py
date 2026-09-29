"""UI resource discovery and reads may run through different MCP sessions."""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from mcp.shared.memory import create_connected_server_and_client_session

from cadgen.mcp.server import create_server
from cadgen.mcp.ui_resources import UiResources


class UiResourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_connections_on_either_side_of_a_rebuild_read_both_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.dict(os.environ, {
                "CADGEN_MCP_UI_CACHE_DIR": str(root / "interfaces"),
                "CADGEN_STATE_DIR": str(root / "state"),
                "CADGEN_CACHE_DIR": str(root / "geometry"),
            }):
                html = root / "app.html"
                first = "<!doctype html><title>first</title>"
                second = "<!doctype html><title>second</title>"
                html.write_text(first)
                older = create_server(root, ui_path=html)
                async with create_connected_server_and_client_session(older) as old_client:
                    old_uri = next(t for t in (await old_client.list_tools()).tools if t.name == "cad_open").meta["ui"]["resourceUri"]
                    html.write_text(second)
                    newer = create_server(root, ui_path=html)
                    async with create_connected_server_and_client_session(newer) as new_client:
                        new_uri = next(t for t in (await new_client.list_tools()).tools if t.name == "cad_open").meta["ui"]["resourceUri"]
                        self.assertNotEqual(old_uri, new_uri)
                        for client in (old_client, new_client):
                            for uri, expected in ((old_uri, first), (new_uri, second)):
                                resource = (await client.read_resource(uri)).contents[0]
                                self.assertEqual(resource.text, expected)
                                self.assertFalse(resource.meta["ui"]["prefersBorder"])

    def test_unknown_invalid_and_corrupted_bundles_never_return_other_bytes(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"CADGEN_MCP_UI_CACHE_DIR": directory}):
            first = UiResources(b"first")
            second = UiResources(b"second")
            for invalid in ("../secret", "v1", "A" * 64):
                with self.assertRaisesRegex(ValueError, "Invalid"):
                    first.read(invalid)
            with self.assertRaisesRegex(ValueError, "no longer cached"):
                first.read("0" * 64)
            (Path(directory) / f"{second.digest}.html").write_bytes(b"replaced")
            with self.assertRaisesRegex(ValueError, "content check"):
                first.read(second.digest)
            # The owning session's immutable in-memory snapshot still works.
            self.assertEqual(second.read(second.digest), "second")


if __name__ == "__main__":
    unittest.main()
