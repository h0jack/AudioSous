import { planDynamics } from "@audiosous/dynamics-planner";
import { NOW, demonstration } from "@audiosous/dynamics-planner/testing";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import { DynamicsPanel, DynamicsPanelView } from "./DynamicsPanel";

/** Renders the Dynamics views with a real plan, so a broken render path fails here rather than in the app. */
const playback = { engineKind: "native", playing: false, seek: () => undefined, dynamicsMeter: async () => [] } as unknown as Parameters<typeof DynamicsPanel>[0]["playback"];

describe("Dynamics views render", () => {
  let input: ReturnType<typeof demonstration>;

  beforeEach(() => {
    input = demonstration();
    const plan = planDynamics({ ...input, now: NOW });
    useAppStore.getState().openDocument(input.document, "/tmp/dynamics-render/project.amix", []);
    useAppStore.getState().setDynamics({ open: true, phase: "ready", plan, fingerprints: [], selectedId: plan.changes.find((change) => change.processing.type === "compressor")!.id });
  });

  it("renders the closed panel with what Dynamics does", () => {
    const html = renderToString(createElement(DynamicsPanel, { document: input.document, playback }));
    expect(html).toMatch(/Makeup stays at 0 dB and the A\/B is level-matched/);
  });

  it("renders the plan, its rows, and the selected compressor's editor, timeline, and numbers", () => {
    const html = renderToString(createElement(DynamicsPanelView, { document: input.document, playback, dynamics: useAppStore.getState().dynamics })).replaceAll("<!-- -->", "");
    for (const text of ["Dynamics Candidate", "Apply accepted", "Level-match A/B", "Processor", "Amount / GR", "Compressor", "Duck", "Dynamic EQ", "Transient", "Bypassed", "Recommended", "Threshold", "Ratio", "Attack", "Release", "Knee", "Gain reduction over time", "Target 2–4 dB"]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/dB GR/);
    expect(html).toContain("Hearing Current (saved mix)");
  });

  it("renders a duck's key controls and a dynamic EQ's curve", () => {
    const session = useAppStore.getState().dynamics;
    const duck = session.plan!.changes.find((change) => change.processing.type === "ducking")!;
    const duckHtml = renderToString(createElement(DynamicsPanelView, { document: input.document, playback, dynamics: { ...session, selectedId: duck.id } }));
    expect(duckHtml).toContain("Key track");
    expect(duckHtml).toContain("Hits (fast)");
    expect(duckHtml).toContain("Max reduction");
    const dip = session.plan!.changes.find((change) => change.processing.type === "dynamic-eq")!;
    const dipHtml = renderToString(createElement(DynamicsPanelView, { document: input.document, playback, dynamics: { ...session, selectedId: dip.id } }));
    expect(dipHtml).toContain("Frequency");
    expect(dipHtml).toMatch(/Dashed: the bell at rest/);
  });

  it("warns that the legacy engine does not play dynamics", () => {
    const legacy = { ...playback, engineKind: "legacy" } as typeof playback;
    expect(renderToString(createElement(DynamicsPanelView, { document: input.document, playback: legacy, dynamics: useAppStore.getState().dynamics }))).toMatch(/does not play dynamics/);
  });
});
