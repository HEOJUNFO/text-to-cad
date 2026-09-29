"""MCP transport over the shared viewer for one registered CAD document.

Only that document and declared dependencies are addressable. Content-addressed
store and display caches retain their existing contracts; no source executes.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import os
import threading
from urllib.parse import urlsplit

from cadgen.viewer.http_app import CadApp, POST_GUARD_HEADER
from cadgen.viewer.response import Request, Response
from cadgen.viewer.url_norm import request_query

from .documents import DocumentAssetBackend, SUPPORTED_EXTENSIONS
# The official JS stdio client caps a JSON frame at 10 MiB. Base64 bodies fit
# within that frame; file streams use smaller chunks without a total file cap.
MAX_BYTES = 6 * 1024 * 1024
CHUNK_BYTES = 4 * 1024 * 1024
_READ_PATHS = frozenset({
    "/__cad/catalog", "/__cad/artifact", "/__cad/asset", "/__cad/store",
    "/__cad/preview", "/__cad/server",
})
_POST_PATHS = frozenset({
    "/__cad/artifact", "/__cad/surfaces", "/__cad/surfaces/cancel",
})


class _BoundedBuffer(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_BYTES:
            raise ValueError("CAD MCP response exceeds the 6 MiB message limit")
        return super().write(data)


class _Capture:
    """The minimal handler interface used by the existing Response writer."""
    def __init__(self):
        self.wfile = _BoundedBuffer()
        self.status = 0
        self.headers = {}
        self.close_connection = False

    def send_response_only(self, status):
        self.status = status
        self.headers = {}
        self.wfile.seek(0)
        self.wfile.truncate()

    def send_header(self, name, value):
        self.headers[name.lower()] = value

    def date_time_string(self):
        return ""

    def end_headers(self):
        pass


def _file_revision(stat_result: os.stat_result) -> str:
    fields = (stat_result.st_dev, stat_result.st_ino, stat_result.st_size,
              stat_result.st_mtime_ns, stat_result.st_ctime_ns)
    return hashlib.sha256(repr(fields).encode("ascii")).hexdigest()


class _ChunkedResponse(Response):
    """Preserve viewer routing while adapting only file streaming to MCP."""
    def __init__(self, handler, *, head_only: bool, offset: int, revision: str | None):
        super().__init__(handler, head_only=head_only)
        self.offset = offset
        self.revision = revision
        self.transfer = None

    def stream_file(self, file_path, stat_result, content_type=""):
        with open(file_path, "rb") as handle:
            before = os.fstat(handle.fileno())
            revision = _file_revision(before)
            if _file_revision(stat_result) != revision or (self.revision is not None and self.revision != revision):
                raise ValueError("CAD asset changed during transfer; restart the read")
            if self.offset > before.st_size:
                raise ValueError("CAD transfer offset exceeds the file size")
            body = b""
            if not self._head_only:
                handle.seek(self.offset)
                body = handle.read(CHUNK_BYTES)
            if _file_revision(os.fstat(handle.fileno())) != revision or _file_revision(os.stat(file_path)) != revision:
                raise ValueError("CAD asset changed during transfer; restart the read")
        # Keep the complete resource headers; the app combines all chunks
        # before constructing a browser Response. HEAD never starts a transfer.
        headers = [("cache-control", "no-store"), ("content-length", before.st_size)]
        if content_type:
            headers.append(("content-type", content_type))
        self._begin(200, headers)
        self._write(body)
        if not self._head_only and (before.st_size > CHUNK_BYTES or self.offset):
            self.transfer = {"offset": self.offset, "totalBytes": before.st_size, "revision": revision}


class _DocumentApp(CadApp):
    def read_catalog(self, preferred_file=None) -> dict:
        return {**self.backend.read_catalog(preferred_file), "scopeId": self.document_id}


class ViewerBridge:
    def __init__(self, document: dict):
        self.document_id = document["id"]
        backend = DocumentAssetBackend(document["path"])
        self.app = _DocumentApp(root=backend.root_path, host="127.0.0.1", port=0, backend=backend)
        self.app.document_id = self.document_id
        self.app.auto_reload = False

    def close(self):
        self.app.ops.shutdown()

    def request(self, path: str, method: str = "GET", body: str | None = None,
                offset: int = 0, revision: str | None = None) -> dict:
        # The bridge binds file-bearing routes to its immutable document.
        # CadApp still owns compilation and content-addressed cache semantics.
        parsed = urlsplit(path)
        if (not path.startswith("/") or path.startswith("//") or parsed.scheme
                or parsed.netloc or parsed.fragment or "\\" in parsed.path
                or any(ord(char) < 32 for char in path)):
            raise ValueError("CAD MCP accepts only local viewer API paths")
        route = parsed.path
        cache = route.startswith("/__tess_cache/")
        allowed = (
            method in {"GET", "HEAD"} and (route in _READ_PATHS or cache)
            or method == "POST" and (route in _POST_PATHS or cache)
        )
        if not allowed:
            raise ValueError("This route or method is not exposed by CAD MCP")
        if type(offset) is not int or offset < 0:
            raise ValueError("CAD transfer offset must be a nonnegative integer")
        if revision is not None and (not isinstance(revision, str) or len(revision) != 64
                                     or any(char not in "0123456789abcdef" for char in revision)):
            raise ValueError("CAD transfer revision must be a SHA-256 token")
        if offset and revision is None:
            raise ValueError("CAD transfer continuation requires its revision")
        if (offset or revision is not None) and (method != "GET" or route not in {"/__cad/asset", "/__cad/store"}):
            raise ValueError("CAD transfer continuation is only available for file reads")
        raw = b""
        if body is not None:
            if len(body) > ((MAX_BYTES + 2) // 3) * 4:
                raise ValueError("CAD MCP request exceeds the 6 MiB message limit")
            try:
                raw = base64.b64decode(body, validate=True)
            except (binascii.Error, ValueError) as error:
                raise ValueError("CAD MCP body must be base64") from error
            if len(raw) > MAX_BYTES:
                raise ValueError("CAD MCP request exceeds the 6 MiB message limit")
        if method in {"GET", "HEAD"} and raw:
            raise ValueError("CAD MCP reads must not carry a body")
        request = Request(
            raw_method=method, path=route, query=request_query(path),
            headers={POST_GUARD_HEADER: "1", "content-length": str(len(raw))},
            read_body=lambda: raw,
        )
        if route in {"/__cad/catalog", "/__cad/artifact", "/__cad/preview"}:
            file = request.query.get("file")
            if file or route != "/__cad/catalog":
                self.app.backend.require_document(file or "")
        capture = _Capture()
        response = _ChunkedResponse(capture, head_only=request.is_head, offset=offset, revision=revision)
        if route == "/__cad/server":
            response.send_json(200, {
                "serverMode": "mcp", "serverFeatures": [], "backend": "local-fs",
                "scopeId": self.document_id, "stepArtifactGenerationAvailable": False,
                "autoReload": False,
            })
        else:
            self.app.handle(request, response)
        if capture.close_connection:
            raise ValueError("CAD asset changed or became unreadable during transfer; retry")
        if (offset or revision is not None) and capture.status == 200 and response.transfer is None:
            raise ValueError("This CAD response does not support transfer continuation")
        return {
            "status": capture.status,
            "headers": {k: v for k, v in capture.headers.items() if k != "date"},
            "body": base64.b64encode(capture.wfile.getvalue()).decode("ascii"),
            **({"transfer": response.transfer} if response.transfer is not None else {}),
        }


class ViewerDocuments:
    """Lazy document adapters; no directory limit or discovery.

    Each adapter owns only locks, subscriber IDs and an empty compile ledger.
    DocumentCompiler has no workers or threads: jobs belong to the shared pool.
    """
    def __init__(self):
        self._documents = {}
        self._lock = threading.Lock()

    def get(self, document: dict) -> ViewerBridge:
        with self._lock:
            bridge = self._documents.get(document["id"])
            if bridge is None:
                bridge = ViewerBridge(document)
                self._documents[document["id"]] = bridge
            return bridge

    def close(self):
        for bridge in self._documents.values():
            bridge.close()
