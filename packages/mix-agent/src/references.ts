import { SECTION_TYPE_LABELS, TRACK_ROLE_LABELS, guessTrackRole, type ProjectDocument, type SongSection, type Track, type TrackRole } from "@audiosous/project-model";
import type { ConversationFocus } from "./contract";

/**
 * Deterministic resolution of what a person calls a stem or a section. The model may pass a name, a role word, or
 * an id; it is resolved here, against the project, never guessed by the model.
 */

export type TrackResolution =
  | { kind: "match"; trackIds: string[]; via: "id" | "name" | "role" | "selection" | "focus" | "group" }
  | { kind: "ambiguous"; trackIds: string[] }
  | { kind: "none" };

export type SectionResolution =
  | { kind: "match"; sectionIds: string[]; via: "id" | "name" | "ordinal" | "type" | "selection" | "playhead" | "focus" }
  | { kind: "ambiguous"; sectionIds: string[] }
  | { kind: "none" };

export interface ReferenceContext {
  selectedTrackId: string | null;
  selectedSectionId: string | null;
  playheadSeconds: number;
  focus: ConversationFocus;
}

export function referenceContext(document: ProjectDocument, focus: ConversationFocus): ReferenceContext {
  return { selectedTrackId: document.uiState.selectedTrackId, selectedSectionId: document.uiState.selectedSectionId, playheadSeconds: document.uiState.playheadSeconds, focus };
}

export function trackName(track: Pick<Track, "name" | "customLabel">): string {
  return track.customLabel?.trim() || track.name;
}

const DEICTIC_TRACK = /^(this|that|it|this one|that one|this track|that track|this stem|that stem|the selected (track|stem)|selected (track|stem))$/;
/** "that synth", "this bass": a pointer plus a role or name word. */
const POINTER = /^(this|that|the selected)\s+/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'%.+\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripArticle(text: string): string {
  return text.replace(/^(the|my|our|a|an)\s+/, "");
}

function words(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

/** Every role word the project already uses, singular and plural ("pad", "pads", "backing vocal"). */
function roleWords(role: TrackRole): string[] {
  const label = TRACK_ROLE_LABELS[role].toLowerCase();
  const out = [label, `${label}s`];
  if (role === "snare-clap") out.push("snare", "snares", "clap", "claps");
  if (role === "hi-hat") out.push("hat", "hats", "hihat", "hihats", "hi hat", "hi hats");
  if (role === "brass") out.push("horn", "horns", "trumpet", "trumpets", "sax");
  if (role === "backing-vocal") out.push("backing vocals", "bvs", "harmonies");
  if (role === "atmosphere") out.push("atmos", "ambience");
  if (role === "drums") out.push("drum", "kit");
  if (role === "percussion") out.push("perc");
  return out;
}

const PLURAL_GROUP = /^(all( the)?|every|both( the)?)\s+/;

/** Words that qualify a stem's name rather than say what it is ("Trumpet Main", "Bass Bus", "Kick Room"). */
const QUALIFIERS = new Set(["bus", "main", "room", "double", "dbl", "group", "stem", "track", "take", "mix", "layer", "l", "r", "left", "right", "di", "amp", "print", "fx", "wet", "dry", "close", "far", "top", "bottom", "in", "out"]);

/** The noun a stem's name is about: its last word that is not a qualifier or a number. */
function headWord(label: string): string | null {
  const list = words(label.replace(/[_-]+/g, " ")).filter((word) => !/^\d+$/.test(word) && !/^take\d*$/.test(word));
  for (let index = list.length - 1; index >= 0; index -= 1) if (!QUALIFIERS.has(list[index]!)) return list[index]!;
  return null;
}

function union(left: Track[], right: Track[]): Track[] {
  return [...left, ...right.filter((track) => !left.includes(track))];
}

/**
 * Resolves a stem reference. A pronoun goes to the selected stem, then the conversation's focus. A name beats a
 * role; a role matches by the stems' roles and by the role patterns used at import ("trumpet" is brass). When
 * several stems fit equally, the selected or focused one wins; otherwise the result is ambiguous and the agent asks.
 */
export function resolveTrack(document: ProjectDocument, reference: string, ctx: ReferenceContext): TrackResolution {
  const raw = normalize(reference);
  if (!raw) return { kind: "none" };
  const byId = document.tracks.find((track) => track.id === reference.trim());
  if (byId) return { kind: "match", trackIds: [byId.id], via: "id" };
  const tracks = document.tracks;
  const phrase = stripArticle(raw);
  if (DEICTIC_TRACK.test(phrase)) {
    if (ctx.selectedTrackId && tracks.some((track) => track.id === ctx.selectedTrackId)) return { kind: "match", trackIds: [ctx.selectedTrackId], via: "selection" };
    const focused = ctx.focus.trackIds.filter((id) => tracks.some((track) => track.id === id));
    if (focused.length === 1) return { kind: "match", trackIds: focused, via: "focus" };
    return focused.length > 1 ? { kind: "ambiguous", trackIds: focused } : { kind: "none" };
  }
  const pointed = POINTER.test(phrase);
  const group = PLURAL_GROUP.test(phrase);
  const core = phrase.replace(POINTER, "").replace(PLURAL_GROUP, "").trim();
  if (!core) return { kind: "none" };

  // Whole name or label.
  const exact = tracks.filter((track) => normalize(track.name) === core || (track.customLabel && normalize(track.customLabel) === core));
  if (exact.length === 1) return { kind: "match", trackIds: [exact[0]!.id], via: "name" };

  const coreWords = core.split(" ");
  const singular = core.replace(/s$/, "");
  const guessed = guessTrackRole(core) !== "other" ? guessTrackRole(core) : guessTrackRole(singular);
  const byRole = tracks.filter((track) => roleWords(track.role).includes(core) || (guessed !== "other" && track.role === guessed));
  let named: Track[];
  if (coreWords.length > 1) {
    // Every word of the reference appears in the name or label ("bass bus", "lead vocal").
    named = tracks.filter((track) => {
      const nameWords = new Set([...words(track.name), ...words(track.customLabel ?? "")]);
      return coreWords.every((word) => nameWords.has(word) || nameWords.has(word.replace(/s$/, "")));
    });
  } else {
    // One word names a stem when it is the head of its name: "synth" is "Lead Synth" and "Subway Synth", but "bass"
    // is not "Bass Drum Room" (a kind of drum).
    named = tracks.filter((track) =>
      [track.name, track.customLabel ?? ""].some((label) => {
        const head = headWord(label);
        return head !== null && (head === core || head === singular || `${head}s` === core);
      }),
    );
  }
  const plural = group || (core.endsWith("s") && !named.some((track) => words(trackName(track)).includes(core)) && byRole.length + named.length > 1);

  let pool: Track[];
  if (plural) pool = union(named, byRole);
  else if (named.length === 1) pool = named;
  else if (named.length > 1) pool = coreWords.length === 1 ? union(named, byRole) : named;
  else pool = byRole;
  if (pool.length === 0) return { kind: "none" };
  if (pool.length === 1) return { kind: "match", trackIds: [pool[0]!.id], via: named.length > 0 ? "name" : "role" };
  if (plural) return { kind: "match", trackIds: pool.map((track) => track.id), via: "group" };
  const ids = pool.map((track) => track.id);
  if (ctx.selectedTrackId && ids.includes(ctx.selectedTrackId)) return { kind: "match", trackIds: [ctx.selectedTrackId], via: "selection" };
  const focused = ctx.focus.trackIds.filter((id) => ids.includes(id));
  if (focused.length === 1) return { kind: "match", trackIds: focused, via: "focus" };
  if (pointed && focused.length === 0 && ctx.selectedTrackId === null) return { kind: "ambiguous", trackIds: ids };
  return { kind: "ambiguous", trackIds: ids };
}

/* ------------------------------------------------------------------ sections */

const HERE = /^(here|now|this section|this part|that section|that part|the current section|current section|where we are( now)?|where i am|this bit|the selected section|selected section|this|that)$/;
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1, final: -1 };

export function sectionAt(document: ProjectDocument, seconds: number): SongSection | null {
  return document.sections.find((section) => seconds >= section.startTime && seconds < section.endTime) ?? null;
}

function sectionWords(section: SongSection): string[] {
  const out = [normalize(section.name)];
  if (section.type && section.type !== "custom") out.push(SECTION_TYPE_LABELS[section.type].toLowerCase());
  return out;
}

/**
 * Resolves a section reference: "Drop 2", "the second drop", "the last chorus", "the breakdown", "here" (the
 * selected section, else the one under the playhead). "The chorus" with several choruses means all of them: a
 * section type names a part of the song, and every chorus is that part.
 */
export function resolveSection(document: ProjectDocument, reference: string, ctx: ReferenceContext): SectionResolution {
  const raw = stripArticle(normalize(reference));
  if (!raw) return { kind: "none" };
  const sections = [...document.sections].sort((left, right) => left.startTime - right.startTime);
  const byId = sections.find((section) => section.id === reference.trim());
  if (byId) return { kind: "match", sectionIds: [byId.id], via: "id" };
  if (HERE.test(raw)) {
    if (ctx.selectedSectionId && sections.some((section) => section.id === ctx.selectedSectionId)) return { kind: "match", sectionIds: [ctx.selectedSectionId], via: "selection" };
    const at = sectionAt(document, ctx.playheadSeconds);
    if (at) return { kind: "match", sectionIds: [at.id], via: "playhead" };
    if (ctx.focus.sectionId) return { kind: "match", sectionIds: [ctx.focus.sectionId], via: "focus" };
    return { kind: "none" };
  }
  const exact = sections.filter((section) => normalize(section.name) === raw);
  if (exact.length === 1) return { kind: "match", sectionIds: [exact[0]!.id], via: "name" };

  // "second drop", "drop 2", "the last chorus".
  const ordinal = raw.match(/^(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)\s+(.+)$/) ?? null;
  const numbered = raw.match(/^(.+?)\s+(\d+)$/) ?? null;
  const kindWord = ordinal ? ordinal[2]! : numbered ? numbered[1]! : raw;
  const index = ordinal ? ORDINALS[ordinal[1]!]! : numbered ? Number(numbered[2]) : null;
  const singular = kindWord.replace(/s$/, "");
  const ofKind = sections.filter((section) => sectionWords(section).some((word) => word === kindWord || word === singular || word.replace(/\s*\d+$/, "") === singular));
  if (ofKind.length === 0) return { kind: "none" };
  if (index !== null) {
    const pick = index === -1 ? ofKind.at(-1) : ofKind[index - 1];
    return pick ? { kind: "match", sectionIds: [pick.id], via: "ordinal" } : { kind: "none" };
  }
  return { kind: "match", sectionIds: ofKind.map((section) => section.id), via: ofKind.length === 1 ? "name" : "type" };
}

/* ------------------------------------------------------------------ mentions */

export interface Mention<T> {
  phrase: string;
  resolution: T;
}

const GENERIC = new Set([
  "mix", "song", "track", "tracks", "stem", "stems", "it", "this", "that", "the", "a", "an", "and", "or", "but", "more", "less", "louder", "quieter",
  "make", "can", "you", "me", "is", "are", "be", "feel", "feels", "sound", "sounds", "too", "very", "bit", "little", "out", "up", "down", "in", "on",
  "of", "to", "for", "with", "without", "not", "don't", "do", "keep", "just", "only", "all", "everything", "something", "whole", "here", "now", "there",
  "main", "bus", "group", "one", "two", "same", "thing", "way", "should", "would", "why", "what", "how", "my", "our", "your", "i", "we", "so", "low",
  "high", "end", "mid", "mids", "top", "side", "left", "right", "center", "centre", "wide", "wider", "narrow", "eq", "level", "levels", "gain",
]);

/**
 * Stems and sections a message mentions, longest phrase first, each resolved. Used to build a request's context and
 * to tell the model which references are ambiguous before it plans anything.
 */
export function findMentions(document: ProjectDocument, text: string, ctx: ReferenceContext): { tracks: Array<Mention<TrackResolution>>; sections: Array<Mention<SectionResolution>> } {
  const tokens = normalize(text).split(" ").filter(Boolean);
  const used = new Array<boolean>(tokens.length).fill(false);
  const tracks: Array<Mention<TrackResolution>> = [];
  const sections: Array<Mention<SectionResolution>> = [];
  for (let size = 4; size >= 1; size -= 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      if (used.slice(start, start + size).some(Boolean)) continue;
      const phrase = tokens.slice(start, start + size).join(" ");
      const bare = phrase.replace(/[.,!?]+$/, "");
      if (size === 1 && (GENERIC.has(bare) || bare.length < 3 || /^\d/.test(bare))) continue;
      if (bare.split(" ").every((word) => GENERIC.has(word))) continue;
      const section = sectionPhrase(bare) ? resolveSection(document, bare, ctx) : { kind: "none" as const };
      if (section.kind === "match" && section.via !== "selection" && section.via !== "playhead" && section.via !== "focus") {
        sections.push({ phrase: bare, resolution: section });
        used.fill(true, start, start + size);
        continue;
      }
      const track = resolveTrack(document, bare, ctx);
      if (track.kind !== "none" && track.kind === "match" && (track.via === "id" || track.via === "selection" || track.via === "focus") && size === 1 && !named(document, bare)) continue;
      if (track.kind !== "none") {
        tracks.push({ phrase: bare, resolution: track });
        used.fill(true, start, start + size);
      }
    }
  }
  // "here", "this section", "where we are": the selected section, else the playhead.
  const here = /\b(here|this section|this part|where we are|right now|at the moment)\b/.exec(normalize(text));
  if (here) {
    const resolution = resolveSection(document, here[1]!, ctx);
    if (resolution.kind === "match") sections.push({ phrase: here[1]!, resolution });
  }
  return { tracks, sections };
}

function sectionPhrase(phrase: string): boolean {
  return !/\b(this|that|it)\b/.test(phrase);
}

function named(document: ProjectDocument, word: string): boolean {
  return document.tracks.some((track) => words(trackName(track)).includes(word));
}

/** "Pad", or "Pad and Lead", for messages. */
export function namesOf(document: ProjectDocument, trackIds: readonly string[]): string {
  const names = trackIds.map((id) => document.tracks.find((track) => track.id === id)).filter((track): track is Track => Boolean(track)).map(trackName);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function sectionNamesOf(document: ProjectDocument, sectionIds: readonly string[]): string {
  const names = sectionIds.map((id) => document.sections.find((section) => section.id === id)?.name).filter((name): name is string => Boolean(name));
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
