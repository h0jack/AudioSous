import type { SongProfile } from "@audiosous/mix-planner";
import { multiProblem } from "@audiosous/mix-planner/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPlatform, MixCheckRequest, ReferenceInfo } from "../platform/types";
import { idleBalance, idleDynamics, idleEq, idleFullMix, idleSpace, useAppStore } from "../state/app-store";
import { engineVariant } from "./full-mix";
import { monitorState, publishMonitor } from "./monitor";
import { REFERENCE_TRACK_ID } from "./native-playback";
import { referenceMonitor } from "./playback";
import { importReference, loadReferences, planTowardReference, referenceComparison, selectReference, setReferenceListening } from "./reference";

const EDGES = Array.from({ length: 25 }, (_, index) => 20 * 1000 ** (index / 24));
const CENTERS = EDGES.slice(0, -1).map((low, index) => Math.sqrt(low * EDGES[index + 1]!));

function profile(lufs: number, lowMid = 0): SongProfile {
  return {
    version: 1,
    durationSeconds: 60,
    loudness: { integratedLufs: lufs, loudnessRangeLu: 6, samplePeakDbfs: lufs + 9, truePeakDbtp: lufs + 9.3, maxShortTermLufs: lufs + 2 },
    edgesHz: EDGES,
    midDb: CENTERS.map((hz) => -20 - 3 * Math.log2(hz / 1000) + (hz >= 150 && hz < 500 ? lowMid : 0)),
    sideDb: CENTERS.map((hz) => -28 - 3 * Math.log2(hz / 1000) + (hz >= 150 && hz < 500 ? lowMid : 0)),
    bodyShare: 0.9,
    crestDb: 12,
    lowCorrelation: 0.95,
  };
}

const REF: ReferenceInfo = { name: "Night Drive Master", durationSeconds: 60, profile: profile(-9) };

function shell() {
  const profiles: MixCheckRequest[] = [];
  const platform = {
    kind: "tauri",
    listReferences: vi.fn(async () => [REF]),
    pickReferenceFile: vi.fn(async () => "/music/Night Drive Master.mp3"),
    importReference: vi.fn(async () => REF),
    deleteReference: vi.fn(async () => undefined),
    // The saved mix measures 4 dB heavier in the low-mids than the reference, and 9 dB quieter.
    mixProfile: vi.fn(async (_file: string, request: { variant: { name: string } }) => (request.variant.name === "candidate" ? profile(-18.5, 1.5) : profile(-18, 4))),
    checkMix: vi.fn(async (_file: string, request: MixCheckRequest) => {
      profiles.push(request);
      return request.variants.map((variant) => ({ name: variant.name, seconds: 10, peakDbfs: -6, rmsDb: -20, monoLossDb: 0.5, correlation: 0.8, sections: [] }));
    }),
    appendLog: vi.fn(async () => undefined),
  } as unknown as DesktopPlatform;
  return platform;
}

describe("reference songs in the desktop app", () => {
  let song: ReturnType<typeof multiProblem>;
  beforeEach(() => {
    song = multiProblem();
    useAppStore.getState().openDocument(song.document, "/tmp/reference-flow/project.amix", []);
  });

  it("lists, selects, measures the mix, and compares", async () => {
    const platform = shell();
    await loadReferences(platform);
    await vi.waitFor(() => expect(useAppStore.getState().reference.mixProfile).not.toBeNull());
    const state = useAppStore.getState().reference;
    expect(state.selected).toBe("Night Drive Master");
    const comparison = referenceComparison(state)!;
    expect(comparison.tonal.find((gap) => gap.region.id === "low-mid")!.gapDb).toBeGreaterThan(2);
    expect(comparison.findings.join(" ")).toMatch(/muddier/);
    expect(comparison.findings.join(" ")).toMatch(/reference is 9\.0 dB louder/);
  });

  it("imports a reference without touching the project", async () => {
    const platform = shell();
    await importReference(platform);
    expect(platform.importReference).toHaveBeenCalledWith("/tmp/reference-flow/project.amix", "/music/Night Drive Master.mp3");
    expect(useAppStore.getState().reference.selected).toBe("Night Drive Master");
    expect(useAppStore.getState().document).toBe(song.document);
    expect(useAppStore.getState().dirty).toBe(false);
  });

  it("plans toward the reference as a Full Mix candidate, renders it, and measures it again", async () => {
    const platform = shell();
    await loadReferences(platform);
    await vi.waitFor(() => expect(useAppStore.getState().reference.mixProfile).not.toBeNull());
    const loadInputs = vi.fn(async () => ({ measurements: song.measurements, bands: song.bands, stereo: song.stereo, envelopes: song.envelopes, fingerprints: [], mixPeakDbfs: -6 }));
    await planTowardReference("normal", platform, loadInputs);
    const state = useAppStore.getState();
    expect(state.reference.phase).toBe("ready");
    const plan = state.fullMix.plan!;
    expect(plan.reference?.name).toBe("Night Drive Master");
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.changes.every((change) => change.source === "reference")).toBe(true);
    expect(state.fullMix.phase).toBe("ready");
    expect(state.reference.planCreatedAt).toBe(plan.createdAt);
    expect(state.reference.candidateProfile).not.toBeNull();
    const after = referenceComparison(state.reference, "candidate")!;
    expect(Math.abs(after.tonal.find((gap) => gap.region.id === "low-mid")!.gapDb)).toBeLessThan(2.5);
    // Nothing is written until Apply.
    expect(state.document).toBe(song.document);
    expect(state.tasks.reference).toMatchObject({ status: "complete" });
  });

  it("A/B plays the reference alone at the mix's loudness, on the same engine", async () => {
    const platform = shell();
    await loadReferences(platform);
    await vi.waitFor(() => expect(useAppStore.getState().reference.mixProfile).not.toBeNull());
    expect(referenceMonitor(useAppStore.getState().reference, true)).toEqual({ trackId: REFERENCE_TRACK_ID, listening: false, gainDb: -9 });
    setReferenceListening(true);
    const ref = referenceMonitor(useAppStore.getState().reference, true)!;
    const calls: string[] = [];
    const engine = {
      getCurrentTime: () => 0,
      setTrackGain: (id: string, db: number) => calls.push(`gain ${id} ${db}`),
      setTrackPan: () => undefined,
      setMute: (id: string, muted: boolean) => calls.push(`mute ${id} ${muted}`),
      setSolo: () => undefined,
    } as unknown as Parameters<typeof publishMonitor>[0];
    publishMonitor(engine, song.document, monitorState(song.document, idleBalance(), idleEq(), idleSpace(), idleDynamics(), idleFullMix()), true, ref);
    for (const track of song.document.tracks) expect(calls).toContain(`mute ${track.id} true`);
    expect(calls).toContain(`mute ${REFERENCE_TRACK_ID} false`);
    expect(calls).toContain(`gain ${REFERENCE_TRACK_ID} -9`);
    setReferenceListening(false);
    calls.length = 0;
    publishMonitor(engine, song.document, monitorState(song.document, idleBalance(), idleEq(), idleSpace(), idleDynamics(), idleFullMix()), true, referenceMonitor(useAppStore.getState().reference, true));
    expect(calls).toContain(`mute ${REFERENCE_TRACK_ID} true`);
    expect(calls.filter((line) => line.endsWith(" true") && !line.includes(REFERENCE_TRACK_ID))).toHaveLength(song.document.tracks.filter((track) => track.muted).length);
    expect(referenceMonitor(useAppStore.getState().reference, false)).toBeNull();
  });

  it("measures the mix as the engine plays it", async () => {
    const platform = shell();
    selectReference(null);
    await loadReferences(platform);
    await vi.waitFor(() => expect(platform.mixProfile).toHaveBeenCalled());
    const request = (platform.mixProfile as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { variant: unknown; durationSeconds: number };
    expect(request.variant).toEqual(engineVariant("current", song.document));
    expect(request.durationSeconds).toBe(song.document.project.durationSeconds);
  });
});
