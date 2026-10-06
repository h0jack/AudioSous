import type { ProjectDocument } from "@audiosous/project-model";
import { AGENT_LIMITS, type AgentCard, type AgentDecision, type AgentSession, type TranscriptEntry, type UiFocus } from "./contract";
import { buildContext } from "./context";
import type { AgentEnvironment } from "./environment";
import { checkGrounding } from "./grounding";
import { isQuestion, readApproval, readConstraints, readDirectEdits, readStatedFactors, type ApprovalContext } from "./language";
import { ProviderError, type AgentContent, type AgentMessage, type AgentModel } from "./model";
import { SYSTEM_PROMPT } from "./prompt";
import { findMentions, referenceContext, resolveSection, resolveTrack } from "./references";
import { Superseded, TOOLS, applyCurrent, clarifySchema, respondSchema, toolSpecs, type ToolContext, type TurnState } from "./tools";

/**
 * The orchestrator. One request is: deterministic reading of the message (references, constraints, approval,
 * explicit values) → compact context → model ⇄ tools, bounded → a validated final reply → grounding check →
 * session update. The model only ever returns decisions; every decision is validated against the allowlist and its
 * schema before anything runs, and writes need the person's approval in this message.
 */

export interface TurnOptions {
  model: AgentModel;
  env: AgentEnvironment;
  session: AgentSession;
  message: string;
  /** False once a newer message or Cancel replaced this request. Old results never reach the session. */
  isCurrent: () => boolean;
  signal?: AbortSignal;
}

export type TurnOutcome =
  | { status: "done"; session: AgentSession; reply: TranscriptEntry; focus: UiFocus | null; toolCalls: number; modelCalls: number }
  | { status: "superseded" };

let counter = 0;
function entryId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** A working copy the tools may change. Discarded if the request is superseded. */
function draftOf(session: AgentSession): AgentSession {
  return {
    ...session,
    transcript: [...session.transcript],
    summary: [...session.summary],
    focus: { ...session.focus, trackIds: [...session.focus.trackIds] },
    standing: { ...session.standing },
    candidates: session.candidates.map((entry) => ({ ...entry })),
  };
}

function approvalContext(session: AgentSession, env: AgentEnvironment): ApprovalContext {
  const entry = session.candidates.find((item) => item.id === session.currentCandidateId) ?? null;
  const shown = env.candidate();
  const plan = entry ? (shown && shown.createdAt === entry.plan.createdAt && shown.stateIdentity === entry.plan.stateIdentity ? shown : entry.plan) : null;
  const ready = Boolean(plan && !env.candidateStale(plan) && plan.changes.some((change) => change.status === "proposed" || change.status === "accepted"));
  const last = [...session.transcript].reverse().find((item) => item.role === "assistant");
  return {
    candidateReady: ready,
    candidatePresented: Boolean(entry && last?.cards?.some((card) => card.kind === "candidate" && card.candidateId === entry.id)),
    offeredToBuild: Boolean(last && /\b(i can|shall i|want me to|should i|i could) (build|make|create|try|put together|plan)\b/i.test(last.text)),
    canUndoApply: Boolean(session.lastApply && session.lastApply.documentRef === env.document()),
  };
}

/** Standing constraints follow what the person says: "don't touch the vocal" lasts, "you can touch the vocal now" releases it. */
function updateStanding(session: AgentSession, reading: ReturnType<typeof readConstraints>): void {
  const standing = session.standing;
  standing.protectedTrackIds = [...new Set([...standing.protectedTrackIds, ...reading.protectedTrackIds])].filter((id) => !reading.releasedTrackIds.includes(id));
  standing.excludedDomains = [...new Set([...standing.excludedDomains, ...reading.excludedDomains])].filter((domain) => !reading.releasedDomains.includes(domain));
  standing.excludedProcessors = [...new Set([...standing.excludedProcessors, ...reading.excludedProcessors])];
  if (reading.standingStrength) standing.strength = reading.strength;
}

function resolveFocus(document: ProjectDocument, focus: UiFocus | undefined, turn: TurnState, session: AgentSession, candidateIds: { problems: string[]; changes: string[] }): UiFocus | null {
  const merged: UiFocus = { ...(turn.focus ?? {}) };
  if (focus?.trackIds?.length) {
    const ids: string[] = [];
    for (const ref of focus.trackIds) {
      const resolved = resolveTrack(document, ref, turn.refs);
      if (resolved.kind === "match") ids.push(...resolved.trackIds);
    }
    if (ids.length) merged.trackIds = [...new Set(ids)].slice(0, 4);
  }
  if (focus?.sectionId) {
    const resolved = resolveSection(document, focus.sectionId, turn.refs);
    if (resolved.kind === "match" && resolved.sectionIds.length === 1) merged.sectionId = resolved.sectionIds[0]!;
  }
  if (focus?.problemId && candidateIds.problems.includes(focus.problemId)) merged.problemId = focus.problemId;
  if (focus?.changeId && candidateIds.changes.includes(focus.changeId)) merged.changeId = focus.changeId;
  if (focus?.tab) merged.tab = focus.tab;
  if (merged.problemId && !candidateIds.problems.includes(merged.problemId)) delete merged.problemId;
  if (merged.changeId && !candidateIds.changes.includes(merged.changeId)) delete merged.changeId;
  if (Object.keys(merged).length === 0) return null;
  session.focus = {
    trackIds: merged.trackIds ?? session.focus.trackIds,
    sectionId: merged.sectionId ?? session.focus.sectionId,
    problemId: merged.problemId ?? session.focus.problemId,
    changeId: merged.changeId ?? session.focus.changeId,
  };
  return merged;
}

/** A reply built from what the tools actually returned, used when the model cannot produce a grounded one. */
function fallbackReply(turn: TurnState, reason: string): string {
  const lines: string[] = [];
  for (const write of turn.writes) lines.push(`${write.kind === "undo" ? "Undone" : "Done"}: ${write.lines.join("; ")}.`);
  const candidate = turn.cards.find((card): card is Extract<AgentCard, { kind: "candidate" }> => card.kind === "candidate");
  if (candidate) lines.push(`${candidate.label} is ready to preview: ${candidate.changes.length ? candidate.changes.join("; ") : "no change"}.`);
  if (lines.length === 0) lines.push(`I couldn't put together an answer I can back with measurements (${reason}). Nothing was changed.`);
  return lines.join(" ");
}

export async function runAgentTurn(options: TurnOptions): Promise<TurnOutcome> {
  const { model, env, message } = options;
  const draft = draftOf(options.session);
  const document = env.document();
  const refs = referenceContext(document, draft.focus);
  const approval = readApproval(message, approvalContext(draft, env));
  const constraints = readConstraints(document, message, refs);
  const edits = readDirectEdits(document, message, refs);
  const statedFactors = readStatedFactors(message);
  const mentions = findMentions(document, message, refs);
  updateStanding(draft, constraints);
  const started = Date.now();
  env.log("agent.request", { provider: model.info.provider, model: model.info.model, chars: message.length, question: isQuestion(message), approvesApply: approval.apply, asksUndo: approval.undo, candidates: draft.candidates.length });

  const currentEntry = draft.candidates.find((entry) => entry.id === draft.currentCandidateId) ?? null;
  const shown = env.candidate();
  const live = currentEntry ? (shown && shown.createdAt === currentEntry.plan.createdAt && shown.stateIdentity === currentEntry.plan.stateIdentity ? shown : currentEntry.plan) : null;
  const context = buildContext({
    document,
    session: draft,
    message,
    mentions,
    constraints,
    approval,
    directEdits: edits.edits,
    statedFactors,
    candidate: live,
    candidateStale: live ? env.candidateStale(live) : null,
  });
  const turn: TurnState = {
    message,
    approval,
    constraints,
    directEdits: edits.edits,
    statedFactors,
    refs,
    isCurrent: options.isCurrent,
    facts: [context.text],
    cards: [],
    focus: null,
    writes: [],
    actions: [],
    inputs: null,
    reading: null,
  };
  const activity: string[] = [];
  // The environment with activity recorded for the transcript. Every other member is the environment's own, bound
  // to it, so a class-based environment keeps its state.
  const record = (label: string) => {
    if (!options.isCurrent() || !label) return;
    if (activity.at(-1) !== label) activity.push(label);
    env.activity(label);
  };
  const tracked = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "activity") return record;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const ctx: ToolContext = { env: tracked, session: draft, turn };

  const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: context.text }] }];
  const specs = toolSpecs();
  let modelCalls = 0;
  let toolCalls = 0;
  let groundingRetried = false;
  let final: Extract<AgentDecision, { type: "answer" | "clarify" }> | null = null;
  let failure: string | null = null;

  try {
    while (modelCalls < AGENT_LIMITS.maxModelCalls) {
      modelCalls += 1;
      ctx.env.activity(modelCalls === 1 ? "Reading the request…" : "Thinking…");
      const response = await model.complete({ system: SYSTEM_PROMPT, messages, tools: specs, maxTokens: 8000, ...(options.signal ? { signal: options.signal } : {}) });
      if (!options.isCurrent()) return { status: "superseded" };
      if (response.stop === "refusal") {
        failure = "The model declined this request.";
        break;
      }
      messages.push({ role: "assistant", content: response.content, ...(response.providerData !== undefined ? { providerData: response.providerData } : {}) });
      const calls = response.content.filter((item): item is Extract<AgentContent, { type: "tool-call" }> => item.type === "tool-call");
      const text = response.content
        .filter((item): item is Extract<AgentContent, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (calls.length === 0) {
        // A plain-text reply is accepted as an answer, with the same grounding check.
        if (!text) {
          failure = response.stop === "max-tokens" ? "The reply was cut off." : "The model returned nothing.";
          break;
        }
        const decision: AgentDecision = { type: "answer", message: text, focus: null, confidence: null };
        const verdict = groundOrRetry(decision.message);
        if (verdict === "retry") continue;
        final = verdict === "ok" ? decision : { ...decision, message: fallbackReply(turn, "unsupported values") };
        break;
      }
      const results: AgentContent[] = [];
      const finals = calls.filter((call) => call.name === "respond" || call.name === "ask_clarification");
      const work = calls.filter((call) => !finals.includes(call));
      for (const call of work) {
        toolCalls += 1;
        results.push(await execute(call, toolCalls > AGENT_LIMITS.maxToolCalls));
        if (!options.isCurrent()) return { status: "superseded" };
      }
      for (const call of finals) {
        if (work.length > 0) {
          results.push({ type: "tool-result", callId: call.callId, isError: true, content: "Not ended: call respond (or ask_clarification) alone, after reading these tool results." });
          continue;
        }
        if (call.name === "ask_clarification") {
          const parsed = clarifySchema.safeParse(call.arguments);
          if (!parsed.success) {
            results.push({ type: "tool-result", callId: call.callId, isError: true, content: `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` });
            continue;
          }
          final = { type: "clarify", question: parsed.data.question, options: parsed.data.options };
          break;
        }
        const parsed = respondSchema.safeParse(call.arguments);
        if (!parsed.success) {
          results.push({ type: "tool-result", callId: call.callId, isError: true, content: `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` });
          continue;
        }
        const verdict = groundOrRetry(parsed.data.message, call.callId, results);
        if (verdict === "retry") continue;
        final = { type: "answer", message: verdict === "ok" ? parsed.data.message : fallbackReply(turn, "unsupported values or claims"), focus: parsed.data.focus ?? null, confidence: parsed.data.confidence ?? null };
        break;
      }
      if (final) break;
      messages.push({ role: "user", content: results });
    }
  } catch (caught) {
    if (caught instanceof Superseded || !options.isCurrent()) return { status: "superseded" };
    if (caught instanceof ProviderError && caught.kind === "cancelled") return { status: "superseded" };
    failure = caught instanceof ProviderError ? caught.message : caught instanceof Error ? `Something went wrong: ${caught.message}` : "Something went wrong.";
    env.log("agent.error", { kind: caught instanceof ProviderError ? caught.kind : "internal", modelCalls, toolCalls });
  }
  if (!options.isCurrent()) return { status: "superseded" };

  if (!final) {
    const reason = failure ?? `I stopped after ${modelCalls} steps without a final answer.`;
    final = { type: "answer", message: turn.writes.length > 0 || turn.cards.length > 0 ? `${fallbackReply(turn, reason)}${failure ? ` (${failure})` : ""}` : `${reason} The saved mix was not changed${turn.writes.length ? " apart from what is listed" : ""}.`, focus: null, confidence: null };
  }

  const candidateIds = (() => {
    const entry = draft.candidates.find((item) => item.id === draft.currentCandidateId);
    const plan = entry ? (env.candidate() ?? entry.plan) : null;
    return { problems: plan?.problems.map((problem) => problem.id) ?? [], changes: plan?.changes.map((change) => change.id) ?? [] };
  })();
  const focus = resolveFocus(env.document(), final.type === "answer" ? (final.focus ?? undefined) : undefined, turn, draft, candidateIds);
  const now = env.now();
  const userEntry: TranscriptEntry = { id: entryId("u"), role: "user", text: message, at: now };
  const reply: TranscriptEntry = {
    id: entryId("a"),
    role: "assistant",
    text: final.type === "answer" ? final.message : final.question,
    ...(activity.length ? { activity } : {}),
    ...(turn.cards.length ? { cards: turn.cards } : {}),
    ...(final.type === "clarify" && final.options.length ? { options: final.options } : {}),
    ...(failure && turn.writes.length === 0 && turn.cards.length === 0 ? { error: true } : {}),
    at: now,
  };
  draft.transcript = [...draft.transcript, userEntry, reply].slice(-200);
  draft.pendingQuestion = final.type === "clarify" ? final.question : null;
  // What the model will not see verbatim any more is kept as one line per turn.
  if (draft.transcript.length > AGENT_LIMITS.recentEntries) {
    const dropped = draft.transcript[draft.transcript.length - AGENT_LIMITS.recentEntries - 1];
    if (dropped?.role === "assistant" || dropped?.role === "user") draft.summary = [...draft.summary, `${dropped.role === "user" ? "Person" : "Audiosous"}: ${dropped.text.slice(0, 160)}`].slice(-12);
  }
  if (turn.actions.length) draft.summary = [...draft.summary, `Did: ${turn.actions.join("; ")}`.slice(0, 300)].slice(-12);
  if (focus) env.focusUi(focus);
  env.log("agent.complete", { modelCalls, toolCalls, durationMs: Date.now() - started, writes: turn.writes.length, candidate: turn.cards.some((card) => card.kind === "candidate"), clarify: final.type === "clarify", failed: Boolean(failure) });
  return { status: "done", session: draft, reply, focus, toolCalls, modelCalls };

  /** Grounds a final message: ok, retry once (the model is told what was unsupported), or give up (fallback). */
  function groundOrRetry(text: string, callId?: string, results?: AgentContent[]): "ok" | "retry" | "fallback" {
    const verdict = checkGrounding(text, turn.facts, turn.writes);
    if (verdict.unsupported.length === 0 && verdict.falseWrites.length === 0) return "ok";
    env.log("agent.grounding", { unsupported: verdict.unsupported.length, falseWrites: verdict.falseWrites.length, retried: groundingRetried });
    if (groundingRetried || modelCalls >= AGENT_LIMITS.maxModelCalls) return "fallback";
    groundingRetried = true;
    const note = [
      verdict.unsupported.length ? `These values are not in any tool result or the context: ${verdict.unsupported.join(", ")}. Use only measured or planned values, or leave the number out.` : "",
      verdict.falseWrites.length ? `You claimed a write that did not happen this turn ("${verdict.falseWrites.join('", "')}"). Nothing was applied, undone, or set unless a WRITE tool succeeded.` : "",
      "Call respond again with a corrected message.",
    ]
      .filter(Boolean)
      .join(" ");
    // A respond call gets the note as its result (sent with the turn's other results); plain text gets a message.
    if (callId && results) results.push({ type: "tool-result", callId, isError: true, content: note });
    else messages.push({ role: "user", content: [{ type: "text", text: note }] });
    return "retry";
  }

  async function execute(call: Extract<AgentContent, { type: "tool-call" }>, overBudget: boolean): Promise<AgentContent> {
    const tool = TOOLS.find((item) => item.name === call.name);
    if (!tool) {
      env.log("agent.tool", { tool: "unknown", ok: false });
      return { type: "tool-result", callId: call.callId, isError: true, content: `Unknown tool "${call.name}". Only these exist: ${TOOLS.map((item) => item.name).join(", ")}.` };
    }
    if (overBudget) return { type: "tool-result", callId: call.callId, isError: true, content: "Tool budget for this request is spent. Respond with what you have." };
    const parsed = tool.schema.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      env.log("agent.tool", { tool: tool.name, ok: false, invalid: true });
      return { type: "tool-result", callId: call.callId, isError: true, content: `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}` };
    }
    const label = tool.activity(parsed.data as never, ctx);
    if (label) ctx.env.activity(label);
    const startedTool = Date.now();
    try {
      const result = await tool.run(parsed.data as never, ctx);
      env.log("agent.tool", { tool: tool.name, permission: tool.permission, ok: result.ok, durationMs: Date.now() - startedTool });
      const clipped = fitJson(result.ok ? result.content : { error: result.error, ...(result.content ?? {}) }, AGENT_LIMITS.toolResultChars);
      turn.facts.push(clipped);
      return { type: "tool-result", callId: call.callId, isError: !result.ok, content: clipped };
    } catch (caught) {
      if (caught instanceof Superseded) throw caught;
      const reason = caught instanceof Error && caught.message ? caught.message : "it failed";
      env.log("agent.tool", { tool: tool.name, ok: false, error: true });
      return { type: "tool-result", callId: call.callId, isError: true, content: `${tool.name} failed: ${reason}. Nothing was changed. Tell the person what could not be done; do not guess a result.` };
    }
  }
}

/**
 * The panel's Apply button: the same apply path as the tool, approved by the click itself. Returns the session with
 * a transcript line saying exactly what was applied.
 */
export function applyFromPanel(env: AgentEnvironment, session: AgentSession, mode: "all" | "accepted"): { session: AgentSession; ok: boolean; message: string } {
  const draft = draftOf(session);
  const document = env.document();
  const turn: TurnState = {
    message: "",
    approval: { apply: true, applyMode: mode, undo: false, preview: false, note: null },
    constraints: readConstraints(document, "", referenceContext(document, draft.focus)),
    directEdits: [],
    statedFactors: [],
    refs: referenceContext(document, draft.focus),
    isCurrent: () => true,
    facts: [],
    cards: [],
    focus: null,
    writes: [],
    actions: [],
    inputs: null,
    reading: null,
  };
  const result = applyCurrent({ env, session: draft, turn }, mode);
  const text = result.ok ? `Applied ${turn.writes[0]?.lines.length ?? 0} ${turn.writes[0]?.lines.length === 1 ? "change" : "changes"}. Undo restores the previous mix.` : result.error;
  draft.transcript = [...draft.transcript, { id: entryId("a"), role: "assistant" as const, text, ...(turn.cards.length ? { cards: turn.cards } : {}), ...(result.ok ? {} : { error: true }), at: env.now() }].slice(-200);
  return { session: draft, ok: result.ok, message: text };
}

/**
 * A tool result within the budget, always as valid JSON: long strings are shortened first, then long lists, so the
 * model gets every field it would have had, in less detail, rather than a result cut off mid-object.
 */
export function fitJson(value: unknown, limit: number): string {
  let text = JSON.stringify(value);
  for (const [chars, items] of [[600, Infinity], [300, Infinity], [180, 12], [120, 8], [90, 5], [60, 3]] as const) {
    if (text.length <= limit) return text;
    text = JSON.stringify(clip(value, chars, items));
  }
  return text.length <= limit ? text : JSON.stringify({ note: "This result is too large to send. Ask again with a narrower scope (fewer stems or one section)." });
}

function clip(value: unknown, chars: number, items: number): unknown {
  if (typeof value === "string") return value.length > chars ? `${value.slice(0, chars)}…` : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => clip(item, chars, items));
    return value.length > items ? [...kept, `…and ${value.length - items} more`] : kept;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item, chars, items)]));
  return value;
}
