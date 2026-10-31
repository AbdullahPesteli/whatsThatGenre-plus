/**
 * Small helpers shared across the extension.
 *
 * Reconstructed from the previously published dist/whatsThatGenre-plus.js, which
 * was built from a source tree that included this file but never committed it.
 * Behaviour is preserved; see issue #2.
 */

/** "synth-pop" / "post grunge" -> "Synth-Pop" / "PostGrunge" */
export function camelize(value: string): string {
  return value.replace(/(^\w{1})|([\s-]+\w{1})/g, (match) =>
    match.toUpperCase(),
  );
}

/** Global string replace. */
export function replaceAll(
  value: string,
  find: string,
  replacement: string,
): string {
  // split/join treats `find` literally ("hip.hop", "c++", "(indietronica)") and
  // also keeps `$&`-style patterns in `replacement` literal.
  if (find === "") return value;
  return value.split(find).join(replacement);
}

/** Trailing-edge debounce. */
export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delay = 300,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = function (this: unknown, ...args: Parameters<T>) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
  /** Drop any pending call (used on teardown). */
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}

/**
 * Either a CSS selector or a resolver function. The resolver form exists because
 * the now-playing markup is built from hashed class names that change between
 * Spotify releases, so a stable structural lookup is more reliable than a
 * selector. See issue #1.
 */
export type ElementTarget = string | (() => Element | null);

function resolveElement(target: ElementTarget): Element | null {
  return typeof target === "string" ? document.querySelector(target) : target();
}

/**
 * Resolve `target` now, or as soon as it appears within `timeout` ms.
 * Resolves `null` if it never appears.
 */
export function waitForElement(
  target: ElementTarget,
  timeout = 5000,
): Promise<Element | null> {
  return new Promise((resolve) => {
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (element: Element | null) => {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      resolve(element);
    };

    const attempt = () => {
      const element = resolveElement(target);
      if (element) finish(element);
    };

    const immediate = resolveElement(target);
    if (immediate) return resolve(immediate);
    if (!timeout) return resolve(null);

    // One timer for the whole wait (previously one was armed per DOM mutation).
    timer = setTimeout(() => finish(null), timeout);
    observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/* ------------------------------------------------------------------ */
/* Genre lookup (pure logic; no DOM, so it is unit-testable under node) */
/* ------------------------------------------------------------------ */

export const DISCOGS_USER_AGENT =
  "WhatsThatGenrePlus/2.0.1 +https://github.com/AbdullahPesteli/whatsThatGenre-plus";
export const REQUEST_TIMEOUT_MS = 8000;
export const MAX_RETRY_AFTER_MS = 10000;
/** iTunes candidates need at least this blended score to be accepted at all. */
export const APPLE_MIN_SCORE = 0.9;
/** Titles must be (near-)identical whole-word matches. Pinned by tests. */
export const TITLE_MIN_SIMILARITY = 0.92;
/** Only results at/above this confidence are persisted to localStorage. */
export const CACHE_MIN_CONFIDENCE = 0.95;

export type GenreResult = {
  genres: string[];
  source: "Discogs" | "Apple Music";
  /** 0..1; low-confidence results are shown but never cached. */
  confidence: number;
};

export type TrackQuery = {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  artistId?: string;
};

export type LookupOutcome =
  | { status: "ok"; result: GenreResult; cached: boolean }
  | { status: "not_found" }
  | { status: "error"; message: string };

export const MSG_LOOKING = "Looking for genre...";
export const MSG_NOT_FOUND = "Genre not found";
export const MSG_NETWORK_ERROR =
  "Couldn't reach Discogs/Apple Music - check your connection";

/** NFKD + strip combining marks, lowercase, keep any-script letters and digits. */
export function normalizeText(value: string): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeTitle(value: string): string {
  return normalizeText(value)
    .replace(
      /\b(remaster(?:ed)?|radio edit|single version|album version|explicit|clean)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Cache key, or "" when artist or title normalise to nothing (then: do not cache). */
export function cacheKeyFor(artist: string, title: string): string {
  const a = normalizeText(artist);
  const t = normalizeTitle(title);
  return a && t ? `hermesGenre:${a}|${t}` : "";
}

const DERIVATIVE_TERMS = [
  "tribute",
  "cover",
  "covers",
  "karaoke",
  "in the style of",
  "experience",
  "as made famous",
  "originally performed",
];

/**
 * True when `candidate` carries a tribute/cover/karaoke marker that the real
 * track (`reference`) does not itself contain.
 */
export function isDerivativeName(candidate: string, reference = ""): boolean {
  const c = ` ${normalizeText(candidate)} `;
  const r = ` ${normalizeText(reference)} `;
  return DERIVATIVE_TERMS.some(
    (term) => c.includes(` ${term} `) && !r.includes(` ${term} `),
  );
}

export function tokenSubset(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bb = new Set(b.split(" ").filter(Boolean));
  const aa = a.split(" ").filter(Boolean);
  if (!aa.length) return false;
  return aa.every((token) => bb.has(token));
}

/** Whole-word similarity: "bohemian rhapsody" vs "bohemian rhapsodyx" = 0.5. */
export function wordSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aa = new Set(a.split(" "));
  const bb = new Set(b.split(" "));
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection++;
  return intersection / Math.max(aa.size, bb.size);
}

export type AppleItem = {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  primaryGenreName?: string;
  trackTimeMillis?: number;
};

export type Evaluation = {
  accept: boolean;
  score: number;
  reason: string;
  durationDiff: number;
};

export function evaluateAppleCandidate(
  track: TrackQuery,
  item: AppleItem,
): Evaluation {
  const reject = (reason: string): Evaluation => ({
    accept: false,
    score: 0,
    reason,
    durationDiff: Number.POSITIVE_INFINITY,
  });
  if (!item.primaryGenreName) return reject("no genre");

  const reference = `${track.artist} ${track.title} ${track.album}`;
  if (
    isDerivativeName(item.artistName || "", reference) ||
    isDerivativeName(item.trackName || "", reference) ||
    isDerivativeName(item.collectionName || "", reference)
  ) {
    return reject("tribute/cover/karaoke");
  }

  const qTitle = normalizeTitle(track.title);
  const qArtist = normalizeText(track.artist);
  const qAlbum = normalizeText(track.album);
  const cTitle = normalizeTitle(item.trackName || "");
  const cArtist = normalizeText(item.artistName || "");

  const titleScore = wordSimilarity(qTitle, cTitle);
  const artistScore = wordSimilarity(qArtist, cArtist);
  // Spotify lists the lead artist ("Justice"); iTunes the full credit
  // ("Justice & Tame Impala"): accept when every query token is in the credit.
  const artistSubset = tokenSubset(qArtist, cArtist);
  const artistCombined = Math.max(artistScore, artistSubset ? 0.9 : 0);
  const artistOk = artistScore >= 0.9 || artistSubset;

  const parts: Array<[number, number]> = [
    [titleScore, 0.46],
    [artistCombined, 0.36],
  ];
  if (qAlbum)
    parts.push([
      wordSimilarity(qAlbum, normalizeText(item.collectionName || "")),
      0.1,
    ]);

  // Missing duration on either side is neutral: the component is left out of the
  // blend instead of counting as an infinite mismatch.
  const hasDuration = Boolean(track.durationMs && item.trackTimeMillis);
  const durationDiff = hasDuration
    ? Math.abs(track.durationMs - Number(item.trackTimeMillis))
    : Number.POSITIVE_INFINITY;
  if (hasDuration)
    parts.push([
      durationDiff <= 2500 ? 1 : durationDiff <= 7000 ? 0.5 : 0,
      0.08,
    ]);

  const weight = parts.reduce((sum, [, w]) => sum + w, 0);
  const score = parts.reduce((sum, [v, w]) => sum + v * w, 0) / weight;

  if (titleScore < TITLE_MIN_SIMILARITY)
    return { accept: false, score, reason: "title", durationDiff };
  if (!artistOk)
    return { accept: false, score, reason: "artist", durationDiff };
  if (hasDuration && durationDiff > 6000)
    return { accept: false, score, reason: "duration", durationDiff };
  if (score < APPLE_MIN_SCORE)
    return { accept: false, score, reason: "score", durationDiff };
  return { accept: true, score, reason: "ok", durationDiff };
}

/* ---- network ---- */

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type LookupDeps = {
  fetch: FetchLike;
  storage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

export type FetchOutcome =
  | { kind: "ok"; json: any }
  | { kind: "http"; status: number }
  | { kind: "network"; error: unknown };

export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number {
  if (!header) return 1000;
  const seconds = Number(header);
  let ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) ms = 1000;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** Fetch JSON with a timeout; 429/5xx get at most ONE retry honouring Retry-After. */
export async function fetchJson(
  url: string,
  deps: LookupDeps,
  headers?: Record<string, string>,
): Promise<FetchOutcome> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    try {
      const res = await deps.fetch(url, { headers, signal: controller.signal });
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await sleep(parseRetryAfter(res.headers?.get("Retry-After")));
        continue;
      }
      if (!res.ok) return { kind: "http", status: res.status };
      return { kind: "ok", json: await res.json() };
    } catch (error) {
      return { kind: "network", error };
    } finally {
      clearTimeout(timer);
    }
  }
  return { kind: "http", status: 0 };
}

type Probe = { answered: number; failed: number };

function note(probe: Probe, outcome: FetchOutcome) {
  // 429/5xx/network = "service unavailable"; any other response = it answered.
  if (
    outcome.kind === "ok" ||
    (outcome.kind === "http" && outcome.status !== 429 && outcome.status < 500)
  )
    probe.answered++;
  else probe.failed++;
}

async function lookupDiscogs(
  track: TrackQuery,
  deps: LookupDeps,
  probe: Probe,
): Promise<GenreResult | undefined> {
  if (!track.artist) return;
  const normArtist = normalizeText(track.artist);
  const a = encodeURIComponent(track.artist);
  const q = (params: string) =>
    `https://api.discogs.com/database/search?${params}&type=release&per_page=25`;
  const urls = [
    track.album
      ? q(`artist=${a}&release_title=${encodeURIComponent(track.album)}`)
      : "",
    track.title
      ? q(`artist=${a}&track=${encodeURIComponent(track.title)}`)
      : "",
    q(`artist=${a}`),
  ].filter(Boolean);

  for (const url of urls) {
    const outcome = await fetchJson(url, deps, {
      "User-Agent": DISCOGS_USER_AGENT,
    });
    note(probe, outcome);
    if (outcome.kind !== "ok") continue;
    const results: any[] = Array.isArray(outcome.json?.results)
      ? outcome.json.results
      : [];

    // Only trust releases whose title contains our artist (search is fuzzy).
    const relevant = normArtist
      ? results.filter((item) => {
          const t = normalizeText(item.title || "");
          return tokenSubset(normArtist, t) || t.includes(normArtist);
        })
      : [];
    const pool = relevant.length ? relevant : results;
    if (!pool.length) continue;

    const genreCounts = new Map<string, number>();
    const styleCounts = new Map<string, number>();
    for (const item of pool) {
      for (const g of item.genre || [])
        genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
      for (const st of item.style || [])
        styleCounts.set(st, (styleCounts.get(st) || 0) + 1);
    }
    const ranked = styleCounts.size ? styleCounts : genreCounts;
    const labels = [...ranked.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([name]) => name);
    if (labels.length) {
      // Unrelated fallback pool (nothing matched the artist) is shown but not trusted/cached.
      return {
        genres: labels.slice(0, 5),
        source: "Discogs",
        confidence: relevant.length ? 1 : 0.5,
      };
    }
  }
  return;
}

async function lookupApple(
  track: TrackQuery,
  deps: LookupDeps,
  probe: Probe,
): Promise<GenreResult | undefined> {
  if (!track.title || !track.artist) return;
  const term = encodeURIComponent(`${track.title} ${track.artist}`);
  let results: AppleItem[] = [];
  for (const country of ["us", "tr"]) {
    const outcome = await fetchJson(
      `https://itunes.apple.com/search?term=${term}&entity=song&limit=25&country=${country}`,
      deps,
    );
    note(probe, outcome);
    if (outcome.kind === "ok" && Array.isArray(outcome.json?.results))
      results = results.concat(outcome.json.results);
  }

  const qAlbum = normalizeText(track.album);
  const candidates = results
    .map((item) => ({ item, ev: evaluateAppleCandidate(track, item) }))
    .filter(({ ev }) => ev.accept)
    .sort(
      (x, y) =>
        y.ev.score - x.ev.score || x.ev.durationDiff - y.ev.durationDiff,
    );
  if (!candidates.length) return;

  const winner = candidates[0];
  const tied = candidates.filter(
    (c) => Math.abs(winner.ev.score - c.ev.score) < 0.015,
  );
  const tiedGenres = new Set(
    tied.map((c) => normalizeText(c.item.primaryGenreName || "")),
  );
  let genre = winner.item.primaryGenreName as string;
  if (tiedGenres.size > 1) {
    // Equally plausible releases disagree: prefer the current album, else fail closed.
    const same =
      qAlbum &&
      tied.find(
        (c) =>
          wordSimilarity(qAlbum, normalizeText(c.item.collectionName || "")) >=
          0.94,
      );
    if (!same) return;
    genre = same.item.primaryGenreName as string;
  }
  return {
    genres: [genre],
    source: "Apple Music",
    confidence: winner.ev.score,
  };
}

function readCache(
  storage: LookupDeps["storage"],
  key: string,
): GenreResult | undefined {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.genres) && parsed.genres.length)
      return { confidence: 1, ...parsed } as GenreResult;
  } catch {}
  return;
}

export function shouldCache(key: string, result: GenreResult): boolean {
  return (
    Boolean(key) &&
    result.genres.length > 0 &&
    result.confidence >= CACHE_MIN_CONFIDENCE
  );
}

/** Cache -> Discogs -> Apple Music. Network failure is reported separately from "not found". */
export async function lookupGenres(
  track: TrackQuery,
  deps: LookupDeps,
): Promise<LookupOutcome> {
  const key = cacheKeyFor(track.artist, track.title);
  if (key) {
    const cached = readCache(deps.storage, key);
    if (cached) return { status: "ok", result: cached, cached: true };
  }

  const probe: Probe = { answered: 0, failed: 0 };
  let result = await lookupDiscogs(track, deps, probe);
  if (!result) result = await lookupApple(track, deps, probe);

  if (result) {
    if (shouldCache(key, result)) {
      try {
        deps.storage?.setItem(key, JSON.stringify(result));
      } catch {}
    }
    return { status: "ok", result, cached: false };
  }
  // Nothing answered at all -> connectivity problem, not "no genre".
  if (probe.answered === 0 && probe.failed > 0)
    return { status: "error", message: MSG_NETWORK_ERROR };
  return { status: "not_found" };
}
