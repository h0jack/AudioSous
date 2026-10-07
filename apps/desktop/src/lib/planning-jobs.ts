import { readMix } from "@audiosous/mix-agent";
import { planFullMix, planReferenceMatch, simplifyFullMix } from "@audiosous/mix-planner";
import type { WorkerJob } from "./full-mix";

/** One planning job, on whatever thread calls it: the worker in the app, the main thread in tests. */
export function runJob(job: WorkerJob): unknown {
  switch (job.kind) {
    case "plan":
      return planFullMix(job.input);
    case "read":
      return readMix(job.document, job.inputs, job.strength, job.now);
    case "simplify":
      return simplifyFullMix(job.input, job.plan, { keep: job.keep });
    case "reference":
      return planReferenceMatch(job.input);
  }
}
