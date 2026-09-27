/**
 * Which tap of a click sequence activates what it picked, and when.
 *
 * A click acts at once: nothing waits to tell it from a double-click. What makes that safe
 * is the browser's own count. The second click of a double-click (a press the browser counts
 * as the second, `MouseEvent.detail` 2) is dispatched a moment before the `dblclick` that
 * owns the gesture, so its activation is held for one turn of the task queue and `double()`
 * cancels it; a second click the browser pairs with nothing commits after that turn, as the
 * click it turned out to be. The double-click is then told whether the gesture's FIRST click
 * activated (`double()` returns it), so the surface can put back the selection that click
 * changed before it isolates, leaves isolation or copies — the gesture ends as it did when
 * every click waited.
 *
 * `tap(clickCount, referenceId, options)`: a press released within the tap slop; `miss(clickCount)`:
 * a press that was not one (a drag, a cancel, a chord), which for a fresh gesture (count 1)
 * forgets any earlier click; `double()`: the dblclick; `cancel()`: drop a held second click.
 */
export function createClickActivation({
  commit,
  doubleClick = true,
  defer = (fn) => window.setTimeout(fn, 0),
  cancel = (id) => window.clearTimeout(id)
}) {
  let heldId = 0;
  // Whether this gesture's first click activated: what a following double-click undoes.
  let activated = false;

  function drop() {
    if (!heldId) return;
    cancel(heldId);
    heldId = 0;
  }

  return {
    tap(clickCount, referenceId, options) {
      drop();
      if (!doubleClick || !(clickCount >= 2)) {
        activated = true;
        commit(referenceId, options);
        return;
      }
      heldId = defer(() => {
        heldId = 0;
        activated = true;
        commit(referenceId, options);
      });
    },
    miss(clickCount) {
      drop();
      if (!(clickCount >= 2)) activated = false;
    },
    double() {
      drop();
      const first = activated;
      activated = false;
      return first;
    },
    cancel: drop
  };
}
