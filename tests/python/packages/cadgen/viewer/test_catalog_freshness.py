"""The catalog is fresh on every request, and a warm request does not re-list the tree.

The client polls the catalog every 2s, and the artifact-status route reads it on
every 400ms build poll, so a served root holding a project's scratch — thousands
of renders, BREPs and logs under ``tmp/`` — used to cost one full walk per
request (two, on the steady path). The scanner now memoises each directory's
relevant rows on that directory's own identity. These pin both halves of that
bargain: nothing a walk can observe goes stale (a new model appears on the next
request, a deleted or renamed one leaves, a retargeted link is followed), and a
warm walk re-lists nothing that has not changed.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from cadgen import catalog
from cadgen._internal.shared_read import open_shared_for_read
from cadgen.viewer import scanner
from cadgen.viewer.backend import LocalAssetBackend
from cadgen.viewer.scanner import scan_cad_directory

JUNK_DIRECTORIES = 10
JUNK_PER_DIRECTORY = 50


class FreshnessFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "models")
        os.makedirs(self.root)
        previous = os.environ.get("CADGEN_CACHE_DIR")
        os.environ["CADGEN_CACHE_DIR"] = os.path.join(self.tmp, "cache")
        self.addCleanup(self._restore, previous)
        self.write("gripper/base.stl", "solid base\nendsolid base\n")
        self.write("gripper/finger.stl", "solid finger\nendsolid finger\n")
        # A project's scratch: nothing here is an artifact, and all of it used
        # to be re-listed on every request.
        for directory in range(JUNK_DIRECTORIES):
            for index in range(JUNK_PER_DIRECTORY):
                self.write(f"gripper/tmp/renders/r{directory}/frame{index}.png", "x")

    @staticmethod
    def _restore(previous) -> None:
        if previous is None:
            os.environ.pop("CADGEN_CACHE_DIR", None)
        else:
            os.environ["CADGEN_CACHE_DIR"] = previous

    def write(self, relative: str, text: str) -> str:
        path = os.path.join(self.root, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Path(path).write_text(text, encoding="utf-8")
        return path

    def settle(self, top: str | None = None) -> None:
        """Age every directory under ``top`` past the listing settle window.

        A listing is trusted only once its directory has been quiet for a while
        (timestamp granularity), so a fixture built a millisecond ago would never
        be cached at all. Backdating stands in for the wait.
        """
        past = time.time_ns() - 60 * 1_000_000_000
        for directory, _, _ in os.walk(top or self.root):
            os.utime(directory, ns=(past, past))

    def files(self) -> list[str]:
        return [entry["file"] for entry in scan_cad_directory(self.root, defer_unpreferred=True)["entries"]]

    def listed(self) -> list[str]:
        """The directories a walk actually lists, in order."""
        with mock.patch.object(scanner.os, "scandir", wraps=os.scandir) as scandir:
            self.files()
        return [os.path.relpath(str(call.args[0]), self.root) for call in scandir.call_args_list]


class WarmWalks(FreshnessFixture):
    def test_a_warm_walk_lists_no_settled_directory_again(self) -> None:
        self.settle()
        cold = self.listed()
        self.assertEqual(len(cold), 4 + JUNK_DIRECTORIES, cold)
        self.assertEqual(self.listed(), [], "a warm walk re-listed directories that had not changed")
        self.assertEqual(self.files(), ["gripper/base.stl", "gripper/finger.stl"])

    def test_only_the_changed_directory_is_listed_again(self) -> None:
        self.settle()
        self.listed()
        self.write("gripper/tmp/renders/r3/frame_new.png", "x")
        self.assertEqual(self.listed(), [os.path.join("gripper", "tmp", "renders", "r3")])

    def test_a_directory_written_within_the_settle_window_is_never_trusted(self) -> None:
        # Its mtime may not move again for a change landing in the same clock
        # tick, so a listing taken while it is this fresh must not be reused.
        self.settle()
        self.listed()
        self.write("gripper/tmp/renders/r5/frame_new.png", "x")
        fresh = os.path.join("gripper", "tmp", "renders", "r5")
        self.assertIn(fresh, self.listed())
        self.assertEqual(self.listed(), [fresh], "a still-settling directory must be re-listed every walk")


def join_catalog_refreshes() -> None:
    """Wait out the background refresh a stale ``read_catalog`` starts.

    That thread hashes every model while the test goes on mutating the tree.
    Those reads no longer block a delete (``ReadsNeverBlockDeletion`` pins it),
    but NTFS still refuses a rename onto a file any handle has open, and without
    POSIX delete semantics a file deleted under an open handle stays listed
    until it closes, so a mutation raced against the refresh would make the
    next request's answer depend on thread timing. Joining first keeps each
    request's expected answer exact.
    """
    for thread in threading.enumerate():
        if thread.name == "cadgen-viewer-catalog":
            thread.join(timeout=60)
            if thread.is_alive():
                raise AssertionError("the catalog refresh did not finish within 60s")


class CatalogFreshness(FreshnessFixture):
    def catalog_files(self, backend: LocalAssetBackend) -> list[str]:
        return [entry["rootRelativeFile"] for entry in backend.read_catalog()["entries"]]

    def test_a_new_model_appears_and_a_deleted_one_disappears_on_the_next_request(self) -> None:
        backend = LocalAssetBackend(self.root)
        self.settle()
        self.assertEqual(self.catalog_files(backend), ["gripper/base.stl", "gripper/finger.stl"])
        self.catalog_files(backend)  # warm

        # Deep inside the scratch tree the walk no longer re-lists.
        new_model = self.write("gripper/tmp/renders/r7/probe.stl", "solid probe\nendsolid probe\n")
        self.assertIn("gripper/tmp/renders/r7/probe.stl", self.catalog_files(backend))
        self.settle()  # its listing is now trusted and cached
        self.assertIn("gripper/tmp/renders/r7/probe.stl", self.catalog_files(backend))

        join_catalog_refreshes()
        os.unlink(new_model)
        self.assertNotIn("gripper/tmp/renders/r7/probe.stl", self.catalog_files(backend))

        # A new directory, and a rename.
        self.write("gripper/tmp/renders/r7/deeper/part.step", "ISO-10303-21;\n")
        self.assertIn("gripper/tmp/renders/r7/deeper/part.step", self.catalog_files(backend))
        self.settle()
        join_catalog_refreshes()
        os.replace(
            os.path.join(self.root, "gripper", "finger.stl"),
            os.path.join(self.root, "gripper", "thumb.stl"),
        )
        files = self.catalog_files(backend)
        self.assertIn("gripper/thumb.stl", files)
        self.assertNotIn("gripper/finger.stl", files)

    def test_a_retargeted_directory_link_is_followed_to_its_new_target(self) -> None:
        first = os.path.join(self.tmp, "library_a")
        second = os.path.join(self.tmp, "library_b")
        for directory, name in ((first, "bolt.stl"), (second, "nut.stl")):
            os.makedirs(directory)
            Path(directory, name).write_text("solid x\nendsolid x\n", encoding="utf-8")
        link = os.path.join(self.root, "library")
        os.symlink(first, link)
        self.settle()
        self.settle(first)
        self.settle(second)
        self.assertIn("library/bolt.stl", self.files())

        # A file added to the link's target, whose parent listing did not change.
        Path(first, "washer.stl").write_text("solid w\nendsolid w\n", encoding="utf-8")
        self.assertIn("library/washer.stl", self.files())

        os.unlink(link)
        os.symlink(second, link)
        files = self.files()
        self.assertIn("library/nut.stl", files)
        self.assertNotIn("library/bolt.stl", files)


class ReadsNeverBlockDeletion(FreshnessFixture):
    """A catalog read that has a model open must not stop the user deleting it.

    The catalog hashes every model, on a background thread, while the user is
    free to delete any of them. POSIX never lets a reader's handle
    refuse an unlink; Windows does, unless the reader asked for delete sharing,
    and a plain ``open()`` does not. On Windows these fail with ``WinError 32``
    the moment a hash goes back to a plain ``open``; off Windows they pin the
    scan's tolerance of a file that vanishes mid-read.
    """

    def delete_while_open(self, target, *, before_open: bool = False):
        """An opener that deletes ``target`` while (or just before) it is read."""
        def opener(path):
            if os.path.realpath(path) != os.path.realpath(target):
                return open_shared_for_read(path)
            if before_open:
                os.unlink(path)
                return open_shared_for_read(path)
            handle = open_shared_for_read(path)
            os.unlink(path)
            self.deleted.append(path)
            return handle
        self.deleted = []
        return opener

    def test_a_model_deleted_while_the_scan_hashes_it_is_deleted(self) -> None:
        model = self.write("gripper/probe.stl", "solid probe\nendsolid probe\n")
        with mock.patch.object(scanner, "open_shared_for_read", self.delete_while_open(model)):
            scan_cad_directory(self.root)
        self.assertEqual(self.deleted, [model])
        self.assertFalse(os.path.exists(model))
        self.assertNotIn("gripper/probe.stl", self.files())

    def test_a_model_gone_before_the_scan_opens_it_leaves_the_scan_standing(self) -> None:
        model = self.write("gripper/probe.stl", "solid probe\nendsolid probe\n")
        opener = self.delete_while_open(model, before_open=True)
        with mock.patch.object(scanner, "open_shared_for_read", opener):
            entries = scan_cad_directory(self.root)["entries"]
        probe = next(entry for entry in entries if entry["file"] == "gripper/probe.stl")
        self.assertEqual(probe["hash"], "")
        self.assertNotIn("gripper/probe.stl", self.files())

    def test_a_step_deleted_while_its_digest_is_read_is_deleted(self) -> None:
        document = self.write("gripper/part.step", "ISO-10303-21;\nEND-ISO-10303-21;\n")
        with mock.patch.object(catalog, "open_shared_for_read", self.delete_while_open(document)):
            catalog.artifact_file_hash(Path(document))
        self.assertEqual(len(self.deleted), 1)
        self.assertFalse(os.path.exists(document))


if __name__ == "__main__":
    unittest.main()
