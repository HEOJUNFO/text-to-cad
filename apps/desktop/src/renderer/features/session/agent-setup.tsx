import { useEffect } from "react";
import { Check, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@renderer/components/ui/button";
import { AgentMark } from "@renderer/features/settings/AgentMark";
import { JobLog, useJob } from "@renderer/features/settings/AgentDrawer";
import { cn } from "@renderer/lib/utils";
import { useAgents } from "@renderer/state/agents";
import { ONBOARDING_AGENT_IDS } from "@renderer/state/onboarding";
import { useUi } from "@renderer/state/ui";
import type { AgentStatus } from "@shared/agents";

/*
 * Getting an agent running: what the new-session screen shows when nothing
 * is installed, what a session shows when its agent's CLI is gone, and the
 * rows the welcome's agent step lists.
 */

/**
 * Main's refusal to spawn an agent whose CLI is not on this machine
 * (`ensureLive`/`probeOptions` in src/main/acp/sessions.ts:
 * `${provider.name} is not installed`). It crosses IPC as a plain message —
 * there is no typed reason — so this is the one place that reads it.
 */
export function isNotInstalledError(message: string | null | undefined): boolean {
  return /\bis not installed\.?$/.test((message ?? "").trim());
}

/** Installed and signed in (or needing no sign-in): a session can start with it. */
export function isAgentReady(agent: AgentStatus): boolean {
  return agent.installed && (agent.auth === "authenticated" || agent.auth === "not-required");
}

/**
 * One agent with the step that gets it running — Install, then Sign in —
 * and the job's output under it. The welcome's agent step, the new-session
 * screen's "no agent installed" card and a session whose CLI is gone.
 */
export function AgentRow({ agent }: { agent: AgentStatus }) {
  const install = useAgents((state) => state.install);
  const login = useAgents((state) => state.login);
  const refresh = useAgents((state) => state.refresh);
  const { jobId, output, running, start } = useJob();

  // An install or sign-in changes what detection would find: look again once it ends.
  useEffect(() => {
    if (jobId && !running) {
      void refresh();
    }
  }, [jobId, running, refresh]);

  const ready = isAgentReady(agent);
  const status = ready ? "Ready" : !agent.installed ? "Not installed" : agent.auth === "unauthenticated" ? "Signed out" : "Installed";

  return (
    <div className="rounded-lg border px-3 py-2.5" data-onboarding-agent={agent.id}>
      <div className="flex items-center gap-3">
        <AgentMark icon={agent.icon} id={agent.id} name={agent.name} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{agent.name}</p>
          <p className={cn("text-xs", ready ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
            {status}
          </p>
        </div>
        {ready ? (
          <Check aria-label="Ready" className="size-4 text-emerald-500" />
        ) : !agent.installed ? (
          <Button className="h-7 gap-1.5" disabled={running} onClick={() => void start(() => install(agent.id))} size="sm">
            {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Install
          </Button>
        ) : (
          <Button className="h-7 gap-1.5" disabled={running} onClick={() => void start(() => login(agent.id))} size="sm">
            {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Sign in
          </Button>
        )}
      </div>
      {jobId ? <JobLog output={output} /> : null}
    </div>
  );
}

/**
 * "No agent can run this": the agents text-to-cad offers first, each with
 * its Install / Sign in, and the way to the rest in Settings › Agents. The
 * new-session screen shows it before anything is typed when nothing is
 * installed; a session whose agent's CLI is gone shows it in place of a
 * Reconnect that would only fail again.
 */
export function AgentSetupCard({
  agents,
  title,
  message,
  onRetry,
}: {
  agents: AgentStatus[];
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  const openSettings = useUi((state) => state.openSettings);
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3" data-agent-setup>
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[13px] leading-5 whitespace-pre-wrap text-muted-foreground">{message}</p>
      </div>
      {agents.length > 0 ? (
        <div className="space-y-2">
          {agents.map((agent) => (
            <AgentRow agent={agent} key={agent.id} />
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {onRetry ? (
          <Button className="h-7 gap-1.5 text-[12px]" onClick={onRetry} size="sm" variant="outline">
            <RotateCcw className="size-3.5" />
            Try again
          </Button>
        ) : null}
        <Button
          className="h-7 text-[12px] text-muted-foreground"
          onClick={() => openSettings("agents")}
          size="sm"
          variant="ghost"
        >
          Settings › Agents
        </Button>
      </div>
    </div>
  );
}

/** The agents offered first (the welcome's order), as detection reported them. */
export function useOfferedAgents(): AgentStatus[] {
  const agents = useAgents((state) => state.agents);
  return ONBOARDING_AGENT_IDS.map((id) => agents.find((agent) => agent.id === id)).filter(
    (agent): agent is AgentStatus => agent !== undefined,
  );
}
