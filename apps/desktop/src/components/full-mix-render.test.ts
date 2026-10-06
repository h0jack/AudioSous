import { planFullMix } from "@audiosous/mix-planner";
import { multiProblem } from "@audiosous/mix-planner/testing";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import { FullMixPanel, FullMixPanelView } from "./FullMixPanel";

/** Renders the Full Mix views with a real plan, so a broken render path fails here rather than in the app. */
const playback = { engineKind: "native", playing: false, seek: () => undefined, dynamicsMeter: async () => [] } as unknown as Parameters<typeof FullMixPanel>[0]["playback"];

describe("Full Mix views render", () => {
  let song: ReturnType<typeof multiProblem>;

  beforeEach(() => {
    song = multiProblem();
    const plan = planFullMix({ ...song, now: "2026-10-05T00:00:00.000Z" });
    useAppStore.getState().openDocument(song.document, "/tmp/full-mix-render/project.amix", []);
    const problem = plan.problems.find((item) => item.type === "low-end-collision")!;
    const duck = plan.changes.find((change) => change.problemIds.includes(problem.id))!;
    useAppStore.getState().setFullMix({ open: true, phase: "ready", plan, fingerprints: [], selectedProblemId: problem.id, selectedChangeId: duck.id });
  });

  it("renders the closed panel with what Full Mix does", () => {
    const html = renderToString(createElement(FullMixPanel, { document: song.document, playback }));
    expect(html).toMatch(/one coordinated plan across gain, EQ, space, and dynamics/);
  });

  it("renders problems first, then their changes, alternatives, evidence, A/B, and an editor", () => {
    const html = renderToString(createElement(FullMixPanelView, { document: song.document, playback, fullMix: useAppStore.getState().fullMix })).replaceAll("<!-- -->", "");
    for (const text of [
      "Full Mix Candidate",
      "Loudness-match A/B",
      "Apply accepted",
      "issues",
      "selected change",
      "Overall confidence",
      "Severity: ",
      "Accept solution",
      "Reject solution",
      "Only this fix",
      "Candidate without it",
      "Evidence",
      "Considered",
      "Recommended changes",
      "Only this",
      "Without",
      "Maximum reduction",
      "How it was decided",
      "four planners on their own propose",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("Hearing Current (saved mix)");
  });

  it("warns that the legacy engine does not play the whole candidate", () => {
    const legacy = { ...playback, engineKind: "legacy" } as typeof playback;
    expect(renderToString(createElement(FullMixPanelView, { document: song.document, playback: legacy, fullMix: useAppStore.getState().fullMix }))).toMatch(/does not play dynamics or width/);
  });
});
