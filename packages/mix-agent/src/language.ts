import type { ConstraintDomain, ConstraintProcessor, MixStrength } from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import type { Route } from "./contract";
import { resolveSection, resolveTrack, type ReferenceContext } from "./references";

/**
 * What can be read from the person's own words without a model, deterministically. These readings are not
 * suggestions to the model: they gate what the agent may do (only these words can approve a write, only values
 * stated here can be set directly, and constraints read here cannot be dropped by the model).
 */

function clean(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ approval */

export interface ApprovalContext {
  /** A candidate exists, is fresh, and has something to apply. */
  candidateReady: boolean;
  /** The last assistant reply presented that candidate (so a bare "do it" refers to it). */
  candidatePresented: boolean;
  /** The last reply offered to build something rather than to apply ("I can build a candidate…"). */
  offeredToBuild: boolean;
  /** The last agent apply can still be undone from the conversation. */
  canUndoApply: boolean;
}

export interface Approval {
  apply: boolean;
  /** "Apply the accepted ones" / "apply those two" asks for accepted changes only. */
  applyMode: "all" | "accepted";
  undo: boolean;
  preview: boolean;
  /** Why an apply-like phrase did not count, for the activity log and tests. */
  note: string | null;
}

const QUESTION_LEAD = /^(should|would|what|why|how|is|are|does|do you think|will|which|when|where|who|did)\b/;
const NEGATED = /\b(don't|do not|not yet|no,|never|before (you |we )?(apply|applying)|without applying|hold off|wait)\b/;
const STRONG_APPLY = /\b(apply|commit|save (it|that|this|the candidate|these|those)|write (it|that|this) (in|to the project)|make (it|that|this|them|those|these) permanent|lock (it|that) in)\b/;
const WEAK_APPLY = /^(yes|yeah|yep|ok|okay|sure|do it|go ahead|go for it|sounds good|perfect|great|let'?s do it|let'?s go|make it so|that'?s good|that works|keep it|keep that|i like it|love it)\b[\s\S]{0,40}$/;
const PREVIEW = /\b(let'?s hear|hear it|let me hear|play (it|that|the candidate|me)|preview|audition|listen|a\/b|compare (it )?with the (current|saved|original))\b/;
const UNDO = /\b(undo|revert (that|it|the last|what you)|roll (it |that )?back|put it back|take (that|it) back|change it back)\b/;

/**
 * Whether this message approves a write. Only the person's words (or a button) can approve one; the model's
 * reading of the message is never enough. "Let's hear it" is a preview, not an apply. A bare "do it" approves only
 * right after a presented candidate, and not when the last reply offered to build something.
 */
export function readApproval(message: string, ctx: ApprovalContext): Approval {
  const text = clean(message);
  const out: Approval = { apply: false, applyMode: "all", undo: false, preview: PREVIEW.test(text), note: null };
  const politeRequest = /^(can|could|would) you\b|^please\b/.test(text);
  const question = text.endsWith("?") && !politeRequest;
  if (UNDO.test(text) && !question && !/\b(don't|do not) (undo|revert)\b/.test(text)) out.undo = ctx.canUndoApply;
  if (NEGATED.test(text)) {
    if (STRONG_APPLY.test(text) || WEAK_APPLY.test(text)) out.note = "The message holds off or negates applying.";
    return out;
  }
  if (question || QUESTION_LEAD.test(text)) {
    if (STRONG_APPLY.test(text)) out.note = "A question about applying is not an instruction to apply.";
    return out;
  }
  if (!ctx.candidateReady) {
    if (STRONG_APPLY.test(text)) out.note = "There is no fresh candidate to apply.";
    return out;
  }
  if (STRONG_APPLY.test(text)) {
    out.apply = true;
    out.applyMode = /\b(accepted|those two|these two|just those|only those|only the accepted)\b/.test(text) ? "accepted" : "all";
    return out;
  }
  if (WEAK_APPLY.test(text) && !out.preview) {
    if (ctx.candidatePresented && !ctx.offeredToBuild) out.apply = true;
    else out.note = ctx.offeredToBuild ? "The last reply offered to build a candidate; agreeing builds it." : "A bare agreement approves only right after a presented candidate.";
  }
  return out;
}

/* ------------------------------------------------------------------ constraints */

export interface ConstraintReading {
  protectedTrackIds: string[];
  releasedTrackIds: string[];
  excludedDomains: ConstraintDomain[];
  releasedDomains: ConstraintDomain[];
  excludedProcessors: ConstraintProcessor[];
  onlySectionIds: string[] | null;
  excludedSectionIds: string[];
  strength: MixStrength | null;
  /** "From now on", "always", "in general", "I prefer": the strength is a standing preference. */
  standingStrength: boolean;
  /** A narrow request that names one planner's domain ("only fix the levels", "just work on compression"). */
  route: Route | null;
  /** References the constraints mention that could not be resolved or are ambiguous. */
  unresolved: Array<{ phrase: string; options: string[] }>;
}

const PROTECT_PATTERNS: RegExp[] = [
  /\b(?:don't|do not|never|please don't|without) (?:touch(?:ing)?|chang(?:e|ing)(?: anything on)?|mov(?:e|ing)|alter(?:ing)?|modif(?:y|ying)|process(?:ing)?|adjust(?:ing)?|affect(?:ing)?|mess(?:ing)? with|do(?:ing)? anything to) (?:the |my )?([a-z0-9][a-z0-9 \-]{0,30}?)(?=$|[,.;:!?]| (?:itself|at all|please|but|and|or|though|anymore|either|in|during|while)\b)/g,
  /\bleave (?:the |my )?([a-z0-9][a-z0-9 \-]{0,30}?) (?:alone|as it is|as is|untouched|be)\b/g,
  /\bkeep (?:the |my )?([a-z0-9][a-z0-9 \-]{0,30}?) (?:as it is|as is|untouched|exactly (?:as it is|the same)|the same|unchanged)\b/g,
  /\b(?:but )?not the ([a-z0-9][a-z0-9 \-]{0,30}?)(?=$|[,.;:!?])/g,
  /\bprotect (?:the |my )?([a-z0-9][a-z0-9 \-]{0,30}?)(?=$|[,.;:!?]| (?:but|and|please)\b)/g,
];

const RELEASE_TRACK = /\byou can (?:now )?(?:touch|change|process|adjust) (?:the |my )?([a-z0-9][a-z0-9 \-]{0,30}?)(?: now| again| too| as well)?(?=$|[,.;:!?])/g;

const DOMAIN_WORDS: Array<{ domain: ConstraintDomain; pattern: RegExp }> = [
  { domain: "space", pattern: /\b(stereo|width|widths|pan|panning|pans|spatial|image|stereo field|stereo image)\b/ },
  { domain: "eq", pattern: /\b(eq|eqs|equali[sz]ation|filters?|tone|frequency changes)\b/ },
  { domain: "dynamics", pattern: /\b(dynamics( processing)?)\b/ },
  { domain: "gain", pattern: /\b(levels?|faders?|gains?|volumes?)\b/ },
];

const PROCESSOR_WORDS: Array<{ processor: ConstraintProcessor; pattern: RegExp }> = [
  { processor: "compressor", pattern: /\b(compression|compressors?|compress(ing)?)\b/ },
  { processor: "ducking", pattern: /\b(side-?chain(ing)?|ducking|ducks?)\b/ },
  { processor: "transient", pattern: /\b(transient (shaping|shapers?)|transient changes)\b/ },
  { processor: "dynamic-eq", pattern: /\b(dynamic eqs?)\b/ },
];

/** Phrases that rule a domain or processor out: "no X", "without X", "leave X alone", "don't change X", "keep X as it is". */
function exclusionClauses(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bno ([a-z \-]{2,40}?)(?: changes?| moves?| processing)?(?=$|[,.;:!?]| (?:please|but|and)\b)/g,
    /\bwithout (?:the |any |touching (?:the )?|changing (?:the )?)?([a-z \-]{2,40}?)(?=$|[,.;:!?]| (?:please|but|and)\b)/g,
    /\bleave (?:the |my )?([a-z \-]{2,40}?) alone\b/g,
    /\b(?:don't|do not) (?:change|touch|add|use|move) (?:the |any |anything in (?:the )?)?([a-z \-]{2,40}?)(?=$|[,.;:!?]| (?:please|but|and)\b)/g,
    /\bkeep the ([a-z \-]{2,40}?) (?:exactly )?(?:as it is|as is|the same|unchanged)\b/g,
    /\bdon't move anything in ([a-z \-]{2,30})/g,
    /\btry it without (?:the )?([a-z \-]{2,40}?)(?=$|[,.;:!?])/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) out.push(match[1]!.trim());
  return out;
}

/**
 * Reads the constraints a message states. Stems are resolved against the project; a protected reference that is
 * ambiguous is reported, not guessed.
 */
export function readConstraints(document: ProjectDocument, message: string, ctx: ReferenceContext): ConstraintReading {
  const text = clean(message);
  const out: ConstraintReading = {
    protectedTrackIds: [],
    releasedTrackIds: [],
    excludedDomains: [],
    releasedDomains: [],
    excludedProcessors: [],
    onlySectionIds: null,
    excludedSectionIds: [],
    strength: null,
    standingStrength: false,
    route: null,
    unresolved: [],
  };

  // Domains and processors ruled out.
  for (const clause of exclusionClauses(text)) {
    let matched = false;
    for (const item of PROCESSOR_WORDS) {
      if (item.pattern.test(clause)) {
        out.excludedProcessors.push(item.processor);
        matched = true;
      }
    }
    if (matched) continue;
    for (const item of DOMAIN_WORDS) {
      if (item.pattern.test(clause)) {
        out.excludedDomains.push(item.domain);
        matched = true;
      }
    }
  }
  for (const item of DOMAIN_WORDS) {
    const released = new RegExp(`\\b(?:you can (?:use|change|touch) (?:the )?|(?:it'?s )?(?:fine|ok|okay) to (?:use|change) )${item.pattern.source.slice(2, -2)}`);
    if (released.test(text)) out.releasedDomains.push(item.domain);
  }

  // Protected stems: every protect phrase that resolves to stems (and is not a domain word).
  for (const pattern of PROTECT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const phrase = match[1]!.trim().replace(/\s+(itself|at all|please)$/, "");
      if (!phrase || DOMAIN_WORDS.some((item) => item.pattern.test(phrase)) || PROCESSOR_WORDS.some((item) => item.pattern.test(phrase))) continue;
      const section = resolveSection(document, phrase, ctx);
      if (section.kind === "match" && section.via !== "selection" && section.via !== "playhead") {
        out.excludedSectionIds.push(...section.sectionIds);
        continue;
      }
      const resolved = resolveTrack(document, phrase, ctx);
      if (resolved.kind === "match") out.protectedTrackIds.push(...resolved.trackIds);
      else if (resolved.kind === "ambiguous") out.unresolved.push({ phrase, options: resolved.trackIds });
    }
  }
  for (const match of text.matchAll(RELEASE_TRACK)) {
    const resolved = resolveTrack(document, match[1]!.trim(), ctx);
    if (resolved.kind === "match") out.releasedTrackIds.push(...resolved.trackIds);
  }

  // Scope: "only (in|change) the chorus", "in drop 2 only", "just the breakdown".
  const only =
    /\bonly (?:change |touch |work on |make changes (?:in|to) |in |during |for )?(?:the )?([a-z0-9][a-z0-9 \-]{1,30}?)(?=$|[,.;:!?]| (?:please|but|and)\b)/.exec(text) ??
    /\b(?:in|during) (?:the )?([a-z0-9][a-z0-9 \-]{1,30}?) only\b/.exec(text) ??
    /\bjust (?:in )?(?:the )?([a-z0-9][a-z0-9 \-]{1,30}?)(?=$|[,.;:!?])/.exec(text);
  if (only) {
    const section = resolveSection(document, only[1]!.trim(), ctx);
    if (section.kind === "match") out.onlySectionIds = section.sectionIds;
  }
  // "here", "in Drop 2", "during the breakdown": a request placed in a section changes only that section.
  if (!out.onlySectionIds && !isQuestion(message)) {
    const placed = /\b(here|in this section|in this part|right here)\b/.test(text)
      ? resolveSection(document, "here", ctx)
      : (() => {
          const match = /\b(?:in|during|for) (?:the )?((?:first |second |third |last |final )?[a-z0-9][a-z0-9 \-]{1,24}?)(?=$|[,.;:!?]| (?:only|please|but|and|too|as well|section|part)\b)/.exec(text);
          return match ? resolveSection(document, match[1]!.trim(), ctx) : null;
        })();
    if (placed?.kind === "match" && (placed.via !== "focus" || /\bhere\b/.test(text))) out.onlySectionIds = placed.sectionIds;
  }
  for (const match of text.matchAll(/\b(?:don't|do not) (?:change|touch) (?:the |anything in (?:the )?)?([a-z0-9][a-z0-9 \-]{1,30}?)(?=$|[,.;:!?]| (?:please|but|and)\b)/g)) {
    const section = resolveSection(document, match[1]!.trim(), ctx);
    if (section.kind === "match" && section.via !== "selection" && section.via !== "playhead") out.excludedSectionIds.push(...section.sectionIds);
  }

  // Strength.
  if (/\b(subtle|subtly|gentle|gently|conservative|a (little|touch|bit)|slightly|slight|light touch|lightly|tiny|small changes?|less aggressive|back (it|that) off|not too much)\b/.test(text)) out.strength = "conservative";
  else if (/\b(stronger|more aggressive|aggressive|push it|go further|bigger changes?|strong|really|a lot|much more|harder)\b/.test(text)) out.strength = "strong";
  out.standingStrength = out.strength !== null && /\b(from now on|always|in general|generally|i prefer|i like .* changes|by default|going forward)\b/.test(text);

  // Narrow routes.
  if (/\b(only|just) (fix |change |work on |adjust |touch )?(the )?(levels?|faders?|gains?|volume|balance)\b/.test(text)) out.route = "level";
  else if (/\b(only|just) (fix |change |work on |use |touch )?(the )?(eq|equali[sz]ation|frequencies|tone)\b/.test(text)) out.route = "eq";
  else if (/\b(only|just) (fix |change |work on |use |touch )?(the )?(stereo|width|panning|pan|space|stereo image)\b/.test(text)) out.route = "space";
  else if (/\b(only|just) (fix |change |work on |use |touch )?(the )?(compression|dynamics|ducking|sidechain|transients?)\b/.test(text)) out.route = "dynamics";

  out.protectedTrackIds = [...new Set(out.protectedTrackIds)];
  out.excludedDomains = [...new Set(out.excludedDomains)];
  out.excludedProcessors = [...new Set(out.excludedProcessors)];
  out.excludedSectionIds = [...new Set(out.excludedSectionIds)];
  return out;
}

/* ------------------------------------------------------------------ direct edits */

export interface DirectEdit {
  trackIds: string[];
  phrase: string;
  control: "gain" | "pan" | "width";
  /** "delta": move by the value; "set": set to it. Gain in dB, pan −100…100 (left…right), width in percent. */
  mode: "delta" | "set";
  value: number;
  sectionIds: string[] | null;
}

export interface DirectEditReading {
  edits: DirectEdit[];
  ambiguous: Array<{ phrase: string; options: string[] }>;
}

const NUM = "([0-9]+(?:\\.[0-9]+)?)";
const TRACK = "(?:the |my )?([a-z0-9][a-z0-9 \\-]{0,30}?)";

/**
 * Explicit, numeric instructions: "make the bass 1 dB quieter", "pan the guitar 20% left", "set the pad width to
 * 80%". Only these values may be set without a planner; the model can carry them out but cannot invent them.
 */
export function readDirectEdits(document: ProjectDocument, message: string, ctx: ReferenceContext): DirectEditReading {
  const text = clean(message).replace(/−/g, "-");
  const found: Array<Omit<DirectEdit, "trackIds" | "sectionIds">> = [];
  const add = (phrase: string, control: DirectEdit["control"], mode: DirectEdit["mode"], value: number) => found.push({ phrase: phrase.trim(), control, mode, value });
  const gain: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [new RegExp(`\\b(?:make|turn|bring|put) ${TRACK} (?:by )?${NUM} ?db (quieter|softer|lower|down|louder|higher|up)\\b`, "g"), (m) => add(m[1]!, "gain", "delta", Number(m[2]) * (/quieter|softer|lower|down/.test(m[3]!) ? -1 : 1))],
    [new RegExp(`\\b(?:turn|bring|push|pull) ${TRACK} (down|up) (?:by )?${NUM} ?db\\b`, "g"), (m) => add(m[1]!, "gain", "delta", Number(m[3]) * (m[2] === "down" ? -1 : 1))],
    [new RegExp(`\\b(lower|cut|drop|reduce|attenuate) ${TRACK} by ${NUM} ?db\\b`, "g"), (m) => add(m[2]!, "gain", "delta", -Number(m[3]))],
    [new RegExp(`\\b(raise|boost|lift|increase) ${TRACK} by ${NUM} ?db\\b`, "g"), (m) => add(m[2]!, "gain", "delta", Number(m[3]))],
    [new RegExp(`\\bset ${TRACK}(?:'s)? (?:gain|fader|level|volume) to (-?${NUM.slice(1, -1)}) ?db\\b`, "g"), (m) => add(m[1]!, "gain", "set", Number(m[2]))],
  ];
  const pan: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [new RegExp(`\\bpan ${TRACK} (?:to )?${NUM} ?%? (left|right)\\b`, "g"), (m) => add(m[1]!, "pan", "set", Number(m[2]) * (m[3] === "left" ? -1 : 1))],
    [new RegExp(`\\bpan ${TRACK} hard (left|right)\\b`, "g"), (m) => add(m[1]!, "pan", "set", m[2] === "left" ? -100 : 100)],
    [new RegExp(`\\b(?:center|centre) ${TRACK}(?=$|[,.;:!?]| (?:please|and|but)\\b)`, "g"), (m) => add(m[1]!, "pan", "set", 0)],
    [new RegExp(`\\bpan ${TRACK} (?:to )?(?:the )?(?:center|centre|middle)\\b`, "g"), (m) => add(m[1]!, "pan", "set", 0)],
  ];
  const width: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [new RegExp(`\\b(?:set )?${TRACK}(?:'s)? width to ${NUM} ?%`, "g"), (m) => add(m[1]!, "width", "set", Number(m[2]))],
    [new RegExp(`\\b(?:narrow|widen) ${TRACK} to ${NUM} ?%`, "g"), (m) => add(m[1]!, "width", "set", Number(m[2]))],
    [new RegExp(`\\bmake ${TRACK} ${NUM} ?% wide\\b`, "g"), (m) => add(m[1]!, "width", "set", Number(m[2]))],
  ];
  for (const [pattern, handle] of [...gain, ...pan, ...width]) for (const match of text.matchAll(pattern)) handle(match);

  const sectionMatch = /\b(?:in|during) (?:the )?([a-z0-9][a-z0-9 \-]{1,30}?)(?=$|[,.;:!?]| only\b)/.exec(text);
  const section = sectionMatch ? resolveSection(document, sectionMatch[1]!, ctx) : null;
  const sectionIds = section?.kind === "match" ? section.sectionIds : null;
  const out: DirectEditReading = { edits: [], ambiguous: [] };
  for (const edit of found) {
    const phrase = edit.phrase.replace(/\s+(in|during)\s.*$/, "");
    const resolved = resolveTrack(document, phrase, ctx);
    if (resolved.kind === "match") out.edits.push({ ...edit, phrase, trackIds: resolved.trackIds, sectionIds });
    else if (resolved.kind === "ambiguous") out.ambiguous.push({ phrase, options: resolved.trackIds });
  }
  return out;
}

/* ------------------------------------------------------------------ amounts */

/** Named amounts for relative refinement. The factor moves a change from its current value. */
export const AMOUNTS = {
  "much-less": 0.5,
  less: 0.7,
  "slightly-less": 0.85,
  "slightly-more": 1.15,
  more: 1.3,
  "much-more": 1.5,
} as const;
export type AmountName = keyof typeof AMOUNTS;

/**
 * Factors the person stated as numbers: "25% weaker" → 0.75, "half as much" → 0.5, "20% more" → 1.2. A refinement
 * may use one of these or a named amount, nothing else.
 */
export function readStatedFactors(message: string): number[] {
  const text = clean(message);
  const out: number[] = [];
  for (const match of text.matchAll(/\b([0-9]{1,2}(?:\.[0-9])?) ?% (weaker|less|softer|smaller|gentler|lighter|lower)\b/g)) out.push(round2(1 - Number(match[1]) / 100));
  for (const match of text.matchAll(/\b([0-9]{1,3}(?:\.[0-9])?) ?% (stronger|more|bigger|harder|deeper)\b/g)) out.push(round2(Math.min(2, 1 + Number(match[1]) / 100)));
  if (/\bhalf (as much|the amount|of that|of it)|\bhalve\b|\bby half\b/.test(text)) out.push(0.5);
  if (/\b(twice|double) (as much|the amount)\b/.test(text)) out.push(2);
  return [...new Set(out)];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A question about the mix or a concept, as opposed to an instruction. */
export function isQuestion(message: string): boolean {
  const text = clean(message);
  return text.endsWith("?") || QUESTION_LEAD.test(text) || /^(explain|tell me|show me why)\b/.test(text);
}
