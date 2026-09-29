/**
 * The one piece of protocol logic in the app: fold a stream of events into a
 * `SessionState` (plan §5).
 *
 * Pure. No clock (every event carries `at`), no ids drawn from randomness
 * (turn ids the reducer mints are positional), no mutation of the input —
 * the renderer's store relies on fresh references to know what changed, and
 * the tests replay recorded adapter transcripts through it.
 *
 * Rules the adapters made necessary, learned from the recordings under
 * `tests/fixtures/acp/`:
 *
 *   - Text and thought chunks concatenate into the trailing part of the same
 *     kind; a tool call in between starts a new one.
 *   - Tool calls upsert by id. A `tool_call_update` for an id nobody
 *     announced is created rather than dropped: better a row with a blank
 *     title than a permission request pointing at nothing.
 *   - An update whose `sessionId` is a subagent's lands inside that
 *     subagent's part. The Claude adapter's flattened form tags updates with
 *     `_meta.claudeCode.parentToolUseId` instead; those land in the parent
 *     tool call's `children`.
 *   - Session-level facts (mode, config options, commands, usage, title)
 *     always update the state; they only become parts when a turn is open,
 *     because the adapters send most of them right after `session/new`.
 *     Only the root session's count: a subagent's plan lands in its own
 *     part, the rest of what it reports about itself is dropped.
 *   - An update under a session id that is neither the root nor a known
 *     subagent is parked (bounded) until that subagent's spawn arrives,
 *     rather than glued onto the root's reply.
 *   - A tool call id is looked up across every turn: a late update (after a
 *     cancel, a background command) updates the row where it is, and an
 *     update for an unknown id never opens a turn when none is open.
 *   - A cancelled or failed turn settles what was still pending or running
 *     in it; an ordinary end does not (a background command can outlive it).
 */
import {
  type AvailableCommand,
  type ConfigOption,
  type ContextBreakdownEntry,
  type Part,
  type PendingPermission,
  type PermissionOption,
  type PlanEntry,
  type PromptBlock,
  type RateLimit,
  type RawSessionUpdate,
  type SessionEvent,
  type SessionMode,
  type SessionState,
  type SubagentState,
  type TokenTotals,
  type ToolCallPart,
  type ToolCallStatus,
  type ToolContent,
  type ToolKind,
  type ToolLocation,
  type Turn,
  type TurnUsage,
  ToolCallStatusSchema,
  ToolKindSchema,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Entry point                                                                  */
/* -------------------------------------------------------------------------- */

export function reduce(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "session/update":
      return applyUpdate(state, event.acpSessionId, event.update, event.at);

    case "session/connected":
      return {
        ...state,
        acpSessionId: event.acpSessionId,
        status: event.loading ? "connecting" : "idle",
        error: null,
        currentModeId: event.modes?.currentModeId ?? state.currentModeId,
        modes: event.modes?.availableModes ?? state.modes,
        configOptions: event.configOptions ?? state.configOptions,
      };

    case "session/loaded":
      return { ...closeOpenTurn(state, event.at, null), status: "idle" };

    case "prompt/start": {
      const closed = closeOpenTurn(state, event.at, null);
      const userTurn: Turn = {
        id: event.turnId,
        role: "user",
        parts: event.content.map(promptBlockToPart),
        startedAt: event.at,
        endedAt: event.at,
        stopReason: null,
      };
      const agentTurn: Turn = {
        id: `${event.turnId}:agent`,
        role: "agent",
        parts: [],
        startedAt: event.at,
        endedAt: null,
        stopReason: null,
      };
      return {
        ...closed,
        turns: [...closed.turns, userTurn, agentTurn],
        status: "running",
        error: null,
      };
    }

    case "prompt/end": {
      const next = closeOpenTurn(
        state,
        event.at,
        event.stopReason,
        event.stopReason === "cancelled" ? { tool: "cancelled", subagent: "cancelled" } : undefined,
      );
      return {
        ...next,
        status: "idle",
        lastTurnUsage: event.usage ?? next.lastTurnUsage,
        sessionUsage: event.usage ? addTurnUsage(next.sessionUsage, event.usage) : next.sessionUsage,
        // A cancelled turn takes its unanswered permission requests with it.
        pendingPermissions: [],
      };
    }

    case "prompt/error": {
      const withError = withRootParts(state, event.at, (parts) => [
        ...parts,
        { type: "error", message: event.message },
      ]);
      return {
        ...closeOpenTurn(withError, event.at, null, { tool: "failed", subagent: "failed" }),
        status: "error",
        error: event.message,
        pendingPermissions: [],
      };
    }

    case "permission/request": {
      const { request } = event;
      const part: Part = {
        type: "permission_request",
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        title: request.title,
        description: request.description,
        options: request.options,
        outcome: { state: "pending" },
      };
      const next = withSessionParts(state, request.acpSessionId, event.at, (parts) => [
        ...parts,
        part,
      ]);
      return {
        ...next,
        status: "waiting",
        pendingPermissions: [...next.pendingPermissions, request],
      };
    }

    case "permission/resolve": {
      const pendingPermissions = state.pendingPermissions.filter(
        (pending) => pending.requestId !== event.requestId,
      );
      const turns = state.turns.map((turn) => ({
        ...turn,
        parts: mapPartsDeep(turn.parts, (part) =>
          part.type === "permission_request" && part.requestId === event.requestId
            ? { ...part, outcome: event.outcome }
            : part,
        ),
      }));
      return {
        ...state,
        turns,
        pendingPermissions,
        status:
          state.status === "waiting" && pendingPermissions.length === 0
            ? hasOpenAgentTurn(state)
              ? "running"
              : "idle"
            : state.status,
      };
    }

    case "config/updated":
      return { ...state, configOptions: event.configOptions };

    case "status":
      return { ...state, status: event.status, error: event.error };
  }
}

/* -------------------------------------------------------------------------- */
/* session/update                                                               */
/* -------------------------------------------------------------------------- */

function applyUpdate(
  state: SessionState,
  acpSessionId: string,
  update: RawSessionUpdate,
  at: number,
): SessionState {
  const u = update as Record<string, unknown>;
  // Before `session/connected` names the root, every update is the root's.
  const isRoot = state.acpSessionId === null || acpSessionId === state.acpSessionId;
  if (!isRoot && !state.subagentSessionIds.includes(acpSessionId)) {
    return park(state, acpSessionId, update, at);
  }
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      const part = contentBlockToPart(u.content, false, true);
      return part ? appendUserChunk(state, at, part, asString(u.messageId)) : state;
    }

    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const part = contentBlockToPart(u.content, update.sessionUpdate === "agent_thought_chunk");
      if (!part) {
        return state;
      }
      return withUpdateTarget(state, acpSessionId, u, at, (parts) => appendChunk(parts, part));
    }

    case "tool_call":
    case "tool_call_update": {
      const id = asString(u.toolCallId);
      if (!id) {
        return state;
      }
      const turnOpen = state.turns.at(-1)?.endedAt === null;
      // A fresh announcement while a turn is open belongs to that turn, even
      // if an earlier turn used the same id (the fake agent does); anything
      // else is news about a call that already has a row somewhere.
      if (update.sessionUpdate === "tool_call_update" || !turnOpen) {
        const inPlace = updateToolCallAnywhere(state, id, u);
        if (inPlace) {
          return inPlace;
        }
        if (!turnOpen && update.sessionUpdate === "tool_call_update") {
          // A late update for a call nobody announced, with no turn open:
          // opening one would put a blank row in a turn nobody started.
          return state;
        }
      }
      return withUpdateTarget(state, acpSessionId, u, at, (parts) => upsertToolCall(parts, id, u));
    }

    case "plan": {
      const entries = planEntries(u.entries);
      if (!isRoot) {
        return withSessionParts(state, acpSessionId, at, (parts) => setPlan(parts, entries), false);
      }
      const next = { ...state, plan: entries };
      return hasOpenAgentTurn(next)
        ? withSessionParts(next, acpSessionId, at, (parts) => setPlan(parts, entries), false)
        : next;
    }

    case "plan_update": {
      const plan = asRecord(u.plan);
      if (plan?.type !== "items") {
        return state;
      }
      const entries = planEntries(plan.entries);
      if (!isRoot) {
        return withSessionParts(state, acpSessionId, at, (parts) => setPlan(parts, entries), false);
      }
      const next = { ...state, plan: entries };
      return hasOpenAgentTurn(next)
        ? withSessionParts(next, acpSessionId, at, (parts) => setPlan(parts, entries), false)
        : next;
    }

    case "plan_removed":
      return isRoot ? { ...state, plan: null } : state;

    case "available_commands_update": {
      if (!isRoot) {
        return state;
      }
      const commands = availableCommands(u.availableCommands);
      const next = { ...state, availableCommands: commands };
      return hasOpenAgentTurn(next)
        ? withSessionParts(
            next,
            acpSessionId,
            at,
            (parts) => [...parts, { type: "available_commands", commands }],
            false,
          )
        : next;
    }

    case "current_mode_update": {
      if (!isRoot) {
        return state;
      }
      const modeId = asString(u.currentModeId);
      if (!modeId) {
        return state;
      }
      const next = { ...state, currentModeId: modeId };
      return hasOpenAgentTurn(next)
        ? withSessionParts(
            next,
            acpSessionId,
            at,
            (parts) => [...parts, { type: "mode_change", modeId }],
            false,
          )
        : next;
    }

    case "config_option_update":
      return isRoot ? { ...state, configOptions: configOptions(u.configOptions) } : state;

    case "session_info_update": {
      if (!isRoot) {
        return state;
      }
      const title = asString(u.title);
      return title === null ? state : { ...state, title };
    }

    case "usage_update": {
      if (!isRoot) {
        return state;
      }
      // A `usage_update` carries two independent things: the window, and —
      // when the Claude adapter is forwarding a `rate_limit_event` — one of
      // the account's plan limits. Either can be there without the other, so
      // the limit is folded first and a window that did not parse does not
      // throw the limit away with it.
      const limit = rateLimit(u._meta);
      const withLimit = limit
        ? { ...state, rateLimits: { ...state.rateLimits, [limit.type]: limit } }
        : state;
      const used = asNumber(u.used);
      const size = asNumber(u.size);
      if (used === null || size === null) {
        return withLimit;
      }
      const cost = asRecord(u.cost);
      const amount = cost ? asNumber(cost.amount) : null;
      const currency = cost ? asString(cost.currency) : null;
      return {
        ...withLimit,
        contextUsage: {
          used,
          size,
          cost: amount !== null && currency !== null ? { amount, currency } : null,
          breakdown: contextBreakdown(u._meta),
        },
      };
    }

    case "subagent_spawned": {
      const childId = asString(u.subagentSessionId) ?? asString(u.sessionId);
      if (!childId) {
        return state;
      }
      const part: Part = {
        type: "subagent",
        sessionId: childId,
        name: asString(u.name) ?? asString(u.title) ?? asString(u.subagentType) ?? "Subagent",
        task: asString(u.task) ?? asString(u.description) ?? asString(u.prompt),
        state: "running",
      parts: [],
      };
      const next = withSessionParts(state, acpSessionId, at, (parts) =>
        findSubagent(parts, childId) ? parts : [...parts, part],
      );
      return unpark(
        {
          ...next,
          subagentSessionIds: next.subagentSessionIds.includes(childId)
            ? next.subagentSessionIds
            : [...next.subagentSessionIds, childId],
        },
        childId,
      );
    }

    case "subagent_state_update": {
      const childId = asString(u.subagentSessionId) ?? asString(u.sessionId);
      if (!childId) {
        return state;
      }
      const subagentState = toSubagentState(u.state ?? u.status);
      return {
        ...state,
        turns: state.turns.map((turn) => ({
          ...turn,
          parts: mapPartsDeep(turn.parts, (part) =>
            part.type === "subagent" && part.sessionId === childId
              ? { ...part, state: subagentState }
              : part,
          ),
        })),
      };
    }

    default:
      // compaction_update, compaction_summary_chunk, and whatever an adapter
      // invents next: nothing the transcript shows.
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/* Turn plumbing                                                               */
/* -------------------------------------------------------------------------- */

function hasOpenAgentTurn(state: SessionState): boolean {
  const last = state.turns.at(-1);
  return last?.role === "agent" && last.endedAt === null;
}

/** What a turn that was cancelled or failed leaves its unfinished work as. */
type Settle = { tool: ToolCallStatus; subagent: SubagentState };

function closeOpenTurn(
  state: SessionState,
  at: number,
  stopReason: Turn["stopReason"],
  settle?: Settle,
) {
  const last = state.turns.at(-1);
  if (!last || last.endedAt !== null) {
    return state;
  }
  const parts = settle ? settleParts(last.parts, settle) : last.parts;
  const closed: Turn = { ...last, parts, endedAt: at, stopReason };
  return { ...state, turns: [...state.turns.slice(0, -1), closed] };
}

/** Every pending or running call, and every running subagent, in `parts` — however deep. */
function settleParts(parts: Part[], settle: Settle): Part[] {
  return mapPartsDeep(parts, (part) => {
    if (part.type === "tool_call" && (part.status === "pending" || part.status === "in_progress")) {
      return { ...part, status: settle.tool };
    }
    if (part.type === "subagent" && part.state === "running") {
      return { ...part, state: settle.subagent };
    }
    return part;
  });
}

/** How many updates for not-yet-spawned subagents are held; the oldest go first. */
const PARKED_LIMIT = 200;

function park(state: SessionState, acpSessionId: string, update: RawSessionUpdate, at: number): SessionState {
  const parked = [...(state.parked ?? []), { acpSessionId, update, at }];
  return { ...state, parked: parked.length > PARKED_LIMIT ? parked.slice(-PARKED_LIMIT) : parked };
}

/** Fold what was parked for `childId`, in arrival order, now that it has somewhere to go. */
function unpark(state: SessionState, childId: string): SessionState {
  const all = state.parked ?? [];
  const mine = all.filter((entry) => entry.acpSessionId === childId);
  if (mine.length === 0) {
    return state;
  }
  const rest = all.filter((entry) => entry.acpSessionId !== childId);
  const { parked: _dropped, ...withoutParked } = state;
  let next: SessionState = rest.length > 0 ? { ...withoutParked, parked: rest } : withoutParked;
  for (const entry of mine) {
    next = applyUpdate(next, entry.acpSessionId, entry.update, entry.at);
  }
  return next;
}

/**
 * Apply `fn` to the open agent turn's parts, opening a turn if there is none
 * (a replayed history has no `prompt/start`). When `create` is false and no
 * agent turn is open, the state comes back unchanged.
 */
function withRootParts(
  state: SessionState,
  at: number,
  fn: (parts: Part[]) => Part[],
  create = true,
): SessionState {
  const last = state.turns.at(-1);
  if (last?.role === "agent" && last.endedAt === null) {
    const updated: Turn = { ...last, parts: fn(last.parts) };
    return { ...state, turns: [...state.turns.slice(0, -1), updated] };
  }
  if (!create) {
    return state;
  }
  const closed = closeOpenTurn(state, at, null);
  const turn: Turn = {
    id: `t${closed.turns.length + 1}`,
    role: "agent",
    parts: fn([]),
    startedAt: at,
    endedAt: null,
    stopReason: null,
  };
  return { ...closed, turns: [...closed.turns, turn] };
}

/** Route by ACP session id: the root's open turn, or a subagent's parts. */
function withSessionParts(
  state: SessionState,
  acpSessionId: string,
  at: number,
  fn: (parts: Part[]) => Part[],
  create = true,
): SessionState {
  if (acpSessionId !== state.acpSessionId && state.subagentSessionIds.includes(acpSessionId)) {
    let found = false;
    const turns = state.turns.map((turn) => {
      const parts = mapPartsDeep(turn.parts, (part) => {
        if (part.type === "subagent" && part.sessionId === acpSessionId) {
          found = true;
          return { ...part, parts: fn(part.parts) };
        }
        return part;
      });
      return parts === turn.parts ? turn : { ...turn, parts };
    });
    if (found) {
      return { ...state, turns };
    }
  }
  return withRootParts(state, at, fn, create);
}

/** Route by session id, then by the Claude adapter's parent-tool tag. */
function withUpdateTarget(
  state: SessionState,
  acpSessionId: string,
  update: Record<string, unknown>,
  at: number,
  fn: (parts: Part[]) => Part[],
): SessionState {
  const parentId = claudeParentToolUseId(update);
  if (!parentId) {
    return withSessionParts(state, acpSessionId, at, fn);
  }
  let found = false;
  const turns = state.turns.map((turn) => {
    const parts = mapPartsDeep(turn.parts, (part) => {
      if (part.type === "tool_call" && part.id === parentId) {
        found = true;
        return { ...part, children: fn(part.children) };
      }
      return part;
    });
    return parts === turn.parts ? turn : { ...turn, parts };
  });
  return found ? { ...state, turns } : withSessionParts(state, acpSessionId, at, fn);
}

function claudeParentToolUseId(update: Record<string, unknown>): string | null {
  const meta = asRecord(update._meta);
  const claude = meta ? asRecord(meta.claudeCode) : null;
  return claude ? asString(claude.parentToolUseId) : null;
}

/**
 * A replayed user message. Chunks carrying the same ACP `messageId` are one
 * message and concatenate; a different id is the next message and starts its
 * own turn. Without ids there is no telling one streamed block from the next
 * prompt, so each chunk stays its own part (the bubble joins them with a
 * line break) rather than running two prompts together.
 */
function appendUserChunk(
  state: SessionState,
  at: number,
  part: Part,
  messageId: string | null,
): SessionState {
  const last = state.turns.at(-1);
  const sameMessage =
    last?.role === "user" &&
    last.endedAt === null &&
    (messageId === null || last.messageId === undefined || last.messageId === messageId);
  if (last && sameMessage) {
    const parts = messageId !== null && last.messageId === messageId ? appendChunk(last.parts, part) : [...last.parts, part];
    const updated: Turn = { ...last, parts };
    return { ...state, turns: [...state.turns.slice(0, -1), updated] };
  }
  const closed = closeOpenTurn(state, at, null);
  const turn: Turn = {
    id: `t${closed.turns.length + 1}`,
    role: "user",
    parts: [part],
    startedAt: at,
    endedAt: null,
    stopReason: null,
    ...(messageId !== null ? { messageId } : {}),
  };
  return { ...closed, turns: [...closed.turns, turn] };
}

/* -------------------------------------------------------------------------- */
/* Part-level operations                                                       */
/* -------------------------------------------------------------------------- */

/** Text onto trailing text, thought onto trailing thought; anything else appends. */
function appendChunk(parts: Part[], part: Part): Part[] {
  const last = parts.at(-1);
  if (
    last &&
    (part.type === "text" || part.type === "thought") &&
    last.type === part.type
  ) {
    return [...parts.slice(0, -1), { ...last, text: last.text + part.text }];
  }
  return [...parts, part];
}

function setPlan(parts: Part[], entries: PlanEntry[]): Part[] {
  const index = parts.findLastIndex((part) => part.type === "plan");
  if (index === -1) {
    return [...parts, { type: "plan", entries }];
  }
  return parts.map((part, i) => (i === index ? { type: "plan", entries } : part));
}

function upsertToolCall(parts: Part[], id: string, update: Record<string, unknown>): Part[] {
  let found = false;
  const next = mapPartsDeep(parts, (part) => {
    if (part.type === "tool_call" && part.id === id) {
      found = true;
      return mergeToolCall(part, update);
    }
    return part;
  });
  return found ? next : [...parts, mergeToolCall(blankToolCall(id), update)];
}

/**
 * Merge `update` into the call with this id wherever it is — the newest turn
 * that has one, since an id can come back in a later turn; null when no
 * turn does.
 */
function updateToolCallAnywhere(
  state: SessionState,
  id: string,
  update: Record<string, unknown>,
): SessionState | null {
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const turn = state.turns[index]!;
    let found = false;
    const parts = mapPartsDeep(turn.parts, (part) => {
      if (!found && part.type === "tool_call" && part.id === id) {
        found = true;
        return mergeToolCall(part, update);
      }
      return part;
    });
    if (found) {
      return { ...state, turns: state.turns.map((candidate, i) => (i === index ? { ...turn, parts } : candidate)) };
    }
  }
  return null;
}

function blankToolCall(id: string): ToolCallPart {
  return {
    type: "tool_call",
    id,
    kind: "other",
    title: "",
    name: null,
    status: "pending",
    input: undefined,
    output: undefined,
    content: [],
    locations: [],
    stream: "",
    children: [],
  };
}

/** Fields the update carries replace; fields it omits (or nulls) survive. */
function mergeToolCall(part: ToolCallPart, update: Record<string, unknown>): ToolCallPart {
  const kind = toolKind(update.kind);
  const status = toolStatus(update.status);
  const title = asString(update.title);
  const name = asString(update.name);
  const content = Array.isArray(update.content) ? toolContents(update.content) : null;
  const locations = Array.isArray(update.locations) ? toolLocations(update.locations) : null;
  const delta = streamedOutput(update);
  const joined = delta === null ? part.stream : part.stream + delta;
  const truncated = joined.length > STREAM_TAIL;
  // A call its turn settled as cancelled stays so unless the agent says it finished.
  const settled = part.status === "cancelled" && (status === "pending" || status === "in_progress");
  return {
    ...part,
    kind: kind ?? part.kind,
    status: settled ? part.status : (status ?? part.status),
    title: title ?? part.title ?? name ?? part.name ?? "",
    name: name ?? part.name,
    input: update.rawInput !== undefined ? update.rawInput : part.input,
    output: update.rawOutput !== undefined ? update.rawOutput : part.output,
    content: content ?? part.content,
    locations: locations ?? part.locations,
    stream: truncated ? joined.slice(-STREAM_TAIL) : joined,
    ...(truncated ? { streamTruncated: true } : {}),
  };
}

/** How much of a call's streamed output is kept: the tail, like the terminal's. */
const STREAM_TAIL = 64 * 1024;

/** Codex streams a command's output as `_meta.terminal_output_delta.data` on each update. */
function streamedOutput(update: Record<string, unknown>): string | null {
  const meta = asRecord(update._meta);
  const delta = meta ? asRecord(meta.terminal_output_delta) : null;
  return delta ? asString(delta.data) : null;
}

/** Rebuild a parts tree with `fn` applied to every node, preserving identity where nothing changed. */
function mapPartsDeep(parts: Part[], fn: (part: Part) => Part): Part[] {
  let changed = false;
  const next = parts.map((part) => {
    let inner = part;
    if (part.type === "tool_call" && part.children.length > 0) {
      const children = mapPartsDeep(part.children, fn);
      if (children !== part.children) {
        inner = { ...part, children };
      }
    } else if (part.type === "subagent" && part.parts.length > 0) {
      const nested = mapPartsDeep(part.parts, fn);
      if (nested !== part.parts) {
        inner = { ...part, parts: nested };
      }
    }
    const mapped = fn(inner);
    if (mapped !== part) {
      changed = true;
    }
    return mapped;
  });
  return changed ? next : parts;
}

function findSubagent(parts: Part[], sessionId: string): boolean {
  return parts.some(
    (part) =>
      (part.type === "subagent" && (part.sessionId === sessionId || findSubagent(part.parts, sessionId))) ||
      (part.type === "tool_call" && findSubagent(part.children, sessionId)),
  );
}

/* -------------------------------------------------------------------------- */
/* Conversions from the wire                                                   */
/* -------------------------------------------------------------------------- */

function promptBlockToPart(block: PromptBlock): Part {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", data: block.data, mimeType: block.mimeType };
    case "resource_link":
      return { type: "resource_link", uri: block.uri, name: block.name };
    case "resource":
      return { type: "resource", uri: block.uri, name: nameOfUri(block.uri), text: block.text, mimeType: block.mimeType };
  }
}

/** `attachment:///notes%20v2.md` → `notes v2.md`. */
function nameOfUri(uri: string): string {
  const last = uri.split(/[\\/]/).pop() || uri;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** `user`: an embedded resource is the person's attachment, kept whole; an agent's reads as text. */
function contentBlockToPart(raw: unknown, thought = false, user = false): Part | null {
  const block = asRecord(raw);
  if (!block) {
    return null;
  }
  switch (block.type) {
    case "text": {
      const text = asString(block.text);
      return text === null ? null : { type: thought ? "thought" : "text", text };
    }
    case "image": {
      const data = asString(block.data);
      const mimeType = asString(block.mimeType);
      return data !== null && mimeType !== null ? { type: "image", data, mimeType } : null;
    }
    case "resource_link": {
      const uri = asString(block.uri);
      return uri === null ? null : { type: "resource_link", uri, name: asString(block.name) ?? uri };
    }
    case "resource": {
      const resource = asRecord(block.resource);
      const text = resource ? asString(resource.text) : null;
      if (text === null) {
        return null;
      }
      const uri = resource ? asString(resource.uri) : null;
      if (user && uri !== null) {
        return { type: "resource", uri, name: nameOfUri(uri), text, mimeType: asString(resource?.mimeType) };
      }
      return { type: thought ? "thought" : "text", text };
    }
    default:
      return null;
  }
}

function toolContents(raw: unknown[]): ToolContent[] {
  const out: ToolContent[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) {
      continue;
    }
    switch (entry.type) {
      case "content": {
        const block = asRecord(entry.content);
        if (!block) {
          break;
        }
        if (block.type === "text") {
          const text = asString(block.text);
          if (text !== null) {
            out.push({ type: "text", text });
          }
        } else if (block.type === "image") {
          const data = asString(block.data);
          const mimeType = asString(block.mimeType);
          if (data !== null && mimeType !== null) {
            out.push({ type: "image", data, mimeType });
          }
        } else if (block.type === "resource_link") {
          const uri = asString(block.uri);
          if (uri !== null) {
            out.push({
              type: "resource_link",
              uri,
              name: asString(block.name) ?? uri,
              mimeType: asString(block.mimeType),
            });
          }
        } else if (block.type === "resource") {
          const resource = asRecord(block.resource);
          const text = resource ? asString(resource.text) : null;
          if (text !== null) {
            out.push({ type: "text", text });
          }
        }
        break;
      }
      case "diff": {
        const path = asString(entry.path);
        const newText = asString(entry.newText);
        if (path !== null && newText !== null) {
          out.push({ type: "diff", path, oldText: asString(entry.oldText), newText });
        }
        break;
      }
      case "terminal": {
        const terminalId = asString(entry.terminalId);
        if (terminalId !== null) {
          out.push({ type: "terminal", terminalId });
        }
        break;
      }
    }
  }
  return out;
}

function toolLocations(raw: unknown[]): ToolLocation[] {
  const out: ToolLocation[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const path = entry ? asString(entry.path) : null;
    if (entry && path !== null) {
      out.push({ path, line: asNumber(entry.line) });
    }
  }
  return out;
}

function toolKind(raw: unknown): ToolKind | null {
  const parsed = ToolKindSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function toolStatus(raw: unknown): ToolCallStatus | null {
  const parsed = ToolCallStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function planEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PlanEntry[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const content = entry ? asString(entry.content) : null;
    if (!entry || content === null) {
      continue;
    }
    const priority = entry.priority;
    const status = entry.status;
    out.push({
      content,
      priority: priority === "high" || priority === "low" ? priority : "medium",
      status: status === "in_progress" || status === "completed" ? status : "pending",
    });
  }
  return out;
}

function availableCommands(raw: unknown): AvailableCommand[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AvailableCommand[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const name = entry ? asString(entry.name) : null;
    if (!entry || name === null) {
      continue;
    }
    const input = asRecord(entry.input);
    out.push({
      name,
      description: asString(entry.description) ?? "",
      hint: input ? asString(input.hint) : null,
    });
  }
  return out;
}

/** Normalise the wire form of modes; exported for `session/new` responses. */
/** `_meta.kind`, which is where both adapters say what a mode or preset *is*. */
function metaKind(entry: Record<string, unknown>): string | null {
  const meta = asRecord(entry._meta);
  return meta ? asString(meta.kind) : null;
}

export function sessionModes(raw: unknown): SessionMode[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SessionMode[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const id = entry ? asString(entry.id) : null;
    if (!entry || id === null) {
      continue;
    }
    out.push({
      id,
      name: asString(entry.name) ?? id,
      description: asString(entry.description),
      kind: metaKind(entry),
    });
  }
  return out;
}

/** Normalise the wire form of config options; grouped selects are flattened. */
export function configOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ConfigOption[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const id = entry ? asString(entry.id) : null;
    if (!entry || id === null) {
      continue;
    }
    const base = {
      id,
      name: asString(entry.name) ?? id,
      description: asString(entry.description),
      category: asString(entry.category),
    };
    if (entry.type === "boolean") {
      out.push({ ...base, type: "boolean", currentValue: entry.currentValue === true });
      continue;
    }
    if (entry.type !== "select") {
      continue;
    }
    const options: Extract<ConfigOption, { type: "select" }>["options"] = [];
    for (const optionRaw of Array.isArray(entry.options) ? entry.options : []) {
      const option = asRecord(optionRaw);
      if (!option) {
        continue;
      }
      if (Array.isArray(option.options)) {
        const group = asString(option.name) ?? asString(option.group);
        for (const grouped of option.options) {
          const inner = asRecord(grouped);
          const value = inner ? asString(inner.value) : null;
          if (inner && value !== null) {
            options.push({
              value,
              name: asString(inner.name) ?? value,
              description: asString(inner.description),
              group,
              kind: metaKind(inner),
            });
          }
        }
      } else {
        const value = asString(option.value);
        if (value !== null) {
          options.push({
            value,
            name: asString(option.name) ?? value,
            description: asString(option.description),
            group: null,
            kind: metaKind(option),
          });
        }
      }
    }
    out.push({
      ...base,
      type: "select",
      currentValue: asString(entry.currentValue) ?? "",
      options,
    });
  }
  return out;
}

/** Normalise permission options, lifting the adapters' `_meta.permission.description`. */
export function permissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PermissionOption[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const optionId = entry ? asString(entry.optionId) : null;
    if (!entry || optionId === null) {
      continue;
    }
    const kind = entry.kind;
    const meta = asRecord(entry._meta);
    const permission = meta ? asRecord(meta.permission) : null;
    out.push({
      optionId,
      name: asString(entry.name) ?? optionId,
      kind:
        kind === "allow_once" || kind === "allow_always" || kind === "reject_always"
          ? kind
          : "reject_once",
      description: permission ? asString(permission.description) : null,
    });
  }
  return out;
}

/** Build the pending-permission record from a raw `session/request_permission`. */
export function pendingPermissionFromRequest(
  requestId: string,
  raw: unknown,
): PendingPermission | null {
  const request = asRecord(raw);
  const toolCall = request ? asRecord(request.toolCall) : null;
  const acpSessionId = request ? asString(request.sessionId) : null;
  const toolCallId = toolCall ? asString(toolCall.toolCallId) : null;
  if (!request || !toolCall || acpSessionId === null || toolCallId === null) {
    return null;
  }
  const meta = asRecord(request._meta);
  const permission = meta ? asRecord(meta.permission) : null;
  return {
    requestId,
    acpSessionId,
    toolCallId,
    title: (permission ? asString(permission.title) : null) ?? asString(toolCall.title),
    description: permission ? asString(permission.description) : null,
    kind: toolKind(toolCall.kind),
    input: toolCall.rawInput,
    options: permissionOptions(request.options),
  };
}

function toSubagentState(raw: unknown): SubagentState {
  switch (raw) {
    case "completed":
    case "failed":
    case "cancelled":
    case "disconnected":
    case "running":
      return raw;
    case "success":
    case "done":
      return "completed";
    case "error":
      return "failed";
    default:
      return "running";
  }
}

/* -------------------------------------------------------------------------- */
/* Loose readers                                                               */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* -------------------------------------------------------------------------- */
/* Token accounting                                                            */
/* -------------------------------------------------------------------------- */

/** Add one turn's `usage` to the session's running totals. */
function addTurnUsage(totals: TokenTotals | null, usage: TurnUsage): TokenTotals {
  const base = totals ?? {
    turns: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  };
  return {
    turns: base.turns + 1,
    totalTokens: base.totalTokens + usage.totalTokens,
    inputTokens: base.inputTokens + usage.inputTokens,
    outputTokens: base.outputTokens + usage.outputTokens,
    cachedReadTokens: base.cachedReadTokens + (usage.cachedReadTokens ?? 0),
    cachedWriteTokens: base.cachedWriteTokens + (usage.cachedWriteTokens ?? 0),
  };
}

/**
 * The category breakdown of a `usage_update`, out of its `_meta`.
 *
 * ACP has no field for one and neither adapter sends one today, so this
 * reads an extension: any `_meta` key whose name ends in `breakdown` — bare,
 * `contextBreakdown`, or namespaced the way the Claude adapter namespaces its
 * own (`_claude/contextBreakdown`) — holding either a list of
 * `{ id, name, tokens }` or a plain `name: tokens` map. Anything else, and
 * anything that adds up to nothing, reads as no breakdown at all: the popover
 * then shows the window and the token counts and says nothing about
 * categories, which is the honest answer when the agent did not say.
 */
function contextBreakdown(meta: unknown): ContextBreakdownEntry[] | null {
  const record = asRecord(meta);
  if (!record) {
    return null;
  }
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase().endsWith("breakdown"));
  if (key === undefined) {
    return null;
  }
  const raw = record[key];
  const entries: ContextBreakdownEntry[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const fields = asRecord(item);
      if (!fields) {
        continue;
      }
      const tokens = asNumber(fields.tokens) ?? asNumber(fields.used) ?? asNumber(fields.value);
      const name = asString(fields.name) ?? asString(fields.label) ?? asString(fields.title);
      const id = asString(fields.id) ?? name;
      if (tokens === null || tokens <= 0 || id === null) {
        continue;
      }
      entries.push({ id, name: name ?? id, tokens });
    }
  } else {
    const fields = asRecord(raw);
    if (!fields) {
      return null;
    }
    for (const [id, value] of Object.entries(fields)) {
      const tokens = asNumber(value);
      if (tokens === null || tokens <= 0) {
        continue;
      }
      entries.push({ id, name: id, tokens });
    }
  }
  return entries.length > 0 ? entries : null;
}

/**
 * One plan limit out of a `usage_update`'s `_meta`.
 *
 * The Claude adapter forwards the SDK's `rate_limit_event` verbatim under
 * `_claude/rateLimit`; the key is matched loosely (any `_meta` key ending in
 * `ratelimit`) for the same reason the breakdown is, and every field is read
 * defensively — an event this build does not understand is ignored, never
 * thrown on. Two units are normalised here so nothing downstream has to
 * guess:
 *
 *   - `utilization` becomes a fraction of the limit. The SDK sends 0…1; a
 *     value above 1 is read as a percentage, because the only other thing a
 *     number like `63` can mean is 63%.
 *   - `resetsAt` becomes epoch **milliseconds**. The SDK sends epoch
 *     seconds, so anything past the year 2001 in milliseconds (`> 1e12`) is
 *     already milliseconds and is left alone.
 *
 * A limit with no `rateLimitType` is dropped: `rateLimits` is keyed by type,
 * and an unnamed limit has nowhere to go and nothing to be labelled with.
 */
function rateLimit(meta: unknown): RateLimit | null {
  const record = asRecord(meta);
  if (!record) {
    return null;
  }
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase().endsWith("ratelimit"));
  if (key === undefined) {
    return null;
  }
  const fields = asRecord(record[key]);
  if (!fields) {
    return null;
  }
  const type = asString(fields.rateLimitType);
  const raw = asNumber(fields.utilization);
  if (type === null || type === "" || raw === null) {
    return null;
  }
  const fraction = raw > 1 ? raw / 100 : raw;
  const resets = asNumber(fields.resetsAt);
  const status = asString(fields.status);
  return {
    type,
    status: status === "allowed_warning" || status === "rejected" ? status : "allowed",
    utilization: Math.max(0, Math.min(1, fraction)),
    resetsAt: resets === null || resets <= 0 ? null : resets > 1e12 ? resets : resets * 1000,
    isUsingOverage: typeof fields.isUsingOverage === "boolean" ? fields.isUsingOverage : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Derived views                                                               */
/* -------------------------------------------------------------------------- */

/** Every tool call in the transcript, in order, nested ones included. */
export function allToolCalls(state: SessionState): ToolCallPart[] {
  const out: ToolCallPart[] = [];
  const walk = (parts: Part[]) => {
    for (const part of parts) {
      if (part.type === "tool_call") {
        out.push(part);
        walk(part.children);
      } else if (part.type === "subagent") {
        walk(part.parts);
      }
    }
  };
  for (const turn of state.turns) {
    walk(turn.parts);
  }
  return out;
}

/** The trailing agent text of the last turn — what a harness prints as the reply. */
export function lastAgentText(state: SessionState): string {
  const turn = state.turns.findLast((candidate) => candidate.role === "agent");
  if (!turn) {
    return "";
  }
  return turn.parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}
