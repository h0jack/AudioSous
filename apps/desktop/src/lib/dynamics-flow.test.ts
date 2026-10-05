import type { AudioEngine, TrackDynamicsSetting } from "@audiosous/audio-engine";
import {
  dynamicsPlanIsStale,
  editDynamicsRecommendation,
  planDynamics,
  setDynamicsRecommendationStatus,
  type DynamicsPlan,
  type DynamicsRecommendation,
} from "@audiosous/dynamics-planner";
import { NOW, SAVED_COMPRESSOR, demonstration, fixtureA } from "@audiosous/dynamics-planner/testing";
import { setTrackEqNodes, trackDynamicsNodes, sectionDynamicsNodes, type ProjectDocument } from "@audiosous/project-model";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import {
  applyDynamics,
  auditionDynamics,
  cancelDynamicsPlan,
  dynamicsCheckRequest,
  dynamicsHearing,
  dynamicsScope,
  hearDynamicsRow,
  setDynamicsPreview,
} from "./dynamics";
import { setEqPreview } from "./eq";
import { monitorGainAt, monitorState, publishMonitor } from "./monitor";
import { setSpacePreview } from "./space";

function row(plan: DynamicsPlan, trackId: string, type: DynamicsRecommendation["processing"]["type"]): DynamicsRecommendation {
  const found = plan.changes.find((change) => change.trackId === trackId && change.processing.type === type);
  if (!found) throw new Error(`no ${type} row on ${trackId}`);
  return found;
}

function heard() {
  const store = useAppStore.getState();
  return monitorState(store.document!, store.balance, store.eq, store.space, store.dynamics);
}

function nodesOf(state: ReturnType<typeof heard>, trackId: string, seconds: number) {
  const track = state.dynamics.find((item) => item.trackId === trackId);
  if (!track) return [];
  const region = track.regions.find((item) => seconds >= item.startSeconds && seconds < item.endSeconds);
  return [...track.nodes, ...(region?.nodes ?? [])].map((node) => node.type);
}

describe("Dynamics review flow", () => {
  let document: ProjectDocument;
  let plan: DynamicsPlan;

  beforeEach(() => {
    const input = demonstration();
    document = input.document;
    plan = planDynamics({ ...input, now: NOW });
    useAppStore.getState().openDocument(document, "/tmp/dynamics-flow/project.amix", []);
    useAppStore.getState().setDynamics({ open: true, phase: "ready", plan, fingerprints: [] });
  });

  it("produces the acceptance plan and says what it reads", () => {
    expect(plan.changes.map((change) => `${change.trackId}:${change.processing.type}`).sort()).toEqual(["bass:compressor", "bass:ducking", "pad:dynamic-eq", "snare:transient"]);
    expect(row(plan, "bass", "ducking").scope).toEqual({ type: "section", sectionId: "drop" });
    expect(dynamicsScope(document)).toMatch(/each of the 2 sections/);
  });

  it("A/Bs the whole plan and one row through the monitor without touching the project", () => {
    expect(nodesOf(heard(), "bass", 40)).toEqual([]);
    expect(dynamicsHearing(document, useAppStore.getState().dynamics)).toBe("Hearing Current (saved mix)");
    setDynamicsPreview(true);
    expect(nodesOf(heard(), "bass", 10)).toEqual(["compressor"]);
    expect(nodesOf(heard(), "bass", 40)).toEqual(["compressor", "ducking"]);
    expect(nodesOf(heard(), "pad", 40)).toEqual(["dynamic-eq"]);
    expect(dynamicsHearing(document, useAppStore.getState().dynamics)).toBe("Hearing the Dynamics Candidate, level-matched");
    // Level match: the compressed bass plays louder than its saved fader in the audition, by what compression removes.
    const comp = row(plan, "bass", "compressor");
    expect(heard().gains.get("bass")).toBeCloseTo(-comp.evaluation!.levelChangeDb, 1);
    const duck = row(plan, "bass", "ducking");
    expect(monitorGainAt(heard(), "bass", 40)).toBeCloseTo(-comp.evaluation!.levelChangeDb - duck.evaluation!.levelChangeDb, 1);
    useAppStore.getState().setDynamics({ levelMatch: false });
    expect(heard().gains.get("bass")).toBe(0);
    useAppStore.getState().setDynamics({ levelMatch: true });
    auditionDynamics(duck.id, "recommended");
    expect(nodesOf(heard(), "bass", 40)).toEqual(["ducking"]);
    expect(nodesOf(heard(), "pad", 40)).toEqual([]);
    auditionDynamics(duck.id, "bypassed");
    expect(nodesOf(heard(), "bass", 40)).toEqual([]);
    expect(dynamicsHearing(document, useAppStore.getState().dynamics)).toBe("Hearing Bass without this change");
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().dirty).toBe(false);
  });

  it("one comparison plays at a time across gain, EQ, space, and dynamics", () => {
    useAppStore.getState().setBalance({ preview: true });
    useAppStore.getState().setEq({ preview: true });
    useAppStore.getState().setSpace({ preview: true });
    setDynamicsPreview(true);
    expect(useAppStore.getState().balance.preview).toBe(false);
    expect(useAppStore.getState().eq.preview).toBe(false);
    expect(useAppStore.getState().space.preview).toBe(false);
    setEqPreview(true);
    expect(useAppStore.getState().dynamics.preview).toBe(false);
    setDynamicsPreview(true);
    setSpacePreview(true);
    expect(useAppStore.getState().dynamics.preview).toBe(false);
  });

  it("hears an edit right away", () => {
    const duck = row(plan, "bass", "ducking");
    useAppStore.getState().setDynamics({ plan: editDynamicsRecommendation(plan, duck.id, { rangeDb: -1.3 }) });
    hearDynamicsRow(duck.id);
    expect(useAppStore.getState().dynamics).toMatchObject({ auditionId: duck.id, auditionSide: "recommended", preview: false });
    const node = heard().dynamics.find((item) => item.trackId === "bass")!.regions[0]!.nodes[0]!;
    expect(node).toMatchObject({ type: "ducking", rangeDb: -1.3 });
    setDynamicsPreview(true);
    hearDynamicsRow(duck.id);
    expect(useAppStore.getState().dynamics).toMatchObject({ preview: true, auditionId: null });
  });

  it("follows the demonstration: reject Snare, edit the duck to −1.3 dB, apply accepted, undo in one step", () => {
    const duck = row(plan, "bass", "ducking");
    const snare = row(plan, "snare", "transient");
    let next = setDynamicsRecommendationStatus(plan, snare.id, "rejected");
    next = editDynamicsRecommendation(next, duck.id, { rangeDb: -1.3 });
    for (const change of next.changes) if (change.id !== snare.id) next = setDynamicsRecommendationStatus(next, change.id, "accepted");
    useAppStore.getState().setDynamics({ plan: next });
    setDynamicsPreview(true);
    expect(applyDynamics("accepted")).toBe(true);
    const applied = useAppStore.getState().document!;
    expect(trackDynamicsNodes(applied, "bass").map((node) => node.type)).toEqual(["compressor"]);
    expect(sectionDynamicsNodes(applied, "bass", "drop")[0]).toMatchObject({ type: "ducking", keyTrackId: "kick", rangeDb: -1.3, origin: "dynamics-plan" });
    expect(trackDynamicsNodes(applied, "pad")[0]).toMatchObject({ type: "dynamic-eq", keyTrackId: "lead" });
    expect(trackDynamicsNodes(applied, "snare")).toEqual([]);
    expect(applied.tracks.map((track) => track.file)).toEqual(document.tracks.map((track) => track.file));
    expect(applied.tracks.map((track) => track.gainDb)).toEqual(document.tracks.map((track) => track.gainDb));
    expect(useAppStore.getState().dynamics.plan).toBeNull();
    // The saved mix now plays the applied nodes, and no audition offset remains.
    expect(nodesOf(heard(), "bass", 40)).toEqual(["compressor", "ducking"]);
    expect(heard().gains.get("bass")).toBe(0);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document!.tracks).toEqual(document.tracks);
    expect(useAppStore.getState().document!.sectionTrackSettings).toEqual(document.sectionTrackSettings);
  });

  it("refuses a stale plan after a fader move or an EQ change, and stops auditioning it", () => {
    const moved = { ...document, tracks: document.tracks.map((track) => (track.id === "bass" ? { ...track, gainDb: -2 } : track)) };
    useAppStore.getState().replaceDocument(moved, true, { mode: "record" });
    const session = useAppStore.getState().dynamics;
    expect(dynamicsPlanIsStale(session.plan!, moved, session.fingerprints, session.settings)).toBe(true);
    useAppStore.getState().setDynamics({ preview: true });
    expect(nodesOf(heard(), "bass", 40)).toEqual([]);
    expect(applyDynamics("all")).toBe(false);
    expect(useAppStore.getState().document).toBe(moved);
    const carved = setTrackEqNodes(document, "pad", [{ id: "x", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 2_000, gainDb: -2, q: 1 }, origin: "manual", note: null }]);
    if (!carved.ok) throw new Error(carved.message);
    expect(dynamicsPlanIsStale(plan, carved.document)).toBe(true);
  });

  it("does not go stale on selection or the playhead", () => {
    expect(dynamicsPlanIsStale(plan, { ...document, uiState: { ...document.uiState, selectedTrackId: "pad", playheadSeconds: 12 } })).toBe(false);
  });

  it("cancel discards the plan and leaves the project untouched", () => {
    setDynamicsPreview(true);
    cancelDynamicsPlan();
    expect(useAppStore.getState().document).toEqual(document);
    expect(useAppStore.getState().dynamics).toMatchObject({ plan: null, preview: false, open: false });
    expect(useAppStore.getState().dirty).toBe(false);
  });

  it("builds a proxy check from the row's scope: its key, saved EQ, and before/after chains", () => {
    const duck = row(plan, "bass", "ducking");
    const request = dynamicsCheckRequest(document, duck)!;
    expect(request).toMatchObject({ trackId: "bass", keyTrackId: "kick", kind: "ducking", band: [40, 150] });
    expect(request.before).toEqual([]);
    expect(request.after).toEqual([expect.objectContaining({ type: "ducking", keyTrackId: "kick" })]);
    expect(request.windows.length).toBeGreaterThan(0);
  });
});

describe("dynamics monitor", () => {
  it("sends saved dynamics to the native engine and nothing to the legacy one", () => {
    const input = fixtureA({ dynamics: [{ track: "bass", nodes: [SAVED_COMPRESSOR] }] });
    useAppStore.getState().openDocument(input.document, "/tmp/dynamics-flow/project.amix", []);
    const sent: { dynamics: TrackDynamicsSetting[] | null } = { dynamics: null };
    const engine = {
      setTrackGain: () => undefined,
      setTrackPan: () => undefined,
      setMute: () => undefined,
      setSolo: () => undefined,
      setGainRegions: () => undefined,
      setTrackEq: () => undefined,
      setTrackSpatial: () => undefined,
      setTrackDynamics: (tracks: TrackDynamicsSetting[]) => (sent.dynamics = tracks),
      getCurrentTime: () => 0,
    } as unknown as AudioEngine;
    publishMonitor(engine, input.document, heard(), true);
    expect(sent.dynamics).toEqual([{ trackId: "bass", nodes: [{ type: "compressor", thresholdDb: -12, ratio: 1.5, attackMs: 30, releaseMs: 200, kneeDb: 6, makeupDb: 0 }], regions: [] }]);
    sent.dynamics = null;
    publishMonitor(engine, input.document, heard(), false);
    expect(sent.dynamics).toBeNull();
  });
});
