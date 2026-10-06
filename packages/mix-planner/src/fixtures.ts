import type { EqNode } from "@audiosous/project-model";
import { BASS, KICK, LEAD, PAD_MASKING, PAD_SEPARATED, SNARE_SHAPE, base, bump, dipped, hits, kickTrack, mixSong, notes, sum, unstableBass, wholeSong, type MixTrackInput } from "./testing";

/**
 * The milestone's whole-mix fixtures, shared by the planner, plan-contract, and desktop flow tests. Each one is a
 * small song where several of the four planners would act, and where the right integrated answer is known.
 */

const lead = (extra: Partial<MixTrackInput> = {}): MixTrackInput => ({ id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD }, envelope: notes({ levelDb: -16, period: 0.4, decayDb: 2, lowDb: -30 }), ...extra });
const pad = (extra: Partial<MixTrackInput> = {}): MixTrackInput => ({
  id: "pad",
  name: "Pad",
  role: "pad",
  fixture: { shape: PAD_MASKING },
  stereo: { correlation: 0.7 },
  envelope: notes({ levelDb: -18, period: 2, decayDb: 1, lowDb: -15 }),
  ...extra,
});
const sustainedBass = (gainDb?: number): MixTrackInput => ({ id: "bass", name: "Bass", role: "bass", gainDb, fixture: { shape: BASS }, envelope: notes({ levelDb: -12, period: 0.5, decayDb: 1, lowDb: -1 }) });
const kick = (): MixTrackInput => ({ ...kickTrack(), fixture: { shape: KICK, crest: 16, onsets: 2 } });
const focalLead = [{ track: "lead", section: "all", prominence: "focal" as const }];

/** A: a pad masks a Focal lead the whole time. Gain, EQ, pan, and a duck could all help; one or two cheap moves should. */
export function fixtureA() {
  return mixSong({ tracks: [lead(), pad()], sections: wholeSong(), prominence: focalLead });
}

/** B: a kick over a sustained bass that sits as loud as the kick in the low end on every hit. */
export function fixtureB() {
  return mixSong({ tracks: [kick(), sustainedBass()] });
}

/** The pad's presence cut M4 would make, already saved on the pad. */
export const SAVED_PAD_CUT: EqNode = { id: "eq-saved", type: "eq", enabled: true, origin: "eq-plan", note: "saved", filter: { kind: "bell", frequencyHz: 2_800, gainDb: -6, q: 0.9 } };

/** C: fixture A with the EQ fix already applied: nothing in space should be added for the same pair. */
export function fixtureC() {
  return mixSong({ tracks: [lead(), pad()], sections: wholeSong(), prominence: focalLead, eq: [{ track: "pad", nodes: [SAVED_PAD_CUT] }] });
}

/** A low-mid pad that does not compete with the lead's presence range. */
const PAD_LOW_MID = sum(base(-54, -4), bump(110, 0.35, 18));

/** D: a pad far louder than its Supporting role allows, competing with nothing in particular: a level problem. */
export function fixtureD() {
  return mixSong({
    tracks: [lead(), { ...pad({ fixture: { shape: PAD_LOW_MID } }), gainDb: 10 }],
    sections: wholeSong(),
    prominence: focalLead,
  });
}

/** E: static masking. The lead plays the whole song, so the pad masks it whenever it plays. */
export function fixtureE() {
  return fixtureA();
}

const phrases: Array<[number, number]> = [
  [10, 20],
  [30, 40],
  [50, 60],
];

/** F: event masking. The same pad, but the lead only plays phrases, half the song. */
export function fixtureF() {
  return mixSong({ tracks: [lead({ fixture: { shape: LEAD, active: phrases } }), pad()], sections: wholeSong(), prominence: focalLead });
}

/** G: an arrangement that already works: pre-ducked bass, separated pad, ordinary drums, steady levels. */
export function fixtureG() {
  return mixSong({
    tracks: [
      kick(),
      { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS }, envelope: dipped(notes({ levelDb: -15, period: 0.5, decayDb: 2, lowDb: -1 }), { period: 0.5, dipDb: 9, lengthMs: 100 }), gainDb: -3 },
      { id: "snare", name: "Snare", role: "snare-clap", fixture: { shape: SNARE_SHAPE }, envelope: hits({ peakDb: -10, period: 1, offset: 0.5, attackDb: 6, decayMs: 100, lowDb: -15 }) },
      lead({ envelope: notes({ levelDb: -16, period: 0.4, offsets: [0, -1, -2, -1], decayDb: 2, lowDb: -30 }) }),
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_SEPARATED }, stereo: { correlation: 0.6 }, envelope: notes({ levelDb: -24, period: 2, decayDb: 1, lowDb: -6 }), gainDb: -6 },
    ],
    sections: [
      { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
      { id: "chorus", name: "Chorus", type: "chorus", start: 30, end: 60 },
    ],
  });
}

const SYNTH_SHAPE = sum(base(-46, -1.5), bump(900, 1, 10));

/** H: the drop's note asks for more width and punch than the build before it has; the build is already as wide. */
export function fixtureH() {
  return mixSong({
    tracks: [
      kick(),
      { id: "snare", name: "Snare", role: "snare-clap", fixture: { shape: SNARE_SHAPE }, envelope: hits({ peakDb: -14, period: 1, offset: 0.5, attackDb: 2, decayMs: 120, lowDb: -15 }) },
      lead(),
      { id: "synth", name: "Synth", role: "synth", fixture: { shape: SYNTH_SHAPE }, stereo: { correlation: 0.75 } },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_SEPARATED }, stereo: { correlation: 0.7 }, gainDb: -6 },
    ],
    sections: [
      { id: "build", name: "Build", type: "build", start: 0, end: 30 },
      { id: "drop", name: "Drop", type: "drop", start: 30, end: 60, intent: "The drop should feel wider and punchier." },
    ],
  });
}

/** The milestone's multi-problem song: bad kick/bass, a pad masking the lead, an over-wide synth, and an unstable bass. */
export function multiProblem() {
  return mixSong({
    tracks: [
      kick(),
      { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS }, envelope: unstableBass(-10) },
      lead(),
      pad(),
      { id: "synth", name: "Synth", role: "synth", fixture: { shape: SYNTH_SHAPE }, stereo: { correlation: 0.15 }, width: 1.7, gainDb: -4 },
      { id: "atmos", name: "Atmosphere", role: "atmosphere", fixture: { shape: sum(base(-60, -2), bump(6_000, 1.5, 12)) }, stereo: { correlation: 0.3 }, gainDb: -6 },
    ],
    sections: wholeSong(),
    prominence: focalLead,
  });
}

/** One pad that masks two focal parts in the same range: one cut serves both. */
export function multiBenefit() {
  return mixSong({
    tracks: [lead(), { ...lead(), id: "vocal", name: "Vocal", role: "vocal" }, pad()],
    sections: wholeSong(),
    prominence: [...focalLead, { track: "vocal", section: "all", prominence: "focal" }],
  });
}
