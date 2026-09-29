"""Immutable UI bundles shared by independently started MCP connections.

Discovery and resource reads need not use the same process. Keep published
bundles addressable after a rebuild; never substitute new bytes at an old URI.
This disposable interface cache is separate from CAD's geometry store and the
extension's persistent recent-model library.
"""
from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
import re
import sys

from cadgen._internal.atomic_replace import write_bytes_atomic

UI_TEMPLATE = "ui://cad/viewer/v2/{digest}.html"
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_MAX_BYTES = 8 * 1024 * 1024


def _cache_root() -> Path:
    override = os.environ.get("CADGEN_MCP_UI_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    if os.environ.get("XDG_CACHE_HOME"):
        base = Path(os.environ["XDG_CACHE_HOME"])
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    else:
        base = Path.home() / ".cache"
    return base / "cadgen-mcp-ui"


class UiResources:
    def __init__(self, content: bytes):
        if len(content) > _MAX_BYTES:
            raise ValueError("CAD extension UI exceeds the 8 MiB bundle limit")
        self.html = content.decode("utf-8")
        self.digest = hashlib.sha256(content).hexdigest()
        self.uri = UI_TEMPLATE.format(digest=self.digest)
        self.root = _cache_root() / "v2"
        destination = self.root / f"{self.digest}.html"
        # Every writer publishes the same bytes for a given digest. Atomic
        # replacement also repairs an incomplete or corrupted cache entry.
        self.cache_error = None
        try:
            write_bytes_atomic(destination, content)
        except OSError as error:
            self.cache_error = str(error)
            logging.getLogger(__name__).warning("CAD UI cache could not be published; this connection still serves its bundled UI: %s", error)

    def read(self, digest: str) -> str:
        if not _DIGEST.fullmatch(digest):
            raise ValueError("Invalid CAD interface resource digest")
        if digest == self.digest:
            return self.html
        path = self.root / f"{digest}.html"
        try:
            with path.open("rb") as stream:
                content = stream.read(_MAX_BYTES + 1)
        except OSError as error:
            raise ValueError("This CAD interface version is no longer cached or its cache is unreadable. Reload the CAD plugin connection.") from error
        if len(content) > _MAX_BYTES or hashlib.sha256(content).hexdigest() != digest:
            raise ValueError("CAD interface cache failed its content check. Reload the CAD plugin connection.")
        return content.decode("utf-8")
