import { clauseTrackReferences, noteClauses } from "@audiosous/balance-planner";
import type { ProjectDocument, Track } from "@audiosous/project-model";

/**
 * Deterministic reading of spatial words in section and Track × Section notes.
 * A phrase table, not language understanding. Only these concepts are read:
 *
 *   wider     wide, wider, widen, spread, spread out, surround
 *   narrower  narrow, narrower, narrow down, focused, intimate
 *   center    centered, center, centre, in the middle, down the middle
 *   left      left, to the left, push … left, pan … left
 *   right     right, to the right, push … right, pan … right
 *
 * Tone words (warm, punchy, bright, aggressive, big) are never spatial instructions. A negated clause
 * is ignored. A clause that names a stem with a word that fits several stems is not guessed.
 */
export type SpatialWord = "wider" | "narrower" | "center" | "left" | "right";

export interface SpatialClause {
  word: SpatialWord;
  /** "surround" asks for the background to wrap around; it only widens Background elements. */
  surround: boolean;
  text: string;
}

export interface SpatialInstruction extends SpatialClause {
  sectionId: string;
  /** Where the instruction came from, highest precedence first. */
  source: "track-intent" | "section-intent" | "section-general";
}

export interface AmbiguousSpatialReference {
  sectionId: string;
  word: string;
  trackIds: string[];
  text: string;
}

export interface SpatialIntentIndex {
  /** sectionId → trackId → instructions that name or belong to that track. */
  tracks: Map<string, Map<string, SpatialInstruction[]>>;
  /** sectionId → instructions for the section as a whole ("make the breakdown wider"). */
  general: Map<string, SpatialInstruction[]>;
  ambiguous: AmbiguousSpatialReference[];
}

const NEGATION = /\b(don'?t|do not|not|never|no longer|shouldn'?t|should not|isn'?t|aren'?t|no)\b/;
const WIDER = /\b(wide|wider|widen|widened|widening|spread|spread out|surround|surrounding)\b/;
const NARROWER = /\b(narrow|narrower|narrowed|narrow down|focused|intimate)\b/;
const CENTER = /\b(centered|centred|center|centre|in the middle|down the middle)\b/;
const LEFT = /\b(left)\b/;
const RIGHT = /\b(right)\b/;
/** "right" as an adverb or adjective, not a side. */
const RIGHT_IDIOM = /\b(right now|right away|right here|right there|all right|alright|right before|right after|right at|right on|just right|sounds right|feel right|feels right)\b/g;
const DIRECTION_WORDS = /\b(left|right|center|centre|centered|centred|middle|wide|wider|narrow|narrower)\b/g;

export function spatialClause(clause: string): SpatialClause | null {
  const value = normalize(clause).replace(RIGHT_IDIOM, " ");
  if (NEGATION.test(value)) return null;
  const found: SpatialWord[] = [];
  if (WIDER.test(value)) found.push("wider");
  if (NARROWER.test(value)) found.push("narrower");
  if (CENTER.test(value)) found.push("center");
  if (LEFT.test(value)) found.push("left");
  if (RIGHT.test(value)) found.push("right");
  if (found.length !== 1) return null;
  return { word: found[0]!, surround: /\bsurround/.test(value), text: clause.trim() };
}

export function indexSpatialIntent(document: ProjectDocument): SpatialIntentIndex {
  const tracks: SpatialIntentIndex["tracks"] = new Map();
  const general: SpatialIntentIndex["general"] = new Map();
  const ambiguous: AmbiguousSpatialReference[] = [];
  const add = (sectionId: string, trackId: string, instruction: SpatialInstruction) => {
    const perSection = tracks.get(sectionId) ?? new Map<string, SpatialInstruction[]>();
    perSection.set(trackId, [...(perSection.get(trackId) ?? []), instruction]);
    tracks.set(sectionId, perSection);
  };
  for (const section of document.sections) {
    if (section.userIntent) {
      for (const clause of noteClauses(section.userIntent)) {
        const read = spatialClause(clause);
        if (!read) continue;
        const refs = references(document, clause);
        if (refs.length === 0) {
          // Only width words make sense for a whole section. "Left" with no stem named is not guessed.
          if (read.word === "wider" || read.word === "narrower") {
            general.set(section.id, [...(general.get(section.id) ?? []), { ...read, sectionId: section.id, source: "section-general" }]);
          }
          continue;
        }
        if (refs.length > 1 && (read.word === "left" || read.word === "right")) {
          // "Push the guitar and the piano left" could be fine, but "guitar left, piano right" is two clauses
          // joined by a comma. Several stems with one direction are not split up by guessing.
          ambiguous.push({ sectionId: section.id, word: refs.map((ref) => ref.word).join(", "), trackIds: refs.flatMap((ref) => ref.trackIds), text: clause.trim() });
          continue;
        }
        for (const ref of refs) {
          if (ref.trackIds.length !== 1) {
            ambiguous.push({ sectionId: section.id, word: ref.word, trackIds: ref.trackIds, text: clause.trim() });
            continue;
          }
          add(section.id, ref.trackIds[0]!, { ...read, sectionId: section.id, source: "section-intent" });
        }
      }
    }
  }
  for (const row of document.sectionTrackSettings) {
    if (!row.userIntent) continue;
    const track = document.tracks.find((item) => item.id === row.trackId);
    if (!track) continue;
    for (const clause of noteClauses(row.userIntent)) {
      const read = spatialClause(clause);
      if (!read) continue;
      // A clause that clearly names a different stem is about that stem, not this row's.
      const refs = references(document, clause);
      if (refs.length > 0 && !refs.some((ref) => ref.trackIds.includes(track.id))) continue;
      add(row.sectionId, track.id, { ...read, sectionId: row.sectionId, source: "track-intent" });
    }
  }
  return { tracks, general, ambiguous };
}

/**
 * The instruction that holds for one track in one section, by precedence:
 * Track × Section note, then a section note naming the stem, then a whole-section instruction.
 * Conflicting instructions at the same level cancel.
 */
export function instructionFor(index: SpatialIntentIndex, sectionId: string, trackId: string): SpatialInstruction | null {
  const named = index.tracks.get(sectionId)?.get(trackId) ?? [];
  for (const source of ["track-intent", "section-intent"] as const) {
    const items = named.filter((item) => item.source === source);
    if (items.length === 0) continue;
    const words = new Set(items.map((item) => item.word));
    return words.size === 1 ? items[0]! : null;
  }
  const general = index.general.get(sectionId) ?? [];
  if (general.length === 0) return null;
  return new Set(general.map((item) => item.word)).size === 1 ? general[0]! : null;
}

/** Track references with direction words removed first, so "Gtr Left" is not named by "push the guitar left". */
function references(document: ProjectDocument, clause: string): Array<{ word: string; trackIds: string[] }> {
  const stripped = normalize(clause).replace(DIRECTION_WORDS, " ");
  return clauseTrackReferences(document, stripped);
}

export function namesTrack(document: ProjectDocument, track: Track, text: string): boolean {
  return references(document, text).some((ref) => ref.trackIds.includes(track.id));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
}
