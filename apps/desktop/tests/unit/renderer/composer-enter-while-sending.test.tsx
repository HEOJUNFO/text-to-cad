import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@renderer/features/session/Composer";
import { useComposer } from "@renderer/state/composer";

const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
(Text.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects ??= noRects;

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  useComposer.setState({ drafts: { s1: "applied", [NEW]: "hello" }, queues: {}, sending: {}, paused: {} });
});
const NEW = "new-draft";

async function mount(props: { sessionId: string | null; status: "ready" | "submitted" | "streaming"; queueWhileSubmitted?: boolean }) {
  const onSubmit = vi.fn();
  const { container } = render(
    <Composer
      {...props}
      chips={null}
      commands={[]}
      newDraftKey={props.sessionId === null ? NEW : undefined}
      onSubmit={onSubmit}
    />,
  );
  const input = await vi.waitFor(() => {
    const found = container.querySelector<HTMLElement>("[data-composer-input]");
    if (!found) throw new Error("no editor yet");
    return found;
  });
  input.focus();
  return { input, onSubmit };
}

/**
 * A prompt that is out but whose turn has not started reads `submitted` while the session itself
 * still says idle (`sending`, state/composer.ts). A person who sends again in that window is
 * queueing behind it, like one sending during a turn; Enter used to do nothing then (the submit
 * button is disabled for the spinner), and the text just sat in the box.
 */
describe("Enter while a prompt is in flight", () => {
  it("sends in a session (the store queues it behind the one out)", async () => {
    const { input, onSubmit } = await mount({ sessionId: "s1", status: "submitted", queueWhileSubmitted: true });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toBe("applied");
  });

  it("still does nothing on the new-session screen, where a second send would create a second session", async () => {
    const { input, onSubmit } = await mount({ sessionId: null, status: "submitted" });
    vi.useFakeTimers();
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await vi.runAllTimersAsync();
    expect(onSubmit).not.toHaveBeenCalled();
    // The same keystroke on a box that is not blocked does send (the Enter path works here), so
    // the silence above is the gate and not a path that never ran.
    vi.useRealTimers();
    const ready = await mount({ sessionId: null, status: "ready" });
    fireEvent.keyDown(ready.input, { key: "Enter", code: "Enter" });
    await vi.waitFor(() => expect(ready.onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends once for two Enters pressed before the first has taken the draft", async () => {
    const { input, onSubmit } = await mount({ sessionId: "s1", status: "ready" });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    await vi.runAllTimersAsync();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
