/**
 * Shares one in-flight promise per key, so a second caller asking for the same expensive work (Auto Mix asking for
 * EQ bands while the EQ tab is already measuring them) joins it instead of starting a duplicate job. The entry is
 * dropped when the work settles; results are not kept here.
 */
const running = new Map<string, Promise<unknown>>();

export function shareInFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = running.get(key);
  if (existing) return existing as Promise<T>;
  const promise = work().finally(() => {
    if (running.get(key) === promise) running.delete(key);
  });
  running.set(key, promise);
  return promise;
}

/** For tests: how many keys are in flight. */
export function inFlightCount(): number {
  return running.size;
}
