"""A ready spare has loaded the kernel and resolved the identities every saved
build stamps; importing its supervisor has done neither."""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
import unittest


class WorkerPrewarm(unittest.TestCase):
    def test_kernel_and_identities_are_ready_before_ready_but_not_at_namespace_import(self):
        # A fresh interpreter prevents this suite's earlier geometry tests from
        # making a parser-only prewarm appear to have loaded the kernel.
        program = textwrap.dedent("""
            import sys
            from cadgen.daemon import worker
            assert "build123d" not in sys.modules
            assert "OCP.BRep" not in sys.modules
            import cadgen
            from cadgen.store import surfaces
            resolved = set()
            real_kernel, real_version = surfaces.kernel_versions, cadgen._resolve_version
            surfaces.kernel_versions = lambda: (resolved.add("kernel"), real_kernel())[1]
            cadgen._resolve_version = lambda: (resolved.add("cadgen"), real_version())[1]
            original_emit = worker._emit
            def checked_emit(frame):
                if "ready" in frame:
                    assert "build123d" in sys.modules, "ready before build123d import"
                    assert "OCP.BRep" in sys.modules, "ready before kernel import"
                    assert resolved == {"kernel", "cadgen"}, f"ready before the writer identities: {resolved}"
                original_emit(frame)
            worker._emit = checked_emit
            raise SystemExit(worker.serve())
        """)
        completed = subprocess.run(
            [sys.executable, "-c", program], input="", text=True,
            capture_output=True, timeout=90,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        frames = [json.loads(line) for line in completed.stdout.splitlines() if line]
        self.assertEqual(len(frames), 1, frames)
        self.assertGreater(frames[0]["ready"], 0)


if __name__ == "__main__":
    unittest.main()
