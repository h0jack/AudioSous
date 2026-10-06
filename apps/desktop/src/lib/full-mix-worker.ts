import { planFullMix, type PlanFullMixInput } from "@audiosous/mix-planner";

/**
 * Full Mix planning off the interface thread. It runs the four planners several times (a few seconds on large
 * projects); the audio callback is native and never waits for it, and this keeps the window responsive.
 */
const scope = self as unknown as { onmessage: ((event: MessageEvent<PlanFullMixInput>) => void) | null; postMessage: (message: unknown) => void };

scope.onmessage = (event) => {
  try {
    const started = performance.now();
    const plan = planFullMix(event.data);
    scope.postMessage({ ok: true, plan, durationMs: Math.round(performance.now() - started) });
  } catch (caught) {
    scope.postMessage({ ok: false, message: caught instanceof Error && caught.message ? caught.message : "Full Mix planning failed." });
  }
};
