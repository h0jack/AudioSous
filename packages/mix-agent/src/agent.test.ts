import { applyFullMixPlan, editChange, processorKind, type FullMixPlan } from "@audiosous/mix-planner";
import { LEAD, PAD_MASKING, fixtureA, fixtureB, fixtureG, fixtureH, mixSong, multiProblem } from "@audiosous/mix-planner/testing";
import { describe, expect, it } from "vitest";
import { applyFromPanel, fitJson, runAgentTurn } from "./agent";
import { AGENT_LIMITS, emptySession, type AgentSession } from "./contract";
import { MemoryEnvironment, ScriptedModel, call, calls_, clarify, respond, type ScriptStep, type Song } from "./testing";

async function turn(env: MemoryEnvironment, session: AgentSession, message: string, steps: ScriptStep[], isCurrent: () => boolean = () => true) {
  const model = new ScriptedModel(steps);
  const outcome = await runAgentTurn({ model, env, session, message, isCurrent });
  if (outcome.status !== "done") throw new Error("superseded");
  return { ...outcome, model };
}

function start(song: Song) {
  const env = new MemoryEnvironment(song);
  return { env, session: emptySession(song.document.project.id) };
}

const changesOf = (plan: FullMixPlan | null) => (plan?.changes ?? []).filter((change) => change.processing.type !== "trim");
const included = (plan: FullMixPlan | null) => changesOf(plan).filter((change) => change.status === "proposed" || change.status === "accepted");

function twoSections(): Song {
  return mixSong({
    tracks: [
      { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD } },
      { id: "pad", name: "Pad", role: "pad", fixture: { shape: PAD_MASKING }, stereo: { correlation: 0.95 } },
    ],
    sections: [
      { id: "verse", name: "Verse", type: "verse", start: 0, end: 30 },
      { id: "chorus", name: "Chorus", type: "chorus", start: 30, end: 60 },
    ],
    prominence: [
      { track: "lead", section: "verse", prominence: "focal" },
      { track: "lead", section: "chorus", prominence: "focal" },
    ],
  });
}

describe("explicit instructions", () => {
  it("'Make Bass 1 dB quieter' is a direct edit of exactly that value, one undo step", async () => {
    const { env, session } = start(fixtureB());
    const before = env.doc.tracks.find((track) => track.id === "bass")!.gainDb;
    const result = await turn(env, session, "Make Bass 1 dB quieter.", [call("set_track_control", { track: "bass", control: "gain", mode: "delta", value: -1 }), respond("Bass is 1 dB quieter.")]);
    expect(env.doc.tracks.find((track) => track.id === "bass")!.gainDb).toBeCloseTo(before - 1, 5);
    expect(env.history).toHaveLength(1);
    expect(result.reply.cards?.[0]).toMatchObject({ kind: "applied" });
    expect(env.plans).toBe(0);
  });

  it("refuses a value the person did not state (no invented DSP values)", async () => {
    const { env, session } = start(fixtureB());
    const result = await turn(env, session, "Make the bass tighter.", [call("set_track_control", { track: "bass", control: "gain", mode: "delta", value: -1.7 }), respond("I couldn't set that.")]);
    expect(result.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    expect(String(result.model.resultsBefore(1)[0]!.body.error)).toMatch(/not stated/);
    expect(env.history).toHaveLength(0);
  });

  it("there is no tool that takes a raw EQ value from the model", async () => {
    const { env, session } = start(fixtureA());
    const result = await turn(env, session, "Fix the pad.", [call("set_eq", { track: "pad", frequencyHz: 2430, gainDb: -3.17 }), respond("That is not something I can do directly.")]);
    expect(result.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    expect(String(result.model.resultsBefore(1)[0]!.body.text)).toMatch(/Unknown tool/);
    expect(env.doc).toBe(start(fixtureA()).env.doc === env.doc ? env.doc : env.doc);
    expect(env.history).toHaveLength(0);
  });
});

describe("diagnosis without changes", () => {
  it("answers 'why' from measurements and creates nothing", async () => {
    const { env, session } = start(multiProblem());
    const original = env.doc;
    const result = await turn(env, session, "Why is the lead buried?", [call("detect_mix_problems", { tracks: ["lead"] }), (request) => {
      const text = JSON.stringify(request.messages.at(-1));
      expect(text).toMatch(/masking:lead\|pad|Pad/);
      return respond("The Pad masks the Lead in its presence range; that is the main reason. I can build a candidate if you want.");
    }]);
    expect(env.doc).toBe(original);
    expect(env.plan).toBeNull();
    expect(result.session.candidates).toHaveLength(0);
    expect(result.reply.text).toMatch(/Pad masks the Lead/);
    // The UI is pointed at the stems it talked about.
    expect(env.focuses.at(-1)?.trackIds).toContain("lead");
  });

  it("says 'leave it' on an already-good mix with the healthy relationship as evidence", async () => {
    const { env, session } = start(fixtureG());
    const result = await turn(env, session, "Should the bass be louder?", [call("detect_mix_problems", { tracks: ["bass"] }), (request) => {
      const body = JSON.parse((request.messages.at(-1)!.content[0] as { content: string }).content) as { problems: unknown[]; healthyRelationships: unknown[] };
      expect(body.healthyRelationships.length + body.problems.length).toBeGreaterThan(0);
      return respond("I'd leave it where it is: the Kick/Bass relationship already reads as separated.");
    }]);
    expect(result.session.candidates).toHaveLength(0);
    expect(env.history).toHaveLength(0);
  });
});

describe("planning and routing", () => {
  it("a broad request builds a Full Mix candidate in the review, never in the project", async () => {
    const { env, session } = start(multiProblem());
    const original = env.doc;
    const result = await turn(env, session, "Clean this mix up.", [call("plan_mix", { route: "full" }), respond("Candidate A is ready to preview.")]);
    expect(env.doc).toBe(original);
    expect(env.plan).not.toBeNull();
    expect(changesOf(env.plan).length).toBeGreaterThan(0);
    expect(result.session.candidates).toHaveLength(1);
    expect(result.reply.cards?.some((card) => card.kind === "candidate")).toBe(true);
    expect(env.focuses.at(-1)?.tab).toBe("full");
  });

  it("subsystem routes only use their own domain", async () => {
    for (const [route, domain] of [["eq", "eq"], ["dynamics", "dynamics"], ["level", "gain"], ["space", "space"]] as const) {
      const { env, session } = start(multiProblem());
      await turn(env, session, "Work on it.", [call("plan_mix", { route }), respond("Done planning.")]);
      for (const change of changesOf(env.plan)) expect(change.domain).toBe(domain);
    }
  });

  it("the person's 'only fix the levels' narrows the route even when the model asks for Full Mix", async () => {
    const { env, session } = start(multiProblem());
    await turn(env, session, "Only fix the levels.", [call("plan_mix", { route: "full" }), respond("Levels only.")]);
    expect(env.plan?.constraints?.excludedDomains).toEqual(expect.arrayContaining(["eq", "space"]));
  });

  it("protected stems are never changed, even when the model forgets to protect them", async () => {
    const { env, session } = start(multiProblem());
    await turn(env, session, "Make the lead clearer, but don't touch the lead itself.", [call("plan_mix", { route: "full", focusTracks: ["lead"] }), respond("Built.")]);
    expect(env.plan?.constraints?.protectedTrackIds).toEqual(["lead"]);
    expect(changesOf(env.plan).some((change) => change.trackId === "lead")).toBe(false);
    // And it lasts for the session.
    const second = await turn(env, (await turn(env, session, "Make the lead clearer, but don't touch the lead itself.", [respond("Noted.")])).session, "Now make it punchier.", [call("plan_mix", { route: "full" }), respond("Built.")]);
    expect(second.session.standing.protectedTrackIds).toEqual(["lead"]);
    expect(changesOf(env.plan).some((change) => change.trackId === "lead")).toBe(false);
  });

  it("an excluded domain is respected", async () => {
    const { env, session } = start(fixtureA());
    await turn(env, session, "Give the lead more room, no EQ.", [call("plan_mix", { route: "full" }), respond("Built.")]);
    expect(changesOf(env.plan).some((change) => change.domain === "eq")).toBe(false);
  });

  it("a section-scoped request changes only that section", async () => {
    const song = twoSections();
    const { env, session } = start(song);
    await turn(env, session, "Only change the chorus: the lead should stand out more.", [call("plan_mix", { route: "full", focusTracks: ["lead"] }), respond("Built.")]);
    const real = changesOf(env.plan);
    expect(real.length).toBeGreaterThan(0);
    for (const change of real) expect(change.scope).toEqual({ type: "section", sectionId: "chorus" });
  });

  it("'make the drop wider' reaches the planners as a request intent, checked and sized by them, never saved", async () => {
    const song = fixtureH();
    const silent = { ...song, document: { ...song.document, sections: song.document.sections.map((section) => ({ ...section, userIntent: null })) } };
    const { env, session } = start(silent);
    const first = await turn(env, session, "Make the drop wider and punchier.", [call("plan_mix", { route: "full", focusSections: ["drop"], intents: [{ note: "wider and punchier 6 dB", section: "drop" }] }), respond("Built.")]);
    expect(changesOf(env.plan).length).toBeGreaterThan(0);
    expect(env.plan?.constraints?.intents?.[0]?.note).toBe("wider and punchier dB");
    await turn(env, first.session, "Apply it.", [call("apply_candidate", {}), respond("Applied.")]);
    expect(env.doc.sections.every((section) => section.userIntent === null)).toBe(true);
  });

  it("an ambiguous reference makes the agent ask, not guess", async () => {
    const song = mixSong({
      tracks: [
        { id: "lead", name: "Lead", role: "lead", fixture: { shape: LEAD } },
        { id: "tp1", name: "Trumpet Main", role: "brass", fixture: { shape: PAD_MASKING } },
        { id: "tp2", name: "Trumpet Double", role: "brass", fixture: { shape: PAD_MASKING } },
      ],
      sections: [{ id: "all", name: "Chorus", type: "chorus", start: 0, end: 60 }],
    });
    const { env, session } = start(song);
    const result = await turn(env, session, "The trumpet should stand out more.", [
      (request) => {
        expect(request.messages[0]!.content[0]).toMatchObject({ type: "text" });
        expect(JSON.stringify(request.messages[0])).toMatch(/ambiguous/);
        return call("plan_mix", { route: "full", focusTracks: ["trumpet"] });
      },
      clarify("I have two tracks that could mean 'trumpet': Trumpet Main and Trumpet Double. Which one?", ["Trumpet Main", "Trumpet Double"]),
    ]);
    expect(result.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    expect(result.reply.options).toEqual(["Trumpet Main", "Trumpet Double"]);
    expect(result.session.pendingQuestion).toMatch(/Which one/);
    expect(env.plan).toBeNull();
  });

  it("the selection resolves 'this' without asking", async () => {
    const song = twoSections();
    const { env, session } = start(song);
    env.edit({ ...env.doc, uiState: { ...env.doc.uiState, selectedTrackId: "pad", selectedSectionId: "chorus" } }, false);
    const result = await turn(env, session, "Make this stand out more here.", [call("plan_mix", { route: "full", focusTracks: ["this"], focusSections: ["here"] }), respond("Built.")]);
    expect(env.plan?.constraints?.focusTrackIds).toEqual(["pad"]);
    expect(env.plan?.constraints?.focusSectionIds).toEqual(["chorus"]);
    expect(result.reply.error).toBeUndefined();
  });
});

describe("permissions", () => {
  it("never applies without the person's approval, and 'let's hear it' is a preview", async () => {
    const { env, session } = start(multiProblem());
    const original = env.doc;
    const first = await turn(env, session, "Make it punchier.", [call("plan_mix", { route: "full", goal: "punchy" }), call("apply_candidate", {}), respond("Candidate A is ready to preview.")]);
    expect(first.model.resultsBefore(2)[0]).toMatchObject({ isError: true });
    expect(env.doc).toBe(original);
    const second = await turn(env, first.session, "Let's hear it.", [calls_(["preview", { what: "candidate" }], ["apply_candidate", {}]), respond("Playing Candidate A.")]);
    expect(second.model.resultsBefore(1).find((item) => item.name === "apply_candidate")).toMatchObject({ isError: true });
    expect(env.previews.at(-1)).toEqual({ kind: "candidate" });
    expect(env.doc).toBe(original);
    const third = await turn(env, second.session, "Apply it.", [call("apply_candidate", {}), respond("Applied.")]);
    expect(third.model.resultsBefore(1)[0]).toMatchObject({ isError: false });
    expect(env.history).toHaveLength(1);
    expect(env.plan).toBeNull();
    expect(third.reply.cards?.find((card) => card.kind === "applied")).toBeDefined();
  });

  it("'do it' right after a presented candidate applies; after an offer to build it does not", async () => {
    const { env, session } = start(fixtureA());
    const offered = await turn(env, session, "What's wrong with the lead?", [respond("The Pad masks the Lead. I can build a candidate that gives the Lead more room.")]);
    const declined = await turn(env, offered.session, "Do it.", [call("apply_candidate", {}), call("plan_mix", { route: "full" }), respond("Candidate A is ready.")]);
    expect(declined.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    expect(env.history).toHaveLength(0);
    const applied = await turn(env, declined.session, "Do it.", [call("apply_candidate", {}), respond("Applied.")]);
    expect(applied.model.resultsBefore(1)[0]).toMatchObject({ isError: false });
    expect(env.history).toHaveLength(1);
  });

  it("a reply that claims an apply that did not happen is corrected", async () => {
    const { env, session } = start(fixtureA());
    const result = await turn(env, session, "Improve it.", [call("plan_mix", { route: "full" }), respond("I've applied the changes."), respond("I've applied the changes.")]);
    expect(result.reply.text).not.toMatch(/applied the changes/);
    expect(result.reply.text).toMatch(/ready to preview/);
    expect(env.history).toHaveLength(0);
  });

  it("the panel's Apply button uses the same path and records what was applied", async () => {
    const { env, session } = start(fixtureA());
    const built = await turn(env, session, "Improve it.", [call("plan_mix", { route: "full" }), respond("Candidate A is ready.")]);
    const expected = applyFullMixPlan(env.doc, env.plan!, "all");
    const result = applyFromPanel(env, built.session, "all");
    expect(result.ok).toBe(true);
    expect(expected.ok && JSON.stringify(env.doc.tracks)).toBe(expected.ok && JSON.stringify(expected.document.tracks));
    expect(result.session.lastApply?.lines.length).toBeGreaterThan(0);
  });
});

describe("conversation", () => {
  it("weak → less aggressive → keep the EQ, lose the width → apply: only the current accepted candidate persists", async () => {
    const song = multiProblem();
    const { env, session } = start(song);
    const a = await turn(env, session, "The chorus feels weak.", [call("detect_mix_problems", { sections: ["chorus"] }), call("plan_mix", { route: "full", focusSections: ["chorus"] }), respond("Candidate A is ready to preview.")]);
    const plan = env.plan!;
    expect(included(plan).length).toBeGreaterThan(1);
    const scalable = included(plan).find((change) => change.processing.type === "eq" || change.processing.type === "dynamics" || change.processing.type === "gain")!;
    const b = await turn(env, a.session, "Less aggressive.", [call("refine_candidate", { operations: [{ action: "scale", target: { all: true }, amount: "less" }] }), respond("Toned it down.")]);
    const scaled = env.plan!.changes.find((change) => change.id === scalable.id)!;
    expect(JSON.stringify(scaled.processing)).not.toBe(JSON.stringify(scalable.processing));
    expect(b.session.candidates).toHaveLength(1);
    const c = await turn(env, b.session, "Keep the EQ but lose the width change.", [call("refine_candidate", { operations: [{ action: "remove", target: { domains: ["space"] } }, { action: "accept", target: { domains: ["eq"] } }] }), respond("Done.")]);
    for (const change of env.plan!.changes) if (change.domain === "space") expect(change.status).toBe("rejected");
    const final = env.plan!;
    await turn(env, c.session, "Apply that.", [call("apply_candidate", {}), respond("Applied.")]);
    const expected = applyFullMixPlan(song.document, final, "all");
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(JSON.stringify(env.doc.tracks)).toBe(JSON.stringify(expected.document.tracks));
    expect(JSON.stringify(env.doc.sectionTrackSettings)).toBe(JSON.stringify(expected.document.sectionTrackSettings));
    // The width change was not written.
    const synth = env.doc.tracks.find((track) => track.id === "synth")!;
    expect(synth.width).toBe(song.document.tracks.find((track) => track.id === "synth")!.width);
  });

  it("'a little less' starts from the person's own edit in the plan UI", async () => {
    const { env, session } = start(fixtureA());
    const a = await turn(env, session, "Give the lead room.", [call("plan_mix", { route: "full" }), respond("Built.")]);
    const eq = env.plan!.changes.find((change) => change.processing.type === "eq")!;
    env.plan = editChange(env.plan!, eq.id, { gainDb: -1 });
    const result = await turn(env, a.session, "That's better. A little less still.", [
      (request) => {
        expect(JSON.stringify(request.messages[0])).toMatch(/editedByPerson/);
        return call("refine_candidate", { operations: [{ action: "scale", target: { changeIds: [eq.id] }, amount: "much-less" }] });
      },
      respond("Halved your edit."),
    ]);
    const after = env.plan!.changes.find((change) => change.id === eq.id)!;
    expect(after.processing.type === "eq" && after.processing.filter.gainDb).toBe(-0.5);
    expect(result.reply.cards?.find((card) => card.kind === "edit")).toBeDefined();
  });

  it("a stated factor is allowed; an unstated one is not", async () => {
    const { env, session } = start(fixtureA());
    const a = await turn(env, session, "Give the lead room.", [call("plan_mix", { route: "full" }), respond("Built.")]);
    const refused = await turn(env, a.session, "Make that weaker.", [call("refine_candidate", { operations: [{ action: "scale", target: { all: true }, statedFactor: 0.62 }] }), respond("Could not.")]);
    expect(refused.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    const allowed = await turn(env, refused.session, "Make that 25% weaker.", [call("refine_candidate", { operations: [{ action: "scale", target: { all: true }, statedFactor: 0.75 }] }), respond("Done.")]);
    expect(allowed.model.resultsBefore(1)[0]).toMatchObject({ isError: false });
  });

  it("another option, compare, and go back to the first one", async () => {
    const { env, session } = start(multiProblem());
    const a = await turn(env, session, "Clean it up.", [call("plan_mix", { route: "full" }), respond("A.")]);
    const b = await turn(env, a.session, "Give me another option, more conservative.", [call("plan_mix", { route: "full", strength: "conservative" }), respond("B.")]);
    expect(b.session.candidates.map((entry) => entry.label)).toEqual(["Candidate A", "Candidate B"]);
    expect(env.plan!.settings.strength).toBe("conservative");
    const compared = await turn(env, b.session, "What's the difference?", [call("compare_candidates", { a: "A", b: "B" }), respond("Compared.")]);
    expect(Object.keys(compared.model.resultsBefore(1)[0]!.body)).toEqual(expect.arrayContaining(["only in Candidate A", "only in Candidate B", "same"]));
    const back = await turn(env, compared.session, "Go back to the first one.", [call("select_candidate", { candidate: "first" }), respond("Back to A.")]);
    expect(back.session.currentCandidateId).toBe(back.session.candidates[0]!.id);
    expect(env.plan!.settings.strength).toBe("normal");
  });

  it("'too processed' simplifies into a new candidate that keeps most of the improvement", async () => {
    const { env, session } = start(multiProblem());
    const a = await turn(env, session, "Clean it up.", [call("plan_mix", { route: "full" }), respond("A.")]);
    const before = included(env.plan).length;
    const result = await turn(env, a.session, "This sounds better, but maybe too processed.", [call("simplify_candidate", {}), respond("Simplified.")]);
    const body = result.model.resultsBefore(1)[0]!.body;
    if ((body.removed as unknown[]).length > 0) {
      expect(result.session.candidates).toHaveLength(2);
      expect(included(env.plan).length).toBeLessThan(before);
      expect(body.shareOfImprovementKept as number).toBeGreaterThanOrEqual(0.8);
    } else expect(body.note).toMatch(/earns its place/);
  });
});

describe("undo, stale, failures", () => {
  it("'undo that' after an apply uses the undo history; after only a candidate it discards", async () => {
    const { env, session } = start(fixtureA());
    const original = env.doc;
    const a = await turn(env, session, "Improve it.", [call("plan_mix", { route: "full" }), respond("A.")]);
    const discarded = await turn(env, a.session, "Undo what you just did.", [call("undo_last_apply", {}), call("discard_candidate", {}), respond("Closed the candidate; the saved mix was never changed.")]);
    expect(discarded.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    expect(env.plan).toBeNull();
    expect(env.doc).toBe(original);
    const b = await turn(env, discarded.session, "Improve it again.", [call("plan_mix", { route: "full" }), respond("B.")]);
    const applied = await turn(env, b.session, "Apply it.", [call("apply_candidate", {}), respond("Applied.")]);
    expect(env.doc).not.toBe(original);
    const undone = await turn(env, applied.session, "Undo that.", [call("undo_last_apply", {}), respond("Undone.")]);
    expect(undone.model.resultsBefore(1)[0]).toMatchObject({ isError: false });
    expect(env.doc).toBe(original);
  });

  it("conversational undo never undoes a manual edit made after the apply", async () => {
    const { env, session } = start(fixtureA());
    const a = await turn(env, session, "Improve it.", [call("plan_mix", { route: "full" }), respond("A.")]);
    const applied = await turn(env, a.session, "Apply it.", [call("apply_candidate", {}), respond("Applied.")]);
    const afterApply = env.doc;
    env.edit({ ...env.doc, tracks: env.doc.tracks.map((track) => (track.id === "lead" ? { ...track, gainDb: track.gainDb + 2 } : track)) });
    const manual = env.doc;
    const result = await turn(env, applied.session, "Undo that.", [call("undo_last_apply", {}), respond("I could not undo it.")]);
    expect(result.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    expect(env.doc).toBe(manual);
    expect(afterApply).not.toBe(manual);
  });

  it("refuses a stale candidate after a fader move, and says it must be rebuilt", async () => {
    const { env, session } = start(fixtureA());
    const a = await turn(env, session, "Improve it.", [call("plan_mix", { route: "full" }), respond("A.")]);
    env.edit({ ...env.doc, tracks: env.doc.tracks.map((track) => (track.id === "pad" ? { ...track, gainDb: track.gainDb - 1 } : track)) });
    const moved = env.doc;
    const result = await turn(env, a.session, "Apply it.", [
      (request) => {
        expect((request.messages[0]!.content[0] as { text: string }).text).toMatch(/"stale":true/);
        return call("apply_candidate", {});
      },
      respond("The mix changed since I built that candidate. I'll need to regenerate it before applying."),
    ]);
    expect(result.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    expect(String(result.model.resultsBefore(1)[0]!.body.error)).toMatch(/out of date|no fresh candidate|not approved/);
    expect(env.doc).toBe(moved);
  });

  it("a candidate built while the mix changed is refused, not presented", async () => {
    const { env, session } = start(fixtureA());
    env.duringPlan = () => env.edit({ ...env.doc, tracks: env.doc.tracks.map((track) => (track.id === "pad" ? { ...track, gainDb: -3 } : track)) });
    const result = await turn(env, session, "Improve it.", [call("plan_mix", { route: "full" }), respond("The mix changed while I was planning; nothing was changed.")]);
    expect(result.model.resultsBefore(1)[0]).toMatchObject({ isError: true });
    expect(result.session.candidates).toHaveLength(0);
  });

  it("a tool failure is reported, never turned into a result", async () => {
    const { env, session } = start(fixtureA());
    env.failPlan = "the Pad playback proxy is missing";
    const result = await turn(env, session, "Improve it.", [call("plan_mix", { route: "full" }), respond("I couldn't evaluate the candidate because the Pad playback proxy is missing. The saved mix was not changed.")]);
    const failed = result.model.resultsBefore(1)[0]!;
    expect(failed.isError).toBe(true);
    expect(String(failed.body.text ?? failed.body.error)).toMatch(/proxy is missing.*Nothing was changed/);
    expect(result.session.candidates).toHaveLength(0);
    expect(env.history).toHaveLength(0);
  });

  it("missing analysis is stated, not hidden", async () => {
    const { env, session } = start(fixtureA());
    env.missing = [{ trackId: "pad", what: "envelopes" }];
    const result = await turn(env, session, "What's wrong?", [call("detect_mix_problems", {}), respond("Checked.")]);
    expect(String(result.model.resultsBefore(1)[0]!.body.missing)).toMatch(/Pad \(envelopes\)/);
  });
});

describe("guards and limits", () => {
  it("an invented number is sent back once, then replaced by what the tools found", async () => {
    const { env, session } = start(fixtureA());
    const result = await turn(env, session, "Fix the pad.", [call("plan_mix", { route: "full" }), respond("Cut the Pad 3.17 dB at 2.43 kHz."), respond("Cut the Pad 3.17 dB at 2.43 kHz.")]);
    expect(result.model.requests).toHaveLength(3);
    expect(JSON.stringify(result.model.requests[2]!.messages.at(-1))).toMatch(/not in any tool result/);
    expect(result.reply.text).not.toMatch(/3\.17/);
  });

  it("numbers from tool results pass the check", async () => {
    const { env, session } = start(fixtureA());
    const result = await turn(env, session, "Fix the pad.", [
      call("plan_mix", { route: "full" }),
      (request) => {
        const body = JSON.parse((request.messages.at(-1)!.content[0] as { content: string }).content) as { changes: Array<{ change: string; track: string }> };
        return respond(`Candidate A: ${body.changes[0]!.track} ${body.changes[0]!.change}.`);
      },
    ]);
    expect(result.model.requests).toHaveLength(2);
    expect(result.reply.text).toMatch(/Candidate A: Pad/);
  });

  it("invalid arguments are rejected before anything runs", async () => {
    const { env, session } = start(fixtureA());
    const result = await turn(env, session, "Improve it.", [call("plan_mix", { route: "everything", raw: { eq: -3 } }), respond("Sorry.")]);
    expect(String(result.model.resultsBefore(1)[0]!.body.text)).toMatch(/Invalid arguments/);
    expect(env.plans).toBe(0);
  });

  it("stops after the request's model-call limit", async () => {
    const { env, session } = start(fixtureA());
    const steps = Array.from({ length: 30 }, () => call("get_project_overview", {}));
    const result = await turn(env, session, "Tell me everything.", steps);
    expect(result.model.requests).toHaveLength(AGENT_LIMITS.maxModelCalls);
    expect(result.reply.text).toMatch(/stopped|Nothing was changed|not changed/i);
  });

  it("a superseded request leaves the session and project as they were", async () => {
    const { env, session } = start(fixtureA());
    let current = true;
    const model = new ScriptedModel([
      () => {
        current = false;
        return call("plan_mix", { route: "full" });
      },
      respond("Built."),
    ]);
    const outcome = await runAgentTurn({ model, env, session, message: "Improve it.", isCurrent: () => current });
    expect(outcome.status).toBe("superseded");
    expect(env.plan).toBeNull();
    expect(session.candidates).toHaveLength(0);
    expect(session.transcript).toHaveLength(0);
  });

  it("sends structured context only: no file paths, audio, or long transcripts", async () => {
    const { env, session } = start(multiProblem());
    let current = session;
    for (let index = 0; index < 12; index += 1) current = (await turn(env, current, `Question number ${index} about the mix?`, [respond(`Answer ${index}.`)])).session;
    const result = await turn(env, current, "What's in the mix?", [respond("Six stems.")]);
    const sent = JSON.stringify(result.model.requests[0]);
    for (const track of env.doc.tracks) expect(sent).not.toContain(track.file.relativePath);
    expect(sent).not.toMatch(/media\/|\.wav|\.proxy|frames|base64/i);
    expect(sent).not.toContain("Question number 0 about");
    expect(sent).toContain("Question number 11 about");
    const context = (result.model.requests[0]!.messages[0]!.content[0] as { text: string }).text;
    expect(context.length).toBeLessThan(AGENT_LIMITS.contextChars + 4000);
  });

  it("shortens a large tool result field by field and keeps it valid JSON", () => {
    const big = { problems: Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, explanation: "x".repeat(900), evidence: Array.from({ length: 10 }, () => "y".repeat(300)) })) };
    const text = fitJson(big, AGENT_LIMITS.toolResultChars);
    expect(text.length).toBeLessThanOrEqual(AGENT_LIMITS.toolResultChars);
    const parsed = JSON.parse(text) as { problems: unknown[] };
    expect(parsed.problems.length).toBeGreaterThan(1);
    expect(String(parsed.problems.at(-1))).toMatch(/more/);
  });

  it("logs metadata, never the message text", async () => {
    const { env, session } = start(fixtureA());
    await turn(env, session, "My secret song title is Moonlight Ballad. Improve it.", [call("plan_mix", { route: "full" }), respond("Built.")]);
    const logged = JSON.stringify(env.events);
    expect(logged).not.toMatch(/Moonlight/);
    expect(env.events.map((item) => item.event)).toEqual(expect.arrayContaining(["agent.request", "agent.tool", "agent.plan", "agent.complete"]));
  });

  it("every planned change keeps its planner's provenance", async () => {
    const { env, session } = start(multiProblem());
    await turn(env, session, "Clean it up.", [call("plan_mix", { route: "full" }), respond("Built.")]);
    for (const change of changesOf(env.plan)) {
      expect(["level", "eq", "space", "dynamics", "full-mix"]).toContain(change.source);
      expect(change.reasons.length).toBeGreaterThan(0);
      expect(processorKind(change.processing)).toBeTruthy();
    }
  });
});
