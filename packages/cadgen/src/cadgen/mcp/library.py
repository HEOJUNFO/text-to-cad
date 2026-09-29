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

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path is not None else library_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE)")
            tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "recent_models" in tables:
                rows = db.execute("SELECT * FROM recent_models ORDER BY opened DESC").fetchall()
                db.execute("ALTER TABLE recent_models RENAME TO legacy_recent_models")
            else:
                rows = []
            db.execute("""CREATE TABLE IF NOT EXISTS recents (
                id TEXT PRIMARY KEY REFERENCES documents(id), opened REAL NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0, thumbnail TEXT,
                thumbnail_revision TEXT, thumbnail_hash TEXT
            )""")
            for row in rows:
                canonical = str(Path(row["path"]).resolve())
                db.execute("INSERT OR IGNORE INTO documents(id,path) VALUES(?,?)", (row["id"], canonical))
                document = db.execute("SELECT id FROM documents WHERE path=?", (canonical,)).fetchone()
                image = row["thumbnail"]
                image_hash = hashlib.sha256(image.encode("ascii")).hexdigest() if image else None
                db.execute("""INSERT INTO recents VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                    pinned=MAX(recents.pinned,excluded.pinned),
                    thumbnail_revision=CASE WHEN recents.thumbnail IS NULL THEN excluded.thumbnail_revision ELSE recents.thumbnail_revision END,
                    thumbnail_hash=COALESCE(recents.thumbnail_hash,excluded.thumbnail_hash),
                    thumbnail=COALESCE(recents.thumbnail,excluded.thumbnail)""",
                    (document["id"], row["opened"], row["pinned"], image, row["thumbnail_revision"], image_hash))
            # Older live-view grants can outlive their visible history. Preserve
            # those document identities too; directories no longer grant access.
            if "model_roots" in tables:
                columns = {row["name"] for row in db.execute("PRAGMA table_info(model_roots)")}
                if "path" in columns:
                    for row in db.execute("SELECT recent_id,path FROM model_roots WHERE path IS NOT NULL"):
                        db.execute("INSERT OR IGNORE INTO documents(id,path) VALUES(?,?)",
                                   (row["recent_id"], str(Path(row["path"]).resolve())))
                db.execute("DROP TABLE model_roots")
            if rows or "recent_models" in tables:
                db.execute("DROP TABLE legacy_recent_models")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def get(self, document_id: str) -> dict:
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown CAD documentId; open an absolute CAD file path first")
        from .documents import canonical_document
        if canonical_document(row["path"]) != row["path"]:
            raise ValueError("CAD document path now points elsewhere; reopen its absolute path")
        return dict(row)

    def record(self, path: str) -> dict:
        from .documents import canonical_document
        path = canonical_document(path)
        with closing(self._connect()) as db, db:
            db.execute("INSERT OR IGNORE INTO documents(id,path) VALUES(?,?)", (uuid.uuid4().hex, path))
            row = db.execute("SELECT * FROM documents WHERE path=?", (path,)).fetchone()
            db.execute("""INSERT INTO recents(id,opened) VALUES(?,?)
                ON CONFLICT(id) DO UPDATE SET opened=excluded.opened""", (row["id"], time.time()))
        return {"id": row["id"], "path": path, "name": Path(path).name, "revision": file_revision(path)}

    def _item(self, row) -> dict:
        revision = file_revision(row["path"])
        return {
            "id": row["id"], "path": row["path"], "name": Path(row["path"]).name,
            "lastOpened": row["opened"], "pinned": bool(row["pinned"]), "missing": revision is None,
            "revision": revision,
            "thumbnailRevision": row["thumbnail_hash"] if revision and row["thumbnail_revision"] == revision else None,
        }

    def list(self) -> dict:
        with closing(self._connect()) as db:
            rows = db.execute("""SELECT documents.path,recents.* FROM recents JOIN documents USING(id)
                ORDER BY pinned DESC, opened DESC, id LIMIT 100""").fetchall()
        return {"items": [self._item(row) for row in rows]}

    def update(self, action: str, document_id: str, *, pinned: bool | None = None,
               thumbnail: str | None = None, revision: str | None = None) -> dict:
        with closing(self._connect()) as db:
            row = db.execute("SELECT documents.path,recents.* FROM recents JOIN documents USING(id) WHERE id=?",
                             (document_id,)).fetchone()
        if row is None:
            raise ValueError("CAD document is not in recent history; open it before updating its library entry")
        if action == "thumbnail":
            current = file_revision(row["path"])
            if thumbnail is None:
                fresh = bool(current and row["thumbnail_revision"] == current)
                return {"thumbnail": row["thumbnail"] if fresh else None,
                        "revision": row["thumbnail_hash"] if fresh else None}
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
            thumbnail_hash = hashlib.sha256(thumbnail.encode("ascii")).hexdigest()
            with closing(self._connect()) as db, db:
                db.execute("UPDATE recents SET thumbnail=?,thumbnail_revision=?,thumbnail_hash=? WHERE id=?",
                           (thumbnail, revision, thumbnail_hash, document_id))
                if file_revision(row["path"]) != revision:
                    raise ValueError("CAD model changed during thumbnail upload; reopen it")
            return {"thumbnail": thumbnail, "revision": thumbnail_hash}
        with closing(self._connect()) as db, db:
            if action == "pin" and pinned is not None:
                db.execute("UPDATE recents SET pinned=? WHERE id=?", (int(pinned), document_id))
            elif action == "remove":
                db.execute("DELETE FROM recents WHERE id=?", (document_id,))
            else:
                raise ValueError("Library action must be list, pin, remove or thumbnail; pin requires pinned")
        return self.list()
