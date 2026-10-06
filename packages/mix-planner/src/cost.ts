import type { ProjectDocument } from "@audiosous/project-model";
import type { ChangeProcessing, MixScope } from "./model";
import type { MixGoal } from "./settings";

/**
 * Processing cost, in the same unit as benefit (problem severity × share removed). It is what makes "do nothing"
 * and "one small change" win when results are comparable:
 *
 *   gain          0.02 + 0.012 per dB             low
 *   safety trim   0.03                             low (one move on every fader)
 *   static EQ     0.04 + 0.012 per dB of cut       low; a boost 0.06 + 0.025 per dB
 *   pan           0.05 + 0.06 per unit moved       low/moderate
 *   width         0.07 + 0.10 per unit changed     moderate
 *   compressor    0.08 + 0.012 per dB of GR (p95)  moderate
 *   transient     0.08 + 0.15 per unit             moderate
 *   duck          0.11 + 0.015 per dB              moderate/high (a routing)
 *   dynamic EQ    0.13 + 0.015 per dB              high (a routing and a band)
 *
 * plus 0.03 for a section-only change (more to follow and to undo), 0.03 for each further processor on the same
 * problem, ×1.4 on an anchor (kick, bass, snare, lead or vocal, or a stem marked Focal), and a goal's lean.
 * Editing a node the stem already has costs 0.02 less than adding one.
 */
export interface CostContext {
  document: ProjectDocument;
  goal: MixGoal;
}

export const ANCHOR_ROLES = new Set(["kick", "bass", "snare-clap", "lead", "vocal"]);

export function changeCost(
  ctx: CostContext,
  change: { trackId: string; scope: MixScope; processing: ChangeProcessing; replacesNodeId: string | null; reductionP95Db?: number },
  current?: { pan: number; width: number },
): number {
  const processing = change.processing;
  let cost: number;
  let goal = 1;
  switch (processing.type) {
    case "gain":
      cost = 0.02 + 0.012 * Math.abs(processing.deltaDb);
      break;
    case "trim":
      return round3(0.03 + 0.004 * Math.abs(processing.gainDb));
    case "eq": {
      const filter = processing.filter;
      if (filter.kind === "high-pass" || filter.kind === "low-pass") cost = 0.04;
      else cost = filter.gainDb <= 0 ? 0.04 + 0.012 * Math.abs(filter.gainDb) : 0.06 + 0.025 * filter.gainDb;
      break;
    }
    case "spatial": {
      const base = current ?? { pan: 0, width: 1 };
      cost = 0;
      if (processing.pan !== null && Math.abs(processing.pan - base.pan) >= 0.005) cost += 0.05 + 0.06 * Math.abs(processing.pan - base.pan);
      if (processing.width !== null && Math.abs(processing.width - base.width) >= 0.005) {
        cost += 0.07 + 0.1 * Math.abs(processing.width - base.width);
        if (ctx.goal === "intimate" && processing.width > base.width) goal = 1.5;
        if ((ctx.goal === "wide" || ctx.goal === "open") && processing.width > base.width) goal = 0.75;
      }
      cost = Math.max(cost, 0.05);
      break;
    }
    case "dynamics": {
      const node = processing.processing;
      if (node.type === "compressor") {
        cost = 0.08 + 0.012 * (change.reductionP95Db ?? 2);
        if (ctx.goal === "controlled") goal = 0.75;
        if (ctx.goal === "intimate") goal = 1.3;
      } else if (node.type === "transient") {
        cost = 0.08 + 0.15 * Math.max(Math.abs(node.attack), Math.abs(node.sustain));
        if (ctx.goal === "punchy") goal = 0.8;
      } else if (node.type === "ducking") {
        cost = 0.11 + 0.015 * Math.abs(node.rangeDb);
        if (ctx.goal === "punchy") goal = 0.85;
      } else {
        cost = 0.13 + 0.015 * Math.abs(node.rangeDb);
      }
      break;
    }
  }
  if (change.scope.type === "section") cost += 0.03;
  if (change.replacesNodeId && !change.replacesNodeId.startsWith("fm-")) cost -= 0.02;
  if (isAnchor(ctx.document, change.trackId, change.scope)) cost *= 1.4;
  return round3(Math.max(0.01, cost * goal));
}

/** Kick, bass, snare, lead or vocal, or a stem marked Focal in the scope (or anywhere, for a whole-song change). */
export function isAnchor(document: ProjectDocument, trackId: string, scope: MixScope): boolean {
  const track = document.tracks.find((item) => item.id === trackId);
  if (!track) return false;
  if (ANCHOR_ROLES.has(track.role)) return true;
  return document.sectionTrackSettings.some((row) => row.trackId === trackId && row.prominence === "focal" && (scope.type === "global" || row.sectionId === scope.sectionId));
}

/** A further processor on the same problem has to earn its place on top of its own cost. */
export const EXTRA_PROCESSOR_COST = 0.03;

export function costLabel(total: number): "none" | "low" | "low/moderate" | "moderate" | "high" {
  if (total <= 0.001) return "none";
  if (total < 0.2) return "low";
  if (total < 0.45) return "low/moderate";
  if (total < 0.9) return "moderate";
  return "high";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
