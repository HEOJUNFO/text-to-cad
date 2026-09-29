"""Official MCP SDK wiring. Only imported by the optional MCP command."""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
from pathlib import Path

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult, Icon, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field

from cadgen.assets import AssetMissing, runtime_build_hint, runtime_root
from .backend import SUPPORTED_EXTENSIONS, ViewerRoots

UI_URI = "ui://cad/viewer/v1.html"
UI_MIME_TYPE = "text/html;profile=mcp-app"
CAD_ICON = Icon(
    src="data:image/svg+xml;base64," + base64.b64encode(
        b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" '
        b'stroke="currentColor" stroke-width="1.33" stroke-linejoin="round">'
        b'<path d="m10 2 7 4v8l-7 4-7-4V6Zm-7 4 7 4 7-4M10 10v8"/></svg>'
    ).decode("ascii"),
    mimeType="image/svg+xml", sizes=["20x20"],
)


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


def create_server(root: str | Path | None = None, *, ui_path: str | Path | None = None, port: int = 8000) -> FastMCP:
    roots = ViewerRoots(root)

    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield None
        finally:
            roots.close()

    server = FastMCP(
        "CAD", instructions="Use the CAD skills for modeling. This server opens existing CAD artifacts; it never executes model source.",
        lifespan=lifespan, host="127.0.0.1", port=port,
        max_request_body_size=9 * 1024 * 1024,
    )
    html_path = Path(ui_path) if ui_path else runtime_root() / "chatgpt" / "index.html"

    @server.resource(UI_URI, name="CAD", mime_type=UI_MIME_TYPE, meta={
        "ui": {
            "prefersBorder": False,
            # The single-file bundle creates blob workers and fetches embedded
            # fonts/assets. These local schemes grant no network origin. MCP
            # Apps maps resourceDomains to static-resource CSP directives and
            # connectDomains to fetch/XHR (including data/blob URL reads).
            "csp": {"connectDomains": ["data:", "blob:"], "resourceDomains": ["data:", "blob:"]},
            "permissions": {"clipboardWrite": {}},
        },
    })
    def viewer_html() -> str:
        if not html_path.is_file():
            raise AssetMissing("CAD extension UI is missing. " + runtime_build_hint(html_path))
        return html_path.read_text(encoding="utf-8")

    @server.tool(
        name="cad_open", title="CAD", icons=[CAD_ICON],
        description="Open an existing STEP, STL, GLB or 3MF in the CAD viewer. Model paths stay within the working directory or explicit --root; host file entrypoints can authorize their containing directory unless --root restricts them.",
        annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False),
        meta={
            "ui": {"resourceUri": UI_URI},
            "openai/ui": {"entrypoints": [
                {"type": "global"},
                {"type": "file", "extensions": list(SUPPORTED_EXTENSIONS)},
            ]},
        },
    )
    async def cad_open(ctx: Context, path: str | None = None, file: FileInput | None = None) -> CallToolResult:
        resource_path = _resource_path(ctx)
        bridge = await asyncio.to_thread(roots.for_resource, resource_path)
        # A file entrypoint initially may supply only an opaque URI. The UI's
        # first cad_open call receives the host-injected path; never infer it
        # from the filename or treat the opaque URI as a filesystem location.
        result = await asyncio.to_thread(bridge.open, path=path if file is None else None, resource_path=resource_path)
        if file is not None:
            result["resourceUri"] = file.resourceUri
        return _result(result, "CAD viewer opened.")

    @server.tool(
        name="cad_request", title="CAD data",
        description="Internal CAD viewer transport. Reads CAD artifacts and resolves derived geometry through the existing viewer backend.",
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False),
        meta={"ui": {"visibility": ["app"]}},
    )
    async def cad_request(ctx: Context, path: str, method: str = "GET", body: str | None = None,
                          offset: int = 0, revision: str | None = None) -> CallToolResult:
        bridge = await asyncio.to_thread(roots.for_resource, _resource_path(ctx))
        return _result(await asyncio.to_thread(bridge.request, path, method, body, offset, revision))

    return server
