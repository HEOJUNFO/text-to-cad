import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type { AgentJobOutput, AgentStatus } from "@shared/agents";

/**
 * The agent table — registry rows with what the detector found — and the
 * output of any install or login job in flight. P6's Agents page reads
 * this; the composer's agent chip reads `installed`.
 */
type AgentsState = {
  agents: AgentStatus[];
  ready: boolean;
  /**
   * Why the agent list could not be read, when it could not. Set only by a
   * failed `load`; any list that arrives afterwards clears it. Shown as its
   * own message, so an unreadable list does not pass for "no agents".
   */
  loadError: string | null;
  /** Output so far per job id. */
  jobs: Record<string, { agentId: string; kind: AgentJobOutput["kind"]; output: string; exitCode: number | null }>;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  install: (agentId: string, index?: number) => Promise<string>;
  login: (agentId: string) => Promise<string>;
  writeJob: (jobId: string, data: string) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  receive: (agents: AgentStatus[]) => void;
  receiveOutput: (chunk: AgentJobOutput) => void;
};

const JOB_TAIL = 64 * 1024;

export const useAgents = create<AgentsState>((set) => ({
  agents: [],
  ready: false,
  loadError: null,
  jobs: {},

  /**
   * `ready` means "detection has answered", never "an agent was found".
   *
   * An empty `agents.list` is main's "the first probe is still running"
   * (`AgentDetector.list`): the answer follows on `agents.status`, and
   * `receive` marks it — an empty table included. A list that cannot be read
   * at all is an answer too: nothing will follow it, and a screen waiting on
   * `ready` (the welcome's Continue) would otherwise wait forever. That answer
   * is logged and kept in `loadError`, so it reads as a failure, not as an
   * empty table.
   */
  load: async () => {
    try {
      const agents = await window.textToCad.agents.list();
      set({ agents, ready: agents.length > 0, loadError: null });
    } catch (error) {
      console.error("[agents] Could not read the agent list (agents.list):", error);
      set({ ready: true, loadError: error instanceof Error ? error.message : String(error) });
    }
  },

  refresh: async () => {
    const agents = await window.textToCad.agents.refresh();
    set({ agents, ready: true, loadError: null });
  },

  install: async (agentId, index = 0) => {
    const { jobId } = await window.textToCad.agents.install({ agentId, index });
    return jobId;
  },

  login: async (agentId) => {
    const { jobId } = await window.textToCad.agents.login({ agentId });
    return jobId;
  },

  writeJob: (jobId, data) => window.textToCad.agents.writeJob({ jobId, data }),

  cancelJob: (jobId) => window.textToCad.agents.cancelJob({ jobId }),

  receive: (agents) => set({ agents, ready: true, loadError: null }),

  receiveOutput: (chunk) =>
    set((state) => {
      const existing = state.jobs[chunk.jobId];
      const output = ((existing?.output ?? "") + chunk.data).slice(-JOB_TAIL);
      return {
        jobs: {
          ...state.jobs,
          [chunk.jobId]: {
            agentId: chunk.agentId,
            kind: chunk.kind,
            output,
            exitCode: chunk.exitCode ?? existing?.exitCode ?? null,
          },
        },
      };
    }),
}));

/**
 * The installed agents, for the composer's agent chip. `useShallow` because
 * the filter builds a fresh array every call and zustand compares with
 * Object.is — without it every render schedules another.
 */
export function useInstalledAgents(): AgentStatus[] {
  return useAgents(
    useShallow((state) => state.agents.filter((agent) => agent.installed || agent.launchWithoutBinary)),
  );
}
