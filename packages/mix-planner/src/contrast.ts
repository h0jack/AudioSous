import { noteClauses } from "@audiosous/balance-planner";
import type { ProjectDocument, SongSection } from "@audiosous/project-model";
import { clamp, round2, round3 } from "./changes";
import type { Survey } from "./survey";

/**
 * Section contrast: what a section note asks a section to be relative to the one before it, and whether the mix
 * already is. Only dimensions Audiosous can change and measure are read:
 *
 *   width       wider, wide, widen, spread, open up, bigger, larger, big, huge, massive
 *   punch       punchy, punchier, punch, hit harder, harder, impact, slam, snappy, bigger
 *   foreground  the lead / vocal / melody / hook stands out, forward, on top, dominates
 *
 * Loudness is never one of them: a section is not made "bigger" by turning it up. A negated clause is ignored.
 * The note only says where to look; the measurement decides whether anything is missing.
 */
export type ContrastDimension = "width" | "punch" | "foreground";

export interface ContrastReading {
  sectionId: string;
  previousId: string | null;
  asked: ContrastDimension[];
  text: string;
  /** 0 when the section already has what the note asks for; up to 0.6 when it clearly does not. */
  shortfall: number;
  dims: Partial<Record<ContrastDimension, { current: number; previous: number; unit: string }>>;
  evidence: Array<{ label: string; detail: string; value: number | null; unit: string | null }>;
}

const NEGATION = /\b(don'?t|do not|not|never|no longer|shouldn'?t|should not|isn'?t|aren'?t|no|less)\b/;
const WIDTH = /\b(wide|wider|widen|spread|open up|opens up|bigger|larger|big|huge|massive)\b/;
const PUNCH = /\b(punchy|punchier|punch|hit harder|hits harder|harder|impact|impactful|slam|slams|snappy|bigger)\b/;
const FOREGROUND = /\b(lead|vocal|vocals|melody|hook|topline)\b.*\b(stand out|stands out|forward|up front|on top|dominate|dominates|lead the)\b/;
const DRUMS = new Set(["kick", "snare-clap", "drums", "percussion", "hi-hat"]);

export function contrastClauses(text: string): { asked: ContrastDimension[]; text: string } | null {
  const asked = new Set<ContrastDimension>();
  const used: string[] = [];
  for (const clause of noteClauses(text)) {
    const value = clause.toLowerCase();
    if (NEGATION.test(value)) continue;
    const before = asked.size;
    if (WIDTH.test(value)) asked.add("width");
    if (PUNCH.test(value)) asked.add("punch");
    if (FOREGROUND.test(value)) asked.add("foreground");
    if (asked.size > before) used.push(clause.trim());
  }
  return asked.size > 0 ? { asked: [...asked], text: used.join(" ") } : null;
}

export function readContrast(survey: Survey): ContrastReading[] {
  const document = survey.document;
  const out: ContrastReading[] = [];
  const ordered = [...document.sections].sort((left, right) => left.startTime - right.startTime);
  for (const [index, section] of ordered.entries()) {
    if (!section.userIntent) continue;
    const read = contrastClauses(section.userIntent);
    if (!read) continue;
    const previous = ordered[index - 1] ?? null;
    const dims: ContrastReading["dims"] = {};
    const evidence: ContrastReading["evidence"] = [];
    let shortfall = 0;
    for (const dimension of read.asked) {
      const current = measure(survey, document, section, dimension);
      const before = previous ? measure(survey, document, previous, dimension) : measure(survey, document, null, dimension);
      if (current === null || before === null) continue;
      const unit = dimension === "width" ? "share" : "dB";
      dims[dimension] = { current: round3(current), previous: round3(before), unit };
      const against = previous ? previous.name : "the whole song";
      if (dimension === "width") {
        const missing = clamp((before + 0.02 - current) / 0.05, 0, 1);
        shortfall = Math.max(shortfall, missing);
        evidence.push({ label: "Width", detail: `Side share ${Math.round(current * 100)}% in ${section.name} against ${Math.round(before * 100)}% in ${against}${missing > 0 ? "" : ": already wider"}.`, value: round3(current - before), unit: "share" });
      } else if (dimension === "punch") {
        const missing = clamp((before + 1 - current) / 3, 0, 1);
        shortfall = Math.max(shortfall, missing);
        evidence.push({ label: "Punch", detail: `Drum attacks sit ${current.toFixed(1)} dB over the rest of the mix in ${section.name} against ${before.toFixed(1)} dB in ${against}${missing > 0 ? "" : ": already punchier"}.`, value: round2(current - before), unit: "dB" });
      } else {
        const missing = clamp((before + 0.5 - current) / 3, 0, 1);
        shortfall = Math.max(shortfall, missing);
        evidence.push({ label: "Foreground", detail: `The lead sits ${formatGap(current)} the supporting parts in ${section.name} against ${formatGap(before)} in ${against}${missing > 0 ? "" : ": already in front"}.`, value: round2(current - before), unit: "dB" });
      }
    }
    if (evidence.length === 0) continue;
    out.push({ sectionId: section.id, previousId: previous?.id ?? null, asked: read.asked, text: read.text, shortfall: round3(0.6 * shortfall), dims, evidence });
  }
  return out;
}

function formatGap(db: number): string {
  return `${Math.abs(db).toFixed(1)} dB ${db >= 0 ? "over" : "under"}`;
}

/** A section's (or the song's, with null) width, punch, or foreground, as the survey heard it. */
function measure(survey: Survey, document: ProjectDocument, section: SongSection | null, dimension: ContrastDimension): number | null {
  if (dimension === "punch") {
    const readings = (survey.dynamics?.readings ?? []).filter(
      (reading) => DRUMS.has(document.tracks.find((track) => track.id === reading.trackId)?.role ?? "other") && reading.attackOverMixDb !== null && (section ? reading.scope.type === "section" && reading.scope.sectionId === section.id : reading.scope.type === "global"),
    );
    if (readings.length === 0) return null;
    return readings.reduce((total, reading) => total + reading.attackOverMixDb!, 0) / readings.length;
  }
  const field = survey.space?.fields.find((item) => (section ? item.sectionId === section.id : item.sectionId === null));
  if (!field || field.tracks.length === 0) return null;
  if (dimension === "width") {
    // The width of the stereo parts around the centre: anchors (kick, snare, bass, lead, vocal) stay centred by design.
    let weighted = 0;
    let total = 0;
    for (const track of field.tracks) {
      const role = document.tracks.find((item) => item.id === track.trackId)?.role ?? "other";
      if (track.mono || ["kick", "snare-clap", "bass", "lead", "vocal"].includes(role)) continue;
      const power = 10 ** (track.levelDb / 10);
      weighted += power * track.image.sideShare;
      total += power;
    }
    return total > 0 ? weighted / total : null;
  }
  const isFront = (trackId: string, tier: string) => tier === "focal" || ["lead", "vocal"].includes(document.tracks.find((track) => track.id === trackId)?.role ?? "");
  const front = field.tracks.filter((track) => isFront(track.trackId, track.tier));
  const rest = field.tracks.filter((track) => !isFront(track.trackId, track.tier) && (track.tier === "supporting" || track.tier === "background"));
  if (front.length === 0 || rest.length === 0) return null;
  const loudest = Math.max(...front.map((track) => track.levelDb));
  const restDb = 10 * Math.log10(rest.reduce((sum, track) => sum + 10 ** (track.levelDb / 10), 0) / rest.length);
  return loudest - restDb;
}

/**
 * The section note in each planner's own vocabulary, for the dimensions that fall short: "wider" for Space, the
 * drum stems asked to be punchy for Dynamics, the lead brought forward for AutoBalance. The planners then size
 * evidence-backed moves inside that section; the full-mix planner picks the few that carry the contrast.
 */
export function translatedNotes(document: ProjectDocument, reading: ContrastReading): ProjectDocument {
  const missing = Object.entries(reading.dims)
    .filter(([dimension, value]) => value && (dimension === "width" ? value.current < value.previous + 0.02 : dimension === "punch" ? value.current < value.previous + 1 : value.current < value.previous + 0.5))
    .map(([dimension]) => dimension as ContrastDimension);
  const parts: string[] = [];
  if (missing.includes("width")) parts.push("Make it wider.");
  if (missing.includes("punch")) {
    for (const track of document.tracks.filter((item) => item.role === "kick" || item.role === "snare-clap")) parts.push(`Make the ${track.name} punchy.`);
  }
  if (missing.includes("foreground")) {
    const lead = document.tracks.find((track) => track.role === "lead" || track.role === "vocal");
    if (lead) parts.push(`Bring the ${lead.name} forward.`);
  }
  if (parts.length === 0) return document;
  return { ...document, sections: document.sections.map((section) => (section.id === reading.sectionId ? { ...section, userIntent: parts.join(" ") } : section)) };
}
