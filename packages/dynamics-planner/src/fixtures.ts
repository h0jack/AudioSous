import type { CompressorNode, DynamicEqNode } from "@audiosous/project-model";
import { BASS, KICK, LEAD, PAD_MASKING, PAD_SEPARATED, base, bump, dipped, dynamicsSong, hits, notes, sum, wholeSong, type DynamicsSongInput, type DynamicsTrackInput } from "./test-fixtures";

/** The milestone's fixtures, shared by the planner, plan-contract, and desktop flow tests. */
export const SNARE_SHAPE = sum(base(-50, -1), bump(200, 0.6, 20), bump(3_000, 1, 14));
const UNEVEN = [0, -7, -2, -9, -1, -6, -3, -8];

export const kickTrack = (): DynamicsTrackInput => ({ id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 }, envelope: hits({ peakDb: -6, period: 0.5, attackDb: 3, decayMs: 80, lowDb: -1 }) });
export const unstableBass = (levelDb = -14) => notes({ levelDb, period: 0.5, offsets: UNEVEN, decayDb: 2, lowDb: -1 });
export const steadyBass = (levelDb = -14) => notes({ levelDb, period: 0.5, decayDb: 2, lowDb: -1 });
export const bassTrack = (envelope = unstableBass(), gainDb?: number): DynamicsTrackInput => ({ id: "bass", name: "Bass", role: "bass", gainDb, fixture: { shape: BASS }, envelope });
const twoSections = [
  { id: "verse", name: "Verse", type: "verse" as const, start: 0, end: 30 },
  { id: "drop", name: "Drop", type: "drop" as const, start: 30, end: 60 },
];

/** A: bass notes whose level jumps by up to 9 dB from note to note. */
export function fixtureA(extra: Partial<DynamicsSongInput> = {}) {
  return dynamicsSong({ tracks: [bassTrack()], ...extra });
}

/** B: a plucked bass with a high crest (12 dB of decay inside every note) but every note at the same level. */
export function fixtureB() {
  return dynamicsSong({ tracks: [bassTrack(notes({ levelDb: -12, period: 0.5, decayDb: 12, lowDb: -1, crestDb: 12 }))] });
}

/** C: a four-on-the-floor kick over a sustained bass that sits as loud as the kick in the low end on every hit. */
export function fixtureC(extra: Partial<DynamicsSongInput> & { bassGainDb?: number } = {}) {
  return dynamicsSong({ tracks: [kickTrack(), bassTrack(notes({ levelDb: -12, period: 0.5, decayDb: 1, lowDb: -1 }), extra.bassGainDb)], ...extra });
}

/** D: the same kick and bass, with the bass already dipping 12 dB under each hit in its own source. */
export function fixtureD() {
  return dynamicsSong({ tracks: [kickTrack(), bassTrack(dipped(notes({ levelDb: -12, period: 0.5, decayDb: 1, lowDb: -1 }), { period: 0.5, dipDb: 12, lengthMs: 120 }))] });
}

const leadPhrases: Array<[number, number]> = [
  [10, 20],
  [30, 40],
  [50, 60],
];

/** E: a pad that masks the lead's presence range, while the lead plays phrases half the time. */
export function fixtureE(extra: Partial<DynamicsSongInput> = {}) {
  return dynamicsSong({
    tracks: [
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: leadPhrases }, envelope: notes({ levelDb: -16, period: 0.4, decayDb: 2, lowDb: -30 }) },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING }, envelope: notes({ levelDb: -18, period: 2, decayDb: 1, lowDb: -15 }) },
    ],
    sections: wholeSong(),
    prominence: [{ track: "lead", section: "all", prominence: "focal" }],
    ...extra,
  });
}

/** F: the same pad over a lead that plays the whole song: persistent masking, a static-EQ problem. */
export function fixtureF() {
  return dynamicsSong({
    tracks: [
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD }, envelope: notes({ levelDb: -16, period: 0.4, decayDb: 2, lowDb: -30 }) },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING }, envelope: notes({ levelDb: -18, period: 2, decayDb: 1, lowDb: -15 }) },
    ],
    sections: wholeSong(),
    prominence: [{ track: "lead", section: "all", prominence: "focal" }],
  });
}

/** G: a Supporting snare whose attacks sit 16 dB over their body and far over a quiet mix. */
export function fixtureG(intent?: string) {
  return dynamicsSong({
    tracks: [
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_SEPARATED }, envelope: notes({ levelDb: -30, period: 2, decayDb: 1, lowDb: -10 }) },
      { id: "snare", name: "Snare", role: "snare-clap", fixture: { shape: SNARE_SHAPE }, envelope: hits({ peakDb: -8, period: 0.5, offset: 0.25, attackDb: 16, decayMs: 90, lowDb: -15 }) },
    ],
    ...(intent ? { sections: wholeSong(), prominence: [{ track: "snare", section: "all", prominence: "supporting" as const, intent }] } : {}),
  });
}

/** H: a Focal snare with a soft attack (2 dB over its body) buried under a dense pad. */
export function fixtureH(prominence: "focal" | "supporting" = "focal") {
  return dynamicsSong({
    tracks: [
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_SEPARATED }, envelope: notes({ levelDb: -12, period: 2, decayDb: 1, lowDb: -10 }) },
      { id: "snare", name: "Snare", role: "snare-clap", fixture: { shape: SNARE_SHAPE }, envelope: hits({ peakDb: -14, period: 0.5, offset: 0.25, attackDb: 2, decayMs: 120, lowDb: -15 }) },
    ],
    sections: wholeSong(),
    prominence: [{ track: "snare", section: "all", prominence }],
  });
}

export const SAVED_COMPRESSOR: CompressorNode = { id: "comp-old", type: "compressor", enabled: true, origin: "manual", note: null, thresholdDb: -12, ratio: 1.5, attackMs: 30, releaseMs: 200, kneeDb: 6, makeupDb: 0 };
export const SAVED_DYNAMIC_EQ: DynamicEqNode = {
  id: "deq-old",
  type: "dynamic-eq",
  enabled: true,
  origin: "manual",
  note: null,
  filter: { kind: "bell", frequencyHz: 2_400, q: 1 },
  keyTrackId: "lead",
  keyDetector: "smooth",
  thresholdDb: -10,
  rangeDb: -0.5,
  attackMs: 20,
  releaseMs: 250,
};

/** Bass unstable only in the Drop, steady in the Verse. */
export function sectionFixture() {
  return dynamicsSong({ tracks: [bassTrack((seconds) => (seconds < 30 ? steadyBass()(seconds) : unstableBass()(seconds)))], sections: twoSections });
}

/** A healthy arrangement: pre-ducked bass, ordinary drums, a lead over a separated pad, steady levels. */
export function alreadyGood() {
  return dynamicsSong({
    tracks: [
      kickTrack(),
      bassTrack(dipped(notes({ levelDb: -15, period: 0.5, decayDb: 2, lowDb: -1 }), { period: 0.5, dipDb: 9, lengthMs: 100 })),
      { id: "snare", name: "Snare", role: "snare-clap", fixture: { shape: SNARE_SHAPE }, envelope: hits({ peakDb: -10, period: 1, offset: 0.5, attackDb: 6, decayMs: 100, lowDb: -15 }) },
      { id: "hat", name: "Hat", role: "hi-hat", fixture: { shape: sum(base(-60, 1), bump(9_000, 0.8, 20)) }, envelope: hits({ peakDb: -20, period: 0.25, offset: 0.125, attackDb: 4, decayMs: 40, lowDb: -40 }) },
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD }, envelope: notes({ levelDb: -16, period: 0.4, offsets: [0, -1, -2, -1], decayDb: 2, lowDb: -30 }) },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_SEPARATED }, envelope: notes({ levelDb: -24, period: 2, decayDb: 1, lowDb: -6 }) },
    ],
    sections: [
      { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
      { id: "chorus", name: "Chorus", type: "chorus", start: 30, end: 60 },
    ],
  });
}

/**
 * The milestone's acceptance demonstration: Kick, Bass, Snare Primary; Lead Focal in the Drop; Pad Supporting.
 * Bass swings everywhere and collides with the kick in the Drop; Pad masks Lead only during its phrases; the
 * snare's attacks are very spiky.
 */
export function demonstration() {
  return dynamicsSong({
    tracks: [
      kickTrack(),
      bassTrack((seconds) => (seconds < 30 ? unstableBass(-18)(seconds) : unstableBass(-8)(seconds))),
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: [[34, 44], [50, 58]] }, envelope: notes({ levelDb: -16, period: 0.4, decayDb: 2, lowDb: -30 }) },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING }, envelope: notes({ levelDb: -18, period: 2, decayDb: 1, lowDb: -15 }) },
      { id: "snare", name: "Snare", role: "snare-clap", fixture: { shape: SNARE_SHAPE }, envelope: hits({ peakDb: 0, period: 1, offset: 0.25, attackDb: 18, decayMs: 90, lowDb: -15 }) },
    ],
    sections: [
      { id: "intro", name: "Intro", type: "intro", start: 0, end: 30 },
      { id: "drop", name: "Drop", type: "drop", start: 30, end: 60 },
    ],
    prominence: [
      { track: "lead", section: "drop", prominence: "focal" },
      { track: "snare", section: "intro", prominence: "primary" },
      { track: "snare", section: "drop", prominence: "primary" },
    ],
  });
}
