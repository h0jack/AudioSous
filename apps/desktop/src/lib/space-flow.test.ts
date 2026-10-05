import type { AudioEngine, TrackSpatialSetting } from "@audiosous/audio-engine";
import { setTrackEqNodes, spatialForSection, type ProjectDocument } from "@audiosous/project-model";
import { editSpatialRecommendation, planSpace, setSpatialRecommendationStatus, spatialPlanIsStale, type SpatialPlan } from "@audiosous/spatial-planner";
import { BASS, KICK, LEAD, NOW, PAD_MASKING, base, bump, spatialSong, sum } from "@audiosous/spatial-planner/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/app-store";
import { setEqPreview } from "./eq";
import { monitorPanAt, monitorState, publishMonitor } from "./monitor";
import { applySpace, auditionSpace, cancelSpacePlan, hearSpaceRow, setSpacePreview, spaceHearing, spaceScope } from "./space";

/** The milestone's acceptance project: Lead and Pad share the center in the Chorus; Pad and Synth are both wide in the Drop. */
function demo() {
  return spatialSong({
    tracks: [
      { id: "kick", name: "Kick", role: "kick", fixture: { shape: KICK, crest: 16, onsets: 2 }, stereo: { mono: true } },
      { id: "bass", name: "Bass", role: "bass", fixture: { shape: BASS }, stereo: { correlation: 0.99 } },
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD, active: [[0, 30]] }, stereo: { correlation: 0.98 } },
      { id: "pad", name: "Pad", role: "pad", width: 1.1, fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.75 } },
      { id: "synth", name: "Synth", role: "synth", pan: -0.15, width: 1.3, fixture: { shape: sum(base(-40, -1), bump(2_600, 0.8, 11)), active: [[30, 60]] }, stereo: { correlation: 0.3 } },
      { id: "atmos", name: "Atmosphere", role: "atmosphere", width: 0.6, fixture: { shape: sum(base(-48, -1), bump(1_000, 1.5, 6)) }, stereo: { correlation: 0.6 } },
    ],
    sections: [
      { id: "chorus", name: "Chorus", type: "chorus", start: 0, end: 30 },
      { id: "drop", name: "Drop", type: "drop", start: 30, end: 60 },
    ],
    prominence: [{ track: "lead", section: "chorus", prominence: "focal" }],
  });
}

function spatialOf(state: ReturnType<typeof monitorState>, trackId: string, seconds: number) {
  const track = state.spatial.find((item) => item.trackId === trackId)!;
  const region = track.regions.find((item) => seconds >= item.startSeconds && seconds < item.endSeconds);
  return region ? { pan: region.pan, width: region.width } : { pan: track.pan, width: track.width };
}

describe("Space review flow", () => {
  let document: ProjectDocument;
  let plan: SpatialPlan;

  beforeEach(() => {
    const input = demo();
    document = input.document;
    plan = planSpace({ ...input, now: NOW });
    useAppStore.getState().openDocument(document, "/tmp/space-flow/project.amix", []);
    useAppStore.getState().setSpace({ open: true, phase: "ready", plan, fingerprints: [] });
  });

  it("produces the acceptance plan: Pad moves off the Lead, Atmosphere widens, Kick, Bass, and Lead stay", () => {
    const pad = plan.changes.find((change) => change.trackId === "pad" && change.scope.type === "global")!;
    const atmos = plan.changes.find((change) => change.trackId === "atmos")!;
    expect(pad.processing.pan).not.toBeNull();
    expect(pad.reasons[0]).toMatch(/Pad .* because it overlaps the centered Lead .* during most of the Chorus\. Lead is Focal and Pad is Supporting\./);
    expect(atmos.processing.width!).toBeGreaterThan(0.6);
    expect(atmos.reasons[0]).toMatch(/Background part/);
    expect(plan.changes.some((change) => ["kick", "bass", "lead"].includes(change.trackId))).toBe(false);
    expect(spaceScope(document)).toMatch(/each of the 2 sections separately/);
  });

  it("A/Bs the whole plan and one row without touching the project", () => {
    const store = useAppStore.getState;
    const pad = plan.changes.find((change) => change.trackId === "pad" && change.scope.type === "global")!;
    const current = monitorState(store().document!, store().balance, store().eq, store().space);
    expect(spatialOf(current, "pad", 10)).toEqual({ pan: 0, width: 1.1 });
    setSpacePreview(true);
    const candidate = monitorState(store().document!, store().balance, store().eq, store().space);
    expect(spatialOf(candidate, "pad", 10).pan).toBe(pad.processing.pan);
    auditionSpace(pad.id, "recommended");
    const single = monitorState(store().document!, store().balance, store().eq, store().space);
    expect(spatialOf(single, "pad", 10).pan).toBe(pad.processing.pan);
    expect(spatialOf(single, "atmos", 10)).toEqual({ pan: 0, width: 0.6 });
    auditionSpace(pad.id, "bypassed");
    expect(spatialOf(monitorState(store().document!, store().balance, store().eq, store().space), "pad", 10)).toEqual({ pan: 0, width: 1.1 });
    expect(store().document).toBe(document);
    expect(store().dirty).toBe(false);
  });

  it("hears an edit right away: from Current it starts that row's audition, and an included row keeps the candidate playing", () => {
    const store = useAppStore.getState;
    const pad = plan.changes.find((change) => change.trackId === "pad" && change.scope.type === "global")!;
    expect(spaceHearing(document, store().space)).toBe("Hearing Current (saved mix)");
    store().setSpace({ plan: editSpatialRecommendation(plan, pad.id, { pan: -0.3 }) });
    hearSpaceRow(pad.id);
    expect(store().space).toMatchObject({ auditionId: pad.id, auditionSide: "recommended", preview: false });
    expect(spaceHearing(document, store().space)).toBe("Hearing Pad with only this change");
    const heard = monitorState(store().document!, store().balance, store().eq, store().space);
    expect(spatialOf(heard, "pad", 10).pan).toBe(-0.3);
    setSpacePreview(true);
    hearSpaceRow(pad.id);
    expect(store().space).toMatchObject({ preview: true, auditionId: null });
    expect(spaceHearing(document, store().space)).toBe("Hearing the Spatial Candidate");
  });

  it("one comparison plays at a time across gain, EQ, and space", () => {
    useAppStore.getState().setBalance({ preview: true });
    useAppStore.getState().setEq({ preview: true });
    setSpacePreview(true);
    expect(useAppStore.getState().balance.preview).toBe(false);
    expect(useAppStore.getState().eq.preview).toBe(false);
    setEqPreview(true);
    expect(useAppStore.getState().space.preview).toBe(false);
  });

  it("follows the demonstration: bypass Pad, edit it to +0.12, reject Atmosphere, apply accepted, then undo in one step", () => {
    const pad = plan.changes.find((change) => change.trackId === "pad" && change.scope.type === "global")!;
    const atmos = plan.changes.find((change) => change.trackId === "atmos")!;
    auditionSpace(pad.id, "bypassed");
    let next = editSpatialRecommendation(plan, pad.id, { pan: 0.12 });
    next = setSpatialRecommendationStatus(next, pad.id, "accepted");
    next = setSpatialRecommendationStatus(next, atmos.id, "rejected");
    useAppStore.getState().setSpace({ plan: next });
    // The edited value is heard immediately in the single-row audition.
    auditionSpace(pad.id, "recommended");
    const heard = monitorState(useAppStore.getState().document!, useAppStore.getState().balance, useAppStore.getState().eq, useAppStore.getState().space);
    expect(spatialOf(heard, "pad", 10).pan).toBe(0.12);
    expect(applySpace("accepted")).toBe(true);
    const applied = useAppStore.getState().document!;
    expect(spatialForSection(applied, "pad", null).pan).toBe(0.12);
    expect(spatialForSection(applied, "atmos", null)).toEqual({ pan: 0, width: 0.6 });
    expect(applied.tracks.map((track) => track.file)).toEqual(document.tracks.map((track) => track.file));
    expect(applied.tracks.map((track) => track.processing)).toEqual(document.tracks.map((track) => track.processing));
    expect(useAppStore.getState().space.plan).toBeNull();
    useAppStore.getState().undo();
    expect(useAppStore.getState().document!.tracks).toEqual(document.tracks);
    expect(useAppStore.getState().document!.sectionTrackSettings).toEqual(document.sectionTrackSettings);
  });

  it("refuses a stale plan after a fader moves or EQ changes, and stops previewing it", () => {
    const moved = { ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, gainDb: -2 } : track)) };
    useAppStore.getState().replaceDocument(moved, true, { mode: "record" });
    const space = useAppStore.getState().space;
    expect(spatialPlanIsStale(space.plan!, moved, space.fingerprints, space.settings)).toBe(true);
    useAppStore.getState().setSpace({ preview: true });
    expect(spatialOf(monitorState(moved, useAppStore.getState().balance, useAppStore.getState().eq, useAppStore.getState().space), "pad", 10)).toEqual({ pan: 0, width: 1.1 });
    expect(applySpace("all")).toBe(false);
    expect(useAppStore.getState().document).toBe(moved);
    const carved = setTrackEqNodes(document, "pad", [{ id: "x", type: "eq", enabled: true, filter: { kind: "bell", frequencyHz: 2_000, gainDb: -2, q: 1 }, origin: "manual", note: null }]);
    if (!carved.ok) throw new Error(carved.message);
    expect(spatialPlanIsStale(plan, carved.document)).toBe(true);
  });

  it("does not go stale on selection or the playhead", () => {
    const selected = { ...document, uiState: { ...document.uiState, selectedTrackId: "pad", playheadSeconds: 12 } };
    expect(spatialPlanIsStale(plan, selected)).toBe(false);
  });

  it("cancel discards the plan and leaves the project untouched", () => {
    setSpacePreview(true);
    cancelSpacePlan();
    expect(useAppStore.getState().document).toEqual(document);
    expect(useAppStore.getState().space.plan).toBeNull();
    expect(useAppStore.getState().space.preview).toBe(false);
    expect(useAppStore.getState().dirty).toBe(false);
  });
});

describe("spatial monitor", () => {
  it("sends saved pan, width, and section pan/width to the native engine, and section pan to the legacy one", () => {
    const { document } = demo();
    const withSection = {
      ...document,
      sectionTrackSettings: [
        ...document.sectionTrackSettings,
        { trackId: "pad", sectionId: "drop", userIntent: null, prominence: null, overrides: { gainDb: null, pan: 0.3, width: 1.25 }, processing: { schemaVersion: 2 as const, nodes: [], dynamics: [] } },
      ],
    };
    useAppStore.getState().openDocument(withSection, "/tmp/space-flow/project.amix", []);
    const sent: { spatial: TrackSpatialSetting[] | null; pans: Map<string, number> } = { spatial: null, pans: new Map() };
    const engine = {
      setTrackGain: () => undefined,
      setTrackPan: (id: string, pan: number) => sent.pans.set(id, pan),
      setMute: () => undefined,
      setSolo: () => undefined,
      setGainRegions: () => undefined,
      setTrackEq: () => undefined,
      setTrackSpatial: (tracks: TrackSpatialSetting[]) => (sent.spatial = tracks),
      getCurrentTime: () => 45,
    } as unknown as AudioEngine;
    const state = monitorState(withSection, useAppStore.getState().balance, useAppStore.getState().eq, useAppStore.getState().space);
    publishMonitor(engine, withSection, state, true);
    expect(sent.spatial!.find((item) => item.trackId === "pad")).toEqual({ trackId: "pad", pan: 0, width: 1.1, regions: [{ startSeconds: 30, endSeconds: 60, pan: 0.3, width: 1.25 }] });
    expect(sent.spatial!.find((item) => item.trackId === "synth")).toEqual({ trackId: "synth", pan: -0.15, width: 1.3, regions: [] });
    expect(sent.pans.size).toBe(0);
    publishMonitor(engine, withSection, state, false);
    expect(sent.pans.get("pad")).toBe(0.3);
    expect(monitorPanAt(state, "pad", 10)).toBe(0);
  });
});
