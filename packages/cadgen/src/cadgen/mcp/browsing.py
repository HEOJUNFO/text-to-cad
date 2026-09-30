"""Lazy directory navigation, independent of selected-document resolution."""
from __future__ import annotations

import os
from pathlib import Path
import string

from .documents import SUPPORTED_EXTENSIONS


def directory_path(value: str) -> str:
    """Normalize lexical ancestry, preserving directory symlinks for navigation."""
    if not Path(value).is_absolute():
        raise ValueError("CAD browsing requires an absolute directory path")
    normalized = os.path.normpath(value)
    if not Path(normalized).is_dir():
        raise ValueError(f"CAD browsing directory is missing or unreadable: {value}")
    return normalized


def _computer_root() -> str | None:
    return None if os.name == "nt" else "/"


def _drives() -> list[dict]:
    # No directory traversal: querying roots also works on the Python floor,
    # which predates os.listdrives(). Disconnected drives are not opened.
    import ctypes
    mask = ctypes.windll.kernel32.GetLogicalDrives()
    return [{"path": f"{letter}:\\", "name": f"{letter}:", "kind": "directory"}
            for index, letter in enumerate(string.ascii_uppercase) if mask & (1 << index)]


def browse_directory(browse_root: str | None = None, directory: str | None = None,
                     *, include_hidden: bool = False) -> dict:
    root = directory_path(browse_root) if browse_root is not None else _computer_root()
    selected = directory_path(directory) if directory is not None else root
    if root is not None and selected is not None:
        try:
            within_root = os.path.commonpath([root, selected]) == root
        except ValueError:  # Different Windows drives.
            within_root = False
        if not within_root:
            root = _computer_root()
    computer = root == _computer_root()
    parent = str(Path(root).parent) if root is not None and not computer else None
    if parent == root:
        parent = None
    if selected is None:
        entries = _drives()
    else:
        entries = []
        with os.scandir(selected) as children:
            for child in children:
                if not include_hidden and child.name.startswith("."):
                    continue
                try:
                    if child.is_dir():
                        kind = "directory"
                    elif Path(child.name).suffix.lower() in SUPPORTED_EXTENSIONS and child.is_file():
                        kind = "file"
                    else:
                        continue
                except OSError:
                    # A deleted or inaccessible child must not hide readable siblings.
                    continue
                entries.append({"path": child.path, "name": child.name, "kind": kind})
        entries.sort(key=lambda entry: (entry["kind"] != "directory", entry["name"].casefold(), entry["name"]))
    return {"root": {"path": root, "name": "Computer" if computer else Path(root).name or root},
            "directory": selected, "entries": entries, "parent": parent, "home": str(Path.home())}
