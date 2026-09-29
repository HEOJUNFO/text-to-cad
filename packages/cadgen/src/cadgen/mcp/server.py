"""Official MCP SDK wiring. Only imported by the optional MCP command."""
from __future__ import annotations

import asyncio
import base64
from contextlib import asynccontextmanager
from pathlib import Path
from importlib.metadata import version
import sqlite3
import logging
import threading
from typing import Literal

from mcp.server.fastmcp import Context, FastMCP
from mcp.types import CallToolResult, Icon, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field

from cadgen.assets import AssetMissing, runtime_build_hint, runtime_root
from .backend import SUPPORTED_EXTENSIONS, ViewerDocuments
from .ui_resources import UI_TEMPLATE, UiResources
from .library import RecentLibrary
from .documents import describe_document, resolve_document

UI_MIME_TYPE = "text/html;profile=mcp-app"
API_VERSION = 2
CAD_TAGLINE = "Give your agent CAD superpowers."


class FileInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1)
    resourceUri: str = Field(min_length=1)


class DocumentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    path: str = Field(min_length=1)
    name: str | None = None
    revision: str | None = None


class ApiError(ValueError):
    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code, self.retryable = code, retryable


def _check_version(api_version: int | None):
    if api_version not in (None, 1, API_VERSION):
        raise ApiError("API_VERSION_UNSUPPORTED", f"CAD API {api_version} is unsupported by this server (API {API_VERSION}). Reload the CAD plugin connection.")


def _error(error: Exception) -> CallToolResult:
    if isinstance(error, ApiError):
        code, retryable = error.code, error.retryable
    elif isinstance(error, OSError):
        code, retryable = ("FILE_NOT_FOUND" if isinstance(error, FileNotFoundError) else "INVALID_DOCUMENT"), False
    elif isinstance(error, ValueError):
        text = str(error).lower()
        code = "FILE_NOT_FOUND" if "missing or unreadable" in text else "DOCUMENT_CHANGED" if "changed" in text or "points elsewhere" in text else "INVALID_DOCUMENT"
        retryable = code == "DOCUMENT_CHANGED"
    else:
        code, retryable = "INTERNAL_ERROR", False
    if code == "INTERNAL_ERROR":
        logging.getLogger(__name__).error("Unhandled CAD MCP error", exc_info=(type(error), error, error.__traceback__))
    message = str(error) if code != "INTERNAL_ERROR" else "CAD encountered an internal error. Reload the plugin connection and include the handshake version when reporting it."
    return CallToolResult(isError=True, content=[TextContent(type="text", text=message)],
        structuredContent={"apiVersion": API_VERSION, "error": {"code": code, "message": message, "retryable": retryable}})


def _result(payload: dict, text: str = "") -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=text)] if text else [],
        structuredContent={"apiVersion": API_VERSION, **payload},
    )


def _resource_path(ctx: Context) -> str | None:
    meta = ctx.request_context.meta
    metadata = meta.model_dump() if meta is not None else {}
    resource = metadata.get("openai/resource") or {}
    value = resource.get("path") if isinstance(resource, dict) else None
    if value is not None and (not isinstance(value, str) or not Path(value).is_absolute()):
        raise ValueError("Host resource path must be an absolute local path")
    return value


def create_server(*, ui_path: str | Path | None = None,
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
    documents = ViewerDocuments()
    # Constructing/discovering CAD must not touch optional history storage.
    library = None
    library_lock = threading.Lock()

    def history():
        nonlocal library
        with library_lock:
            if library is None:
                try:
                    library = RecentLibrary(library_path)
                except Exception as error:
                    raise ApiError("HISTORY_UNAVAILABLE", f"CAD history could not be initialized: {error}. Documents can still be opened by absolute path.", retryable=True) from error
        return library

    def history_call(method, *args, **kwargs):
        try:
            return getattr(history(), method)(*args, **kwargs)
        except (sqlite3.Error, OSError) as error:
            raise ApiError("HISTORY_UNAVAILABLE", f"CAD history is unavailable: {error}. Documents can still be opened by absolute path.", retryable=True) from error

    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield None
        finally:
            documents.close()

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

    @server.tool(name="cad_handshake", title="CAD connection",
                 description="Negotiate the CAD app protocol and report server/build identity without reading history.",
                 annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False),
                 meta={"ui": {"visibility": ["app"]}})
    async def cad_handshake(apiVersion: int = API_VERSION) -> CallToolResult:
        try:
            _check_version(apiVersion)
            return _result({"supportedApiVersions": [1, API_VERSION], "documentTransport": "descriptor",
                            "serverVersion": version("cadgen"), "uiDigest": ui.digest, "uiResourceUri": ui_uri,
                            "uiCacheAvailable": ui.cache_error is None})
        except Exception as error:
            return _error(error)

    @server.tool(
        name="cad_open", title="CAD", icons=[icon],
        description="Open an existing STEP, STL, GLB or 3MF in the CAD viewer. Use an absolute local CAD file path or a previously opened documentId. No workspace directory is required.",
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
                       documentId: str | None = None, document: DocumentInput | None = None,
                       apiVersion: int | None = None) -> CallToolResult:
        try:
            _check_version(apiVersion)
            if sum(value is not None for value in (path, file, documentId, document)) > 1:
                raise ValueError("Open an absolute path, document descriptor, documentId or host file input, not multiple inputs")
            if document is not None:
                opened = await asyncio.to_thread(resolve_document, document.model_dump())
            else:
                selected = _resource_path(ctx) if file is not None else path
                if selected is None and documentId is not None:
                    selected = (await asyncio.to_thread(history_call, "get", documentId))["path"]
                # Some native entrypoint hosts provide metadata without file input.
                if selected is None and path is None and documentId is None:
                    selected = _resource_path(ctx)
                opened = await asyncio.to_thread(describe_document, selected) if selected is not None else None
            result = {"document": opened}
            if file is not None:
                result["resourceUri"] = file.resourceUri
            if opened is not None:
                try:
                    await asyncio.to_thread(history_call, "record", opened["path"])
                except Exception as error:
                    result["warnings"] = [{"code": "HISTORY_UNAVAILABLE", "message": str(error), "retryable": True}]
            return _result(result, "CAD viewer opened.")
        except Exception as error:
            return _error(error)

    @server.tool(
        name="cad_library", title="CAD library",
        description="Read and manage models previously opened in the CAD extension, including pins and preview images. Never scans directories.",
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False),
        meta={"ui": {"visibility": ["app"]}},
    )
    async def cad_library(action: Literal["list", "pin", "remove", "thumbnail"] = "list",
                          documentId: str | None = None, pinned: bool | None = None,
                          thumbnail: str | None = None, revision: str | None = None,
                          apiVersion: int | None = None) -> CallToolResult:
        try:
            _check_version(apiVersion)
            if action == "list":
                return _result(await asyncio.to_thread(history_call, "list"))
            if documentId is None:
                raise ValueError("Library updates require documentId")
            return _result(await asyncio.to_thread(history_call, "update", action, documentId,
                                                  pinned=pinned, thumbnail=thumbnail, revision=revision))
        except Exception as error:
            return _error(error)

    @server.tool(
        name="cad_request", title="CAD data",
        description="Internal CAD viewer transport. Reads CAD artifacts and resolves derived geometry through the existing viewer backend.",
        annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False),
        meta={"ui": {"visibility": ["app"]}},
    )
    async def cad_request(path: str, document: DocumentInput | None = None,
                          documentId: str | None = None, apiVersion: int | None = None,
                          method: str = "GET", body: str | None = None,
                          offset: int = 0, revision: str | None = None) -> CallToolResult:
        try:
            _check_version(apiVersion)
            if document is not None and documentId is None:
                record = await asyncio.to_thread(resolve_document, document.model_dump())
            elif documentId is not None and document is None and apiVersion in (None, 1):
                saved = await asyncio.to_thread(history_call, "get", documentId)
                record = await asyncio.to_thread(describe_document, saved["path"])
                # A mounted API-1 viewer scoped its caches with this historical
                # UUID. Preserve that live transport identity through upgrade.
                record["id"] = documentId
            else:
                raise ValueError("CAD API 2 data requests require one self-contained document descriptor; reopen the absolute path")
            bridge = documents.get(record)
            return _result(await asyncio.to_thread(bridge.request, path, method, body, offset, revision))
        except Exception as error:
            return _error(error)

    return server
