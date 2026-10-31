/**
 * Per-source health ring buffer + circuit breaker (`wtg:health:v1`).
 * Stores ONLY outcome codes and timestamps - never artist/title/album/URL.
 */
export type HealthCode =
  "ok" | "notfound" | "http4xx" | "http429" | "http5xx" | "network" | "schema";

export const HEALTH_KEY = "wtg:health:v1";
export const HEALTH_WINDOW = 50;
export const BACKOFF_MIN = [5, 15, 60];
const MIN = 60_000;

export type Breaker = { level: number; until: number };
type SourceState = { r: [HealthCode, number][]; b?: Breaker };
type HealthState = {
  v: 1;
  s: Record<string, SourceState>;
  canaryAt?: number;
};

export type HealthStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type SourceStatus = "healthy" | "transport" | "throttled" | "schema";

function load(storage?: HealthStorage): HealthState {
  try {
    const raw = storage?.getItem(HEALTH_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.v === 1 && p.s && typeof p.s === "object") return p;
    }
  } catch {
    /* corrupt -> start over */
  }
  return { v: 1, s: {} };
}

function save(storage: HealthStorage | undefined, st: HealthState) {
  try {
    storage?.setItem(HEALTH_KEY, JSON.stringify(st));
  } catch {
    /* quota: health is best-effort */
  }
}

const isFail = (c: HealthCode) =>
  c === "network" || c === "http5xx" || c === "http429" || c === "schema";
const isGood = (c: HealthCode) => !isFail(c);

/** Threshold evaluation over the ring buffer (arge-backend.md 2.2, verbatim). */
export function evaluate(recent: [HealthCode, number][]): SourceStatus {
  const last20 = recent.slice(-20).map((x) => x[0]);
  const transport = last20.filter((c) => c === "network" || c === "http5xx");
  if (transport.length >= 10) return "transport";
  if (last20.filter((c) => c === "http429").length >= 4) return "throttled";
  const http200 = recent
    .map((x) => x[0])
    .filter((c) => c === "ok" || c === "notfound" || c === "schema")
    .slice(-10);
  if (http200.length >= 10 && http200.filter((c) => c === "schema").length >= 8)
    return "schema";
  return "healthy";
}

/** Record one attempt and update the breaker. */
export function recordHealth(
  storage: HealthStorage | undefined,
  source: string,
  code: HealthCode,
  now: number,
) {
  const st = load(storage);
  const s = (st.s[source] ??= { r: [] });
  s.r.push([code, now]);
  if (s.r.length > HEALTH_WINDOW) s.r.splice(0, s.r.length - HEALTH_WINDOW);
  const b = s.b;
  if (!b) {
    if (evaluate(s.r) !== "healthy") s.b = openBreaker(0, now);
  } else if (now >= b.until) {
    // half-open trial
    if (isFail(code)) s.b = openBreaker(b.level, now);
    else if (s.r.slice(-5).filter((x) => isGood(x[0])).length >= 4) delete s.b; // recovered: 4 of last 5 attempts succeeded
  }
  save(storage, st);
}

function openBreaker(prevLevel: number, now: number): Breaker {
  const level = Math.min(prevLevel + 1, BACKOFF_MIN.length);
  return { level, until: now + BACKOFF_MIN[level - 1] * MIN };
}

/** false -> source is skipped (breaker window active). Half-open allows a trial. */
export function sourceAllowed(
  storage: HealthStorage | undefined,
  source: string,
  now: number,
): boolean {
  const b = load(storage).s[source]?.b;
  return !b || now >= b.until;
}

export function sourceStatus(
  storage: HealthStorage | undefined,
  source: string,
): SourceStatus {
  return evaluate(load(storage).s[source]?.r ?? []);
}

export function getBreaker(
  storage: HealthStorage | undefined,
  source: string,
): Breaker | undefined {
  return load(storage).s[source]?.b;
}

export function canaryDue(storage: HealthStorage | undefined, now: number) {
  const at = load(storage).canaryAt;
  return !at || now - at > 24 * 60 * MIN || at > now;
}

export function markCanary(storage: HealthStorage | undefined, now: number) {
  const st = load(storage);
  st.canaryAt = now;
  save(storage, st);
}
