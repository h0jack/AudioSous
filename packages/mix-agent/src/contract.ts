import { CONSTRAINT_DOMAINS, CONSTRAINT_PROCESSORS, MIX_GOALS, MIX_STRENGTHS, type FullMixPlan, type MixGoal, type MixStrength } from "@audiosous/mix-planner";
import { z } from "zod";

/**
 * The conversational agent's contract. Everything the model sends back is validated against these schemas before
 * anything runs; everything the agent keeps between turns is plain, inspectable data.
 */

/* ------------------------------------------------------------------ permissions */

/**
 * READ inspects. PLAN builds an ephemeral candidate (never written to the project). PREVIEW changes what plays, not
 * what is saved. WRITE changes the saved project and needs the person's explicit go-ahead in the current message
 * (or a button). FINAL ends the turn with an answer or a question.
 */
export const PERMISSIONS = ["read", "plan", "preview", "write", "final"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/* ------------------------------------------------------------------ constraints */

/** The person's constraints for a request, in project ids. The planners enforce them; the model cannot drop them. */
export const agentConstraintsSchema = z.object({
  protectedTrackIds: z.array(z.string()).max(64),
  excludedDomains: z.array(z.enum(CONSTRAINT_DOMAINS)).max(4),
  excludedProcessors: z.array(z.enum(CONSTRAINT_PROCESSORS)).max(4),
  /** Only these sections may change. Null: anywhere. */
  onlySectionIds: z.array(z.string()).max(32).nullable(),
  /** Sections that may not change ("don't change the verses"). Resolved against the project into `onlySectionIds`. */
  excludedSectionIds: z.array(z.string()).max(32),
  strength: z.enum(MIX_STRENGTHS).nullable(),
});
export type AgentConstraints = z.infer<typeof agentConstraintsSchema>;

export function emptyAgentConstraints(): AgentConstraints {
  return { protectedTrackIds: [], excludedDomains: [], excludedProcessors: [], onlySectionIds: null, excludedSectionIds: [], strength: null };
}

/* ------------------------------------------------------------------ UI focus */

export const PLAN_TABS = ["gain", "eq", "space", "dynamics", "full"] as const;

/** Structured focus the UI can act on. Never DOM instructions. */
export const uiFocusSchema = z.object({
  trackIds: z.array(z.string()).max(4).optional(),
  sectionId: z.string().nullable().optional(),
  problemId: z.string().nullable().optional(),
  changeId: z.string().nullable().optional(),
  tab: z.enum(PLAN_TABS).nullable().optional(),
});
export type UiFocus = z.infer<typeof uiFocusSchema>;

/* ------------------------------------------------------------------ model decisions */

/** What one model step amounts to, provider-independent. */
export type AgentDecision =
  | { type: "answer"; message: string; focus: UiFocus | null; confidence: "high" | "moderate" | "low" | null }
  | { type: "tool-call"; callId: string; tool: string; arguments: unknown }
  | { type: "clarify"; question: string; options: string[] };

/* ------------------------------------------------------------------ cards */

/** Structured pieces of an assistant reply the panel renders as action cards. */
export type AgentCard =
  | { kind: "candidate"; candidateId: string; label: string; headline: string; changes: string[]; stale: boolean }
  | { kind: "problem"; problemId: string; title: string; severity: number; outcome: string }
  | { kind: "change"; changeId: string; trackName: string; description: string; status: string }
  | { kind: "applied"; lines: string[] }
  | { kind: "edit"; lines: string[] };

/* ------------------------------------------------------------------ transcript */

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Turn's activity lines ("Checking Chorus…"), shown under the reply. */
  activity?: string[];
  cards?: AgentCard[];
  /** The reply is a question and these are suggested answers. */
  options?: string[];
  error?: boolean;
  at: string;
}

/* ------------------------------------------------------------------ candidates */

export interface CandidateEntry {
  id: string;
  /** "Candidate A", "Candidate B", … */
  label: string;
  /** What was asked for, in a few words: "Chorus · conservative · vocal protected". */
  description: string;
  route: Route;
  plan: FullMixPlan;
  createdAt: string;
  /** Set when this candidate was written to the project. */
  appliedAt: string | null;
}

export const ROUTES = ["full", "level", "eq", "space", "dynamics"] as const;
export type Route = (typeof ROUTES)[number];

/* ------------------------------------------------------------------ session */

/** What the conversation is about right now, so "that", "it", "the second one", and "here" resolve. */
export interface ConversationFocus {
  trackIds: string[];
  sectionId: string | null;
  problemId: string | null;
  changeId: string | null;
}

export interface LastApply {
  candidateId: string | null;
  /** The document the apply produced. Conversational undo is offered only while the project is still exactly this. */
  documentRef: unknown;
  lines: string[];
  at: string;
}

/**
 * Session state, scoped to one open project and never written to the project file. The transcript is for display;
 * the model sees a short recent window, a compact summary, and this structured state.
 */
export interface AgentSession {
  projectId: string;
  transcript: TranscriptEntry[];
  /** Compact summary of turns that fell out of the recent window. */
  summary: string[];
  focus: ConversationFocus;
  /** Constraints the person stated that last for the session ("don't touch the vocal", "keep it subtle"). */
  standing: AgentConstraints;
  candidates: CandidateEntry[];
  currentCandidateId: string | null;
  lastApply: LastApply | null;
  /** A question the agent asked and is waiting on. */
  pendingQuestion: string | null;
}

export function emptySession(projectId: string): AgentSession {
  return {
    projectId,
    transcript: [],
    summary: [],
    focus: { trackIds: [], sectionId: null, problemId: null, changeId: null },
    standing: emptyAgentConstraints(),
    candidates: [],
    currentCandidateId: null,
    lastApply: null,
    pendingQuestion: null,
  };
}

/* ------------------------------------------------------------------ limits */

export const AGENT_LIMITS = {
  /** Model calls per request: interpret → inspect → plan → evaluate → explain, plus one grounding retry. */
  maxModelCalls: 8,
  /** Tool executions per request. */
  maxToolCalls: 12,
  /** Recent transcript entries sent to the model. */
  recentEntries: 8,
  /** Characters of one transcript entry sent to the model. */
  entryChars: 700,
  /** Character budget of the structured project context. */
  contextChars: 9_000,
  /** Character budget of one tool result (about 3k tokens); a larger result is shortened field by field. */
  toolResultChars: 12_000,
  /** Candidates kept in the session. */
  maxCandidates: 8,
} as const;

export const STRENGTH_LABEL: Record<MixStrength, string> = { conservative: "conservative", normal: "normal", strong: "strong" };
export type { MixGoal, MixStrength };
export { MIX_GOALS, MIX_STRENGTHS };
