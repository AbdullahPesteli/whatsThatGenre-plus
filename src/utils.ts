/**
 * Small helpers shared across the extension.
 *
 * Reconstructed from the previously published dist/whatsThatGenre-plus.js, which
 * was built from a source tree that included this file but never committed it.
 * Behaviour is preserved; see issue #2.
 */

import {
  getManualGenre,
  completeSourceOrder,
  type SourceId,
} from "./settings/store";
import { takeSlot, resetBudgets } from "./sources/budget";
import {
  recordHealth,
  sourceAllowed,
  canaryDue,
  markCanary,
  type HealthCode,
} from "./sources/health";
import {
  MB_USER_AGENT,
  MB_MAX_RELEASE_LOOKUPS,
  mbSearchUrl,
  mbReleaseUrl,
  parseMbSearch,
  parseMbGenres,
} from "./sources/musicbrainz";

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
  source: "Discogs" | "MusicBrainz" | "Apple Music" | "manual";
  /** 0..1; low-confidence results are shown but never cached. */
  confidence: number;
};

export type TrackQuery = {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  artistId?: string;
  /** Spotify track URI; key for manual genres. */
  uri?: string;
};

/** User-visible lookup state (cache v2 state machine). */
export type CacheState =
  "fresh" | "stale" | "refreshing" | "offline" | "error" | "not_found";

export type LookupOutcome =
  | {
      status: "ok";
      result: GenreResult;
      cached: boolean;
      state: "fresh" | "stale" | "refreshing" | "offline" | "error";
      /** Extra line for the UI (e.g. "Offline - last known genre (10 days ago)"). */
      label?: string;
      /** Age of the cached record in whole days, when it came from cache. */
      ageDays?: number;
      /** Show a retry control. */
      canRetry?: boolean;
      /** Present while a background refresh runs; resolves to the refreshed outcome. */
      refresh?: Promise<LookupOutcome>;
    }
  | {
      status: "not_found";
      state: "not_found";
      cached: boolean;
      canRetry: true;
      message: string;
      retryLabel: string;
      missCount?: number;
    }
  | {
      status: "error";
      state: "error" | "offline";
      message: string;
      canRetry: true;
      retryLabel: string;
    };

export const MSG_LOOKING = "Looking for genre...";
export const MSG_NOT_FOUND = "Genre not found";
export const MSG_NETWORK_ERROR =
  "Couldn't reach Discogs/Apple Music - check your connection";
export const MSG_REFRESHING = "Updating...";
export const MSG_OFFLINE_NONE = "You're offline, no saved genre for this track";
export const MSG_SERVICE_ERROR = "Couldn't get the genre right now";
export const MSG_UPDATE_FAILED = "Update failed";
export const MSG_RETRY = "Try again";
export const MSG_SEARCH_AGAIN = "Search again";
export const EXTENSION_VERSION = "2.0.1";

/** User-facing source name (stored value "Apple Music" is shown as iTunes). */
export function sourceLabel(source: string): string {
  return source === "Apple Music" ? "iTunes" : source;
}

/** Badge text + tooltip; low confidence gets a leading `~`. */
export function sourceBadge(result: { source: string; confidence: number }): {
  text: string;
  title: string;
} {
  const label = sourceLabel(result.source);
  const low = result.confidence < CACHE_MIN_CONFIDENCE;
  return {
    text: (low ? "~" : "") + label,
    title: `Source: ${label}${low ? " (low confidence)" : ""}`,
  };
}

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

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  key?(index: number): string | null;
  readonly length?: number;
};

export type LookupDeps = {
  fetch: FetchLike;
  storage?: StorageLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Connectivity probe; defaults to `navigator.onLine !== false`. */
  isOnline?: () => boolean;
  /** "Search again": bypass negative cache and fresh/stale shortcuts. */
  force?: boolean;
  /** Extension version stamped on records; negative records of other versions are dropped. */
  appVersion?: string;
  /** Source priority from settings; partial/invalid lists are completed with defaults. */
  sourceOrder?: readonly string[];
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
  source?: string,
): Promise<FetchOutcome> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 2; attempt++) {
    // client rate budget: over-budget requests wait in line, they are never dropped
    if (source) await takeSlot(source, deps.now ?? Date.now, sleep);
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

type Probe = {
  answered: number;
  failed: number;
  typeErrors: number;
  /** HTTP 200 but the expected fields were missing (kept apart from not_found). */
  schema: number;
};

const nowOf = (deps: LookupDeps) => (deps.now ?? Date.now)();

function note(
  probe: Probe,
  outcome: FetchOutcome,
  deps?: LookupDeps,
  source?: string,
) {
  let code: HealthCode | undefined;
  if (outcome.kind === "http") {
    code =
      outcome.status === 429
        ? "http429"
        : outcome.status >= 500 || outcome.status === 0
          ? "http5xx"
          : "http4xx";
  } else if (outcome.kind === "network") code = "network";
  if (deps && source && code)
    recordHealth(deps.storage, source, code, nowOf(deps));
  // 429/5xx/network = "service unavailable"; 401/403 = we are being refused; else it answered.
  if (
    outcome.kind === "ok" ||
    (outcome.kind === "http" &&
      outcome.status !== 429 &&
      outcome.status !== 401 &&
      outcome.status !== 403 &&
      outcome.status < 500)
  )
    probe.answered++;
  else {
    probe.failed++;
    if (outcome.kind === "network" && outcome.error instanceof TypeError)
      probe.typeErrors++;
  }
}

/** Parsed-body verdict for an HTTP 200: ok / notfound / schema (own failure class). */
function noteParsed(
  probe: Probe,
  deps: LookupDeps,
  source: string,
  code: "ok" | "notfound" | "schema",
) {
  if (code === "schema") {
    probe.schema++;
    probe.answered--; // a 200 with a broken shape is not a real answer
  }
  recordHealth(deps.storage, source, code, nowOf(deps));
}

/** Discogs: `results` array; when non-empty, some of the first 5 has title + genre|style arrays. */
export function discogsShapeOk(json: any): boolean {
  if (!Array.isArray(json?.results)) return false;
  if (!json.results.length) return true;
  return json.results
    .slice(0, 5)
    .some(
      (r: any) =>
        r &&
        typeof r.title === "string" &&
        (Array.isArray(r.genre) || Array.isArray(r.style)),
    );
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
    if (!sourceAllowed(deps.storage, "Discogs", nowOf(deps))) break;
    const outcome = await fetchJson(
      url,
      deps,
      { "User-Agent": DISCOGS_USER_AGENT },
      "Discogs",
    );
    note(probe, outcome, deps, "Discogs");
    if (outcome.kind !== "ok") continue;
    if (!discogsShapeOk(outcome.json)) {
      noteParsed(probe, deps, "Discogs", "schema");
      continue;
    }
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
    if (!pool.length) {
      noteParsed(probe, deps, "Discogs", "notfound");
      continue;
    }

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
    noteParsed(probe, deps, "Discogs", labels.length ? "ok" : "notfound");
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

async function lookupMusicBrainz(
  track: TrackQuery,
  deps: LookupDeps,
  probe: Probe,
): Promise<GenreResult | undefined> {
  if (!track.title || !track.artist) return;
  if (!sourceAllowed(deps.storage, "MusicBrainz", nowOf(deps))) return;
  const headers = { "User-Agent": MB_USER_AGENT };
  const search = await fetchJson(
    mbSearchUrl(track.title, track.artist),
    deps,
    headers,
    "MusicBrainz",
  );
  note(probe, search, deps, "MusicBrainz");
  if (search.kind !== "ok") return;
  const recs = parseMbSearch(search.json);
  if (!recs) {
    noteParsed(probe, deps, "MusicBrainz", "schema");
    return;
  }
  const qTitle = normalizeTitle(track.title);
  const qArtist = normalizeText(track.artist);
  const matching = recs.filter((r) => {
    if (r.score < 90) return false;
    if (isDerivativeName(r.title, track.title)) return false;
    if (wordSimilarity(qTitle, normalizeTitle(r.title)) < TITLE_MIN_SIMILARITY)
      return false;
    const artists = normalizeText(r.artists.join(" "));
    if (!(tokenSubset(qArtist, artists) || artists.includes(qArtist)))
      return false;
    if (
      track.durationMs > 0 &&
      r.length &&
      Math.abs(track.durationMs - r.length) > 10000
    )
      return false;
    return true;
  });
  if (!matching.length) {
    noteParsed(probe, deps, "MusicBrainz", "notfound");
    return;
  }
  // album-title matches first, then Official before the rest
  const qAlbum = normalizeText(track.album);
  const ranked = matching
    .flatMap((r) => r.releases)
    .map((rel) => ({
      id: rel.id,
      rank:
        (qAlbum && normalizeText(rel.title ?? "") === qAlbum ? 0 : 2) +
        (rel.status === "Official" ? 0 : 1),
    }))
    .sort((x, y) => x.rank - y.rank);
  const releases = [...new Set(ranked.map((x) => x.id))];
  let sawGenres = false;
  for (const id of releases.slice(0, MB_MAX_RELEASE_LOOKUPS)) {
    const lk = await fetchJson(mbReleaseUrl(id), deps, headers, "MusicBrainz");
    note(probe, lk, deps, "MusicBrainz");
    if (lk.kind !== "ok") continue;
    const genres = parseMbGenres(lk.json);
    if (!genres) {
      noteParsed(probe, deps, "MusicBrainz", "schema");
      continue;
    }
    sawGenres = true;
    if (genres.length) {
      noteParsed(probe, deps, "MusicBrainz", "ok");
      const knownLength =
        track.durationMs > 0 && matching.some((m) => m.length);
      const albumHit =
        Boolean(track.album) &&
        wordSimilarity(
          normalizeText(track.album),
          normalizeText(String(lk.json?.title ?? "")),
        ) >= 0.94;
      return {
        genres,
        source: "MusicBrainz",
        confidence: albumHit ? 1 : knownLength ? 0.95 : 0.9,
      };
    }
  }
  noteParsed(
    probe,
    deps,
    "MusicBrainz",
    sawGenres || !releases.length ? "notfound" : "schema",
  );
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
  let appleShapeBad = false;
  for (const country of ["us", "tr"]) {
    if (!sourceAllowed(deps.storage, "Apple Music", nowOf(deps))) break;
    const outcome = await fetchJson(
      `https://itunes.apple.com/search?term=${term}&entity=song&limit=25&country=${country}`,
      deps,
    );
    note(probe, outcome, deps, "Apple Music");
    if (outcome.kind !== "ok") continue;
    const arr = outcome.json?.results;
    if (
      !Array.isArray(arr) ||
      (arr.length > 0 &&
        !arr
          .slice(0, 5)
          .some((r: any) => typeof r?.primaryGenreName === "string"))
    ) {
      appleShapeBad = true;
      noteParsed(probe, deps, "Apple Music", "schema");
      continue;
    }
    noteParsed(probe, deps, "Apple Music", arr.length ? "ok" : "notfound");
    results = results.concat(arr);
  }
  void appleShapeBad;

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

/* ------------------------------------------------------------------ */
/* Cache v2: per-record keys, tiered TTL, negative cache, state machine */
/* ------------------------------------------------------------------ */

export const CACHE_PREFIX = "wtg:v2:";
export const CACHE_INDEX_KEY = "wtg:v2:idx";
export const MAX_ENTRIES = 2000;
export const EVICT_FRACTION = 0.2;
export const INDEX_DEBOUNCE_MS = 500;
export const NEG_BASE_TTL_MS = 60 * 60 * 1000;
export const NEG_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const NEG_MULTIPLIER = 4;
export const NETWORK_BACKOFF_MS = [2000, 8000, 30000];
const DAY = 24 * 60 * 60 * 1000;

export type CacheRecord = {
  v: 2;
  kind: "genre" | "neg";
  genres: string[];
  source: string;
  confidence: number;
  cachedAt: number;
  /** Fresh window, stored so later threshold changes do not affect old records. */
  ttlMs: number;
  /** Past this age the record is "expired" (still shown as last known when offline/error). */
  staleMaxMs: number;
  appVersion: string;
  migrated?: boolean;
  /** Negative records only. */
  missCount?: number;
  expiresAt?: number;
  lastError?: { at: number; message: string };
};

/** Source x confidence -> fresh / staleMax windows. */
export function ttlFor(
  source: string,
  confidence: number,
): { ttlMs: number; staleMaxMs: number } {
  if (source === "Discogs")
    return confidence >= 0.85
      ? { ttlMs: 7 * DAY, staleMaxMs: 90 * DAY }
      : { ttlMs: 1 * DAY, staleMaxMs: 30 * DAY };
  if (source === "Apple Music")
    return { ttlMs: 30 * DAY, staleMaxMs: 180 * DAY };
  if (source === "MusicBrainz" || source === "Wikidata")
    return { ttlMs: 90 * DAY, staleMaxMs: 365 * DAY };
  // unknown (migrated v1): shortest tier
  return { ttlMs: 1 * DAY, staleMaxMs: 30 * DAY };
}

/** Negative TTL: 1h, x4 per consecutive miss, capped at 24h. */
export function negativeTtlMs(missCount: number): number {
  return Math.min(
    NEG_BASE_TTL_MS * NEG_MULTIPLIER ** Math.max(0, missCount - 1),
    NEG_MAX_TTL_MS,
  );
}

export function v2KeyFor(key: string): string {
  return CACHE_PREFIX + key.replace(/^hermesGenre:/, "");
}

type IndexEntry = { u: number; n: 0 | 1 };
type IndexState = {
  map: Map<string, IndexEntry>;
  timer?: ReturnType<typeof setTimeout>;
};
const indexes = new WeakMap<object, IndexState>();

function loadIndex(storage: StorageLike): IndexState {
  let st = indexes.get(storage);
  if (st) return st;
  st = { map: new Map() };
  indexes.set(storage, st);
  try {
    const raw = storage.getItem(CACHE_INDEX_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const [k, e] of Object.entries(parsed ?? {}) as [string, any][])
        if (e && typeof e.u === "number")
          st.map.set(k, { u: e.u, n: e.n ? 1 : 0 });
      return st;
    }
  } catch {}
  // Index missing/corrupt: rebuild from the records themselves when enumerable.
  try {
    const len = storage.length ?? 0;
    for (let i = 0; i < len; i++) {
      const k = storage.key?.(i);
      if (!k || !k.startsWith(CACHE_PREFIX) || k === CACHE_INDEX_KEY) continue;
      try {
        const rec = JSON.parse(storage.getItem(k) ?? "null");
        st.map.set(k, {
          u: rec?.cachedAt ?? 0,
          n: rec?.kind === "neg" ? 1 : 0,
        });
      } catch {}
    }
  } catch {}
  return st;
}

function writeIndexNow(storage: StorageLike, st: IndexState) {
  if (st.timer) clearTimeout(st.timer);
  st.timer = undefined;
  const obj: Record<string, IndexEntry> = {};
  for (const [k, e] of st.map) obj[k] = e;
  try {
    storage.setItem(CACHE_INDEX_KEY, JSON.stringify(obj));
  } catch {}
}

function scheduleIndex(storage: StorageLike, st: IndexState) {
  if (st.timer) return;
  const t = setTimeout(() => writeIndexNow(storage, st), INDEX_DEBOUNCE_MS);
  (t as { unref?: () => void }).unref?.();
  st.timer = t;
}

/** Write the (debounced) index immediately. Used on teardown and by tests. */
export function flushCacheIndex(storage: StorageLike | undefined) {
  if (!storage) return;
  const st = indexes.get(storage);
  if (st) writeIndexNow(storage, st);
}

function evictOldest(storage: StorageLike, st: IndexState, fraction: number) {
  // negatives go first, then least recently used
  const order = [...st.map.entries()].sort(
    (a, b) => b[1].n - a[1].n || a[1].u - b[1].u,
  );
  const count = Math.max(1, Math.ceil(order.length * fraction));
  for (const [k] of order.slice(0, count)) {
    try {
      storage.removeItem?.(k);
    } catch {}
    st.map.delete(k);
  }
}

function putRecord(
  storage: StorageLike | undefined,
  v2Key: string,
  rec: CacheRecord,
  now: number,
): boolean {
  if (!storage) return false;
  try {
    const st = loadIndex(storage);
    const value = JSON.stringify(rec);
    if (!st.map.has(v2Key) && st.map.size >= MAX_ENTRIES)
      evictOldest(storage, st, EVICT_FRACTION);
    try {
      storage.setItem(v2Key, value);
    } catch {
      // QuotaExceededError: drop the oldest 20 %, retry exactly once, then give up quietly.
      evictOldest(storage, st, EVICT_FRACTION);
      storage.setItem(v2Key, value);
    }
    st.map.set(v2Key, { u: now, n: rec.kind === "neg" ? 1 : 0 });
    scheduleIndex(storage, st);
    return true;
  } catch {
    return false;
  }
}

function dropRecord(storage: StorageLike | undefined, v2Key: string) {
  if (!storage) return;
  try {
    storage.removeItem?.(v2Key);
    const st = loadIndex(storage);
    if (st.map.delete(v2Key)) scheduleIndex(storage, st);
  } catch {}
}

function readRecord(
  storage: StorageLike | undefined,
  key: string,
  now: number,
  appVersion: string,
): CacheRecord | undefined {
  if (!storage || !key) return;
  const v2Key = v2KeyFor(key);
  try {
    const raw = storage.getItem(v2Key);
    if (raw) {
      const rec = JSON.parse(raw);
      if (rec && typeof rec.v === "number" && rec.v > 2) return; // future schema: neither read nor delete
      if (
        rec?.v === 2 &&
        (rec.kind === "neg" ||
          (Array.isArray(rec.genres) && rec.genres.length > 0))
      ) {
        const st = loadIndex(storage);
        const prev = st.map.get(v2Key);
        if (!prev || prev.u !== now) {
          st.map.set(v2Key, { u: now, n: rec.kind === "neg" ? 1 : 0 });
          scheduleIndex(storage, st);
        }
        return rec as CacheRecord;
      }
      dropRecord(storage, v2Key); // corrupt / wrong shape
    }
  } catch {
    dropRecord(storage, v2Key);
  }
  // Lazy v1 migration: v1 key held {genres, confidence, source?}
  try {
    const raw = storage.getItem(key);
    if (!raw) return;
    const old = JSON.parse(raw);
    if (!old || !Array.isArray(old.genres) || !old.genres.length) {
      storage.removeItem?.(key);
      return;
    }
    const confidence = typeof old.confidence === "number" ? old.confidence : 1;
    const { ttlMs, staleMaxMs } = ttlFor("unknown", confidence);
    const rec: CacheRecord = {
      v: 2,
      kind: "genre",
      genres: old.genres,
      source: typeof old.source === "string" ? old.source : "unknown",
      confidence,
      cachedAt: now,
      ttlMs,
      staleMaxMs,
      appVersion,
      migrated: true,
    };
    if (putRecord(storage, v2Key, rec, now)) storage.removeItem?.(key);
    return rec;
  } catch {
    return;
  }
}

export function shouldCache(key: string, result: GenreResult): boolean {
  return (
    Boolean(key) &&
    result.genres.length > 0 &&
    result.confidence >= CACHE_MIN_CONFIDENCE
  );
}

/* ---- lookup state machine ---- */

type NetResult =
  | { kind: "found"; result: GenreResult }
  | { kind: "not_found"; clean: boolean }
  | { kind: "error"; network: boolean };

const inflight = new Map<string, Promise<NetResult>>();
const netFailures = new Map<string, { count: number; until: number }>();

/** Test hook: forget in-flight requests and backoff state. */
export function resetLookupState() {
  inflight.clear();
  netFailures.clear();
  resetBudgets();
}

export function ageLabel(ageMs: number): string {
  const days = Math.max(0, Math.floor(ageMs / DAY));
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

async function network(
  track: TrackQuery,
  deps: LookupDeps,
): Promise<NetResult> {
  const probe: Probe = { answered: 0, failed: 0, typeErrors: 0, schema: 0 };
  const steps: Record<SourceId, () => Promise<GenreResult | undefined>> = {
    discogs: () => lookupDiscogs(track, deps, probe),
    musicbrainz: () => lookupMusicBrainz(track, deps, probe),
    itunes: () => lookupApple(track, deps, probe),
  };
  let result: GenreResult | undefined;
  for (const id of completeSourceOrder(deps.sourceOrder)) {
    result = await steps[id]();
    if (result) break;
  }
  if (result) return { kind: "found", result };
  // schema errors are their own class: never written to the negative cache
  if (probe.failed > 0 || probe.schema > 0)
    return {
      kind: "error",
      network:
        probe.schema === 0 &&
        probe.answered === 0 &&
        probe.typeErrors === probe.failed,
    };
  return { kind: "not_found", clean: true };
}

function okFromRecord(
  rec: CacheRecord,
  now: number,
  state: "fresh" | "stale" | "refreshing" | "offline" | "error",
  extra: Partial<Extract<LookupOutcome, { status: "ok" }>> = {},
): LookupOutcome {
  return {
    status: "ok",
    cached: true,
    state,
    ageDays: Math.floor(Math.max(0, now - rec.cachedAt) / DAY),
    result: {
      genres: rec.genres,
      source: rec.source as GenreResult["source"],
      confidence: rec.confidence,
    },
    ...extra,
  };
}

/** Cache -> Discogs -> Apple Music. Network failure is reported separately from "not found". */
export async function lookupGenres(
  track: TrackQuery,
  deps: LookupDeps,
): Promise<LookupOutcome> {
  // A manual genre always wins and is never written to / overwritten by the cache.
  const manual = getManualGenre(deps.storage, track.uri);
  if (manual)
    return {
      status: "ok",
      result: { genres: [manual], source: "manual", confidence: 1 },
      cached: false,
      state: "fresh",
    };

  const key = cacheKeyFor(track.artist, track.title);
  const now = (deps.now ?? Date.now)();
  const appVersion = deps.appVersion ?? EXTENSION_VERSION;
  const online = deps.isOnline
    ? deps.isOnline()
    : typeof navigator === "undefined" || navigator.onLine !== false;
  const v2Key = key ? v2KeyFor(key) : "";

  let rec = readRecord(deps.storage, key, now, appVersion);
  let good: CacheRecord | undefined;
  if (rec?.kind === "neg") {
    if (rec.appVersion !== appVersion) {
      dropRecord(deps.storage, v2Key); // plugin version changed: forget negatives
      rec = undefined;
    } else if (!deps.force && now < (rec.expiresAt ?? 0)) {
      return {
        status: "not_found",
        state: "not_found",
        cached: true,
        canRetry: true,
        message: MSG_NOT_FOUND,
        retryLabel: MSG_SEARCH_AGAIN,
        missCount: rec.missCount,
      };
    }
  } else if (rec) good = rec;

  const age = good ? now - good.cachedAt : Infinity;
  const withinStaleMax = good ? age <= good.staleMaxMs : false;

  if (good && !deps.force && age <= good.ttlMs && !good.lastError)
    return okFromRecord(good, now, "fresh");
  if (good && !deps.force && age <= good.ttlMs && good.lastError)
    return okFromRecord(good, now, "fresh");

  // offline: never touch the network
  const backoff = key ? netFailures.get(key) : undefined;
  const backingOff = online && !deps.force && backoff && now < backoff.until;
  if (!online || backingOff) {
    if (good)
      return okFromRecord(good, now, "offline", {
        label: `Offline - last known genre (${ageLabel(age)})`,
        canRetry: true,
      });
    return {
      status: "error",
      state: "offline",
      message: online ? MSG_NETWORK_ERROR : MSG_OFFLINE_NONE,
      canRetry: true,
      retryLabel: MSG_RETRY,
    };
  }

  // single flight per track
  let flight = key ? inflight.get(key) : undefined;
  if (!flight) {
    flight = (async (): Promise<NetResult> => {
      const net = await network(track, deps);
      const t = (deps.now ?? Date.now)();
      if (net.kind === "found") {
        if (key) netFailures.delete(key);
        if (shouldCache(key, net.result)) {
          const { ttlMs, staleMaxMs } = ttlFor(
            net.result.source,
            net.result.confidence,
          );
          putRecord(
            deps.storage,
            v2Key,
            {
              v: 2,
              kind: "genre",
              genres: net.result.genres,
              source: net.result.source,
              confidence: net.result.confidence,
              cachedAt: t,
              ttlMs,
              staleMaxMs,
              appVersion,
            },
            t,
          );
        }
      } else if (net.kind === "not_found") {
        if (key) netFailures.delete(key);
        // never replace a good record with a negative one
        if (key && net.clean && !good) {
          const missCount =
            (rec?.kind === "neg" ? (rec.missCount ?? 0) : 0) + 1;
          const ttl = negativeTtlMs(missCount);
          putRecord(
            deps.storage,
            v2Key,
            {
              v: 2,
              kind: "neg",
              genres: [],
              source: "none",
              confidence: 0,
              cachedAt: t,
              ttlMs: ttl,
              staleMaxMs: ttl,
              appVersion,
              missCount,
              expiresAt: t + ttl,
            },
            t,
          );
        }
      } else if (net.network && key) {
        const count = (netFailures.get(key)?.count ?? 0) + 1;
        const step =
          NETWORK_BACKOFF_MS[Math.min(count, NETWORK_BACKOFF_MS.length) - 1];
        netFailures.set(key, { count, until: t + step });
      }
      return net;
    })().finally(() => {
      if (key) inflight.delete(key);
    });
    if (key) inflight.set(key, flight);
  }

  const settle = (net: NetResult): LookupOutcome => {
    const t = (deps.now ?? Date.now)();
    if (net.kind === "found")
      return {
        status: "ok",
        result: net.result,
        cached: false,
        state: "fresh",
      };
    if (net.kind === "not_found") {
      if (good) return okFromRecord(good, t, "stale"); // keep what we know
      return {
        status: "not_found",
        state: "not_found",
        cached: false,
        canRetry: true,
        message: MSG_NOT_FOUND,
        retryLabel: MSG_SEARCH_AGAIN,
      };
    }
    // error: never overwrite or drop the good record; remember the error on it
    if (good) {
      putRecord(
        deps.storage,
        v2Key,
        {
          ...good,
          lastError: { at: t, message: net.network ? "network" : "http" },
        },
        t,
      );
      return okFromRecord(good, t, net.network ? "offline" : "error", {
        label: net.network
          ? `Offline - last known genre (${ageLabel(t - good.cachedAt)})`
          : MSG_UPDATE_FAILED,
        canRetry: true,
      });
    }
    return {
      status: "error",
      state: net.network ? "offline" : "error",
      message: net.network ? MSG_NETWORK_ERROR : MSG_SERVICE_ERROR,
      canRetry: true,
      retryLabel: MSG_RETRY,
    };
  };

  // stale-while-revalidate: show the old genres now, refresh in the background
  if (good && !deps.force && withinStaleMax) {
    return okFromRecord(good, now, "refreshing", {
      label: MSG_REFRESHING,
      refresh: flight.then(settle),
    });
  }
  return settle(await flight);
}

/** Fixed canary queries (no user data). */
export const CANARY_DISCOGS_URL =
  "https://api.discogs.com/database/search?artist=Radiohead&release_title=OK%20Computer&type=release&per_page=5";
/** Pablo Honey (Official release); stable MBID. */
export const CANARY_MB_URL = mbReleaseUrl(
  "287dca89-2bf4-42c2-ba32-b6eddceb835f",
);

/**
 * Daily self-test: 1 Discogs + 1 MusicBrainz request, verifies field shape,
 * writes the result to wtg:health:v1. Returns null when not due.
 */
export async function runCanary(
  deps: LookupDeps,
): Promise<{ Discogs: HealthCode; MusicBrainz: HealthCode } | null> {
  const t = nowOf(deps);
  if (!canaryDue(deps.storage, t)) return null;
  markCanary(deps.storage, t);
  const out = {} as { Discogs: HealthCode; MusicBrainz: HealthCode };
  const probe: Probe = { answered: 0, failed: 0, typeErrors: 0, schema: 0 };
  const run = async (
    source: "Discogs" | "MusicBrainz",
    url: string,
    headers: Record<string, string>,
    shapeOk: (json: any) => boolean,
  ) => {
    if (!sourceAllowed(deps.storage, source, nowOf(deps))) {
      out[source] = "network";
      return;
    }
    const o = await fetchJson(url, deps, headers, source);
    note(probe, o, deps, source);
    if (o.kind === "ok") {
      const ok = shapeOk(o.json);
      recordHealth(deps.storage, source, ok ? "ok" : "schema", nowOf(deps));
      out[source] = ok ? "ok" : "schema";
    } else
      out[source] =
        o.kind === "network"
          ? "network"
          : o.status === 429
            ? "http429"
            : o.status >= 500 || o.status === 0
              ? "http5xx"
              : "http4xx";
  };
  await run(
    "Discogs",
    CANARY_DISCOGS_URL,
    { "User-Agent": DISCOGS_USER_AGENT },
    (j) =>
      discogsShapeOk(j) && Array.isArray(j.results) && j.results.length > 0,
  );
  await run(
    "MusicBrainz",
    CANARY_MB_URL,
    { "User-Agent": MB_USER_AGENT },
    (j) => Array.isArray(j?.genres),
  );
  return out;
}

export { reserveSlot, BUDGETS } from "./sources/budget";
export {
  recordHealth,
  sourceAllowed,
  sourceStatus,
  getBreaker,
  evaluate as evaluateHealth,
  HEALTH_KEY,
} from "./sources/health";
export {
  parseMbSearch,
  parseMbGenres,
  MB_USER_AGENT,
} from "./sources/musicbrainz";
