import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { expect, it } from "vitest";

import { Toaster } from "@renderer/components/ui/sonner";

/**
 * Sonner's stock hotkey for "focus the toasts" is Alt+T, and Option+T types a dagger on a Mac
 * keyboard: it fired in the middle of a sentence and took the caret away.
 */
it("does not take focus on Alt+T, which types a character, only on Mod+Alt+T", async () => {
  render(<Toaster />);
  act(() => void toast("Saved"));
  await waitFor(() => expect(document.querySelector("ol[data-sonner-toaster]")).not.toBeNull());
  const list = document.querySelector<HTMLElement>("ol[data-sonner-toaster]")!;

  fireEvent.keyDown(document, { key: "†", code: "KeyT", altKey: true });
  expect(list).not.toHaveFocus();

  fireEvent.keyDown(document, { key: "t", code: "KeyT", altKey: true, ctrlKey: true, metaKey: true });
  expect(list).toHaveFocus();
});
