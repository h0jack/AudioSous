import type { WorkerJob } from "./full-mix";
import { runJob } from "./planning-jobs";

/**
 * Full Mix planning, the assistant's mix reading, and simplification off the interface thread. They run the four
 * planners one or more times (a few seconds on large projects); the audio callback is native and never waits for
 * them, and this keeps the window responsive.
 */
const scope = self as unknown as { onmessage: ((event: MessageEvent<WorkerJob>) => void) | null; postMessage: (message: unknown) => void };

scope.onmessage = (event) => {
  try {
    scope.postMessage({ ok: true, result: runJob(event.data) });
  } catch (caught) {
    scope.postMessage({ ok: false, message: caught instanceof Error && caught.message ? caught.message : "Planning failed." });
  }
};
