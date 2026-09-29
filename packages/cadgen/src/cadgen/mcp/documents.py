"""Selected-document resolution: no workspace discovery or directory authority."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct
from urllib.parse import unquote, urlsplit

from cadgen.viewer.backend import ForbiddenAssetError, _absolutize_entry
from cadgen.viewer.content_types import content_type_for_path
from cadgen.viewer.scanner import CAD_CATALOG_SCHEMA_VERSION, scan_cad_document

SUPPORTED_EXTENSIONS = (".step", ".stp", ".stl", ".glb", ".3mf")


def canonical_document(path: str) -> str:
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ValueError("CAD requires an absolute local file path; resolve the artifact path before opening it")
    if candidate.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise ValueError("CAD opens STEP, STP, STL, GLB and 3MF documents; export the model to a supported format first")
    try:
        candidate = candidate.resolve(strict=True)
        if not candidate.is_file():
            raise OSError("not a file")
        with candidate.open("rb"):
            pass
    except OSError as error:
        raise ValueError(f"CAD file is missing or unreadable: {path}. Restore it or open another absolute file path") from error
    if candidate.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise ValueError("CAD file aliases must resolve to a supported CAD document")
    return str(candidate)


def document_id(path: str) -> str:
    """Identity is portable across MCP processes and independent of history."""
    return hashlib.sha256(("cad-document-v2\0" + str(Path(path).resolve())).encode("utf-8")).hexdigest()


def describe_document(path: str) -> dict:
    from .library import file_revision
    canonical = canonical_document(path)
    return {"id": document_id(canonical), "path": canonical,
            "name": Path(canonical).name, "revision": file_revision(canonical)}


def resolve_document(descriptor: dict) -> dict:
    document = describe_document(descriptor["path"])
    if document["path"] != descriptor["path"]:
        raise ValueError("CAD document path changed; reopen its absolute path")
    if document["id"] != descriptor["id"]:
        raise ValueError("CAD document descriptor ID is invalid; reopen its absolute path")
    return document


class DocumentAssetBackend:
    """One document and its declared assets, using the shared catalog builders.

    root_path is the compiler's relative-path origin, not an access grant.
    Unlike LocalAssetBackend this adapter never walks that directory.
    """
    def __init__(self, path: str):
        self.path = path
        self.root_path = str(Path(path).parent)
        self.root_name = Path(path).name

    def validate(self):
        if canonical_document(self.path) != self.path:
            raise ValueError("CAD document path now points elsewhere; reopen its absolute path")

    def require_document(self, file: str):
        if file != self.path:
            raise ValueError("This request names a different CAD document; open that absolute file path first")
        self.validate()

    def read_catalog(self, preferred_file=None) -> dict:
        if preferred_file:
            self.require_document(preferred_file)
        self.validate()
        entry = _absolutize_entry(scan_cad_document(self.path), root_path=self.root_path, scan_repo_root=self.root_path)
        entry.pop("rootRelativeFile", None)
        return {"schemaVersion": CAD_CATALOG_SCHEMA_VERSION, "entries": [entry]}

    @staticmethod
    def catalog_entry_for_file_ref(catalog, file_ref):
        return next((entry for entry in catalog["entries"] if entry["file"] == file_ref), None)

    def _dependencies(self) -> set[str]:
        paths = {self.path}
        if Path(self.path).suffix.lower() in {".step", ".stp"}:
            paths.add(self.path + ".json")
        if Path(self.path).suffix.lower() != ".glb":
            return paths
        # GLB may explicitly reference external buffers or images. Resolve only
        # those declarations, including ../ references, never sibling discovery.
        with open(self.path, "rb") as handle:
            header = handle.read(20)
            if len(header) != 20:
                return paths
            magic, version, total, length, kind = struct.unpack("<4sIIII", header)
            if magic != b"glTF" or version != 2 or kind != 0x4e4f534a:
                return paths
            if length > 16 * 1024 * 1024 or length + 20 > total:
                raise ValueError("CAD GLB JSON declarations exceed the supported 16 MiB size")
            try:
                document = json.loads(handle.read(length))
            except (ValueError, UnicodeDecodeError) as error:
                raise ValueError("CAD GLB has invalid JSON asset declarations") from error
        if not isinstance(document, dict):
            raise ValueError("CAD GLB asset declarations must be a JSON object")
        for category in ("buffers", "images"):
            assets = document.get(category, [])
            if not isinstance(assets, list):
                raise ValueError(f"CAD GLB {category} declarations must be an array")
            for asset in assets:
                uri = asset.get("uri") if isinstance(asset, dict) else None
                if not isinstance(uri, str):
                    continue
                parsed = urlsplit(uri)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                candidate = Path(self.root_path, unquote(parsed.path)).resolve()
                paths.add(str(candidate))
        return paths

    def asset_path_for_file_ref(self, file_ref):
        self.validate()
        if not isinstance(file_ref, str) or not Path(file_ref).is_absolute():
            raise ForbiddenAssetError()
        candidate = str(Path(file_ref).resolve())
        # Sidecars are declared by format, but a replaced sidecar symlink must
        # not become a general file-reader capability.
        if candidate not in self._dependencies():
            raise ForbiddenAssetError()
        return candidate

    @staticmethod
    def content_type_for_path(path):
        return content_type_for_path(path)
