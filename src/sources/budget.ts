/**
 * Client-side request budgets. Requests over budget are QUEUED (delayed), never dropped.
 * Slots are reserved synchronously, so concurrent callers get distinct, ordered slots.
 */
export type BudgetSpec = { minIntervalMs: number; maxPerMinute: number };

export const BUDGETS: Record<string, BudgetSpec> = {
  Discogs: { minIntervalMs: 2500, maxPerMinute: 20 },
  MusicBrainz: { minIntervalMs: 1000, maxPerMinute: 60 },
};

const slots = new Map<string, number[]>();

/** Test hook. */
export function resetBudgets() {
  slots.clear();
}

/**
 * Reserve the next slot for `source` and return how long the caller must wait (ms).
 * Unknown sources are unbudgeted (0).
 */
export function reserveSlot(source: string, now: number): number {
  const spec = BUDGETS[source];
  if (!spec) return 0;
  const list = slots.get(source) ?? [];
  let at = now;
  const last = list[list.length - 1];
  if (last !== undefined) at = Math.max(at, last + spec.minIntervalMs);
  if (list.length >= spec.maxPerMinute) {
    const nth = list[list.length - spec.maxPerMinute];
    at = Math.max(at, nth + 60_000);
  }
  list.push(at);
  if (list.length > spec.maxPerMinute)
    list.splice(0, list.length - spec.maxPerMinute);
  slots.set(source, list);
  return Math.max(0, at - now);
}

export async function takeSlot(
  source: string,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const wait = reserveSlot(source, now());
  if (wait > 0) await sleep(wait);
}
