import { emptySession, runAgentTurn, type AgentEnvironment, type AgentSession } from "@audiosous/mix-agent";
import { ScriptedModel, call, respond, type ScriptStep } from "@audiosous/mix-agent/testing";
import { applyFullMixPlan } from "@audiosous/mix-planner";
import { multiProblem } from "@audiosous/mix-planner/testing";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { AssistantPanelView } from "../components/AssistantPanel";
import { useAppStore } from "../state/app-store";
import { applyAssistantCandidate, cancelAssistant, desktopEnvironment, sendAssistantMessage } from "./assistant";
import { editFullMixChange } from "./full-mix";
import { monitorState } from "./monitor";

/**
 * The assistant in the desktop app with the real store, the real Full Mix review, the real apply and undo, and a
 * scripted model. Only analysis loading is replaced (the fixture's inputs stand in for the desktop cache).
 */

let song: ReturnType<typeof multiProblem>;

function env(): AgentEnvironment {
  const base = desktopEnvironment(() => true);
  return { ...base, loadInputs: async () => ({ ...song, fingerprints: [], mixPeakDbfs: null, missing: [] }) };
}

async function say(message: string, steps: ScriptStep[], session: AgentSession = useAppStore.getState().assistant.session ?? emptySession(song.document.project.id)) {
  const model = new ScriptedModel(steps);
  const outcome = await runAgentTurn({ model, env: env(), session, message, isCurrent: () => true });
  if (outcome.status !== "done") throw new Error("superseded");
  useAppStore.getState().setAssistant({ session: outcome.session });
  return { ...outcome, model };
}

/** The mix as saved: everything but the selection, playhead, and view. */
function mix(document: ReturnType<typeof useAppStore.getState>["document"]) {
  return JSON.stringify({ tracks: document!.tracks, sections: document!.sections, rows: document!.sectionTrackSettings });
}

function heard() {
  const store = useAppStore.getState();
  return monitorState(store.document!, store.balance, store.eq, store.space, store.dynamics, store.fullMix);
}

describe("assistant in the desktop app", () => {
  beforeEach(() => {
    song = multiProblem();
    useAppStore.getState().openDocument(song.document, "/tmp/assistant-flow/project.amix", []);
  });

  it("builds a candidate into the Full Mix review without touching the project", async () => {
    const result = await say("Clean this mix up but don't touch the lead.", [call("plan_mix", { route: "full" }), respond("Candidate A is ready to preview.")]);
    const state = useAppStore.getState();
    expect(state.fullMix.phase).toBe("ready");
    expect(state.fullMix.plan?.constraints?.protectedTrackIds).toEqual(["lead"]);
    expect(state.planTab).toBe("full");
    expect(mix(state.document)).toBe(mix(song.document));
    expect(state.dirty).toBe(false);
    expect(state.history.past).toHaveLength(0);
    expect(heard().fullMix).toBeNull();
    expect(result.reply.cards?.[0]).toMatchObject({ kind: "candidate", label: "Candidate A" });
  });

  it("'let's hear it' switches the A/B to the candidate; it never applies", async () => {
    const first = await say("Clean this mix up.", [call("plan_mix", { route: "full" }), respond("Candidate A is ready.")]);
    await say("Let's hear it.", [call("preview", { what: "candidate" }), respond("Playing Candidate A.")], first.session);
    expect(useAppStore.getState().fullMix.preview).toBe(true);
    expect(heard().fullMix).not.toBeNull();
    expect(mix(useAppStore.getState().document)).toBe(mix(song.document));
  });

  it("sees the person's own edit in the plan UI and applies exactly the reviewed candidate as one undo step", async () => {
    const first = await say("Clean this mix up.", [call("plan_mix", { route: "full" }), respond("Candidate A is ready.")]);
    const plan = useAppStore.getState().fullMix.plan!;
    const eq = plan.changes.find((change) => change.processing.type === "eq")!;
    editFullMixChange(eq.id, { gainDb: -1 });
    const edited = useAppStore.getState().fullMix.plan!;
    const second = await say("That's better. Apply it.", [
      (request) => {
        expect((request.messages[0]!.content[0] as { text: string }).text).toMatch(/editedByPerson/);
        return call("apply_candidate", {});
      },
      respond("Applied."),
    ], first.session);
    const expected = applyFullMixPlan(song.document, edited, "all");
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const state = useAppStore.getState();
    expect(JSON.stringify(state.document!.tracks)).toBe(JSON.stringify(expected.document.tracks));
    expect(state.history.past).toHaveLength(1);
    expect(state.fullMix.phase).toBe("idle");
    expect(second.session.lastApply?.lines.some((line) => line.includes("−1.0 dB") || line.includes("-1.0 dB"))).toBe(true);
    // Conversational undo is the store's undo.
    await say("Undo that.", [call("undo_last_apply", {}), respond("Undone.")], second.session);
    expect(mix(useAppStore.getState().document)).toBe(mix(song.document));
    expect(useAppStore.getState().history.past).toHaveLength(0);
  });

  it("refuses to apply a candidate the mix moved under, from the conversation and from the card", async () => {
    const first = await say("Clean this mix up.", [call("plan_mix", { route: "full" }), respond("Candidate A is ready.")]);
    const document = useAppStore.getState().document!;
    useAppStore.getState().replaceDocument({ ...document, tracks: document.tracks.map((track) => (track.id === "pad" ? { ...track, gainDb: track.gainDb - 2 } : track)) }, true);
    const moved = useAppStore.getState().document;
    const result = await say("Apply it.", [call("apply_candidate", {}), respond("The mix changed since I built that candidate; I'll need to rebuild it.")], first.session);
    expect(result.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    applyAssistantCandidate("all");
    expect(useAppStore.getState().assistant.error).toMatch(/out of date/);
    expect(useAppStore.getState().document).toBe(moved);
  });

  it("points the interface at what it talks about without recording an edit", async () => {
    await say("What's going on with the pad?", [call("detect_mix_problems", { tracks: ["pad"] }), respond("The Pad masks the Lead.", { focus: { trackIds: ["Pad"], sectionId: "Chorus" } })]);
    const state = useAppStore.getState();
    expect(state.document!.uiState.selectedTrackId).toBe("pad");
    expect(state.document!.uiState.selectedSectionId).toBe("all");
    expect(state.history.past).toHaveLength(0);
    expect(state.workspace).toBe("mix");
  });

  it("carries out an explicit instruction as one undo step", async () => {
    await say("Pan the synth 20% left.", [call("set_track_control", { track: "synth", control: "pan", mode: "set", value: -20 }), respond("Synth panned 20% left.")]);
    const state = useAppStore.getState();
    expect(state.document!.tracks.find((track) => track.id === "synth")!.pan).toBeCloseTo(-0.2, 5);
    expect(state.history.past).toHaveLength(1);
    state.undo();
    expect(mix(useAppStore.getState().document)).toBe(mix(song.document));
  });

  it("works offline: without a provider it says so and changes nothing", async () => {
    await sendAssistantMessage("Make it punchier.");
    const state = useAppStore.getState();
    expect(state.assistant.error).toMatch(/Connect an AI provider/);
    expect(state.assistant.busy).toBe(false);
    expect(state.document).toBe(song.document);
    expect(state.fullMix.plan).toBeNull();
  });

  it("cancel drops the request in flight", () => {
    useAppStore.getState().setAssistant({ busy: true, pending: "x", generation: 4 });
    cancelAssistant();
    const assistant = useAppStore.getState().assistant;
    expect(assistant.busy).toBe(false);
    expect(assistant.generation).toBe(5);
  });

  it("keeps the conversation out of the project file", async () => {
    await say("Clean this mix up.", [call("plan_mix", { route: "full" }), respond("Candidate A is ready.")]);
    expect(JSON.stringify(useAppStore.getState().document)).not.toMatch(/Candidate A|Clean this mix/);
  });

  it("renders the panel, its cards, and the offline notice", async () => {
    useAppStore.getState().setAssistant({ open: true, settings: { provider: "none", model: "", effort: "medium", keySource: null } });
    const view = () => {
      const state = useAppStore.getState();
      return renderToString(createElement(AssistantPanelView, { assistant: state.assistant, document: state.document!, fullMix: state.fullMix })).replaceAll("<!-- -->", "");
    };
    let html = view();
    expect(html).toMatch(/Assistant/);
    expect(html).toMatch(/needs the desktop app|Connect an AI provider/);
    await say("Clean this mix up.", [call("plan_mix", { route: "full" }), respond("Candidate A is ready to preview.")]);
    html = view();
    for (const text of ["Candidate A is ready to preview.", "Candidate A", "Preview", "Current", "Inspect", "Apply"]) expect(html).toContain(text);
  });
});
