import { describe, expect, it } from "vitest";
import { applyEdit, emptyHistory, redoEdit, undoEdit } from "./history";

describe("edit history", () => {
  it("undoes and redoes a recorded edit", () => {
    let history = applyEdit(emptyHistory<string>(), "one", "record", null, 0);
    const undone = undoEdit(history, "two");
    expect(undone?.document).toBe("one");
    history = undone?.history ?? history;
    const redone = redoEdit(history, "one");
    expect(redone?.document).toBe("two");
    expect(undoEdit(emptyHistory<string>(), "one")).toBeNull();
  });

  it("collapses a drag into the state from before it started", () => {
    let history = applyEdit(emptyHistory<number>(), 0, "coalesce", "gain:kick", 1000);
    history = applyEdit(history, 1, "coalesce", "gain:kick", 1400);
    history = applyEdit(history, 2, "coalesce", "gain:kick", 1800);
    expect(history.past).toEqual([0]);
    expect(undoEdit(history, 3)?.document).toBe(0);
  });

  it("starts a new step after the gesture gap or for another control", () => {
    let history = applyEdit(emptyHistory<number>(), 0, "coalesce", "gain:kick", 1000);
    history = applyEdit(history, 1, "coalesce", "gain:kick", 2500);
    history = applyEdit(history, 2, "coalesce", "pan:kick", 2600);
    expect(history.past).toEqual([0, 1, 2]);
  });

  it("ignores transport chrome and caps the stack", () => {
    let history = applyEdit(emptyHistory<number>(), 0, "skip", null, 0);
    expect(history.past).toEqual([]);
    history = emptyHistory<number>();
    for (let step = 0; step < 60; step += 1) {
      history = applyEdit(history, step, "record", null, step);
    }
    expect(history.past).toHaveLength(50);
    expect(history.past[0]).toBe(10);
  });
});