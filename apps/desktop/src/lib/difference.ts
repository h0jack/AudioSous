import {
  dynamicsPlanDifference,
  eqPlanDifference,
  fullMixDifference,
  fullMixPlanIsStale,
  gainPlanDifference,
  spacePlanDifference,
  type MixDifference,
} from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { useMemo } from "react";
import { useAppStore, type PlanTab } from "../state/app-store";
import { cachedEnvelopes } from "./full-mix";

/**
 * The candidate whose changes the timeline marks and the Changes view draws: the Full Mix (or Auto Mix) candidate
 * when one is ready, otherwise the open plan of the tab in view, otherwise any ready plan. Each is the plan's own
 * apply, diffed against the saved project, so every tab shows the same Current / Candidate / Difference model.
 */
export interface ActiveDifference {
  tab: PlanTab;
  label: string;
  diff: MixDifference;
}

type Sessions = Pick<ReturnType<typeof useAppStore.getState>, "balance" | "eq" | "space" | "dynamics" | "fullMix" | "planTab" | "autoMix">;

const memo = new WeakMap<object, { document: ProjectDocument; diff: MixDifference | null }>();

function cached(plan: object, document: ProjectDocument, build: () => MixDifference | null): MixDifference | null {
  const hit = memo.get(plan);
  if (hit && hit.document === document) return hit.diff;
  const diff = build();
  memo.set(plan, { document, diff });
  return diff;
}

export function differenceFor(tab: PlanTab, document: ProjectDocument, state: Sessions): ActiveDifference | null {
  switch (tab) {
    case "full": {
      const full = state.fullMix;
      if (!full.plan || full.phase !== "ready" || fullMixPlanIsStale(full.plan, document, full.fingerprints, full.settings)) return null;
      const diff = cached(full.plan, document, () => fullMixDifference(document, full.plan!, { envelopes: cachedEnvelopes(document.project.id) ?? undefined }));
      const auto = state.autoMix.phase === "ready" && state.autoMix.planCreatedAt === full.plan.createdAt;
      return diff ? { tab, label: auto ? "Recommended Mix" : "Full Mix Candidate", diff } : null;
    }
    case "gain": {
      const plan = state.balance.phase === "ready" ? state.balance.plan : null;
      return plan ? { tab, label: "Gain Candidate", diff: cached(plan, document, () => gainPlanDifference(document, plan))! } : null;
    }
    case "eq": {
      const plan = state.eq.phase === "ready" ? state.eq.plan : null;
      return plan ? { tab, label: "EQ Candidate", diff: cached(plan, document, () => eqPlanDifference(document, plan))! } : null;
    }
    case "space": {
      const plan = state.space.phase === "ready" ? state.space.plan : null;
      return plan ? { tab, label: "Spatial Candidate", diff: cached(plan, document, () => spacePlanDifference(document, plan))! } : null;
    }
    case "dynamics": {
      const plan = state.dynamics.phase === "ready" ? state.dynamics.plan : null;
      return plan ? { tab, label: "Dynamics Candidate", diff: cached(plan, document, () => dynamicsPlanDifference(document, plan, cachedEnvelopes(document.project.id) ?? undefined))! } : null;
    }
  }
}

/** The candidate the timeline marks: Full Mix first, then the tab in view, then any other ready plan. */
export function activeDifference(document: ProjectDocument, state: Sessions): ActiveDifference | null {
  const order: PlanTab[] = ["full", state.planTab, "gain", "eq", "space", "dynamics"];
  for (const tab of order) {
    try {
      const found = differenceFor(tab, document, state);
      if (found) return found;
    } catch {
      // A plan that cannot be applied (a full graph) draws no difference; its panel says why.
    }
  }
  return null;
}

export function useActiveDifference(document: ProjectDocument): ActiveDifference | null {
  const balance = useAppStore((state) => state.balance);
  const eq = useAppStore((state) => state.eq);
  const space = useAppStore((state) => state.space);
  const dynamics = useAppStore((state) => state.dynamics);
  const fullMix = useAppStore((state) => state.fullMix);
  const planTab = useAppStore((state) => state.planTab);
  const autoMix = useAppStore((state) => state.autoMix);
  return useMemo(() => activeDifference(document, { balance, eq, space, dynamics, fullMix, planTab, autoMix }), [document, balance, eq, space, dynamics, fullMix, planTab, autoMix]);
}

export function useDifference(tab: PlanTab, document: ProjectDocument): ActiveDifference | null {
  const balance = useAppStore((state) => state.balance);
  const eq = useAppStore((state) => state.eq);
  const space = useAppStore((state) => state.space);
  const dynamics = useAppStore((state) => state.dynamics);
  const fullMix = useAppStore((state) => state.fullMix);
  const autoMix = useAppStore((state) => state.autoMix);
  return useMemo(() => {
    try {
      return differenceFor(tab, document, { balance, eq, space, dynamics, fullMix, planTab: tab, autoMix });
    } catch {
      return null;
    }
  }, [tab, document, balance, eq, space, dynamics, fullMix, autoMix]);
}
