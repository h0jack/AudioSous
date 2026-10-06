import type { ProjectDocument } from "@audiosous/project-model";
import { useDifference } from "../lib/difference";
import type { PlanTab } from "../state/app-store";
import { ChangesView } from "./ChangesView";

/**
 * A plan tab's Current / Candidate / Difference view of its own candidate, the same model and drawings as Full Mix.
 * Open by default, so the change is visible before it is heard.
 */
export function PlanChanges({ tab, document }: { tab: PlanTab; document: ProjectDocument }) {
  const active = useDifference(tab, document);
  if (!active) return null;
  return (
    <details open className="mt-3 rounded-md border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted select-none">What changes: Current / Candidate / Difference</summary>
      <div className="mt-2">
        <ChangesView document={document} diff={active.diff} label={active.label} />
      </div>
    </details>
  );
}
