import type { AudioEngine, TrackEqSetting } from "@audiosous/audio-engine";
import { editEqRecommendation, eqPlanIsStale, planEq, setEqRecommendationStatus, type EqPlan } from "@audiosous/eq-planner";
import { BASS, KICK, LEAD, NOW, PAD_MASKING, base, bump, song, sum } from "@audiosous/eq-planner/testing";
import { eqChainAt, setTrackSectionState, type ProjectDocument } from "@audiosous/project-model";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import { applyEq, auditionEq, cancelEqPlan, eqScope, setEqPreview } from "./eq";
import { monitorGainAt, monitorState, publishMonitor } from "./monitor";

function demo() {
  return song({
    tracks: [
      { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 } },
      { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS, crest: 8 } },
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: [[0, 40]] } },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: sum(PAD_MASKING, bump(1_300, 0.3, 8)) } },
      { id: "trumpet", name: "Trumpet", role: "brass", fixture: { shape: sum(base(-36, -2), bump(1_300, 0.35, 13)), active: [[40, 60]] } },
    ],
    sections: [
      { id: "verse", name: "Verse", type: "verse", start: 0, end: 40 },
      { id: "drop", name: "Drop", type: "drop", start: 40, end: 60, intent: "Trumpet should be more prominent." },
    ],
    prominence: [
      { track: "bass", section: "verse", prominence: "supporting" },
      { track: "bass", section: "drop", prominence: "supporting" },
      { track: "lead", section: "verse", prominence: "focal" },
    ],
  });
}

function filtersIn(state: ReturnType<typeof monitorState>, trackId: string, seconds: number) {
  const track = state.eq.find((item) => item.trackId === trackId);
  if (!track) return [];
  const region = track.regions.find((item) => seconds >= item.startSeconds && seconds < item.endSeconds);
  return [...track.filters, ...(region?.filters ?? [])];
}

describe("EQ review flow", () => {
  let document: ProjectDocument;
  let plan: EqPlan;

  beforeEach(() => {
    const input = demo();
    document = input.document;
    plan = planEq({ ...input, now: NOW });
    useAppStore.getState().openDocument(document, "/tmp/eq-flow/project.amix", []);
    useAppStore.getState().setEq({ open: true, phase: "ready", plan, fingerprints: [] });
  });

  it("produces the acceptance plan: Bass and Pad track-wide, Pad again in the Drop from the section note", () => {
    const bass = plan.changes.find((change) => change.trackId === "bass" && change.purpose === "separation");
    const padGlobal = plan.changes.find((change) => change.trackId === "pad" && change.purpose === "separation" && change.scope.type === "global");
    const padDrop = plan.changes.find((change) => change.trackId === "pad" && change.scope.type === "section");
    expect(bass?.scope.type).toBe("global");
    expect(padGlobal).toBeTruthy();
    expect(padDrop?.scope).toEqual({ type: "section", sectionId: "drop" });
    expect(padDrop!.reasons[0]).toMatch(/Trumpet should be more prominent/);
    for (const change of plan.changes) expect(change.reasons[0]!.length).toBeGreaterThan(20);
    expect(eqScope(document)).toMatch(/each of the 2 sections separately/);
  });

  it("A/Bs the whole plan and one filter without touching the project", () => {
    const store = useAppStore.getState;
    const padGlobal = plan.changes.find((change) => change.trackId === "pad" && change.scope.type === "global" && change.processing.filter.kind === "bell")!;
    const current = monitorState(store().document!, store().balance, store().eq);
    expect(current.eq).toEqual([]);
    setEqPreview(true);
    const candidate = monitorState(store().document!, store().balance, store().eq);
    expect(filtersIn(candidate, "pad", 10)).toContainEqual(padGlobal.processing.filter);
    expect(filtersIn(candidate, "pad", 50).length).toBeGreaterThan(filtersIn(candidate, "pad", 10).length);
    auditionEq(padGlobal.id, "recommended");
    const single = monitorState(store().document!, store().balance, store().eq);
    expect(single.eq).toEqual([{ trackId: "pad", filters: [padGlobal.processing.filter], regions: [] }]);
    auditionEq(padGlobal.id, "bypassed");
    expect(monitorState(store().document!, store().balance, store().eq).eq).toEqual([]);
    expect(store().document).toBe(document);
    expect(store().dirty).toBe(false);
  });

  it("starting an EQ audition stops a gain audition", () => {
    useAppStore.getState().setBalance({ preview: true });
    setEqPreview(true);
    expect(useAppStore.getState().balance.preview).toBe(false);
  });

  it("edits, rejects, accepts, applies only accepted rows, and undoes the whole plan in one step", () => {
    const [bass, padGlobal] = [
      plan.changes.find((change) => change.trackId === "bass" && change.purpose === "separation")!,
      plan.changes.find((change) => change.trackId === "pad" && change.scope.type === "global" && change.processing.filter.kind === "bell")!,
    ];
    let next = setEqRecommendationStatus(plan, bass.id, "rejected");
    next = editEqRecommendation(next, padGlobal.id, { gainDb: -0.9 });
    next = setEqRecommendationStatus(next, padGlobal.id, "accepted");
    useAppStore.getState().setEq({ plan: next });
    expect(next.changes.find((change) => change.id === padGlobal.id)!.edited).toBe(true);
    expect(applyEq("accepted")).toBe(true);
    const applied = useAppStore.getState().document!;
    expect(eqChainAt(applied, "pad", 10)).toEqual([{ ...padGlobal.processing.filter, gainDb: -0.9 }]);
    expect(eqChainAt(applied, "bass", 10)).toEqual([]);
    expect(applied.tracks.map((track) => track.file)).toEqual(document.tracks.map((track) => track.file));
    expect(useAppStore.getState().eq.plan).toBeNull();
    expect(monitorState(applied, useAppStore.getState().balance, useAppStore.getState().eq).eq).toEqual([
      { trackId: "pad", filters: [{ ...padGlobal.processing.filter, gainDb: -0.9 }], regions: [] },
    ]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document!.tracks).toEqual(document.tracks);
    expect(useAppStore.getState().document!.sectionTrackSettings).toEqual(document.sectionTrackSettings);
  });

  it("refuses a stale plan after a fader moves", () => {
    const moved = { ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, gainDb: -2 } : track)) };
    useAppStore.getState().replaceDocument(moved, true, { mode: "record" });
    const eq = useAppStore.getState().eq;
    expect(eqPlanIsStale(eq.plan!, moved, eq.fingerprints, eq.settings)).toBe(true);
    useAppStore.getState().setEq({ preview: true });
    expect(monitorState(moved, useAppStore.getState().balance, useAppStore.getState().eq).eq).toEqual([]);
    expect(applyEq("all")).toBe(false);
    expect(useAppStore.getState().document).toBe(moved);
  });

  it("refuses a stale plan after a prominence change but not after a selection", () => {
    const selected = { ...document, uiState: { ...document.uiState, selectedTrackId: "pad", playheadSeconds: 12 } };
    expect(eqPlanIsStale(plan, selected)).toBe(false);
    const marked = setTrackSectionState(document, "pad", "verse", { prominence: "primary" });
    if (!marked.ok) throw new Error(marked.message);
    expect(eqPlanIsStale(plan, marked.document)).toBe(true);
  });

  it("cancel discards the plan and leaves the project untouched", () => {
    setEqPreview(true);
    cancelEqPlan();
    expect(useAppStore.getState().document).toEqual(document);
    expect(useAppStore.getState().eq.plan).toBeNull();
    expect(useAppStore.getState().eq.preview).toBe(false);
    expect(useAppStore.getState().dirty).toBe(false);
  });
});

describe("monitor", () => {
  it("plays saved Track × Section gain, which AutoBalance writes on apply", () => {
    const { document } = demo();
    const withGain = {
      ...document,
      sectionTrackSettings: document.sectionTrackSettings.map((row) =>
        row.trackId === "bass" && row.sectionId === "drop" ? { ...row, overrides: { ...row.overrides, gainDb: -3 } } : row,
      ),
    };
    useAppStore.getState().openDocument(withGain, "/tmp/eq-flow/project.amix", []);
    const state = monitorState(withGain, useAppStore.getState().balance, useAppStore.getState().eq);
    expect(state.gainRegions).toEqual([{ trackId: "bass", startSeconds: 40, endSeconds: 60, gainDb: -3 }]);
    expect(monitorGainAt(state, "bass", 50)).toBe(-3);
    expect(monitorGainAt(state, "bass", 10)).toBe(0);
  });

  it("sends saved EQ, gain, pan, mute, solo, and section gain to the engine", () => {
    const { document } = demo();
    const sent: { eq: TrackEqSetting[] | null; regions: unknown[] | null; gains: Map<string, number> } = { eq: null, regions: null, gains: new Map() };
    const engine = {
      setTrackGain: (id: string, gain: number) => sent.gains.set(id, gain),
      setTrackPan: () => undefined,
      setMute: () => undefined,
      setSolo: () => undefined,
      setGainRegions: (regions: unknown[]) => (sent.regions = regions),
      setTrackEq: (tracks: TrackEqSetting[]) => (sent.eq = tracks),
      getCurrentTime: () => 0,
    } as unknown as AudioEngine;
    const saved = {
      ...document,
      tracks: document.tracks.map((track) =>
        track.id === "pad"
          ? { ...track, gainDb: -1.5, processing: { schemaVersion: 1 as const, nodes: [{ id: "n1", type: "eq" as const, enabled: true, filter: { kind: "high-pass" as const, frequencyHz: 70, gainDb: 0, q: 0.71 }, origin: "eq-plan" as const, note: "x" }] } }
          : track,
      ),
    };
    useAppStore.getState().openDocument(saved, "/tmp/eq-flow/project.amix", []);
    publishMonitor(engine, saved, monitorState(saved, useAppStore.getState().balance, useAppStore.getState().eq), true);
    expect(sent.eq).toEqual([{ trackId: "pad", filters: [{ kind: "high-pass", frequencyHz: 70, gainDb: 0, q: 0.71 }], regions: [] }]);
    expect(sent.gains.get("pad")).toBe(-1.5);
    expect(sent.regions).toEqual([]);
  });
});
