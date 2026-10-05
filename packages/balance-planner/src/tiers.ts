import type { ProjectDocument, SongSection, Track, TrackRole } from "@audiosous/project-model";
import { trackIntentTier, type SectionIntentIndex } from "./intent";

/** How much a track should stand out. Shared by every planner so gain and EQ agree on who leads. */
export type Tier = "primary" | "focal" | "supporting" | "background" | "unknown";

export const ROLE_TIER: Record<TrackRole, Tier> = {
  kick: "primary",
  bass: "primary",
  lead: "primary",
  vocal: "primary",
  drums: "primary",
  "snare-clap": "supporting",
  "hi-hat": "supporting",
  percussion: "supporting",
  synth: "supporting",
  pad: "supporting",
  keys: "supporting",
  guitar: "supporting",
  "backing-vocal": "supporting",
  brass: "supporting",
  strings: "supporting",
  fx: "background",
  atmosphere: "background",
  other: "unknown",
};

/**
 * Where a scope's tier came from, highest precedence first:
 * explicit Track × Section prominence, Track × Section note, section note naming the track, role.
 */
export type TierSource = "prominence" | "track-intent" | "section-intent" | "role";

export interface TierRead {
  tier: Tier;
  defaultTier: Tier;
  source: TierSource;
  explicit: boolean;
  /** The note clause that set the tier, when it came from text. */
  intentText: string | null;
  /** A section note had a level instruction that could mean this track or another one. */
  ambiguous: boolean;
}

export function defaultTierFor(track: Track, tracks: Track[]): Tier {
  if (track.role === "drums" && tracks.some((item) => item.role === "kick" && item.id !== track.id)) return "supporting";
  return ROLE_TIER[track.role];
}

export function readTier(document: ProjectDocument, track: Track, section: SongSection | null, intents: SectionIntentIndex): TierRead {
  const defaultTier = defaultTierFor(track, document.tracks);
  const setting = section ? document.sectionTrackSettings.find((item) => item.trackId === track.id && item.sectionId === section.id) : undefined;
  const trackNote = section ? trackIntentTier(document, track, setting?.userIntent) : null;
  const sectionNote = section ? (intents.targets.get(section.id)?.get(track.id) ?? null) : null;
  const ambiguous = section ? intents.ambiguous.some((item) => item.sectionId === section.id && item.trackIds.includes(track.id)) : false;
  let tier: Tier = defaultTier;
  let source: TierSource = "role";
  let intentText: string | null = null;
  if (setting?.prominence) {
    tier = setting.prominence;
    source = "prominence";
  } else if (trackNote) {
    tier = trackNote.tier;
    source = "track-intent";
    intentText = trackNote.text;
  } else if (sectionNote) {
    tier = sectionNote.tier;
    source = "section-intent";
    intentText = sectionNote.text;
  }
  return { tier, defaultTier, source, explicit: source !== "role", intentText, ambiguous: ambiguous && source === "role" };
}

export const TIER_RANK: Record<Tier, number> = {
  focal: 4,
  primary: 3,
  supporting: 2,
  background: 1,
  unknown: 0,
};
