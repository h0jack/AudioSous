export type HistoryMode = "record" | "coalesce" | "skip";

export interface EditHistory<T> {
  past: T[];
  future: T[];
  coalesceKey: string | null;
  coalesceUntil: number;
}

const HISTORY_LIMIT = 50;
const COALESCE_MS = 1000;

export function emptyHistory<T>(): EditHistory<T> {
  return { past: [], future: [], coalesceKey: null, coalesceUntil: 0 };
}

export function applyEdit<T>(
  history: EditHistory<T>,
  current: T,
  mode: HistoryMode,
  key: string | null,
  now: number,
): EditHistory<T> {
  if (mode === "skip") return history;
  if (mode === "coalesce" && key !== null && key === history.coalesceKey && now <= history.coalesceUntil) {
    return { ...history, coalesceUntil: now + COALESCE_MS };
  }
  const past = history.past.length >= HISTORY_LIMIT ? history.past.slice(history.past.length - HISTORY_LIMIT + 1) : history.past.slice();
  past.push(current);
  return {
    past,
    future: [],
    coalesceKey: mode === "coalesce" ? key : null,
    coalesceUntil: mode === "coalesce" ? now + COALESCE_MS : 0,
  };
}

export function undoEdit<T>(history: EditHistory<T>, current: T): { history: EditHistory<T>; document: T } | null {
  const previous = history.past.at(-1);
  if (previous === undefined) return null;
  return {
    document: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, current],
      coalesceKey: null,
      coalesceUntil: 0,
    },
  };
}

export function redoEdit<T>(history: EditHistory<T>, current: T): { history: EditHistory<T>; document: T } | null {
  const next = history.future.at(-1);
  if (next === undefined) return null;
  return {
    document: next,
    history: {
      past: [...history.past, current],
      future: history.future.slice(0, -1),
      coalesceKey: null,
      coalesceUntil: 0,
    },
  };
}
