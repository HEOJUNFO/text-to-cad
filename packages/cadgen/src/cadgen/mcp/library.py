"""Persistent extension-open history, separate from disposable geometry caches."""
from __future__ import annotations

import base64
import binascii
from contextlib import closing
import hashlib
import io
import os
from pathlib import Path
import sqlite3
import struct
import sys
import time
import uuid

from cadgen.viewer.backend import ForbiddenAssetError, require_contained

MAX_THUMBNAIL_BYTES = 256 * 1024


def library_path() -> Path:
    override = os.environ.get("CADGEN_STATE_DIR", "").strip()
    if override:
        root = Path(override)
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support" / "cadgen"
    elif os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "cadgen"
    else:
        root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "cadgen"
    return root / "extension-library.sqlite3"


def file_revision(path: str) -> str | None:
    try:
        stat = Path(path).stat()
        if not Path(path).is_file():
            return None
        return hashlib.sha256(repr((stat.st_dev, stat.st_ino, stat.st_size,
                                    stat.st_mtime_ns, stat.st_ctime_ns)).encode()).hexdigest()
    except OSError:
        return None


class RecentLibrary:
    """Short-lived SQLite connections make independent MCP processes cooperate."""

    def __init__(self, path: str | Path | None = None, *, root: str | Path | None = None):
        self.path = Path(path) if path is not None else library_path()
        self.root = str(Path(root).resolve()) if root is not None else None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS recent_models (
                id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, root TEXT NOT NULL,
                opened REAL NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
                thumbnail TEXT, thumbnail_revision TEXT
            )""")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def _allowed(self, path: str) -> bool:
        if self.root is None:
            return True
        try:
            require_contained(self.root, path)
            return True
        except (ValueError, ForbiddenAssetError):
            return False

    def get(self, recent_id: str) -> dict:
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM recent_models WHERE id=?", (recent_id,)).fetchone()
        if row is None or not self._allowed(row["path"]):
            raise ValueError("Recent CAD model is unavailable in this library")
        return dict(row)

    def record(self, root: str, file: str) -> dict:
        path = os.path.abspath(os.path.join(root, file))
        require_contained(root, path)
        if not self._allowed(path):
            raise ValueError("Recent CAD model is outside the configured root")
        with closing(self._connect()) as db, db:
            db.execute("""INSERT INTO recent_models(id,path,root,opened) VALUES(?,?,?,?)
                ON CONFLICT(path) DO UPDATE SET root=excluded.root, opened=excluded.opened""",
                (uuid.uuid4().hex, path, root, time.time()))
            row = db.execute("SELECT * FROM recent_models WHERE path=?", (path,)).fetchone()
        return self._item(row)

    def _item(self, row) -> dict:
        revision = file_revision(row["path"])
        return {
            "id": row["id"], "file": os.path.relpath(row["path"], row["root"]).replace(os.sep, "/"),
            "name": Path(row["path"]).name, "rootPath": row["root"], "absolutePath": row["path"],
            "lastOpened": row["opened"], "pinned": bool(row["pinned"]), "missing": revision is None,
            "revision": revision,
            "thumbnailRevision": revision if revision and row["thumbnail_revision"] == revision else None,
        }

    def list(self) -> dict:
        items = []
        with closing(self._connect()) as db:
            rows = db.execute("SELECT id,path,root,opened,pinned,thumbnail_revision FROM recent_models ORDER BY pinned DESC, opened DESC, id")
            for row in rows:
                if self._allowed(row["path"]):
                    items.append(self._item(row))
                    if len(items) == 100:
                        break
        return {"items": items}

    def update(self, action: str, recent_id: str, *, pinned: bool | None = None,
               thumbnail: str | None = None, revision: str | None = None) -> dict:
        row = self.get(recent_id)
        if action == "thumbnail":
            current = file_revision(row["path"])
            if thumbnail is None:
                return {"thumbnail": row["thumbnail"] if current and row["thumbnail_revision"] == current else None,
                        "revision": current}
            prefix = "data:image/png;base64,"
            if not thumbnail.startswith(prefix) or len(thumbnail) > len(prefix) + 4 * ((MAX_THUMBNAIL_BYTES + 2) // 3):
                raise ValueError("Thumbnail must be a PNG data URL no larger than 256 KiB")
            try:
                image = base64.b64decode(thumbnail[len(prefix):], validate=True)
            except (ValueError, binascii.Error) as error:
                raise ValueError("Thumbnail contains invalid base64") from error
            if (len(image) > MAX_THUMBNAIL_BYTES or len(image) < 33
                    or not image.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")):
                raise ValueError("Thumbnail must be a PNG no larger than 256 KiB")
            width, height = struct.unpack(">II", image[16:24])
            if not (0 < width <= 2048 and 0 < height <= 2048):
                raise ValueError("Thumbnail dimensions must be between 1 and 2048 pixels")
            from PIL import Image
            try:
                with Image.open(io.BytesIO(image)) as preview:
                    preview.verify()
            except (OSError, ValueError, SyntaxError) as error:
                raise ValueError("Thumbnail is not a valid PNG image") from error
            if current is None or revision != current:
                raise ValueError("CAD model changed before thumbnail upload; reopen it")
            with closing(self._connect()) as db, db:
                db.execute("UPDATE recent_models SET thumbnail=?,thumbnail_revision=? WHERE id=?",
                           (thumbnail, revision, recent_id))
                if file_revision(row["path"]) != revision:
                    raise ValueError("CAD model changed during thumbnail upload; reopen it")
            return {"thumbnail": thumbnail, "revision": revision}
        with closing(self._connect()) as db, db:
            if action == "pin" and pinned is not None:
                db.execute("UPDATE recent_models SET pinned=? WHERE id=?", (int(pinned), recent_id))
            elif action == "remove":
                db.execute("DELETE FROM recent_models WHERE id=?", (recent_id,))
            else:
                raise ValueError("Library action must be list, pin, remove or thumbnail; pin requires pinned")
        return self.list()
