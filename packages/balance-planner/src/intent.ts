import { SECTION_TYPES, TRACK_ROLE_LABELS, type ProjectDocument, type Track, type TrackRole } from "@audiosous/project-model";

/**
 * Deterministic level/prominence reading of free-text intent.
 * This is a phrase table, not language understanding. Anything it cannot read is ignored.
 */
export type IntentTier = "primary" | "focal" | "supporting" | "background";

export interface IntentClause {
  tier: IntentTier;
  /** The clause the level instruction came from, for explanations. */
  text: string;
}

export interface SectionIntentTarget {
  tier: IntentTier;
  text: string;
}

export interface AmbiguousReference {
  sectionId: string;
  word: string;
  trackIds: string[];
  text: string;
}

export interface SectionIntentIndex {
  /** sectionId -> trackId -> target read from section.userIntent. */
  targets: Map<string, Map<string, SectionIntentTarget>>;
  ambiguous: AmbiguousReference[];
}

const NEGATION = /\b(don'?t|do not|not|never|no longer|shouldn'?t|should not|isn'?t|aren'?t)\b/;

// Reduce phrases are checked first so "less prominent" never reads as "prominent".
const BACKGROUND_PATTERNS: RegExp[] = [
  /\bless (prominent|dominant|present|loud|forward|up front|upfront|featured)\b/,
  /\b(quieter|softer|lower in the mix)\b/,
  /\b(recede|receding|recessed|underneath|behind|tuck|tucked|subtle|background|sit back|sits back|out of the way)\b/,
  /\b(pull|push|sit|set|move|turn|bring|tuck|ease)(?:\s+[a-z0-9'-]+){0,3}\s+(back|down|away)\b/,
];

const FOCAL_PATTERNS: RegExp[] = [
  /\b(dominate|dominates|dominant|more dominant|prominent|more prominent|stand out|stands out|more present|louder|focal)\b/,
  /\b(feature|featured|foreground|up front|upfront|take the lead|takes the lead|solo)\b/,
  /\b(bring|push|pull|turn|move)(?:\s+[a-z0-9'-]+){0,3}\s+(forward|up|out front)\b/,
];

const PRIMARY_PATTERN = /\b(primary|foundation|front and center)\b/;
const SUPPORTING_PATTERN = /\b(supporting|support|accompaniment)\b/;

// Words after which the clause names the reference, not the target ("the pad quieter than the lead").
const COMPARATOR = /\b(than|behind|under|underneath|below|beneath|over|above|against|relative to|compared to)\b/;

// Phrases whose words would otherwise look like a track reference.
const IDIOMS = /\b(take|takes|taking) the lead\b/g;

// Single words that never identify a track on their own, including section names ("Drop FX" is not "the drop").
const NAME_STOPWORDS = new Set([
  "the", "and", "track", "stem", "bus", "mix", "main", "final", "audio", "wav", "flac", "mp3", "aif", "aiff",
  "up", "back", "down", "big", "low", "high",
  ...SECTION_TYPES.flatMap((type) => type.split("-")).map(stem),
]);

const ROLE_ALIASES: Partial<Record<TrackRole, string[]>> = {
  "snare-clap": ["snare", "clap"],
  "hi-hat": ["hat", "hihat", "hi hat"],
  percussion: ["perc"],
  drums: ["drum", "kit"],
  vocal: ["vox", "voice", "singer"],
  "backing-vocal": ["backing vocal", "backing vox", "bvs", "harmony"],
  brass: ["trumpet", "horn", "trombone", "sax"],
  strings: ["string", "violin", "viola", "cello"],
  keys: ["piano", "key"],
  atmosphere: ["atmos", "ambience"],
};

/** Read one clause-separated note. Conflicting or negated level words yield null. */
export function tierFromText(text: string | null | undefined): IntentClause | null {
  if (!text) return null;
  const found = clauses(text)
    .map((clause) => ({ clause, tier: clauseTier(clause) }))
    .filter((item): item is { clause: string; tier: IntentTier } => item.tier !== null);
  if (found.length === 0) return null;
  const tiers = new Set(found.map((item) => item.tier));
  if (tiers.size > 1) return null;
  return { tier: found[0]!.tier, text: found[0]!.clause };
}

/**
 * Track × Section note. Clauses that clearly name a different track are skipped,
 * so "let the lead dominate" written on the pad row does not lift the pad.
 */
export function trackIntentTier(document: ProjectDocument, track: Track, text: string | null | undefined): IntentClause | null {
  if (!text) return null;
  const dictionary = buildDictionary(document.tracks);
  const kept = clauses(text).filter((clause) => {
    const refs = references(subjectPart(clause), dictionary);
    if (refs.length === 0) return true;
    return refs.some((ref) => ref.trackIds.includes(track.id));
  });
  return tierFromText(kept.join(". "));
}

/** Section notes only count when a clause names exactly one track and carries a level instruction. */
export function indexSectionIntent(document: ProjectDocument): SectionIntentIndex {
  const dictionary = buildDictionary(document.tracks);
  const targets = new Map<string, Map<string, SectionIntentTarget>>();
  const ambiguous: AmbiguousReference[] = [];
  for (const section of document.sections) {
    if (!section.userIntent) continue;
    const perTrack = new Map<string, SectionIntentTarget[]>();
    for (const clause of clauses(section.userIntent)) {
      const tier = clauseTier(clause);
      if (!tier) continue;
      for (const ref of references(subjectPart(clause), dictionary)) {
        if (ref.trackIds.length !== 1) {
          ambiguous.push({ sectionId: section.id, word: ref.word, trackIds: ref.trackIds, text: clause });
          continue;
        }
        const id = ref.trackIds[0]!;
        perTrack.set(id, [...(perTrack.get(id) ?? []), { tier, text: clause }]);
      }
    }
    const resolved = new Map<string, SectionIntentTarget>();
    for (const [trackId, items] of perTrack) {
      if (new Set(items.map((item) => item.tier)).size === 1) resolved.set(trackId, items[0]!);
    }
    if (resolved.size > 0) targets.set(section.id, resolved);
  }
  return { targets, ambiguous };
}

/** Sentence-level clauses of a note, in order. */
export function noteClauses(text: string): string[] {
  return clauses(text);
}

/**
 * Tracks named in the subject of one clause ("the pad is muddy under the lead" names the pad).
 * A word that matches more than one track comes back with every candidate; the caller decides.
 */
export function clauseTrackReferences(document: ProjectDocument, clause: string): Array<{ word: string; trackIds: string[] }> {
  return references(subjectPart(clause), buildDictionary(document.tracks));
}

function clauses(text: string): string[] {
  return text
    .split(/[.!?;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function clauseTier(clause: string): IntentTier | null {
  const value = normalize(clause);
  if (NEGATION.test(value)) return null;
  const reduce = BACKGROUND_PATTERNS.some((pattern) => pattern.test(value));
  // "less prominent" is a reduce phrase; drop it before looking for lift words.
  const liftText = value.replace(/\bless (prominent|dominant|present|loud|forward|up front|upfront|featured)\b/g, " ");
  const lift = FOCAL_PATTERNS.some((pattern) => pattern.test(liftText));
  const primary = PRIMARY_PATTERN.test(value);
  const supporting = SUPPORTING_PATTERN.test(value);
  const hits = [reduce, lift, primary, supporting].filter(Boolean).length;
  if (hits !== 1) return null;
  if (reduce) return "background";
  if (lift) return "focal";
  if (primary) return "primary";
  return "supporting";
}

function subjectPart(clause: string): string {
  const value = normalize(clause).replace(IDIOMS, " ");
  const match = COMPARATOR.exec(value);
  return match ? value.slice(0, match.index) : value;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function tokens(text: string): string[] {
  return normalize(text)
    .replace(/'/g, "")
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map(stem);
}

interface DictionaryEntry {
  byName: Set<string>;
  byRole: Set<string>;
}

type Dictionary = Map<string, DictionaryEntry>;

const dictionaries = new WeakMap<Track[], Dictionary>();

function buildDictionary(tracks: Track[]): Dictionary {
  const cached = dictionaries.get(tracks);
  if (cached) return cached;
  const dictionary: Dictionary = new Map();
  dictionaries.set(tracks, dictionary);
  const add = (phrase: string[], trackId: string, kind: "byName" | "byRole") => {
    if (phrase.length === 0) return;
    const key = phrase.join(" ");
    const entry = dictionary.get(key) ?? { byName: new Set<string>(), byRole: new Set<string>() };
    entry[kind].add(trackId);
    dictionary.set(key, entry);
  };
  for (const track of tracks) {
    for (const label of [track.name, track.customLabel ?? ""]) {
      const words = tokens(label);
      add(words, track.id, "byName");
      for (const word of words) {
        if (/^\d+$/.test(word) || NAME_STOPWORDS.has(word) || (word.length < 3 && word !== "fx")) continue;
        add([word], track.id, "byName");
      }
    }
    if (track.role === "other") continue;
    add(tokens(TRACK_ROLE_LABELS[track.role]), track.id, "byRole");
    for (const alias of ROLE_ALIASES[track.role] ?? []) add(tokens(alias), track.id, "byRole");
  }
  return dictionary;
}

interface Reference {
  word: string;
  trackIds: string[];
}

/** Longest-match scan. A name match beats a role match for the same word. */
function references(text: string, dictionary: Dictionary): Reference[] {
  const words = tokens(text);
  const longest = Math.max(1, ...[...dictionary.keys()].map((key) => key.split(" ").length));
  const refs: Reference[] = [];
  let index = 0;
  while (index < words.length) {
    let matched = false;
    for (let size = Math.min(longest, words.length - index); size >= 1; size -= 1) {
      const key = words.slice(index, index + size).join(" ");
      const entry = dictionary.get(key);
      if (!entry) continue;
      const ids = entry.byName.size > 0 ? entry.byName : entry.byRole;
      refs.push({ word: key, trackIds: [...ids].sort() });
      index += size;
      matched = true;
      break;
    }
    if (!matched) index += 1;
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = ref.trackIds.join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
