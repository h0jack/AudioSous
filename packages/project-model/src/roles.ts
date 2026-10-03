import type { TrackRole } from "./schema";

const RULES: ReadonlyArray<{ role: TrackRole; pattern: RegExp }> = [
  { role: "kick", pattern: /\b(kick|kik|bass[\s_-]?drum|bd)\b/i },
  { role: "snare-clap", pattern: /\b(snare|snr|sd|clap|claps|rim)\b/i },
  { role: "hi-hat", pattern: /\b(hi[\s_-]?hat|hihat|hh|hats?|open[\s_-]?hat|closed[\s_-]?hat)\b/i },
  { role: "percussion", pattern: /\b(perc|percussion|shaker|tamb(?:ourine)?|conga|bongo|cowbell|clave)\b/i },
  { role: "drums", pattern: /\b(drums?|overheads?|drum[\s_-]?room|kit|toms?)\b/i },
  { role: "backing-vocal", pattern: /\b(backing[\s_-]?vox(?:al)?s?|bgvs?|bvox|harmon(?:y|ies)|ad[\s_-]?libs?)\b/i },
  { role: "vocal", pattern: /\b(vocals?|vox|voice|singer|sing)\b/i },
  { role: "bass", pattern: /\b(bass|sub|808)\b/i },
  { role: "brass", pattern: /\b(brass|trumpet|trombones?|sax(?:ophone)?|horns?)\b/i },
  { role: "strings", pattern: /\b(strings?|violin|viola|cello|orchestra)\b/i },
  { role: "guitar", pattern: /\b(guitars?|gtr|git)\b/i },
  { role: "keys", pattern: /\b(keys|piano|rhodes|organ|wurlitzer|epiano|e[\s_-]?piano)\b/i },
  { role: "pad", pattern: /\b(pads?)\b/i },
  { role: "lead", pattern: /\b(leads?|melody|hook)\b/i },
  { role: "synth", pattern: /\b(synths?|arp(?:eggio)?)\b/i },
  { role: "atmosphere", pattern: /\b(atmospheres?|atmo|ambience|ambient|drone)\b/i },
  { role: "fx", pattern: /\b(fx|sfx|riser|impacts?|sweeps?)\b/i },
];

export function guessTrackRole(filename: string): TrackRole {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ");
  for (const rule of RULES) {
    if (rule.pattern.test(stem) || rule.pattern.test(filename)) return rule.role;
  }
  return "other";
}

export function trackNameFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
  const spaced = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return "Untitled stem";
  return spaced.replace(/\b\w/g, (character) => character.toUpperCase());
}
