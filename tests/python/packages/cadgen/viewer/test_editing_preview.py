"""The build feed reports what a build of a STEP file is doing, never geometry, inside its root."""
from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest import mock

from cadgen.viewer.backend import ForbiddenAssetError
from cadgen.viewer.preview import preview_status, preview_update
from tests.python.support.tmp_root import generated_cad_directory


class BuildStatusTests(unittest.TestCase):
    def setUp(self):
        temporary = generated_cad_directory(prefix="preview-feed-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.output = str(self.root / "new.step")
        self.store = str(self.root / "store")
        env = mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": self.store})
        env.start()
        self.addCleanup(env.stop)

    def job(self, revision=1, **extra):
        return {"id": f"epoch:job-{revision}", "epoch": "epoch", "sequence": revision,
                "tool": "run", "storeRoot": self.store, "outputs": [self.output], "state": "building",
                "subject": "/private/source.py", **extra}

    def test_a_running_build_is_its_state_and_nothing_of_the_job_or_its_geometry(self):
        result = preview_status(str(self.root), self.output, jobs=[self.job(
            phase="tessellating", previews={self.output: {"tree": "a" * 64}})])
        self.assertEqual((result["state"], result["phase"], result["file"]), ("building", "tessellating", "new.step"))
        for private in ("subject", "storeRoot", "preview", "saved", "previewUnavailable", "superseded"):
            self.assertNotIn(private, result)

    def test_changed_feed_uses_its_atomic_job_snapshot_and_only_exposes_cursor(self):
        payload = {"jobsCursor": "epoch:8", "jobs": [self.job()]}
        with mock.patch("cadgen.daemon.client.watch_jobs", return_value=payload) as watch, \
                mock.patch("cadgen.viewer.preview._daemon_jobs", side_effect=AssertionError("extra poll")):
            result = preview_update(str(self.root), self.output, after="epoch:7")
        watch.assert_called_once_with("epoch:7", output=self.output, store_root=self.store)
        self.assertEqual((result["feedCursor"], result["revision"]), ("epoch:8", 1))
        self.assertNotIn("jobs", result)

    def test_saturated_feed_keeps_cursor_and_requests_slow_client_retry(self):
        payload = {"jobsCursor": "epoch:8", "jobs": [], "jobsWatchLimited": True}
        with mock.patch("cadgen.daemon.client.watch_jobs", return_value=payload):
            result = preview_update(str(self.root), self.output, after="epoch:8")
        self.assertEqual(result["feedCursor"], "epoch:8")
        self.assertTrue(result["feedLimited"])

    def test_invalid_output_is_rejected_before_waiting_on_the_daemon(self):
        with mock.patch("cadgen.daemon.client.watch_jobs", side_effect=AssertionError("invalid wait")):
            with self.assertRaises(ValueError):
                preview_update(str(self.root), ".hidden/new.step", after="epoch:7")

    def test_a_filesystem_root_reports_an_output_under_a_hidden_folder(self):
        # A lazy root (a whole filesystem, for a model with no project around it) serves what it is
        # asked for: an agent's worktree under a dot-folder still gets its build's status.
        hidden = str(self.root / ".worktree" / "new.step")
        job = {**self.job(), "outputs": [hidden]}
        self.assertEqual(preview_status(str(self.root), hidden, jobs=[job], lazy=True)["state"], "building")

    def test_newest_request_wins_even_when_old_one_finishes_later(self):
        jobs = [self.job(1, state="done", updatedAt=1000), self.job(2, updatedAt=999)]
        self.assertEqual(preview_status(str(self.root), self.output, jobs=jobs)["revision"], 2)

    def test_compiling_saved_bytes_cannot_supersede_an_editing_request(self):
        jobs = [self.job(1), self.job(2, tool="step-compile", state="done")]
        self.assertEqual(preview_status(str(self.root), self.output, jobs=jobs)["revision"], 1)

    def test_coalesced_subscriber_does_not_advance_edit_ordering(self):
        from cadgen.daemon.jobs import JobLedger

        ledger = JobLedger()
        producer = ledger.start(tool="run", subject="model.py", store_root=self.store)
        producer.update(outputs=[self.output], state="building")
        follower = ledger.start(tool="run", subject="model.py", store_root=self.store, editing_producer=False)
        follower.update(outputs=[self.output])
        result = preview_status(str(self.root), self.output, jobs=ledger.snapshot())
        self.assertEqual(result["request"], producer["id"])
        ledger.accept_editing_producer(follower)
        result = preview_status(str(self.root), self.output, jobs=ledger.snapshot())
        self.assertEqual(result["request"], follower["id"])

    def test_other_store_and_output_are_not_visible(self):
        result = preview_status(str(self.root), self.output, jobs=[
            self.job(storeRoot=str(self.root / "other")),
            self.job(outputs=[str(self.root / "other.step")]),
        ])
        self.assertEqual(result["state"], "disconnected")

    def test_outside_root_and_hidden_paths_are_rejected(self):
        with self.assertRaises(ForbiddenAssetError):
            preview_status(str(self.root), str(self.root.parent / "outside.step"), jobs=[])
        with self.assertRaises(ValueError):
            preview_status(str(self.root), ".hidden/new.step", jobs=[])

    # The file moved on after the build: another installation's build, a checkout, a STEP written
    # by hand. The build's failure is no longer the news.
    def test_a_build_that_saved_is_moved_past_when_the_file_is_no_longer_its_bytes(self):
        from cadgen.catalog import artifact_file_hash

        Path(self.output).write_bytes(b"saved document")
        digest = artifact_file_hash(Path(self.output))
        done = self.job(state="done", finishedAt=2000.0, savedResults={self.output: {"tree": "a" * 64, "documentHash": digest}})
        self.assertNotIn("superseded", preview_status(str(self.root), self.output, jobs=[done]))
        Path(self.output).write_bytes(b"written by another build")
        moved = preview_status(str(self.root), self.output, jobs=[done])
        self.assertTrue(moved["superseded"])
        self.assertIsNone(moved["error"])

    def test_a_build_that_saved_nothing_is_moved_past_by_a_later_write(self):
        Path(self.output).write_bytes(b"before the build")
        os.utime(self.output, (1000.0, 1000.0))
        failed = self.job(state="failed", error="Disk full", finishedAt=2000.0)
        kept = preview_status(str(self.root), self.output, jobs=[failed])
        self.assertEqual(kept["error"], "Disk full")
        self.assertNotIn("superseded", kept)
        os.utime(self.output, (3000.0, 3000.0))
        moved = preview_status(str(self.root), self.output, jobs=[failed])
        self.assertTrue(moved["superseded"])
        self.assertIsNone(moved["error"])
        # A failed first build never wrote the file: its failure stands.
        os.remove(self.output)
        self.assertEqual(preview_status(str(self.root), self.output, jobs=[failed])["error"], "Disk full")
        # A build still running is never moved past: it writes the file next.
        self.assertNotIn("superseded", preview_status(str(self.root), self.output, jobs=[self.job()]))


if __name__ == "__main__":
    unittest.main()
