"""The supervisor's one housekeeping job: evict an over-cap store when idle.

STORE.md §8: the daemon runs size-capped LRU eviction against a store it has
served, only while no job is in flight, and stops the moment one arrives.
It holds no store state -- just which roots it has seen, each with the cap
the requesting client had in force, and when it last looked.

Stdlib + the store modules; never the CAD kernel (the supervisor's rule).
"""

from __future__ import annotations

import threading
import time
from typing import Callable

# One size check per store at most this often; the check is a stat walk over
# the store, cheap but not free on a hundred thousand objects.
CHECK_INTERVAL_SECONDS = 600.0
# Idle this long before the first check: a burst of short requests is one
# build from the user's point of view, not a series of idle gaps.
QUIET_SECONDS = 30.0


class Housekeeper:
    def __init__(
        self,
        *,
        active: Callable[[], bool],
        clock: Callable[[], float] = time.monotonic,
        run: Callable[[str, int | None, Callable[[], bool]], str | None] | None = None,
        log: Callable[[str], None] | None = None,
        check_interval: float = CHECK_INTERVAL_SECONDS,
        quiet_seconds: float = QUIET_SECONDS,
    ) -> None:
        self._active = active
        self._clock = clock
        self._run = run or evict_if_over_cap
        self._log = log or (lambda message: None)
        self._interval = float(check_interval)
        self._quiet = float(quiet_seconds)
        self._guard = threading.Lock()
        self._roots: dict[str, int | None] = {}
        self._checked: dict[str, float] = {}
        self._last_activity = clock()
        self._worker: threading.Thread | None = None

    # --- what the server tells it ------------------------------------------------

    def note_request(self, store_root: str | None, env: dict | None = None) -> None:
        """A request arrived for ``store_root`` with the client's environment."""
        self.note_activity()
        root = str(store_root or "").strip()
        if not root:
            return
        from cadgen.store.evict import configured_max_bytes

        try:
            cap = configured_max_bytes(env if isinstance(env, dict) else None)
        except ValueError:
            cap = configured_max_bytes({})
        with self._guard:
            self._roots[root] = cap

    def note_activity(self) -> None:
        with self._guard:
            self._last_activity = self._clock()

    # --- the idle watcher's call --------------------------------------------------

    def tick(self) -> str | None:
        """Called from the idle watcher. Starts at most one eviction, in its own
        thread, for the first store that is due. Returns that root, or None."""
        if self._active():
            self.note_activity()
            return None
        now = self._clock()
        with self._guard:
            if self._worker is not None and self._worker.is_alive():
                return None
            if now - self._last_activity < self._quiet:
                return None
            due = None
            for root in sorted(self._roots):
                if now - self._checked.get(root, float("-inf")) >= self._interval:
                    due = root
                    break
            if due is None:
                return None
            self._checked[due] = now
            cap = self._roots[due]
            self._worker = threading.Thread(target=self._sweep, args=(due, cap), name="cadgen-store-eviction", daemon=True)
            self._worker.start()
            return due

    def wait(self, timeout: float | None = None) -> None:
        worker = self._worker
        if worker is not None:
            worker.join(timeout)

    def _sweep(self, root: str, cap: int | None) -> None:
        try:
            outcome = self._run(root, cap, self._active)
        except Exception as exc:  # noqa: BLE001 - housekeeping never takes the supervisor down
            outcome = f"eviction failed: {exc}"
        if outcome:
            self._log(f"store {root}: {outcome}")


def evict_if_over_cap(root: str, cap: int | None, should_stop: Callable[[], bool]) -> str | None:
    """Sweep ``root`` when its size is over ``cap``. Returns a log line, or None
    when there was nothing to do."""
    if cap is None:
        return None
    from cadgen.store.evict import store_bytes
    from cadgen.store.gc import collect
    from cadgen.store.paths import store_root_override

    with store_root_override(root):
        size = store_bytes()
        if size["total"] <= cap:
            return None
        if should_stop():
            return None
        report = collect(max_bytes=cap, should_stop=should_stop)
    evicted = ", ".join(f"{count} {kind}" for kind, count in sorted(report.evicted.items())) or "no entries"
    state = "stopped for a job" if report.stopped else "done"
    return (f"over the cap ({size['total']} > {cap} bytes); evicted {evicted}, removed {report.removed} objects "
            f"({report.removed_bytes} bytes); {state}")
