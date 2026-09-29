"""Official MCP SDK wiring. Only imported by the optional MCP command."""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult, Icon, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field

from cadgen.assets import AssetMissing, runtime_build_hint, runtime_root
from .backend import SUPPORTED_EXTENSIONS, ViewerRoots
from .ui_resources import UI_TEMPLATE, UiResources
from .library import RecentLibrary

UI_MIME_TYPE = "text/html;profile=mcp-app"
CAD_TAGLINE = "Give your agent CAD superpowers."


class FileInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1)
    resourceUri: str = Field(min_length=1)


def _result(payload: dict, text: str = "") -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=text)] if text else [],
        structuredContent=payload,
    )


def _resource_path(ctx: Context) -> str | None:
    meta = ctx.request_context.meta
    metadata = meta.model_dump() if meta is not None else {}
    resource = metadata.get("openai/resource") or {}
    value = resource.get("path") if isinstance(resource, dict) else None
    if value is not None and (not isinstance(value, str) or not Path(value).is_absolute()):
        raise ValueError("Host resource path must be an absolute local path")
    return value


def create_server(root: str | Path | None = None, *, ui_path: str | Path | None = None,
                  library_path: str | Path | None = None, port: int = 8000) -> FastMCP:
    icon = Icon(
        src="data:image/svg+xml;base64," + base64.b64encode(Path(__file__).with_name("logo-c.svg").read_bytes()).decode("ascii"),
        mimeType="image/svg+xml", sizes=["any"],
    )
    html_path = Path(ui_path) if ui_path else runtime_root() / "chatgpt" / "index.html"
    if not html_path.is_file():
        raise AssetMissing("CAD extension UI is missing. " + runtime_build_hint(html_path))
    ui = UiResources(html_path.read_bytes())
    ui_uri = ui.uri
    roots = ViewerRoots(root)
    library = RecentLibrary(library_path, root=root)

    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield None
        finally:
            roots.close()

    server = FastMCP(
        "CAD", icons=[icon],
        instructions=CAD_TAGLINE + " Use the CAD skills for modeling. This server opens existing CAD artifacts; it never executes model source.",
        lifespan=lifespan, host="127.0.0.1", port=port,
        max_request_body_size=9 * 1024 * 1024,
    )
    ui_metadata = {
        "ui": {
            "prefersBorder": False,
            # The single-file bundle creates blob workers and fetches embedded
            # fonts/assets. These local schemes grant no network origin. MCP
            # Apps maps resourceDomains to static-resource CSP directives and
            # connectDomains to fetch/XHR (including data/blob URL reads).
            "csp": {"connectDomains": ["data:", "blob:"], "resourceDomains": ["data:", "blob:"]},
            "permissions": {"clipboardWrite": {}},
        },
    }

    @server.resource(ui_uri, name="CAD", description=CAD_TAGLINE, icons=[icon], mime_type=UI_MIME_TYPE, meta=ui_metadata)
    def viewer_html() -> str:
        return ui.html

    @server.resource(UI_TEMPLATE, name="CAD interface version", icons=[icon], mime_type=UI_MIME_TYPE, meta=ui_metadata)
    def viewer_version(digest: str) -> str:
        return ui.read(digest)

    @server.tool(
        name="cad_open", title="CAD", icons=[icon],
        description="Open an existing STEP, STL, GLB or 3MF in the CAD viewer. Model paths stay within the working directory or explicit --root; host file entrypoints can authorize their containing directory unless --root restricts them.",
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False),
        meta={
            "ui": {"resourceUri": ui_uri},
            "openai/ui": {"entrypoints": [
                {"type": "global"},
                {"type": "file", "extensions": list(SUPPORTED_EXTENSIONS)},
            ]},
        },
    )
    async def cad_open(ctx: Context, path: str | None = None, file: FileInput | None = None,
                       recentId: str | None = None) -> CallToolResult:
        if recentId is not None:
            if path is not None or file is not None:
                raise ValueError("Open a recentId or a file, not both")
            record = await asyncio.to_thread(library.get, recentId)
            bridge = await asyncio.to_thread(roots.for_recent, record)
            resource_path = record["path"]
        else:
            resource_path = _resource_path(ctx)
            bridge = await asyncio.to_thread(roots.for_resource, resource_path)
        # A file entrypoint initially may supply only an opaque URI. The UI's
        # first cad_open call receives the host-injected path; never infer it
        # from the filename or treat the opaque URI as a filesystem location.
        result = await asyncio.to_thread(bridge.open, path=path if file is None else None, resource_path=resource_path)
        if file is not None:
            result["resourceUri"] = file.resourceUri
        if result["file"] is not None:
            recent = await asyncio.to_thread(library.record, result["rootPath"], result["file"], result["rootId"])
            result.update(recentId=recent["id"], revision=recent["revision"])
        return _result(result, "CAD viewer opened.")

    @server.tool(
        name="cad_library", title="CAD library",
        description="Read and manage models previously opened in the CAD extension, including pins and preview images. Never scans directories.",
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False),
        meta={"ui": {"visibility": ["app"]}},
    )
    async def cad_library(action: Literal["list", "pin", "remove", "thumbnail"] = "list",
                          recentId: str | None = None, pinned: bool | None = None,
                          thumbnail: str | None = None, revision: str | None = None) -> CallToolResult:
        if action == "list":
            return _result(await asyncio.to_thread(library.list))
        if recentId is None:
            raise ValueError("Library updates require recentId")
        return _result(await asyncio.to_thread(library.update, action, recentId,
                                              pinned=pinned, thumbnail=thumbnail, revision=revision))

    @server.tool(
        name="cad_request", title="CAD data",
        description="Internal CAD viewer transport. Reads CAD artifacts and resolves derived geometry through the existing viewer backend.",
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False),
        meta={"ui": {"visibility": ["app"]}},
    )
    async def cad_request(ctx: Context, path: str, method: str = "GET", body: str | None = None,
                          offset: int = 0, revision: str | None = None, recentId: str | None = None,
                          rootId: str | None = None) -> CallToolResult:
        if recentId is not None:
            record = await asyncio.to_thread(library.get, recentId, rootId)
            bridge = await asyncio.to_thread(roots.for_recent, record)
        else:
            bridge = await asyncio.to_thread(roots.for_resource, _resource_path(ctx))
        if rootId is not None and rootId != bridge.app.root_id:
            raise ValueError("CAD view root does not match the authorized directory; reopen the model")
        return _result(await asyncio.to_thread(bridge.request, path, method, body, offset, revision))

    return server
