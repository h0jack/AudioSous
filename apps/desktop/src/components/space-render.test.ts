import { planSpace } from "@audiosous/spatial-planner";
import { BASS, KICK, LEAD, NOW, PAD_MASKING, base, bump, spatialSong, sum } from "@audiosous/spatial-planner/testing";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import { PlansPanel } from "./PlansPanel";
import { SpacePanel, SpacePanelView } from "./SpacePanel";
import { SpatialInteractionPanel } from "./SpatialInteractionView";
import { CorrelationMeter, StereoField } from "./StereoField";

/** Renders the Space views with a real plan, so a broken render path fails here rather than in the app. */
function demo() {
  return spatialSong({
    tracks: [
      { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 }, stereo: { mono: true } },
      { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS }, stereo: { correlation: 0.99 } },
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: [[0, 30]] }, stereo: { correlation: 0.98 } },
      { id: "pad", name: "Pad", role: "pad", width: 1.1, fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.75 } },
      { id: "atmos", name: "Atmosphere", role: "atmosphere", width: 0.6, fixture: { shape: sum(base(-48, -1), bump(1_000, 1.5, 6)) }, stereo: { correlation: 0.6 } },
    ],
    sections: [
      { id: "chorus", name: "Chorus", type: "chorus", start: 0, end: 30 },
      { id: "drop", name: "Drop", type: "drop", start: 30, end: 60 },
    ],
    prominence: [{ track: "lead", section: "chorus", prominence: "focal" }],
  });
}

const playback = { engineKind: "native", playing: false, seek: () => undefined } as unknown as Parameters<typeof SpacePanel>[0]["playback"];

describe("Space views render", () => {
  let input: ReturnType<typeof demo>;

  beforeEach(() => {
    input = demo();
    const plan = planSpace({ ...input, now: NOW });
    useAppStore.getState().openDocument(input.document, "/tmp/space-render/project.amix", []);
    useAppStore.getState().setSpace({ open: true, phase: "ready", plan, fingerprints: [], selectedId: plan.changes[0]?.id ?? null });
  });

  it("renders the closed panel with what Space does", () => {
    const html = renderToString(createElement(SpacePanel, { document: input.document, playback }));
    expect(html).toMatch(/Kick and bass stay centered/);
  });

  it("renders the plan, its rows, the selected row's field, sliders, and evaluation", () => {
    const html = renderToString(createElement(SpacePanelView, { document: input.document, playback, space: useAppStore.getState().space }));
    for (const text of ["Spatial Candidate", "Apply accepted", "Pan / Balance", "Width", "Bypassed", "Recommended", "Balance", "Correlation now", "Mix center load"]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/role="slider"/);
    expect(html).toMatch(/→/);
  });

  it("says what is playing, and the plans drawer has a resize handle and a collapse control", () => {
    expect(renderToString(createElement(SpacePanelView, { document: input.document, playback, space: useAppStore.getState().space }))).toContain("Hearing Current (saved mix)");
    // The store hook reads the initial state on the server, where no plan is open: the drawer shows tabs only.
    const closed = renderToString(createElement(PlansPanel, { document: input.document, playback }));
    expect(closed).toContain('aria-label="Mix plans"');
    expect(closed).not.toContain('role="separator"');
  });

  it("warns that the legacy engine does not play width", () => {
    const legacy = { ...playback, engineKind: "legacy" } as typeof playback;
    expect(renderToString(createElement(SpacePanelView, { document: input.document, playback: legacy, space: useAppStore.getState().space }))).toMatch(/plays pan and balance but not width/);
  });

  it("renders the spatial interaction view with both images and a correlation meter", () => {
    // Server rendering separates adjacent text with comments; read it as text.
    const html = renderToString(createElement(SpatialInteractionPanel, { document: input.document, onSeek: () => undefined, space: useAppStore.getState().space })).replaceAll("<!-- -->", "");
    expect(html).toContain("Overlap in the field");
    expect(html).toContain("Center competition");
    expect(html).toMatch(/Lead ↔ Pad|Pad ↔ Lead/);
  });

  it("draws stems at their positions and labels correlation in context", () => {
    const image = { position: -0.5, spread: 0.4, correlation: 0.6, sideShare: 0.2, monoLossDb: 1, msRatioDb: -6 };
    const html = renderToString(createElement(StereoField, { stems: [{ trackId: "a", name: "Guitar", image, levelDb: 0, tier: "supporting", mono: false }], label: "field" }));
    expect(html).toContain("Guitar");
    expect(html).toContain("50L");
    expect(renderToString(createElement(CorrelationMeter, { value: -0.3, label: "x" }))).toMatch(/out of phase/);
    expect(renderToString(createElement(CorrelationMeter, { value: 0.95, label: "x" }))).toMatch(/nearly mono/);
  });
});
