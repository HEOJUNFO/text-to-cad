import LoadingIcon from "@text-to-cad/ui/loading-icon";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2, RotateCcw, Unplug } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@renderer/components/ui/button";
import { useAcp } from "@renderer/state/acp";
import { useAgents } from "@renderer/state/agents";
import { useComposer } from "@renderer/state/composer";
import type { TakenDraft } from "@renderer/state/composer";
import { useSettings } from "@renderer/state/settings";
import { effortOption, fastOption, modeChoice, modelOption } from "@shared/acp/options";
import { errorMessage } from "@shared/ipc/errors";
import type { PromptBlock, SessionState } from "@shared/acp/types";
import type { AgentStatus } from "@shared/agents";
import type { Session } from "@shared/types";

import { AgentSetupCard, isNotInstalledError } from "./agent-setup";
import { AuthPrompt } from "./AuthPrompt";
import { Composer } from "./Composer";
import { EffortChip, ModeChip, ModelChip } from "./ComposerChips";
import { ContextMeter } from "./ContextMeter";
import { TranscriptScopeContext, type TranscriptScope } from "./links/PathLink";
import { PlanCard } from "./PlanCard";
import { SessionHeader } from "./SessionHeader";
import { Transcript } from "./Transcript";
import { isAuthError } from "./view";

/**
 * One thread, one agent (plan §3): the header, the transcript, the pinned
 * plan above the composer, the composer — whose row under the box ends in
 * the context ring.
 *
 * The session's live state comes from the acp store; a session picked from
 * the index with no snapshot yet is loaded here, which is the "connecting"
 * and the "resumed from history" states. A reconnect that fails is the
 * error state, with the agent's login surfaced when that is the cause.
 *
 * The full-pane spinner is now the *last* resort, not the first (README,
 * "Opening a session"). A session whose transcript main has a snapshot of
 * paints it immediately and says `Reconnecting…` in the composer's row while
 * the agent comes back; only a session with no snapshot at all — one created
 * before there were snapshots — still waits behind "Connecting to …".
 */
export function SessionView({ session }: { session: Session }) {
  const state = useAcp((store) => store.sessions[session.id] ?? null);
  const loading = useAcp((store) => store.loading[session.id] ?? false);
  const reconnecting = useAcp((store) => store.reconnecting[session.id] ?? false);
  const loadError = useAcp((store) => store.loadErrors[session.id] ?? null);
  const ensureLoaded = useAcp((store) => store.ensureLoaded);
  const load = useAcp((store) => store.load);
  const cancel = useAcp((store) => store.cancel);
  const setMode = useAcp((store) => store.setMode);
  const setConfigOption = useAcp((store) => store.setConfigOption);
  const submit = useComposer((store) => store.submit);
  const agents = useAgents((store) => store.agents);
  const agent = agents.find((candidate) => candidate.id === session.agentId) ?? null;
  // The CLI is gone: Reconnect would fail the same way forever, so the
  // failure offers the install instead (with Try again for after it).
  const notInstalled = isNotInstalledError;

  useEffect(() => {
    void ensureLoaded(session.id);
  }, [session.id, ensureLoaded]);

  const onSubmit = (text: string, content: PromptBlock[], draft: TakenDraft) => submit(session.id, text, content, draft);

  // What a path in this thread's prose is relative to: its worktree when it
  // runs in one (plan §9), else the project. `links/PathLink` reads it.
  const scope = useMemo<TranscriptScope>(
    () => ({ projectId: session.projectId, root: session.worktreePath ?? null }),
    [session.projectId, session.worktreePath],
  );

  const retry = () => {
    const lastPrompt = lastUserPrompt(state);
    if (lastPrompt) {
      void submit(session.id, promptText(lastPrompt), lastPrompt);
    }
  };

  const running = state?.status === "running" || state?.status === "waiting";
  // A reconnect behind a painted transcript is not the composer's business:
  // a prompt sent now is queued against the load and goes out when it lands
  // (`ensureLive` in src/main/acp/sessions.ts), so the box stays live and the
  // row under it says what is happening instead.
  const composerStatus: "ready" | "submitted" | "streaming" = running
    ? "streaming"
    : (state?.status === "connecting" || loading) && !reconnecting
      ? "submitted"
      : "ready";

  const chips = useMemo(() => {
    if (!state) {
      return null;
    }
    const model = modelOption(state.configOptions);
    const effort = effortOption(state.configOptions);
    const mode = modeChoice(state);
    const fast = fastOption(state.configOptions);
    const setOption = (configId: string, value: string | boolean) =>
      reportRefusal(setConfigOption(session.id, configId, value), configId === model?.id ? "the model" : configId === mode?.configId ? "the mode" : "that setting");
    // One chip, two calls: `session/set_mode` for an agent that sends
    // `modes`, its `mode` config option for one that sends that instead.
    const chooseMode = (modeId: string) => {
      if (!mode) {
        return;
      }
      if (mode.source === "modes") {
        reportRefusal(setMode(session.id, modeId), "the mode");
      } else if (mode.configId) {
        setOption(mode.configId, modeId);
      }
    };
    // The row under the box, left to right: `+`, the mode; then on the right
    // the model, the effort and how full the window is. The agent and the
    // project are the title bar's and the sidebar's. The mode is the one
    // permission control — the app has none of its own over the top of it —
    // and it is set through whichever of the two calls this agent answers
    // to (`modeChoice`). Everything else the agent exposes is the agent's
    // business: the composer is four decisions, not a settings panel.
    // Main answers these only while the agent is there (`requireLive`): on a painted, reconnecting,
    // failed or closed session the chips are shown as they were and not offered.
    // A snapshot painted while the agent reconnects can say `idle`; it is not live until the load lands.
    const live = !reconnecting && (state.status === "idle" || state.status === "running" || state.status === "waiting");
    const unavailable = live ? null : reconnecting ? "Reconnecting…" : state.status === "connecting" ? "Connecting…" : "Agent disconnected";
    return {
      leading: mode ? (
        <LiveOnly reason={unavailable}>
          <ModeChip currentModeId={mode.currentModeId} modes={mode.modes} onChange={chooseMode} />
        </LiveOnly>
      ) : null,
      trailing: (
        <>
          <LiveOnly reason={unavailable}>
            {model ? (
              <ModelChip
                agentId={session.agentId}
                fast={fast}
                onChange={(_agentId, value) => setOption(model.id, value)}
                onFastChange={setOption}
                providers={[
                  {
                    agentId: session.agentId,
                    agentName: agent?.name ?? session.agentId,
                    icon: agent?.icon ?? null,
                    model,
                  },
                ]}
              />
            ) : null}
            {effort ? <EffortChip effort={effort} onChange={setOption} /> : null}
          </LiveOnly>
          <ContextMeter
            lastTurnUsage={state.lastTurnUsage}
            rateLimits={state.rateLimits}
            sessionId={session.id}
            sessionUsage={state.sessionUsage}
            usage={state.contextUsage}
          />
        </>
      ),
    };
  }, [state, reconnecting, session.id, session.agentId, agent?.icon, agent?.name, setMode, setConfigOption]);

  const planTurn =
    state?.turns.findLast((turn) => turn.role === "agent" && turn.parts.some((part) => part.type === "plan")) ?? null;
  // A failed prompt is already in the transcript with its Retry; the banner
  // is for a connection that died with nothing to attach the message to.
  const lastAgentTurn = state?.turns.findLast((turn) => turn.role === "agent") ?? null;
  const errorInTranscript = lastAgentTurn?.parts.at(-1)?.type === "error";
  const showErrorBanner = state?.status === "error" && !!state.error && !errorInTranscript;
  // "Disconnect agent" (SessionHeader), or the keep-alive evicting the
  // adapter: nothing is coming back on its own — `ensureLoaded` runs on a
  // session switch, not here — so the way back is a button. A disconnect by
  // hand also forgets the transcript (`close` in state/acp.ts), so a session
  // this view was showing that now has no state and a closed row is that,
  // not a first open still waiting on `ensureLoaded`.
  const [shownId, setShownId] = useState<string | null>(null);
  if (state && shownId !== session.id) {
    setShownId(session.id);
  }
  const disconnected =
    !loading &&
    !loadError &&
    (state ? state.status === "closed" : shownId === session.id && session.status === "closed");

  return (
    <div className="flex h-full min-h-0 flex-col" data-session-view={session.id} data-session-status={state?.status ?? (loading ? "loading" : "detached")}>
      <SessionHeader session={session} title={session.title} />

      {state ? (
        <TranscriptScopeContext.Provider value={scope}>
          <Transcript onReconnect={() => void load(session.id)} onRetry={retry} state={state} />
        </TranscriptScopeContext.Provider>
      ) : loadError ? (
        notInstalled(loadError) ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AgentMissing agent={agent} agentId={session.agentId} message={loadError} onRetry={() => void load(session.id)} />
          </div>
        ) : isAuthError(loadError) || agent?.auth === "unauthenticated" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AuthPrompt agent={agent} message={loadError} onRetry={() => void load(session.id)} />
          </div>
        ) : (
          <LoadFailed message={loadError} onRetry={() => void load(session.id)} />
        )
      ) : disconnected ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <Connecting agentName={agent?.name ?? session.agentId} />
      )}

      <div className="shrink-0 px-6 pb-4">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2">
          {showErrorBanner && state?.error && !isAuthError(state.error) ? (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] leading-5" role="status">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{state.error}</span>
              <Button className="h-6 gap-1 px-2 text-[12px]" onClick={() => void load(session.id)} size="sm" variant="outline">
                <RotateCcw className="size-3" />
                Reconnect
              </Button>
            </div>
          ) : null}
          {showErrorBanner && state?.error && isAuthError(state.error) ? (
            <AuthPrompt agent={agent} message={state.error} onRetry={() => void load(session.id)} />
          ) : null}
          {/* A reconnect that failed behind a painted transcript: the
              transcript is still worth reading, so the failure is a line
              above the composer rather than a screen in place of it. */}
          {state && loadError && !loading ? (
            notInstalled(loadError) ? (
              <AgentMissing agent={agent} agentId={session.agentId} message={loadError} onRetry={() => void load(session.id)} />
            ) : isAuthError(loadError) ? (
              <AuthPrompt agent={agent} message={loadError} onRetry={() => void load(session.id)} />
            ) : (
              <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] leading-5" data-reconnect-failed role="status">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{loadError}</span>
                <Button className="h-6 gap-1 px-2 text-[12px]" onClick={() => void load(session.id)} size="sm" variant="outline">
                  <RotateCcw className="size-3" />
                  Reconnect
                </Button>
              </div>
            )
          ) : null}
          {disconnected ? (
            <div className="flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] leading-5" data-disconnected role="status">
              <Unplug className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-muted-foreground">Agent disconnected</span>
              <Button className="h-6 gap-1 px-2 text-[12px]" onClick={() => void load(session.id)} size="sm" variant="outline">
                <RotateCcw className="size-3" />
                Reconnect
              </Button>
            </div>
          ) : null}
          {state?.plan && state.plan.length > 0 ? (
            <PlanCard entries={state.plan} running={running} startedAt={planTurn?.startedAt ?? null} />
          ) : null}
          <Composer
            autoFocus
            chips={
              <>
                {chips?.leading ?? null}
                {reconnecting ? <Reconnecting /> : null}
              </>
            }
            commands={state?.availableCommands ?? []}
            disabled={!state || state.status === "connecting" || state.status === "closed"}
            onStop={() => reportRefusal(cancel(session.id), "stop the turn", "Could not")}
            onSubmit={onSubmit}
            placeholder={running ? "Send another message — it goes next" : "Do anything"}
            sessionId={session.id}
            status={composerStatus}
            trailing={chips?.trailing ?? null}
          />
        </div>
      </div>
    </div>
  );
}

/** A call main may refuse, said as a toast rather than dropped as an unhandled rejection. */
function reportRefusal(call: Promise<void>, what: string, verb = "Could not change"): void {
  call.catch((error: unknown) => toast.error(`${verb} ${what}: ${errorMessage(error)}`));
}

/**
 * Chips that only mean something with an agent to answer them. Unavailable, they stay where they
 * are, focusable and in the accessibility tree — the kit's `aria-disabled` pattern, not `inert`,
 * which would take them out of both and leave no way to learn why — with the reason as their
 * description, and an attempt to open one says the reason instead of calling main.
 *
 * The chips are `ComposerChips`' triggers, which take no disabled state of their own, so the
 * attributes are put on their buttons from here and activation is stopped in the capture phase,
 * ahead of the menu's own pointer and key handlers.
 */
function LiveOnly({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  const reasonId = useId();
  const box = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    for (const button of box.current?.querySelectorAll("button") ?? []) {
      if (reason) {
        button.setAttribute("aria-disabled", "true");
        button.setAttribute("aria-describedby", reasonId);
      } else if (button.getAttribute("aria-describedby") === reasonId) {
        button.removeAttribute("aria-disabled");
        button.removeAttribute("aria-describedby");
      }
    }
  });
  const refuse = (event: React.SyntheticEvent) => {
    if (!reason) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "click") toast.info(reason);
  };
  return (
    <span
      className={reason ? "flex min-w-0 items-center gap-2 [&_button]:cursor-not-allowed [&_button]:opacity-50" : "contents"}
      onClickCapture={refuse}
      onKeyDownCapture={(event) => {
        if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) refuse(event);
      }}
      onPointerDownCapture={refuse}
      ref={box}
    >
      {children}
      {reason ? <span className="sr-only" id={reasonId}>{reason}</span> : null}
    </span>
  );
}

/**
 * The agent is coming back behind a transcript that is already on screen.
 *
 * Deliberately small and in the composer's row, beside the mode chip: the
 * transcript is readable, the box takes a prompt, and the only thing missing
 * is an adapter — which is a line of text's worth of news, not a screen's.
 */
function Reconnecting() {
  return (
    <span
      className="flex shrink-0 items-center gap-1 px-1 text-[12px] text-muted-foreground"
      data-reconnecting
      role="status"
    >
      <Loader2 className="size-3 animate-spin" />
      Reconnecting…
    </span>
  );
}

function Connecting({ agentName }: { agentName: string }) {
  const reducedMotion = useSettings((state) => state.settings?.reduceMotion ?? false);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center" data-connecting>
      <LoadingIcon size={64} reducedMotion={reducedMotion} />
      <p className="text-[13px] text-muted-foreground">Connecting to {agentName}…</p>
    </div>
  );
}

function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-load-failed>
      <AlertCircle className="size-4 text-destructive" />
      <p className="max-w-[480px] text-[13px] leading-5 whitespace-pre-wrap text-muted-foreground">{message}</p>
      <Button className="h-7 gap-1.5 text-[12px]" onClick={onRetry} size="sm" variant="outline">
        <RotateCcw className="size-3.5" />
        Reconnect
      </Button>
    </div>
  );
}

/** The load failed because the agent's CLI is not installed: install it, then try again. */
function AgentMissing({
  agent,
  agentId,
  message,
  onRetry,
}: {
  agent: AgentStatus | null;
  agentId: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[720px] px-6 py-8" data-agent-missing>
      <AgentSetupCard
        agents={agent ? [agent] : []}
        message={message}
        onRetry={onRetry}
        title={`${agent?.name ?? agentId} is not installed`}
      />
    </div>
  );
}

/** The last prompt the person sent, as blocks Retry can send again. */
export function lastUserPrompt(state: SessionState | null): PromptBlock[] | null {
  const turn = state?.turns.findLast((candidate) => candidate.role === "user");
  if (!turn) {
    return null;
  }
  const blocks: PromptBlock[] = [];
  for (const part of turn.parts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      blocks.push({ type: "image", data: part.data, mimeType: part.mimeType, uri: null });
    } else if (part.type === "resource_link") {
      blocks.push({ type: "resource_link", uri: part.uri, name: part.name, mimeType: null, title: null });
    } else if (part.type === "resource") {
      blocks.push({ type: "resource", uri: part.uri, text: part.text, mimeType: part.mimeType });
    }
  }
  return blocks.length > 0 ? blocks : null;
}

function promptText(blocks: PromptBlock[]): string {
  return blocks
    .filter((block): block is Extract<PromptBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
