"""What the desktop app ships from ``apps/desktop/resources`` is real bytes, never LFS.

electron-builder copies ``apps/desktop/resources/{sample,cadgen,skills}`` into
every installer (``extraResources``), and the release workflow checks out
without git-lfs. An LFS-tracked path there ships as a 130-byte pointer: the
onboarding sample's ``l_bracket.step`` did, and the first thing a new person
opened failed to load.
"""

from __future__ import annotations

import subprocess
import unittest

from tests.python.support.paths import repo_path


LFS_POINTER = b"version https://git-lfs"


def git(*args: str, input: bytes | None = None) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=repo_path(), input=input, capture_output=True, check=True,
    ).stdout


class DesktopResourcesAreNotLfsTests(unittest.TestCase):
    def tracked(self) -> list[str]:
        return git("ls-files", "-z", "apps/desktop/resources").decode().split("\0")[:-1]

    def test_no_path_under_desktop_resources_is_lfs_tracked(self) -> None:
        attributes = git("check-attr", "--stdin", "-z", "filter", input="\0".join(self.tracked()).encode())
        fields = attributes.decode().split("\0")
        lfs = [fields[i] for i in range(0, len(fields) - 2, 3) if fields[i + 2] == "lfs"]
        self.assertEqual(lfs, [])

    def test_no_committed_desktop_resource_is_an_lfs_pointer(self) -> None:
        paths = self.tracked()
        batch = git("cat-file", "--batch", input="".join(f":{path}\n" for path in paths).encode())
        pointers, offset = [], 0
        for path in paths:
            header_end = batch.index(b"\n", offset)
            size = int(batch[offset:header_end].split()[2])
            if batch[header_end + 1 : header_end + 1 + size].startswith(LFS_POINTER):
                pointers.append(path)
            offset = header_end + 1 + size + 1
        self.assertEqual(pointers, [])

if __name__ == "__main__":
    unittest.main()
