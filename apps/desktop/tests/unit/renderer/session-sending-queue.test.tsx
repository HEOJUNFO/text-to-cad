import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionView } from "@renderer/features/session/SessionView";
import { useAcp } from "@renderer/state/acp";
import { useComposer } from "@renderer/state/composer";
import { useProjects } from "@renderer/state/projects";
import { initialSessionState } from "@shared/acp/types";
import type { Project, Session } from "@shared/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), info: vi.fn() } }));
vi.mock("@renderer/features/session/SessionHeader", () => ({ SessionHeader: () => null }));
vi.mock("@renderer/features/session/Transcript", () => ({ Transcript: () => <div data-transcript /> }));
vi.mock("@renderer/features/session/ContextMeter", () => ({ ContextMeter: () => null }));

// The composer's editor is ProseMirror, which measures the selection; jsdom lays nothing out.
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
(Text.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects ??= noRects;

const P: Project = { id: "p1", name: "p", path: "/p", createdAt: 0 };
const SESSION = { id: "s1", projectId: "p1", agentId: "claude", cwd: "/p", gitMode: "checkout", title: "New session", status: "idle" } as unknown as Session;

beforeEach(() => {
  useProjects.setState({ projects: [P], activeId: P.id });
  useAcp.setState({
    sessions: { s1: { ...initialSessionState("s1", "claude"), status: "idle" } },
    loading: {},
    reconnecting: {},
    loadErrors: {},
    ensureLoaded: vi.fn(async () => undefined),
  } as never);
  useComposer.setState({ drafts: {}, queues: {}, sending: {}, paused: {}, submitRequest: null });
});

describe("a prompt sent with no turn started yet", () => {
  // The box shows the spinner (`submitted`) and its button is disabled, but Enter still sends: the
  // submit is `type="button"` while SessionView hands Composer an `onStop`, so the editor's and the
  // vendored textarea's `button[type="submit"]` disabled check finds nothing to refuse, and the store
  // queues the text behind the prompt in flight. Drop `onStop` or retype the button and this fails.
  it("queues the next Enter's text behind it rather than ignoring it", async () => {
    useComposer.setState({ sending: { s1: 1 } });
    render(<SessionView session={SESSION} />);
    useComposer.getState().setDraft("s1", "and a second thing");
    act(() => useComposer.getState().requestSubmit("s1"));
    await vi.waitFor(() => expect(useComposer.getState().queues.s1).toHaveLength(1));
  });
});
