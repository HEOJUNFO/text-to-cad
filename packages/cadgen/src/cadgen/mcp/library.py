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
            # These tables are still used by installed, long-lived MCP servers.
            # Never rename/drop them, even when a newer schema is available.
            db.execute("""CREATE TABLE IF NOT EXISTS recent_models (
                id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, root TEXT NOT NULL,
                opened REAL NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
                thumbnail TEXT, thumbnail_revision TEXT, thumbnail_hash TEXT
            )""")
            if "thumbnail_hash" not in {r["name"] for r in db.execute("PRAGMA table_info(recent_models)")}:
                db.execute("ALTER TABLE recent_models ADD COLUMN thumbnail_hash TEXT")
            db.execute("""CREATE TABLE IF NOT EXISTS model_roots (
                recent_id TEXT NOT NULL, root_id TEXT NOT NULL, root TEXT NOT NULL, path TEXT,
                PRIMARY KEY(recent_id,root_id)
            )""")
            db.execute("CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE)")
            db.execute("CREATE TABLE IF NOT EXISTS mcp_migrations (name TEXT PRIMARY KEY)")
            migrated = db.execute("SELECT 1 FROM mcp_migrations WHERE name='compatible-history-v2'").fetchone()
            tables = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if migrated is None:
                # Repair the short-lived document-registry release that removed
                # the old tables. Existing old rows always win. Import once so
                # later deletions cannot be resurrected by another connection.
                if "recents" in tables:
                    for row in db.execute("SELECT documents.path,recents.* FROM recents JOIN documents USING(id)"):
                        db.execute("""INSERT OR IGNORE INTO recent_models
                            (id,path,root,opened,pinned,thumbnail,thumbnail_revision,thumbnail_hash)
                            VALUES(?,?,?,?,?,?,?,?)""", (row["id"], row["path"], str(Path(row["path"]).parent),
                            row["opened"], row["pinned"], row["thumbnail"], row["thumbnail_revision"], row["thumbnail_hash"]))
                db.execute("INSERT INTO mcp_migrations VALUES('compatible-history-v2')")
            for row in db.execute("SELECT id,path,thumbnail FROM recent_models"):
                db.execute("INSERT OR IGNORE INTO documents(id,path) VALUES(?,?)", (row["id"], row["path"]))
                if row["thumbnail"]:
                    db.execute("UPDATE recent_models SET thumbnail_hash=? WHERE id=? AND thumbnail_hash IS NULL",
                               (hashlib.sha256(row["thumbnail"].encode("ascii")).hexdigest(), row["id"]))

    def _connect(self):
        # History is optional UI state; contention must not hold a file open
        # hostage for seconds. SQLite transactions still serialize all writes.
        db = sqlite3.connect(self.path, timeout=0.2)
        db.row_factory = sqlite3.Row
        from .documents import document_id
        db.create_function("cad_document_id", 1, document_id, deterministic=True)
        return db

    def get(self, document_id: str) -> dict:
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM documents WHERE id=? OR cad_document_id(path)=?",
                             (document_id, document_id)).fetchone()
            if row is None:
                row = db.execute("SELECT id,path FROM recent_models WHERE id=? OR cad_document_id(path)=?",
                                 (document_id, document_id)).fetchone()
        if row is None:
            raise ValueError("Unknown CAD documentId; reopen an absolute CAD path to obtain a self-contained document descriptor")
        from .documents import canonical_document
        canonical = canonical_document(row["path"])
        if canonical != row["path"]:
            raise ValueError("CAD document path now points elsewhere; reopen its absolute path")
        return dict(row)

    def record(self, path: str) -> dict:
        from .documents import describe_document
        document = describe_document(path)
        with closing(self._connect()) as db, db:
            db.execute("INSERT OR IGNORE INTO documents(id,path) VALUES(?,?)", (document["id"], document["path"]))
            existing = db.execute("SELECT id FROM recent_models WHERE cad_document_id(path)=?", (document["id"],)).fetchone()
            if existing is not None:
                db.execute("UPDATE recent_models SET opened=? WHERE cad_document_id(path)=?", (time.time(), document["id"]))
            else:
                db.execute("INSERT INTO recent_models(id,path,root,opened) VALUES(?,?,?,?)",
                           (document["id"], document["path"], str(Path(document["path"]).parent), time.time()))
        return document

    def _item(self, row) -> dict:
        from .documents import document_id
        canonical = str(Path(row["path"]).resolve())
        revision = file_revision(canonical)
        return {
            "id": document_id(canonical), "path": canonical, "name": Path(canonical).name,
            "lastOpened": row["opened"], "pinned": bool(row["pinned"]), "missing": revision is None,
            "revision": revision,
            "thumbnailRevision": row["thumbnail_hash"] if revision and row["thumbnail_revision"] == revision else None,
        }

    def list(self) -> dict:
        with closing(self._connect()) as db:
            rows = db.execute("""SELECT * FROM recent_models ORDER BY pinned DESC, opened DESC, id LIMIT 100""").fetchall()
        items = {}
        for row in rows:
            item = self._item(row)
            items.setdefault(item["id"], item)
        return {"items": list(items.values())}

    def update(self, action: str, document_id: str, *, pinned: bool | None = None,
               thumbnail: str | None = None, revision: str | None = None) -> dict:
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM recent_models WHERE id=? OR cad_document_id(path)=? ORDER BY pinned DESC,opened DESC LIMIT 1",
                             (document_id, document_id)).fetchone()
        if row is None:
            raise ValueError("CAD document is not in recent history; open it before updating its library entry")
        record_id = row["id"]
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
                db.execute("UPDATE recent_models SET thumbnail=?,thumbnail_revision=?,thumbnail_hash=? WHERE cad_document_id(path)=cad_document_id(?)",
                           (thumbnail, revision, thumbnail_hash, row["path"]))
                if file_revision(row["path"]) != revision:
                    raise ValueError("CAD model changed during thumbnail upload; reopen it")
            return {"thumbnail": thumbnail, "revision": thumbnail_hash}
        with closing(self._connect()) as db, db:
            if action == "pin" and pinned is not None:
                db.execute("UPDATE recent_models SET pinned=? WHERE cad_document_id(path)=cad_document_id(?)", (int(pinned), row["path"]))
            elif action == "remove":
                db.execute("DELETE FROM recent_models WHERE id=? OR cad_document_id(path)=cad_document_id(?)", (record_id, row["path"]))
            else:
                raise ValueError("Library action must be list, pin, remove or thumbnail; pin requires pinned")
        return self.list()
