import { clauseTrackReferences, noteClauses } from "@audiosous/balance-planner";
import type { ProjectDocument, Track } from "@audiosous/project-model";
import { GRID_BANDS, toDb, type BandGrid } from "./spectra";

/**
 * Tone words in section and Track × Section notes. A short fixed table, not language understanding.
 * A word only proposes where to look. The track's own measured spectrum has to confirm it before
 * any filter is planned, and a word that names no single track is ignored.
 */
export interface TonalWord {
  id: "harsh" | "muddy" | "boomy" | "boxy" | "nasal" | "thin" | "dull" | "bright";
  pattern: RegExp;
  /** cut: the note complains about too much; boost: about too little. */
  direction: "cut" | "boost";
  lowHz: number;
  highHz: number;
  shape: "bell" | "low-shelf" | "high-shelf";
  label: string;
}

export const TONAL_WORDS: TonalWord[] = [
  { id: "harsh", pattern: /\b(harsh|harshness|piercing|shrill|brittle)\b/, direction: "cut", lowHz: 2_000, highHz: 5_000, shape: "bell", label: "harsh" },
  { id: "muddy", pattern: /\b(muddy|mud|murky)\b/, direction: "cut", lowHz: 200, highHz: 500, shape: "bell", label: "muddy" },
  { id: "boomy", pattern: /\b(boomy|boominess|tubby)\b/, direction: "cut", lowHz: 80, highHz: 200, shape: "bell", label: "boomy" },
  { id: "boxy", pattern: /\b(boxy|cardboard)\b/, direction: "cut", lowHz: 400, highHz: 900, shape: "bell", label: "boxy" },
  { id: "nasal", pattern: /\b(nasal|nasally|honky)\b/, direction: "cut", lowHz: 800, highHz: 2_000, shape: "bell", label: "nasal" },
  { id: "bright", pattern: /\b(too bright|too much top|sizzly|less bright|darker)\b/, direction: "cut", lowHz: 6_000, highHz: 14_000, shape: "high-shelf", label: "too bright" },
  { id: "thin", pattern: /\b(thin|too thin|weedy)\b/, direction: "boost", lowHz: 100, highHz: 300, shape: "low-shelf", label: "thin" },
  { id: "dull", pattern: /\b(dull|muffled|lifeless|brighter)\b/, direction: "boost", lowHz: 5_000, highHz: 12_000, shape: "high-shelf", label: "dull" },
];

const NEGATION = /\b(not|never|isn'?t|aren'?t|no longer|don'?t|doesn'?t|without)\b/;

export interface TonalRequest {
  trackId: string;
  sectionId: string;
  word: TonalWord;
  clause: string;
  source: "section-note" | "track-note";
}

export interface TonalAmbiguity {
  sectionId: string;
  word: string;
  trackIds: string[];
  clause: string;
}

export function readTonalNotes(document: ProjectDocument): { requests: TonalRequest[]; ambiguous: TonalAmbiguity[] } {
  const requests: TonalRequest[] = [];
  const ambiguous: TonalAmbiguity[] = [];
  for (const section of document.sections) {
    for (const clause of noteClauses(section.userIntent ?? "")) {
      const word = wordIn(clause);
      if (!word) continue;
      const refs = clauseTrackReferences(document, clause);
      if (refs.length !== 1) {
        if (refs.length > 1) ambiguous.push({ sectionId: section.id, word: word.label, trackIds: refs.flatMap((ref) => ref.trackIds), clause });
        continue;
      }
      const ref = refs[0]!;
      if (ref.trackIds.length !== 1) {
        ambiguous.push({ sectionId: section.id, word: word.label, trackIds: ref.trackIds, clause });
        continue;
      }
      requests.push({ trackId: ref.trackIds[0]!, sectionId: section.id, word, clause, source: "section-note" });
    }
  }
  for (const row of document.sectionTrackSettings) {
    for (const clause of noteClauses(row.userIntent ?? "")) {
      const word = wordIn(clause);
      if (!word) continue;
      const refs = clauseTrackReferences(document, clause);
      // A Track × Section note speaks about its own track unless a clause clearly names another one.
      if (refs.length > 0 && !refs.some((ref) => ref.trackIds.includes(row.trackId))) continue;
      requests.push({ trackId: row.trackId, sectionId: row.sectionId, word, clause, source: "track-note" });
    }
  }
  // A Track × Section note outranks a section note for the same track, section, and word.
  const seen = new Set<string>();
  const ordered = [...requests].sort((left, right) => (left.source === right.source ? 0 : left.source === "track-note" ? -1 : 1));
  return {
    requests: ordered.filter((request) => {
      const key = `${request.trackId}:${request.sectionId}:${request.word.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    ambiguous,
  };
}

function wordIn(clause: string): TonalWord | null {
  const value = clause.toLowerCase().replace(/[’]/g, "'");
  if (NEGATION.test(value)) return null;
  const found = TONAL_WORDS.filter((word) => word.pattern.test(value));
  // Two tone words in one clause ("harsh and muddy") are only read when they agree in direction; the first wins.
  if (found.length === 0) return null;
  if (new Set(found.map((word) => word.direction)).size > 1) return null;
  return found[0]!;
}

export interface TonalEvidence {
  /** Level of the region against the track's own straight-line spectral trend, dB. */
  excessDb: number;
  peakBand: number;
  confirmed: boolean;
}

/**
 * Compares a region with a straight line fitted through the track's own band levels (log frequency),
 * so a naturally bright or dark source is judged against itself.
 */
export function tonalEvidence(grid: BandGrid, bands: Float64Array, word: TonalWord): TonalEvidence {
  const levels = Array.from(bands, (value) => toDb(value));
  const loudest = Math.max(...levels);
  const fit: Array<{ x: number; y: number }> = [];
  for (let band = 0; band < GRID_BANDS; band += 1) {
    const hz = grid.centers[band]!;
    if (hz < 60 || hz > 14_000 || levels[band]! < loudest - 45) continue;
    fit.push({ x: Math.log2(hz), y: levels[band]! });
  }
  if (fit.length < 6) return { excessDb: 0, peakBand: -1, confirmed: false };
  const meanX = fit.reduce((sum, point) => sum + point.x, 0) / fit.length;
  const meanY = fit.reduce((sum, point) => sum + point.y, 0) / fit.length;
  const slope =
    fit.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / Math.max(1e-9, fit.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0));
  const residual = (band: number) => levels[band]! - (meanY + slope * (Math.log2(grid.centers[band]!) - meanX));
  const inside: number[] = [];
  for (let band = 0; band < GRID_BANDS; band += 1) {
    const hz = grid.centers[band]!;
    if (hz >= word.lowHz && hz < word.highHz) inside.push(band);
  }
  if (inside.length === 0) return { excessDb: 0, peakBand: -1, confirmed: false };
  const excessDb = inside.reduce((sum, band) => sum + residual(band), 0) / inside.length;
  const peakBand = word.direction === "cut" ? inside.reduce((best, band) => (residual(band) > residual(best) ? band : best)) : inside[0]!;
  const confirmed = word.direction === "cut" ? excessDb >= 1.5 : excessDb <= -1.5;
  return { excessDb: Math.round(excessDb * 10) / 10, peakBand, confirmed };
}

export function trackName(document: ProjectDocument, trackId: string): string {
  return document.tracks.find((track: Track) => track.id === trackId)?.name ?? trackId;
}
