import { clauseTrackReferences, noteClauses } from "@audiosous/balance-planner";
import type { ProjectDocument, Track } from "@audiosous/project-model";

/**
 * Deterministic reading of dynamics words in section and Track × Section notes. A phrase table, not language
 * understanding. A word only biases a decision the measurements already support; it never creates one alone.
 *
 *   control  controlled, control, even, consistent, steady, stable, smooth, glue, compress
 *   natural  natural, dynamic, expressive, breathe, open, alive, uncompressed, raw
 *   punch    punchy, punch, snappy, snap, crisp, attack, transients
 *   soften   soft, softer, gentle, tame, rounder, less spiky, less clicky
 *   duck     duck, ducking, sidechain, make room for, out of the way of, punch through, cut through, behind, under
 *   pump     pump, pumping (an explicit request for an audible, stylized duck)
 *
 * A negated clause is ignored. A clause asking for both control and natural is ignored. A pair instruction
 * ("Make the kick punch through the bass", "Keep the pad behind the vocal") needs one stem on each side.
 */
export type DynamicsWord = "control" | "natural" | "punch" | "soften" | "duck" | "pump";

export interface DynamicsClause {
  words: DynamicsWord[];
  text: string;
}

export interface PairInstruction {
  sectionId: string;
  keyTrackId: string;
  targetTrackId: string;
  pump: boolean;
  text: string;
}

export interface DynamicsIntentIndex {
  /** trackId → sectionId → clauses read for that stem (its Track × Section note, or a section note naming it). */
  tracks: Map<string, Map<string, DynamicsClause[]>>;
  pairs: PairInstruction[];
  ambiguous: Array<{ sectionId: string; word: string; trackIds: string[]; text: string }>;
}

const NEGATION = /\b(don'?t|do not|not|never|no longer|shouldn'?t|should not|isn'?t|aren'?t|no)\b/;
const PATTERNS: Array<[DynamicsWord, RegExp]> = [
  ["control", /\b(controlled|control|even|evenly|consistent|steady|stable|smooth|smoother|glue|glued|compress|compressed)\b/],
  ["natural", /\b(natural|dynamic|expressive|breathe|breathing|breathes|open|alive|uncompressed|raw)\b/],
  ["punch", /\b(punchy|punch|punchier|snappy|snap|crisp|attack|transients)\b/],
  ["soften", /\b(soft|softer|gentle|gentler|tame|tamed|rounder|round|less spiky|less clicky|less harsh)\b/],
  ["duck", /\b(duck|ducks|ducked|ducking|sidechain|side-chain|side chain|make room for|out of the way of|punch through|punches through|cut through|cuts through|behind|under|beneath)\b/],
  ["pump", /\b(pump|pumps|pumping)\b/],
];
/** Where the key stem is named after the target: "keep the pad behind the vocal", "duck the bass from the kick". */
const TARGET_FIRST = /\b(behind|under|beneath|below|out of the way of|room for|from|to|with|against)\b/;
/** Where the key stem is named first: "let the kick punch through the bass". */
const KEY_FIRST = /\b(punch through|punches through|cut through|cuts through|through|over)\b/;

export function dynamicsClause(clause: string): DynamicsClause | null {
  const value = normalize(clause);
  if (NEGATION.test(value)) return null;
  const words = PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([word]) => word);
  // "punch through" is a pair phrase, not a request for punchier transients.
  const withoutPair = value.replace(/\b(punch|punches|cut|cuts) through\b/g, " ");
  const filtered = words.filter((word) => word !== "punch" || /\b(punchy|punch|punchier|snappy|snap|crisp|attack|transients)\b/.test(withoutPair));
  if (filtered.includes("control") && filtered.includes("natural")) return null;
  return filtered.length > 0 ? { words: filtered, text: clause.trim() } : null;
}

export function indexDynamicsIntent(document: ProjectDocument): DynamicsIntentIndex {
  const tracks = new Map<string, Map<string, DynamicsClause[]>>();
  const pairs: PairInstruction[] = [];
  const ambiguous: DynamicsIntentIndex["ambiguous"] = [];
  const add = (trackId: string, sectionId: string, clause: DynamicsClause) => {
    if (!tracks.has(trackId)) tracks.set(trackId, new Map());
    const bySection = tracks.get(trackId)!;
    bySection.set(sectionId, [...(bySection.get(sectionId) ?? []), clause]);
  };
  const readPair = (sectionId: string, text: string, clause: DynamicsClause, owner: Track | null): boolean => {
    if (!clause.words.includes("duck") && !clause.words.includes("pump")) return false;
    const value = normalize(text);
    const keyFirst = KEY_FIRST.exec(value);
    const targetFirst = TARGET_FIRST.exec(value);
    const split = keyFirst ?? targetFirst;
    if (!split) return false;
    const before = single(document, value.slice(0, split.index), sectionId, text, ambiguous) ?? (keyFirst ? null : owner?.id ?? null);
    const after = single(document, value.slice(split.index + split[0].length), sectionId, text, ambiguous);
    if (!before || !after || before === after) return false;
    const [keyTrackId, targetTrackId] = keyFirst && split === keyFirst ? [before, after] : [after, before];
    pairs.push({ sectionId, keyTrackId, targetTrackId, pump: clause.words.includes("pump"), text: clause.text });
    return true;
  };
  for (const row of document.sectionTrackSettings) {
    if (!row.userIntent) continue;
    const owner = document.tracks.find((track) => track.id === row.trackId) ?? null;
    for (const text of noteClauses(row.userIntent)) {
      const clause = dynamicsClause(text);
      if (!clause) continue;
      if (readPair(row.sectionId, text, clause, owner)) continue;
      // A Track × Section note speaks for its own stem unless the clause clearly names another one.
      const named = clauseTrackReferences(document, text).flatMap((reference) => reference.trackIds);
      if (named.length > 0 && !named.includes(row.trackId)) continue;
      add(row.trackId, row.sectionId, clause);
    }
  }
  for (const section of document.sections) {
    if (!section.userIntent) continue;
    for (const text of noteClauses(section.userIntent)) {
      const clause = dynamicsClause(text);
      if (!clause) continue;
      if (readPair(section.id, text, clause, null)) continue;
      const trackId = single(document, normalize(text), section.id, text, ambiguous);
      if (trackId) add(trackId, section.id, clause);
    }
  }
  return { tracks, pairs, ambiguous };
}

/** Words read for a stem in a section, Track × Section note first. */
export function wordsFor(index: DynamicsIntentIndex, trackId: string, sectionId: string | null): { words: Set<DynamicsWord>; text: string | null } {
  if (!sectionId) return { words: new Set(), text: null };
  const clauses = index.tracks.get(trackId)?.get(sectionId) ?? [];
  return { words: new Set(clauses.flatMap((clause) => clause.words)), text: clauses[0]?.text ?? null };
}

/** The one stem a phrase names, or null. A word that could be several stems is recorded and not guessed. */
function single(document: ProjectDocument, text: string, sectionId: string, original: string, ambiguous: DynamicsIntentIndex["ambiguous"]): string | null {
  const references = clauseTrackReferences(document, text);
  const ids = new Set<string>();
  for (const reference of references) {
    if (reference.trackIds.length > 1) {
      ambiguous.push({ sectionId, word: reference.word, trackIds: reference.trackIds, text: original.trim() });
      return null;
    }
    for (const id of reference.trackIds) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
}
