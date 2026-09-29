import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { toast } from "sonner";
import { beforeEach, expect, it, vi } from "vitest";

import { Composer } from "@renderer/features/session/Composer";
import { MAX_INLINE_TEXT_BYTES } from "@renderer/features/session/composer/attachments";
import { useComposer } from "@renderer/state/composer";
import { useProjects } from "@renderer/state/projects";
import type { Project } from "@shared/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), info: vi.fn() } }));

// The composer's editor is ProseMirror, which measures the selection; jsdom lays nothing out.
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
(Text.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects ??= noRects;

// jsdom has no blob URLs; the app's own path reads the remembered file, as it must on `file://`.
URL.createObjectURL = () => "blob:composer-test";
URL.revokeObjectURL = () => {};

const project: Project = { id: "p", name: "p", path: "/p", createdAt: 0 };
const draftKey = "__new__:p";
const explorer = window.textToCad.explorer as unknown as {
  paths: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
};

const STEP = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('bracket'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
const binary = (name: string, type = "") => new File([new Uint8Array([0x50, 0x4b, 0, 0, 1, 2, 3])], name, { type });

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  useComposer.setState({ drafts: {}, annotations: {}, acceptedContexts: {}, referenceLabels: {}, pendingFiles: {}, draftRoots: {}, queues: {}, sending: {} });
  useProjects.setState({ projects: [project], activeId: project.id });
  explorer.paths.mockReset().mockResolvedValue({ paths: [], truncated: false });
  explorer.stat.mockReset();
});

function renderComposer(onSubmit = vi.fn(async () => undefined)) {
  const view = render(createElement(Composer, { sessionId: null, newDraftKey: draftKey, chips: null, commands: [], status: "ready", onSubmit }));
  const input = view.container.querySelector<HTMLInputElement>("[data-attach-input]")!;
  const pick = async (...files: File[]) => {
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => fireEvent.change(input));
  };
  const attached = (name: string) => view.container.querySelector(`[data-composer] [title="${name}"]`);
  const send = () => act(async () => fireEvent.submit(view.container.querySelector("form")!));
  return { ...view, pick, attached, send, onSubmit };
}

const errors = () => vi.mocked(toast.error).mock.calls.map(([message]) => String(message));

it("a binary file that is not CAD is refused when it is picked, not when the prompt is sent", async () => {
  const view = renderComposer();
  await view.pick(binary("drawing.pdf", "application/pdf"));
  await waitFor(() => expect(errors()).toEqual(["drawing.pdf is not text or an image, so it was not attached."]));
  expect(view.attached("drawing.pdf")).toBeNull();
});

it("a CAD file outside the project is not attached, and the person is told to put it in the project", async () => {
  const view = renderComposer();
  await view.pick(binary("part.stl"));
  await waitFor(() => expect(errors()).toHaveLength(1));
  expect(errors()[0]).toMatch(/^part\.stl is a CAD file that is not in this project, so it was not attached\. .*project folder/);
  expect(view.attached("part.stl")).toBeNull();
  expect(useComposer.getState().drafts[draftKey] ?? "").toBe("");
});

it("a CAD file already in the project goes in as its reference chip — its path, as typed — not as its bytes", async () => {
  const step = new File([STEP], "bracket.step");
  explorer.paths.mockResolvedValue({ paths: ["README.md", "models/bracket.step", "models/other.step"], truncated: false });
  explorer.stat.mockImplementation(async ({ path }: { path: string }) => ({ path, name: "bracket.step", kind: "file", size: step.size, modifiedAt: 0, fileKind: "cad", mime: "model/step", extension: "step" }));
  const view = renderComposer();
  await view.pick(step);
  await waitFor(() => expect(useComposer.getState().drafts[draftKey]).toBe("models/bracket.step "));
  expect(explorer.stat).toHaveBeenCalledWith({ projectId: "p", path: "models/bracket.step" });
  expect(view.attached("bracket.step")).toBeNull();
  expect(errors()).toEqual([]);

  await view.send();
  await waitFor(() => expect(view.onSubmit).toHaveBeenCalledTimes(1));
  const [, content] = view.onSubmit.mock.calls[0] as unknown as [string, unknown[]];
  expect(content, "the STEP text is not embedded").toEqual([{ type: "text", text: "models/bracket.step" }]);
});

it("a same-named CAD file in the project with a different size is not taken for the picked one", async () => {
  explorer.paths.mockResolvedValue({ paths: ["models/bracket.step"], truncated: false });
  explorer.stat.mockResolvedValue({ path: "models/bracket.step", name: "bracket.step", kind: "file", size: 1, modifiedAt: 0, fileKind: "cad", mime: "", extension: "step" });
  const view = renderComposer();
  await view.pick(new File([STEP], "bracket.step"));
  await waitFor(() => expect(errors()).toHaveLength(1));
  expect(errors()[0]).toMatch(/not in this project/);
  expect(useComposer.getState().drafts[draftKey] ?? "").toBe("");
});

it("a text file over the inline limit is refused with the limit named; a small one is attached and sent as text", async () => {
  expect(MAX_INLINE_TEXT_BYTES).toBe(256 * 1024);
  const view = renderComposer();
  await view.pick(new File(["x".repeat(MAX_INLINE_TEXT_BYTES + 1)], "log.txt", { type: "text/plain" }));
  await waitFor(() => expect(errors()).toHaveLength(1));
  expect(errors()[0]).toMatch(/^log\.txt is larger than 256 KB, so it was not attached\./);
  expect(view.attached("log.txt")).toBeNull();

  await view.pick(new File(["hello"], "notes.txt", { type: "text/plain" }));
  await waitFor(() => expect(view.attached("notes.txt")).not.toBeNull());
  await view.send();
  await waitFor(() => expect(view.onSubmit).toHaveBeenCalledTimes(1));
  const [, content] = view.onSubmit.mock.calls[0] as unknown as [string, unknown[]];
  expect(content).toEqual([{ type: "resource", uri: "attachment:///notes.txt", text: "hello", mimeType: "text/plain" }]);
});

it("a file dropped on the box goes through the same check", async () => {
  const view = renderComposer();
  const form = view.container.querySelector("form")!;
  await act(async () => {
    fireEvent.drop(form, { dataTransfer: { files: [binary("part.3mf")], types: ["Files"] } });
  });
  await waitFor(() => expect(errors()).toHaveLength(1));
  expect(errors()[0]).toMatch(/^part\.3mf is a CAD file that is not in this project/);
  expect(view.attached("part.3mf")).toBeNull();
});
