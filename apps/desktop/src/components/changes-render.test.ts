import { fullMixDifference, mixDifference, planFullMix } from "@audiosous/mix-planner";
import { multiProblem } from "@audiosous/mix-planner/testing";
import { setTrackEqNodes, setTrackSpatial, updateTrack, type ProjectDocument } from "@audiosous/project-model";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { activeDifference } from "../lib/difference";
import { idleAutoMix, idleBalance, idleDynamics, idleEq, idleFullMix, idleSpace, useAppStore } from "../state/app-store";
import { ChangesView } from "./ChangesView";

const NOW = "2026-10-06T00:00:00.000Z";

function ok(result: { ok: true; document: ProjectDocument } | { ok: false; message: string }): ProjectDocument {
  if (!result.ok) throw new Error(result.message);
  return result.document;
}

/** Server rendering separates adjacent text with comments; read it as text. */
function text(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

function render(document: ProjectDocument, candidate: ProjectDocument): string {
  return text(renderToString(createElement(ChangesView, { document, diff: mixDifference({ current: document, candidate }), label: "Test Candidate" })));
}

describe("Changes view", () => {
  beforeEach(() => {
    useAppStore.setState({ changesFocus: null });
  });

  it("draws a subtle EQ cut on a zoomed, labelled difference scale with its numbers and a sentence", () => {
    const document = multiProblem().document;
    const candidate = ok(setTrackEqNodes(document, "pad", [{ id: "cut", type: "eq", enabled: true, origin: "eq-plan", note: "", filter: { kind: "bell", frequencyHz: 2_400, gainDb: -1, q: 1.2 } }]));
    const html = render(document, candidate);
    expect(html).toContain("Difference scale ±2 dB");
    expect(html).toMatch(/Pad\s+−1\.0 dB @ 2\.\d kHz/);
    expect(html).toContain("This is a subtle change.");
    expect(html).toContain("These are subtle changes");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(">Difference<");
  });

  it("shows gain as current, candidate, and delta with arrows and words, not color alone", () => {
    const document = multiProblem().document;
    const candidate = updateTrack(document, "lead", { gainDb: document.tracks.find((track) => track.id === "lead")!.gainDb + 0.8 });
    const html = render(document, candidate);
    expect(html).toContain("Current");
    expect(html).toContain("Candidate");
    expect(html).toContain("Delta");
    expect(html).toContain("▲ +0.8 dB");
    expect(html).toContain("Song-wide");
  });

  it("draws a width move with the current position dashed and the candidate solid", () => {
    const document = ok(setTrackSpatial(multiProblem().document, "synth", { width: 1.28 }));
    const candidate = ok(setTrackSpatial(document, "synth", { width: 1.12 }));
    const html = render(document, candidate);
    expect(html).toContain("Width 128% → 112%");
    expect(html).toContain("narrower");
    expect(html).toContain('stroke-dasharray="4 3"');
  });

  it("labels the before/after measurements as diagnostics, never a quality score", () => {
    const song = multiProblem();
    const plan = planFullMix({ ...song, now: NOW });
    const diff = fullMixDifference(song.document, plan, { envelopes: song.envelopes })!;
    const html = text(renderToString(createElement(ChangesView, { document: song.document, diff, label: "Recommended Mix" })));
    expect(html).toContain("What changes — Recommended Mix");
    expect(html).toContain("Interaction reduction");
    expect(html).toContain("not a score for the mix");
    expect(html).toContain("They are not a mix-quality score.");
    expect(html).not.toMatch(/quality score:/i);
    expect(html).toContain("Where it changes");
  });

  it("the timeline marks the open candidate: Full Mix first, otherwise the plan in view", () => {
    const song = multiProblem();
    const plan = planFullMix({ ...song, now: NOW });
    const sessions = { balance: idleBalance(), eq: idleEq(), space: idleSpace(), dynamics: idleDynamics(), fullMix: { ...idleFullMix(), phase: "ready" as const, plan }, planTab: "gain" as const, autoMix: idleAutoMix() };
    const active = activeDifference(song.document, sessions)!;
    expect(active.tab).toBe("full");
    expect(active.label).toBe("Full Mix Candidate");
    expect(activeDifference(song.document, { ...sessions, fullMix: idleFullMix() })).toBeNull();
    const auto = activeDifference(song.document, { ...sessions, autoMix: { ...idleAutoMix(), phase: "ready", planCreatedAt: plan.createdAt } })!;
    expect(auto.label).toBe("Recommended Mix");
  });
});
