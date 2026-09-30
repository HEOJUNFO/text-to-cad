/**
 * `agents.list` on a warm launch: the real handler, built on a detector with
 * a stored table, answers before the login shell has, and the timing is the
 * handler's own (the cold path waits the shell's whole delay).
 */
import { beforeEach, expect, it, vi } from "vitest";

import type * as Detect from "@main/agents/detect";
import type { DetectorProbes } from "@main/agents/detect";
import { AGENT_PROVIDERS } from "@main/agents/registry";

const SHELL_MS = 400;
const machine = vi.hoisted(() => ({ stored: undefined as unknown }));

vi.mock("@main/agents/detect", async (importOriginal) => {
  const actual = await importOriginal<typeof Detect>();
  const probes: DetectorProbes = {
    env: () => new Promise((resolve) => setTimeout(() => resolve({ PATH: "/usr/local/bin" }), SHELL_MS)),
    isExecutable: async (file) => file === "/usr/local/bin/claude",
    exists: async () => false,
    exec: async () => ({ stdout: "2.1.0 (Claude Code)", stderr: "", code: 0 }),
    homeDir: () => "/Users/me",
    platform: "darwin",
  };
  // The handler's own cache argument is kept; only the machine is fake.
  class FakeMachineDetector extends actual.AgentDetector {
    constructor(providers?: undefined, _probes?: undefined, cache?: Detect.AgentsCache) {
      super(providers, probes, cache);
    }
  }
  return { ...actual, AgentDetector: FakeMachineDetector };
});
vi.mock("@main/db/repositories", () => ({
  settings: { agentsCache: () => machine.stored, setAgentsCache: (value: unknown) => void (machine.stored = value) },
}));
vi.mock("@main/app-paths", () => ({ appVersion: () => "9.9.9", appRoot: () => "", resourcesDir: () => "" }));
vi.mock("@main/ipc/register", () => ({ broadcast: vi.fn(), IpcError: class extends Error {} }));
vi.mock("@main/acp/pty-backend", () => ({ spawnJobPty: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
});

const stored = (version: string) => ({
  version,
  statuses: AGENT_PROVIDERS.map((provider) => ({
    ...provider,
    installed: true,
    binaryPath: "/old/claude",
    version: "1.0.0",
    auth: "unauthenticated",
    checkedAt: 1,
  })),
});

it("answers a warm list from the stored table without waiting for the shell", async () => {
  machine.stored = stored("9.9.9");
  const { agentsHandlers } = await import("@main/ipc/agents");
  const started = performance.now();
  const agents = await agentsHandlers.agents.list();
  const took = performance.now() - started;
  console.info(`agents.list warm: ${took.toFixed(1)} ms (login shell takes ${SHELL_MS} ms)`);
  expect(agents.length).toBe(AGENT_PROVIDERS.length);
  expect(agents.every((agent) => agent.probing === true)).toBe(true);
  expect(took).toBeLessThan(SHELL_MS / 4);
});

it("waits for the shell when the stored table is another version's", async () => {
  machine.stored = stored("9.9.8");
  const { agentsHandlers } = await import("@main/ipc/agents");
  const started = performance.now();
  const agents = await agentsHandlers.agents.list();
  const took = performance.now() - started;
  console.info(`agents.list cold: ${took.toFixed(1)} ms`);
  expect(took).toBeGreaterThanOrEqual(SHELL_MS - 20);
  expect(agents.some((agent) => agent.probing)).toBe(false);
  expect(agents.find((agent) => agent.id === "claude-code")).toMatchObject({ version: "2.1.0" });
});
