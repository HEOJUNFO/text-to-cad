import { beforeEach, expect, it, vi } from "vitest";
import type { ClipboardPort, ViewerLoadFailure } from "@text-to-cad/ui/host";

import { createDesktopLoadFailures } from "@renderer/features/explorer/host/loadFailures";
import { createDesktopPromptContext } from "@renderer/features/explorer/host/promptContext";
import { useComposer } from "@renderer/state/composer";
import { useProjects } from "@renderer/state/projects";
import { useSessions } from "@renderer/state/sessions";
import type { Project, Session } from "@shared/types";

const workspaceId = JSON.stringify(["desktop", "car", null]);
const failure: ViewerLoadFailure = {
  kind: "compile", file: "models/bracket.step", title: "Couldn’t prepare the model", blocking: true,
  reason: "NameError: name 'bracket' is not defined",
  details: "File: models/bracket.step\nOperation: preparing display assets\nNameError: name 'bracket' is not defined",
};
const clipboard = (): ClipboardPort => ({ writeText: vi.fn(async () => {}), readText: async () => "", writeImage: async () => {} });

beforeEach(() => {
  useProjects.setState({ activeId: "car", projects: [{ id: "car", path: "/car" }] as Project[] });
  useSessions.setState({ activeId: "first", sessions: [{ id: "first", projectId: "car", cwd: "/car" } as Session] });
  useComposer.setState({ drafts: {}, pendingFiles: {}, draftRoots: {}, acceptedContexts: {}, focusRequest: null, referenceLabels: {}, queues: {} });
});

it("a build failure names the CAD runtime, never a terminal or address, and offers the agent and the clipboard", () => {
  const recovery = createDesktopLoadFailures(createDesktopPromptContext("car", null, workspaceId, "first"), clipboard()).recover(failure)!;
  expect(recovery.message).toBe("The CAD runtime reported an error building “models/bracket.step”.");
  expect(`${recovery.message} ${recovery.recovery}`).not.toMatch(/terminal|address/);
  expect(recovery.actions?.map(action => action.label)).toEqual(["Ask the agent to fix", "Copy details"]);
});

it("Ask the agent to fix delivers the diagnostic to the session's prompt; Copy details copies it", async () => {
  const board = clipboard();
  const [ask, copy] = createDesktopLoadFailures(createDesktopPromptContext("car", null, workspaceId, "first"), board).recover(failure)!.actions!;
  expect(await ask!.run()).toBe("Added to the prompt.");
  const draft = useComposer.getState().drafts.first!;
  expect(draft).toContain("models/bracket.step");
  expect(draft).toContain("NameError: name 'bracket' is not defined");
  expect(await copy!.run()).toBe("Copied.");
  expect(board.writeText).toHaveBeenCalledWith(failure.details);
});

it("a delivery the session cannot take says why and leaves the draft alone", async () => {
  useSessions.setState({ sessions: [] });
  const [ask] = createDesktopLoadFailures(createDesktopPromptContext("car", null, workspaceId, "first"), clipboard()).recover(failure)!.actions!;
  expect(await ask!.run()).toMatch(/\w/);
  expect(useComposer.getState().drafts.first).toBeUndefined();
});
