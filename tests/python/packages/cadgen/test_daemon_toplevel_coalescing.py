"""Top-level builds coalesce: two ``python model.py`` for one stale model are one job.

Two terminals (two agents) running the same stale model at once used to execute its
body twice -- two 25-minute builds for one result -- because in-flight coalescing keyed
child submits only. Now a top-level request carries the model's closure hash like a
child does, joins the identical job in flight, and receives that job's output as its
own: the tree, the chatter, the result line, the exit. The cases pinned here, on a
private daemon:

- two concurrent requests execute the body ONCE and both get the result;
- a failure reaches both;
- a source edited between the requests is a different closure: both run;
- ``--force`` never joins, but an unforced request joins a forced build in flight;
- the joiner completes after the original requester is killed.

Each model's body appends to ``<name>.runs`` and then waits for ``<name>.release``, so
the test decides when a build is in flight and when it may finish. ``CADGEN_JOBS=2``
gives the non-coalescing cases their second slot.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests.python.support.paths import REPO_ROOT, add_repo_path
from tests.python.support.tmp_root import generated_cad_directory

add_repo_path("packages/cadgen/src")

from cadgen.daemon import client as daemon_client  # noqa: E402
from cadgen.daemon import transport  # noqa: E402
from cadgen.daemon.server import _request_variant  # noqa: E402

DAEMON_DIR = REPO_ROOT / "packages" / "cadgen" / "src" / "cadgen" / "daemon"

MODEL = """\
from cadgen import step
from cadgen import build123d as bd


@step
def {name}():
    import time
    from pathlib import Path
    here = Path(__file__).parent
    with open(here / "{name}.runs", "a", encoding="utf-8") as handle:
        handle.write("ran\\n")
    deadline = time.monotonic() + 120
    while not (here / "{name}.release").exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("release barrier was not opened")
        time.sleep(0.01)
    {after}
    return bd.Box(5.0, 4.0, 2.0)


if __name__ == "__main__":
    {name}()
"""


def _authkey(address: str) -> bytes:
    key = transport.read_authkey(str(address))
    if not key:
        raise OSError("the daemon has not written its auth key")
    return key


class TopLevelCoalescing(unittest.TestCase):
    server: subprocess.Popen | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.work_tmp = generated_cad_directory(prefix="cadgen-coalesce-")
        cls.work = Path(cls.work_tmp.name)
        cls.src = cls.work / "src"
        cls.src.mkdir(parents=True)
        for name in ("once", "bad", "edited", "forced", "joined", "orphan"):
            after = 'raise RuntimeError("deliberate failure after the barrier")' if name == "bad" else "pass"
            (cls.src / f"{name}.py").write_text(MODEL.format(name=name, after=after), encoding="utf-8")
        cls.socket_dir = tempfile.TemporaryDirectory(prefix="cadgen-coalesce-", dir=None if os.name == "nt" else "/tmp")
        cls.address = rf"\\.\pipe\cadgen-coalesce-{os.getpid()}" if os.name == "nt" else str(Path(cls.socket_dir.name) / "d.sock")
        cls.log_path = Path(cls.socket_dir.name) / "daemon.log"
        cls.env = dict(os.environ)
        cls.env.update({
            "CADGEN_CACHE_DIR": str(cls.work / "store"),
            "CADGEN_DAEMON_STATE_DIR": str(cls.work / "state"),
            "CADGEN_DAEMON_SOCKET": cls.address,
            "CADGEN_DAEMON": "1",
            "CADGEN_DAEMON_SPARES": "1",
            "CADGEN_DAEMON_IDLE_TIMEOUT": "600",
            "CADGEN_JOBS": "2",
            "CADGEN_MEMORY_MB": "8192",
            "PYTHONPATH": os.pathsep.join(
                [str(REPO_ROOT / "packages" / "cadgen" / "src")]
                + [os.path.abspath(p) for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
            ),
        })
        for key in ("CADGEN_DAEMON_CHILD", "CADGEN_ROOT_ID", "CADGEN_BROKER", "CADGEN_BROKER_KEY", "CADGEN_EVENTS"):
            cls.env.pop(key, None)
        os.environ["CADGEN_DAEMON_STATE_DIR"] = cls.env["CADGEN_DAEMON_STATE_DIR"]
        os.environ["CADGEN_DAEMON_SOCKET"] = cls.address
        with open(cls.log_path, "ab") as log_file:
            cls.server = subprocess.Popen(
                [sys.executable, str(DAEMON_DIR / "__main__.py")],
                stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT, env=cls.env,
            )
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if cls.server.poll() is not None:
                raise RuntimeError(f"daemon exited during startup:\n{cls.log_path.read_text(encoding='utf-8')}")
            try:
                transport.connect(cls.address, _authkey(cls.address)).close()
                break
            except (OSError, RuntimeError):
                time.sleep(0.1)
        else:
            raise RuntimeError("daemon never came up")

    @classmethod
    def tearDownClass(cls) -> None:
        status = daemon_client.status() or {}
        if cls.server is not None and cls.server.poll() is None:
            cls.server.terminate()
            try:
                cls.server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                cls.server.kill()
        for worker in status.get("workers") or []:
            try:
                os.kill(int(worker["pid"]), 9)
            except (OSError, ValueError, TypeError):
                pass
        os.environ.pop("CADGEN_DAEMON_SOCKET", None)
        os.environ.pop("CADGEN_DAEMON_STATE_DIR", None)
        deadline = time.monotonic() + 15
        while True:
            try:
                cls.socket_dir.cleanup()
                break
            except PermissionError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.2)
        cls.work_tmp.cleanup()

    # --- driving -----------------------------------------------------------------

    def _start(self, name: str, *extra: str) -> subprocess.Popen:
        return subprocess.Popen(
            [sys.executable, f"{name}.py", "--json", *extra], cwd=str(self.src), env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )

    def _runs(self, name: str) -> int:
        try:
            return len((self.src / f"{name}.runs").read_text(encoding="utf-8").splitlines())
        except FileNotFoundError:
            return 0

    def _evidence(self, proc: subprocess.Popen | None = None) -> str:
        """What a failed wait needs to say: the requester's streams (a --json run
        reports failure on stdout) and the daemon's log."""
        parts = []
        if proc is not None and proc.poll() is not None:
            out, err = proc.communicate(timeout=10)
            parts.append(f"requester stdout:\n{out}\nrequester stderr:\n{err}")
        try:
            parts.append("daemon log tail:\n" + "\n".join(self.log_path.read_text(encoding="utf-8").splitlines()[-40:]))
        except OSError:
            pass
        return "\n".join(parts)

    def _wait_runs(self, name: str, count: int, *procs: subprocess.Popen) -> None:
        deadline = time.monotonic() + 120
        while self._runs(name) < count:
            self.assertLess(time.monotonic(), deadline, f"{name}: body never ran {count} time(s)\n{self._evidence()}")
            for proc in procs:
                self.assertIsNone(proc.poll(), f"{name}: a requester exited early:\n{self._evidence(proc)}")
            time.sleep(0.02)

    def _coalesced(self) -> int:
        deadline = time.monotonic() + 30
        while True:
            status = daemon_client.status()
            if status is not None:
                return int((status.get("jobsRunning") or {}).get("coalesced") or 0)
            # A status reply can be slow on a loaded machine; a daemon that is
            # gone stays gone, and that is the evidence to show.
            self.assertLess(time.monotonic(), deadline, f"the daemon stopped answering status\n{self._evidence()}")
            time.sleep(0.5)

    def _wait_coalesced(self, before: int, proc: subprocess.Popen) -> None:
        deadline = time.monotonic() + 120
        while self._coalesced() <= before:
            self.assertLess(time.monotonic(), deadline, f"the second request never joined the job in flight\n{self._evidence()}")
            self.assertIsNone(proc.poll(), f"the second request exited before joining:\n{self._evidence(proc)}")
            time.sleep(0.05)

    def _release(self, name: str) -> None:
        (self.src / f"{name}.release").touch()

    def _finish(self, proc: subprocess.Popen) -> tuple[int, str, str]:
        out, err = proc.communicate(timeout=300)
        return proc.returncode, out, err

    def _events(self, stderr: str) -> list[dict]:
        events = []
        for line in stderr.splitlines():
            if line.startswith("{"):
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
        return events

    # --- the cases -----------------------------------------------------------------

    def test_two_requests_for_one_stale_model_run_its_body_once_and_both_get_the_result(self):
        before = self._coalesced()
        first = self._start("once")
        self._wait_runs("once", 1, first)
        second = self._start("once")
        self._wait_coalesced(before, second)
        self.assertEqual(self._runs("once"), 1, "the joiner ran the body itself")
        self._release("once")
        code_a, out_a, err_a = self._finish(first)
        code_b, out_b, err_b = self._finish(second)
        self.assertEqual((code_a, code_b), (0, 0), err_a + err_b)
        self.assertEqual(self._runs("once"), 1, "the body ran more than once")
        self.assertTrue((self.src / "once.step").is_file())
        # The joiner's stdout is the producer's: the same result line it would
        # have printed itself.
        self.assertIn('"outcome":"built"', out_a)
        self.assertIn('"outcome":"built"', out_b)
        # ...and its build tree was drawn from the producer's events, re-rooted.
        states_b = {(Path(e.get("model", "")).name, e.get("state")) for e in self._events(err_b)}
        self.assertIn(("once.py", "done"), states_b, err_b)

    def test_a_failure_reaches_the_joiner(self):
        before = self._coalesced()
        first = self._start("bad")
        self._wait_runs("bad", 1, first)
        second = self._start("bad")
        self._wait_coalesced(before, second)
        self._release("bad")
        code_a, out_a, err_a = self._finish(first)
        code_b, out_b, err_b = self._finish(second)
        self.assertNotEqual(code_a, 0)
        self.assertEqual(code_b, code_a, "the joiner's exit is the producer's")
        # Under --json a failure is the result envelope on stdout,
        # {"ok": false, "error": ...}; the joiner's stdout is the producer's.
        for label, out, err in (("producer", out_a, err_a), ("joiner", out_b, err_b)):
            lines = out.strip().splitlines()
            self.assertTrue(lines, f"the {label} printed no result: {err}")
            result = json.loads(lines[-1])
            self.assertIs(result.get("ok"), False, f"{label}: {out}")
            self.assertIn("deliberate failure after the barrier", result.get("error", ""),
                          f"the {label} never saw why: {out}{err}")
        self.assertEqual(self._runs("bad"), 1)

    def test_a_helper_changed_during_a_cold_build_does_not_coalesce(self):
        helper = self.src / "dimension.py"
        helper.write_text("WIDTH = 2\n", encoding="utf-8")
        script = self.src / "edited.py"
        script.write_text(
            "from dimension import WIDTH\n" + MODEL.format(name="edited", after="pass").replace(
                "bd.Box(5.0, 4.0, 2.0)", "bd.Box(WIDTH, 4.0, 2.0)").replace(
                '"edited.release"', 'f"edited-{WIDTH}.release"'), encoding="utf-8",
        )
        before = self._coalesced()
        first = self._start("edited")
        self._wait_runs("edited", 1, first)
        helper.write_text("WIDTH = 3\n", encoding="utf-8")
        second = self._start("edited")
        # A different closure is its own job: the body runs again, on the second slot.
        self._wait_runs("edited", 2, first, second)
        self.assertEqual(self._coalesced(), before, "an edited source was joined onto the stale build")
        # Let the new revision publish first. The old job then loses the
        # output compare-and-swap rather than overwriting the new document.
        (self.src / "edited-3.release").touch()
        code_b, out_b, err_b = self._finish(second)
        (self.src / "edited-2.release").touch()
        self._finish(first)
        self.assertEqual(code_b, 0, out_b + err_b)
        self.assertEqual(self._runs("edited"), 2)
        from build123d import import_step

        self.assertAlmostEqual(import_step(str(self.src / "edited.step")).volume, 24.0)

    def test_a_forced_request_never_joins(self):
        before = self._coalesced()
        first = self._start("forced")
        self._wait_runs("forced", 1, first)
        second = self._start("forced", "--force")
        self._wait_runs("forced", 2, first, second)
        self.assertEqual(self._coalesced(), before, "--force joined the unforced build in flight")
        self._release("forced")
        code_a, _out_a, err_a = self._finish(first)
        code_b, _out_b, err_b = self._finish(second)
        self.assertEqual((code_a, code_b), (0, 0), err_a + err_b)
        self.assertEqual(self._runs("forced"), 2)

    def test_an_unforced_request_joins_a_forced_build_in_flight(self):
        before = self._coalesced()
        first = self._start("joined", "--force")
        self._wait_runs("joined", 1, first)
        second = self._start("joined")
        self._wait_coalesced(before, second)
        self.assertEqual(self._runs("joined"), 1)
        self._release("joined")
        code_a, _out_a, err_a = self._finish(first)
        code_b, _out_b, err_b = self._finish(second)
        self.assertEqual((code_a, code_b), (0, 0), err_a + err_b)
        self.assertEqual(self._runs("joined"), 1)

    @unittest.skipUnless(os.name == "posix", "the requester is killed with a POSIX signal")
    def test_the_joiner_completes_after_the_original_requester_is_killed(self):
        before = self._coalesced()
        first = self._start("orphan")
        self._wait_runs("orphan", 1, first)
        second = self._start("orphan")
        self._wait_coalesced(before, second)
        os.kill(first.pid, signal.SIGKILL)
        first.wait(timeout=30)
        first.stdout.close()
        first.stderr.close()
        # Give the daemon's watchdog time to notice the producer is gone, so the
        # release cannot mask a kill of the worker.
        time.sleep(1.5)
        self._release("orphan")
        code_b, out_b, err_b = self._finish(second)
        self.assertEqual(code_b, 0, err_b)
        self.assertIn('"outcome":"built"', out_b)
        self.assertTrue((self.src / "orphan.step").is_file())
        self.assertEqual(self._runs("orphan"), 1)


class CoalescingKey(unittest.TestCase):
    """What the client sends and the daemon keys on, without a daemon."""

    def test_a_top_level_run_keys_on_the_gates_closure(self):
        with generated_cad_directory(prefix="cadgen-coalesce-key-") as tmp:
            src = Path(tmp)
            script = src / "leaf.py"
            script.write_text(MODEL.format(name="leaf", after="pass"), encoding="utf-8")
            env_before = os.environ.get("CADGEN_CACHE_DIR")
            os.environ["CADGEN_CACHE_DIR"] = str(src / "store")
            try:
                from cadgen.store.gate import closure_hash

                sent = daemon_client.source_closure("run", [str(script), "--json"], str(src))
                self.assertEqual(sent, closure_hash(script))
                self.assertIsNotNone(sent, "a statically known cold build can still join")
                self.assertIsNone(daemon_client.source_closure("run", ["missing.py"], str(src)))
                self.assertIsNone(daemon_client.source_closure("stl-build", ["x.step"], str(src)))
            finally:
                if env_before is None:
                    os.environ.pop("CADGEN_CACHE_DIR", None)
                else:
                    os.environ["CADGEN_CACHE_DIR"] = env_before

    def test_the_key_tracks_current_imports_children_constants_and_declared_data(self):
        from unittest import mock
        from cadgen.store.gate import closure_hash
        from cadgen.store.closure import build_closure
        from cadgen.store.records import write_record

        with generated_cad_directory(prefix="cadgen-coalesce-inputs-") as tmp:
            root = Path(tmp)
            script, child, helper, data = (root / name for name in ("parent.py", "child.py", "helper.py", "data.txt"))
            script.write_text("from cadgen import step\nfrom child import child, WIDTH\n@step\ndef parent(): return child()\n", encoding="utf-8")
            child.write_text("from cadgen import step\nfrom helper import size\nWIDTH = 2\n@step\ndef child(): return size()\n", encoding="utf-8")
            helper.write_text("def size(): return 2\n", encoding="utf-8")
            data.write_text("first", encoding="utf-8")
            with mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(root / "store")}):
                for recorded in (False, True):
                    if recorded:
                        closure = build_closure(script, executed={})
                        write_record(script, {"closure": closure.as_json(), "constants": closure.constants,
                                              "children": [{"model": str(child), "tree": "old"}], "tree": None})
                        write_record(child, {"closure": {"files": [child.name, data.name]}, "tree": "old"})
                    for path in (script, child, helper, *([data] if recorded else [])):
                        with self.subTest(recorded=recorded, path=path.name):
                            before = closure_hash(script)
                            self.assertIsNotNone(before)
                            source = path.read_text(encoding="utf-8")
                            path.write_text(source.replace("WIDTH = 2", "WIDTH = 3") if path == child else
                                            source + ("\nCHANGED = 1\n" if path.suffix == ".py" else " changed"), encoding="utf-8")
                            self.assertNotEqual(before, closure_hash(script))
                            path.write_text(source, encoding="utf-8")
                # A newly reached import is visible even though the record's
                # old closure never named it.
                helper.write_text("from added import size\n", encoding="utf-8")
                added = root / "added.py"
                added.write_text("def size(): return 3\n", encoding="utf-8")
                before = closure_hash(script)
                added.write_text("def size(): return 4\n", encoding="utf-8")
                self.assertNotEqual(before, closure_hash(script))
                helper.write_text("def size(): return globals()['WIDTH']\n", encoding="utf-8")
                self.assertIsNone(closure_hash(script), "dynamic inputs must not guess a join key")

    def test_a_compile_door_keys_on_the_documents_bytes(self):
        with generated_cad_directory(prefix="cadgen-coalesce-key-") as tmp:
            document = Path(tmp) / "vendor.step"
            document.write_bytes(b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n")
            self.assertEqual(
                daemon_client.source_closure("step-compile", ["vendor.step"], tmp),
                hashlib.sha256(document.read_bytes()).hexdigest(),
            )

    def test_the_variant_is_the_runs_flags_without_force_or_the_subject(self):
        self.assertEqual(_request_variant(["/m/a.py"]), "")
        self.assertEqual(_request_variant(["/m/a.py", "--force"]), "")
        self.assertEqual(_request_variant(["/m/a.py", "--model", "fn"]), "")
        self.assertEqual(_request_variant(["/m/a.py", "--json"]), "--json")
        self.assertEqual(_request_variant(["/m/a.py", "--mesh-tolerance", "0.1", "--json"]), "--mesh-tolerance 0.1 --json")
        self.assertEqual(_request_variant(["x.step", "--force"]), "")


if __name__ == "__main__":
    unittest.main()
