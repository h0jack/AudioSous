/**
 * Acceptance harness for the conversational agent on a real project: the M7 scenario loader (cached analysis, band,
 * stereo, and envelope frames, scenario edits in memory), the real planners and apply through the in-memory
 * environment, and either a scripted model (deterministic, no network; the default) or the configured provider.
 *
 *   npx vite-node packages/mix-agent/scripts/converse-project.ts -- conversation.json
 *   AGENT_MODEL=anthropic ANTHROPIC_API_KEY=… npx vite-node packages/mix-agent/scripts/converse-project.ts -- conversation.json
 *
 * Scripted turns name the tools the agent would call; "auto" replies are composed only from that turn's tool
 * results, so they go through the same grounding check as a model's. With a real model the scripts are ignored and
 * the model decides. Writes report.txt (per turn: request, tools and outcomes, candidate, writes, reply) and
 * transcript.json (everything sent and received, for the hallucination review). The project file is never written.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { describeChange, fullMixAudition, planFullMix, type FullMixPlan } from "@audiosous/mix-planner";
import { engineSettings, loadScenario } from "../../mix-planner/scripts/scenario";
import { runAgentTurn } from "../src/agent";
import { emptySession, type AgentSession } from "../src/contract";
import { checkGrounding } from "../src/grounding";
import type { AgentModel, AgentRequest, AgentResponse } from "../src/model";
import { anthropicModel } from "../src/providers/anthropic";
import { MemoryEnvironment, ScriptedModel, TEST_NOW, call, clarify, respond, type ScriptStep } from "../src/testing";

type Step = { tool: string; args?: Record<string, unknown> } | { respond: string; focus?: Record<string, unknown> } | { clarify: string; options: string[] };

interface Turn {
  say: string;
  script?: Step[];
  /** Before the message: the person selects a stem or section, moves the playhead, or moves a fader. */
  select?: { track?: string; section?: string; playhead?: number };
  manual?: { track: string; gainDb: number };
  /** Before the message: the person edits a candidate change in the plan UI (the first change of this domain on this stem). */
  editCandidate?: { track: string; domain: string; patch: Record<string, number> };
}

interface Conversation {
  title: string;
  scenario: string;
  out: string;
  turns: Turn[];
}

const path = process.argv.slice(2).find((arg) => arg !== "--");
if (!path) throw new Error("Pass a conversation JSON path.");
const conversation = JSON.parse(readFileSync(path, "utf8")) as Conversation;
const loaded = loadScenario(conversation.scenario);
const song = { document: loaded.document, measurements: loaded.measurements, bands: loaded.bands, stereo: loaded.stereo, envelopes: loaded.envelopes };
const env = new MemoryEnvironment(song);
const useModel = process.env.AGENT_MODEL === "anthropic";
const out = resolve(conversation.out);
mkdirSync(out, { recursive: true });

const name = (id: string) => {
  const track = env.doc.tracks.find((item) => item.id === id);
  return (track?.customLabel ?? track?.name ?? id).replace("Sub Operator V4.23 ", "");
};
const byName = (needle: string) => {
  const hits = env.doc.tracks.filter((track) => name(track.id).toLowerCase().includes(needle.toLowerCase()));
  if (hits.length !== 1) throw new Error(`"${needle}" matched ${hits.length} stems.`);
  return hits[0]!;
};

/** A reply made only of what this turn's tools returned: the scripted stand-in for a model's explanation. */
function autoReply(request: AgentRequest): string {
  const results = request.messages.flatMap((message) => message.content).filter((item): item is Extract<typeof item, { type: "tool-result" }> => item.type === "tool-result");
  const lines: string[] = [];
  for (const result of results) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(result.content) as Record<string, unknown>;
    } catch {
      lines.push(result.content.slice(0, 300));
      continue;
    }
    if (result.isError) lines.push(String(body.error ?? body.text ?? "That did not work.").slice(0, 300));
    else if (Array.isArray(body.applied)) lines.push(`Applied: ${(body.applied as string[]).join("; ")}. ${String(body.undo ?? "")}`);
    else if (Array.isArray(body.undone)) lines.push(`Undone: ${(body.undone as string[]).join("; ")}.`);
    else if (typeof body.done === "string") lines.push(`Done: ${body.done}.`);
    else if (Array.isArray(body.edits)) lines.push(`${String(body.candidate)}: ${(body.edits as string[]).join("; ")}.`);
    else if (Array.isArray(body.removed) && body.candidate) lines.push(`${String(body.candidate)}: ${(body.removed as Array<{ change: string; reason: string }>).map((item) => `took out ${item.change}`).join("; ") || "nothing to take out"} (${body.changesBefore ?? "?"} → ${body.changesAfter ?? "?"} changes).`);
    else if (typeof body.headline === "string" && Array.isArray(body.changes)) {
      const changes = (body.changes as Array<{ track: string; change: string; scope: string; status: string }>).filter((item) => typeof item === "object" && item.status !== "rejected").map((item) => `${item.track}: ${item.change}${item.scope !== "whole song" ? ` (${item.scope})` : ""}`);
      lines.push(`${String(body.candidate ?? "Candidate")}: ${body.headline} ${changes.join("; ")}. Ready to preview; nothing is applied yet.`);
    } else if (Array.isArray(body.problems)) {
      const problems = (body.problems as Array<{ title: string; severity: number }>).slice(0, 3).map((item) => `${item.title} (severity ${item.severity})`);
      const fine = (body.healthyRelationships as Array<{ stems: string[]; domain: string }> | undefined) ?? [];
      lines.push(problems.length ? `Measured: ${problems.join("; ")}.` : "The planners measure no problem past the threshold here.");
      if (fine.length) lines.push(`Fine: ${fine.slice(0, 2).map((item) => `${item.stems.join("/")} (${item.domain})`).join("; ")}.`);
    } else if (body.problem && typeof body.problem === "object") {
      const problem = body.problem as { title: string; solution: string | null; solutionReason?: string; alternativesConsidered?: Array<{ alternative: string; reason: string }> };
      lines.push(`${problem.title}: ${problem.solution ?? "nothing chosen"}. ${problem.solutionReason ?? ""}`);
      for (const item of problem.alternativesConsidered ?? []) lines.push(`Not ${item.alternative}: ${item.reason}`);
    } else if (Object.keys(body).some((key) => key.startsWith("only in"))) lines.push(`Differences: ${JSON.stringify(body)}`);
    else if (typeof body.hearing === "string") lines.push(`${body.hearing}.`);
    else if (Array.isArray(body.stems)) lines.push(`Read ${(body.stems as unknown[]).length} stems.`);
  }
  return lines.join(" ").slice(0, 2300) || "Done.";
}

function scripted(steps: Step[]): ScriptStep[] {
  return steps.map((step) => {
    // "$problem:<type>" stands for that problem's id in the current candidate, as a model would read it from the context.
    if ("tool" in step) return () => call(step.tool, JSON.parse(JSON.stringify(step.args ?? {}).replace(/"\$problem:([a-z-]+)"/g, (_, type: string) => JSON.stringify(env.plan?.problems.find((problem) => problem.type === type)?.id ?? `none-${type}`))) as Record<string, unknown>);
    if ("clarify" in step) return clarify(step.clarify, step.options);
    if (step.respond !== "auto") return respond(step.respond, step.focus ? { focus: step.focus } : {});
    return (request: AgentRequest): AgentResponse => respond(autoReply(request), step.focus ? { focus: step.focus } : {});
  });
}

/** Records what a real model is sent and returns, for the review. */
function recorded(model: AgentModel, log: Array<{ request: AgentRequest; response: AgentResponse }>): AgentModel {
  return {
    info: model.info,
    async complete(request) {
      const response = await model.complete(request);
      log.push({ request: { ...request, signal: undefined }, response: { ...response, providerData: undefined } });
      return response;
    },
  };
}

const report: string[] = [`# ${conversation.title}`, `model: ${useModel ? "anthropic (live)" : "scripted"}`, `project: ${conversation.scenario}`, ""];
const transcript: unknown[] = [];
let session: AgentSession = emptySession(env.doc.project.id);
/** Render variants for bounce_mix: the saved mix, each candidate as previewed (loudness-matched), and each apply. */
const variants: Array<Record<string, unknown>> = [{ name: "current", ...engineSettings(env.doc) }];
const live = useModel ? anthropicModel({ ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}), effort: (process.env.AGENT_EFFORT as "low" | "medium" | "high" | undefined) ?? "medium" }) : null;

for (const [index, turn] of conversation.turns.entries()) {
  if (turn.select) {
    const ui = env.doc.uiState;
    env.edit({ ...env.doc, uiState: { ...ui, selectedTrackId: turn.select.track ? byName(turn.select.track).id : ui.selectedTrackId, selectedSectionId: turn.select.section ? env.doc.sections.find((section) => section.name === turn.select!.section)!.id : ui.selectedSectionId, playheadSeconds: turn.select.playhead ?? ui.playheadSeconds } }, false);
  }
  if (turn.manual) {
    const target = byName(turn.manual.track);
    env.edit({ ...env.doc, tracks: env.doc.tracks.map((track) => (track.id === target.id ? { ...track, gainDb: turn.manual!.gainDb } : track)) });
  }
  if (turn.editCandidate && env.plan) {
    const { editChange } = await import("@audiosous/mix-planner");
    const target = byName(turn.editCandidate.track);
    const change = env.plan.changes.find((item) => item.trackId === target.id && item.domain === turn.editCandidate!.domain);
    if (change) env.plan = editChange(env.plan, change.id, turn.editCandidate.patch);
  }
  const before = env.doc;
  const eventsBefore = env.events.length;
  const exchanges: Array<{ request: AgentRequest; response: AgentResponse }> = [];
  const model = live ? recorded(live, exchanges) : new ScriptedModel(scripted(turn.script ?? [{ respond: "auto" }]));
  const started = performance.now();
  const outcome = await runAgentTurn({ model, env, session, message: turn.say, isCurrent: () => true });
  const ms = performance.now() - started;
  if (outcome.status !== "done") throw new Error("superseded");
  session = outcome.session;
  const requests = live ? exchanges.map((item) => item.request) : (model as ScriptedModel).requests;
  const calls = requests.flatMap((request) => request.messages.flatMap((message) => message.content)).filter((item): item is Extract<typeof item, { type: "tool-call" }> => item.type === "tool-call");
  const uniqueCalls = [...new Map(calls.map((item) => [item.callId, item])).values()];
  const results = new Map(requests.flatMap((request) => request.messages.flatMap((message) => message.content)).filter((item): item is Extract<typeof item, { type: "tool-result" }> => item.type === "tool-result").map((item) => [item.callId, item]));
  const grounding = env.events.slice(eventsBefore).filter((item) => item.event === "agent.grounding");
  report.push(`## ${index + 1}. Person: ${turn.say}`);
  if (turn.select) report.push(`(selected: ${JSON.stringify(turn.select)})`);
  if (turn.manual) report.push(`(manual fader: ${turn.manual.track} → ${turn.manual.gainDb} dB)`);
  if (turn.editCandidate) report.push(`(edited in the plan UI: ${turn.editCandidate.track} ${turn.editCandidate.domain} ${JSON.stringify(turn.editCandidate.patch)})`);
  for (const item of uniqueCalls) {
    const result = results.get(item.callId);
    const status = item.name === "respond" || item.name === "ask_clarification" ? "" : result ? (result.isError ? ` → ERROR ${result.content.slice(0, 220)}` : " → ok") : " → (no result)";
    report.push(`  tool ${item.name} ${JSON.stringify(item.arguments)}${status}`);
  }
  const plan: FullMixPlan | null = env.plan;
  if (plan && outcome.reply.cards?.some((card) => card.kind === "candidate")) {
    report.push(`  candidate (${session.candidates.find((entry) => entry.id === session.currentCandidateId)?.label ?? "?"}): ${plan.summary.headline}`);
    for (const change of plan.changes) report.push(`    ${change.status.padEnd(8)} ${name(change.trackId)} · ${change.scope.type === "global" ? "global" : env.doc.sections.find((section) => section.id === (change.scope as { sectionId: string }).sectionId)?.name} · ${describeChange(change.processing, name, change.evidence.kind === "space" ? change.evidence.current : undefined)}${change.edited ? " (edited)" : ""}`);
    if (plan.constraints) report.push(`    constraints: ${JSON.stringify(plan.constraints)}`);
  }
  if (plan && outcome.reply.cards?.some((card) => card.kind === "candidate")) {
    const label = session.candidates.find((entry) => entry.id === session.currentCandidateId)?.label.replace("Candidate ", "") ?? "x";
    variants.push({ name: `t${index + 1}-candidate-${label}-matched`, ...engineSettings(fullMixAudition(env.doc, plan, { mode: "candidate", loudnessMatch: true }).document) });
    variants.push({ name: `t${index + 1}-candidate-${label}`, ...engineSettings(fullMixAudition(env.doc, plan, { mode: "candidate", loudnessMatch: false }).document) });
  }
  if (env.doc !== before) variants.push({ name: `t${index + 1}-saved`, ...engineSettings(env.doc) });
  report.push(`  project ${env.doc === before ? "unchanged" : "CHANGED"} · history ${env.history.length} · ${outcome.modelCalls} model calls, ${outcome.toolCalls} tools, ${Math.round(ms)} ms${grounding.length ? ` · grounding retries ${grounding.length}` : ""}`);
  report.push(`  Audiosous: ${outcome.reply.text.replaceAll("Sub Operator V4.23 ", "")}`);
  if (outcome.reply.options) report.push(`  options: ${outcome.reply.options.join(" | ")}`);
  // Independent audit: the final reply against everything the agent saw this turn.
  const facts = [turn.say, ...requests.flatMap((request) => request.messages.flatMap((message) => message.content.map((item) => (item.type === "text" ? item.text : item.type === "tool-result" ? item.content : ""))))];
  const audit = checkGrounding(outcome.reply.text, facts, outcome.reply.cards?.some((card) => card.kind === "applied") ? [{ kind: "apply" }, { kind: "edit" }] : session.lastApply === null && before !== env.doc ? [{ kind: "undo" }] : []);
  if (audit.unsupported.length || audit.falseWrites.length) report.push(`  AUDIT: unsupported ${JSON.stringify(audit.unsupported)} false writes ${JSON.stringify(audit.falseWrites)}`);
  report.push("");
  transcript.push({ turn: index + 1, say: turn.say, requests: live ? exchanges : requests, reply: outcome.reply });
}

// The agent's Full Mix candidate against Full Mix run directly on the same saved mix.
const direct = planFullMix({ ...song, document: song.document, now: TEST_NOW });
report.push(`Direct Full Mix on the saved mix (for comparison): ${direct.summary.headline}`);
for (const change of direct.changes) report.push(`  ${name(change.trackId)} · ${describeChange(change.processing, name, change.evidence.kind === "space" ? change.evidence.current : undefined)}`);

writeFileSync(join(out, "report.txt"), `${report.join("\n")}\n`);
writeFileSync(join(out, "transcript.json"), JSON.stringify(transcript, null, 1));
writeFileSync(join(out, "checks.json"), JSON.stringify({ project: resolve(loaded.scenario.project), requests: [] }, null, 2));
writeFileSync(join(out, "bounce.json"), JSON.stringify({ project: resolve(loaded.scenario.project), durationSeconds: song.document.project.durationSeconds, variants }, null, 2));
console.log(report.join("\n"));
