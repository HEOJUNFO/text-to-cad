import { render } from "@testing-library/react";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { App } from "@renderer/app/App";
import { useOnboarding } from "@renderer/state/onboarding";
import { useSessions } from "@renderer/state/sessions";
import { useSettings } from "@renderer/state/settings";
import { useUi } from "@renderer/state/ui";
import { defaultSettings, type Session } from "@shared/types";

/** The window's title says where you are: nothing set it before, so every route was "text-to-cad". */
vi.mock("@renderer/app/Shell", () => ({ Shell: () => null }));
vi.mock("@renderer/app/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@renderer/features/onboarding/Welcome", () => ({ Welcome: () => null }));
vi.mock("@renderer/features/settings/SettingsRoute", () => ({ SettingsRoute: () => null }));
vi.mock("@renderer/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@renderer/state/bridge", () => ({ hydrate: vi.fn(async () => undefined), subscribeToMain: () => () => undefined }));

const BRACKET = { id: "s1", projectId: "p", agentId: "codex", cwd: "/p", title: "Bracket", status: "idle", archived: false } as unknown as Session;

beforeEach(() => {
  document.title = "text-to-cad";
  useUi.setState({ route: "app" });
  useOnboarding.setState({ enabled: false });
  useSessions.setState({ sessions: [], activeId: null });
  useSettings.setState({ settings: { ...defaultSettings(), onboardingCompleted: true }, ready: true } as never);
});

it("names the settings route", () => {
  useUi.setState({ route: "settings" });
  render(<App />);
  expect(document.title).toBe("text-to-cad — Settings");
});

it("names the welcome", () => {
  useOnboarding.setState({ enabled: true });
  useSettings.setState({ settings: { ...defaultSettings(), onboardingCompleted: false }, ready: true } as never);
  render(<App />);
  expect(document.title).toBe("text-to-cad — Welcome");
});

it("names the active session, and is plain with none", () => {
  render(<App />);
  expect(document.title).toBe("text-to-cad");
  act(() => useSessions.setState({ sessions: [BRACKET], activeId: "s1" }));
  expect(document.title).toBe("text-to-cad — Bracket");
  act(() => useSessions.setState({ activeId: null }));
  expect(document.title).toBe("text-to-cad");
});
