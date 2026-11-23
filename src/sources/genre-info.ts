import { resolveLang } from "../settings/store";
import { camelize } from "../utils";
import { genreTrName } from "./genre-tr-names";

export type Lang = "tr" | "en";
export type GenreInfoSource =
  "wikipedia" | "wikidata" | "musicalyst" | "musicbrainz";
export type GenreInfo = {
  query: string;
  lang: Lang;
  descLang: Lang | null;
  fallbackNote: boolean;
  title: string | null;
  description: string | null;
  descSource: GenreInfoSource | null;
  descUrl: string | null;
  related: { name: string; wikidataId?: string }[];
  artists: { name: string; spotifyId?: string; image?: string }[];
  wikidataId: string | null;
  attribution: string[];
  playlistHint: string | null;
  cached: boolean;
  tried: {
    source: string;
    outcome: "hit" | "miss" | "error" | "skipped";
    ms: number;
  }[];
};
type Options = { signal?: AbortSignal; now?: number; fetcher?: typeof fetch };
const PREFIX = "wtg:genre:v1:";
// TR entries store rendered chip names, so old TR entries need refreshing.
const cacheRevision = (lang: Lang) => (lang === "tr" ? 4 : 3);
const ttl = { success: 30 * 864e5, partial: 7 * 864e5, negative: 864e5 };
const queues = new Map<string, Promise<unknown>>();
const errors = new Map<string, { count: number; until: number }>();
const ua = {
  "Api-User-Agent":
    "WhatsThatGenre/2.3.3 (https://github.com/AbdullahPesteli/whatsThatGenre-plus)",
};

export function normalizeGenreName(name: string): string[] {
  const raw = name.trim();
  const base = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const variants = [
    base.replace(/ /g, "-").replace(/:/g, ""),
    raw,
    base.replace(/[^a-z0-9 -]/g, ""),
    base.replace(/&/g, "and").replace(/\//g, "-"),
    base.replace(/[\s-]+/g, ""),
  ];
  return [...new Set(variants)].filter(Boolean).slice(0, 5);
}
function empty(query: string, lang: Lang): GenreInfo {
  return {
    query,
    lang,
    descLang: null,
    fallbackNote: false,
    title: null,
    description: null,
    descSource: null,
    descUrl: null,
    related: [],
    artists: [],
    wikidataId: null,
    attribution: [],
    playlistHint: null,
    cached: false,
    tried: [],
  };
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
const lastStart = new Map<string, number>();
class CircuitOpen extends Error {}
async function getJson(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<any> {
  const host = new URL(url).hostname.replace(
    /^(?:tr|en)\.wikipedia\.org$/,
    "wikipedia.org",
  );
  const task = (queues.get(host) ?? Promise.resolve()).then(async () => {
    signal.throwIfAborted();
    if ((errors.get(host)?.until ?? 0) > Date.now()) throw new CircuitOpen();
    try {
      for (let attempt = 0; ; attempt++) {
        const gap = host === "lucasoe.github.io" ? 250 : 1000;
        const remaining = (lastStart.get(host) ?? 0) + gap - Date.now();
        if (remaining > 0) await sleep(remaining, signal);
        signal.throwIfAborted();
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(6000),
        ]);
        lastStart.set(host, Date.now());
        const response = await abortable(
          Promise.resolve(
            fetcher(url, {
              signal: requestSignal,
              headers:
                host === "lucasoe.github.io"
                  ? {}
                  : host === "musicbrainz.org"
                    ? { "User-Agent": ua["Api-User-Agent"] }
                    : ua,
            }),
          ),
          requestSignal,
        );
        if (response.ok) {
          const data = await abortable(response.json(), requestSignal);
          errors.delete(host);
          return data ?? {};
        }
        if (response.status === 404 || response.status === 410) {
          errors.delete(host);
          return null;
        }
        if (response.status !== 429 && response.status < 500) {
          errors.delete(host);
          return undefined;
        }
        if (attempt === (host === "www.wikidata.org" ? 1 : 2))
          throw new Error(`HTTP ${response.status}`);
        const retry = response.headers?.get("Retry-After");
        const parsed = retry
          ? /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - Date.now()
          : NaN;
        const delay = Number.isFinite(parsed)
          ? Math.max(0, parsed)
          : attempt === 0
            ? 2000
            : 5000;
        // Wikidata discovery must leave room for the Wikipedia title route.
        if (host === "www.wikidata.org" && delay > 2000)
          throw new Error(`HTTP ${response.status}: retry deferred`);
        await sleep(delay, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        const old = errors.get(host);
        const count = (old?.until ? 0 : (old?.count ?? 0)) + 1;
        errors.set(host, {
          count,
          until: count >= 3 ? Date.now() + 600000 : 0,
        });
      }
      throw error;
    }
  });
  queues.set(
    host,
    task.catch(() => undefined),
  );
  return abortable(task, signal);
}
const array = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const text = (x: unknown): string => (typeof x === "string" ? x.trim() : "");
const qid = (x: unknown): x is string =>
  typeof x === "string" && /^Q[1-9]\d*$/.test(x);
const claimIds = (x: unknown): string[] =>
  array(x)
    .map((c) => c?.mainsnak?.datavalue?.value?.id)
    .filter(qid);
const clip = (s: string) => {
  if (s.length <= 600) return s;
  const prefix = s.slice(0, 600);
  const ends = [...prefix.matchAll(/[.!?](?=\s)/g)];
  return (
    prefix
      .slice(0, ends.length ? ends[ends.length - 1].index! + 1 : 599)
      .trimEnd() + (ends.length ? "" : "…")
  );
};
const wikiPath = (title: string) =>
  encodeURIComponent(title.replace(/ /g, "_"));
const music =
  /music|genre|style|song|rock|jazz|hip.hop|techno|metal|müzik|tarz|şarkı|dans/i;
const excluded =
  /index of articles|anlam ayrımı|type of material|art form|kimyasal element/i;
const wd = "https://www.wikidata.org/w/api.php?format=json&origin=*&";
export function safeHttps(value: unknown): string | undefined {
  try {
    if (typeof value !== "string") return;
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password)
      return url.href;
  } catch {}
}
export function spotifyImage(value: unknown): string | undefined {
  const url = safeHttps(value);
  return url?.startsWith("https://i.scdn.co/") ? url : undefined;
}
const foldedName = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .trim();
const relatedKey = (name: string) =>
  foldedName(name).replace(/[\s-]+(?:muzik|music)$/, "");
function record(
  info: GenreInfo,
  source: string,
  outcome: "hit" | "miss" | "error" | "skipped",
  started: number,
) {
  info.tried.push({ source, outcome, ms: Math.max(0, Date.now() - started) });
}
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
function cacheKey(name: string, lang: Lang) {
  return `${PREFIX}${lang}:${name.normalize("NFKC").trim().toLowerCase()}`;
}
export function resetGenreInfoStateForTests(): void {
  queues.clear();
  lastStart.clear();
  errors.clear();
}

export async function fetchGenreInfo(
  name: string,
  lang: Lang,
  opts: Options = {},
): Promise<GenreInfo> {
  const query = name.trim(),
    info = empty(query, lang),
    now = opts.now ?? Date.now(),
    fetcher = opts.fetcher ?? fetch;
  if (!query || (lang !== "tr" && lang !== "en")) return info;
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const store = storage(),
    key = cacheKey(query, lang);
  try {
    const raw = store?.getItem(key);
    if (raw) {
      const entry = JSON.parse(raw);
      if (
        entry.revision === cacheRevision(lang) &&
        entry.until > now &&
        entry.value?.lang === lang &&
        Array.isArray(entry.value.artists) &&
        Array.isArray(entry.value.related) &&
        Array.isArray(entry.value.attribution)
      )
        return { ...entry.value, query, cached: true };
      store?.removeItem(key);
    }
  } catch {}
  const deadline = AbortSignal.timeout(12000);
  const grace = new AbortController();
  const signal = AbortSignal.any([
    deadline,
    grace.signal,
    ...(opts.signal ? [opts.signal] : []),
  ]);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const startGrace = () => {
    graceTimer ??= setTimeout(() => grace.abort(), 2000);
  };
  let blocked = false;
  async function runSource(source: string, url: string, sourceSignal = signal) {
    if (sourceSignal.aborted) return undefined;
    const started = Date.now();
    try {
      const data = await getJson(url, sourceSignal, fetcher);
      record(info, source, data == null ? "miss" : "hit", started);
      return data;
    } catch (error) {
      if (!grace.signal.aborted) blocked = true;
      record(
        info,
        source,
        error instanceof CircuitOpen ? "skipped" : "error",
        started,
      );
      return undefined;
    }
  }
  let mirrorRelated: GenreInfo["related"] = [];
  try {
    const alternate = (async () => {
      for (const slug of normalizeGenreName(query)) {
        const url = `https://lucasoe.github.io/spicetify-genres/api/${encodeURIComponent(slug)}.json`;
        const m = await runSource("musicalyst", url);
        if (m === null) continue;
        const d = m?.pageProps;
        if (!d) return;
        const description = text(d.genresAdvancedInfo?.description);

        if (description) startGrace();
        info.artists = array(d.topArtists)
          .flatMap((a) =>
            text(a?.name)
              ? [
                  {
                    name: text(a.name),
                    spotifyId: text(a.id) || undefined,
                    image:
                      spotifyImage(a.images?.[2]?.url) ??
                      spotifyImage(a.images?.[0]?.url),
                  },
                ]
              : [],
          )
          .slice(0, 10);
        mirrorRelated = array(d.relatedGenres)
          .flatMap((g) => (text(g?.genre) ? [{ name: text(g.genre) }] : []))
          .slice(0, 12);
        const playlist =
          d.genresAdvancedInfo?.playlists?.[0] ?? d.playlists?.[0];
        info.playlistHint =
          text(playlist?.uri) || text(playlist?.id) || text(playlist) || null;
        return { description, url };
      }
    })();
    const otherArtists = (async () => {
      await alternate;
      if (info.artists.length) return;
      const tag = query.replace(/(["\\])/g, "\\$1");
      const mb = await runSource(
        "musicbrainz",
        `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(`tag:"${tag}"`)}&fmt=json&limit=10`,
      );
      info.artists = array(mb?.artists)
        .flatMap((a) => (text(a?.name) ? [{ name: text(a.name) }] : []))
        .slice(0, 10);
      if (info.artists.length) info.attribution.push("MusicBrainz (CC0)");
    })();
    const discovery = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    const search = await runSource(
      "wikidata-search",
      `${wd}action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&limit=6`,
      discovery,
    );
    const candidates = array(search?.search)
      .slice(0, 6)
      .filter((c) => qid(c?.id));
    let entity: any;
    if (candidates.length) {
      const data = await runSource(
        "wikidata",
        `${wd}action=wbgetentities&ids=${candidates.map((c) => c.id).join("|")}&props=labels|descriptions|claims|sitelinks&languages=en|tr&sitefilter=enwiki|trwiki`,
        discovery,
      );
      for (const candidate of candidates) {
        const found = data?.entities?.[candidate.id];
        if (!claimIds(found?.claims?.P31).includes("Q188451")) continue;
        entity = found;
        info.wikidataId = candidate.id;
        info.title =
          text(found.labels?.[lang]?.value) ||
          text(found.labels?.en?.value) ||
          text(candidate.label) ||
          null;
        break;
      }
    }
    const trShort =
      lang === "tr"
        ? text(entity?.descriptions?.tr?.value).replace(/\s+/g, " ")
        : "";
    const entityDescription = trShort || text(entity?.descriptions?.en?.value);
    if (entityDescription) startGrace();
    const ids = [
      ...new Set(
        ["P279", "P1269", "P737"].flatMap((p) => claimIds(entity?.claims?.[p])),
      ),
    ]
      .filter((id) => id !== info.wikidataId)
      .slice(0, 12);
    const langs: Lang[] = lang === "tr" ? ["tr", "en"] : ["en"];
    const chipName = (name: string) =>
      (lang === "tr" ? genreTrName(foldedName(name)) : undefined) ??
      camelize(name);
    const relatedLabels = (async () => {
      if (!ids.length) return [];
      const data = await runSource(
        "wikidata-related",
        `${wd}action=wbgetentities&ids=${ids.join("|")}&props=labels&languages=en|tr`,
      );
      return ids.flatMap((id) => {
        const labels = data?.entities?.[id]?.labels;
        const localized = text(labels?.[lang]?.value);
        const english = text(labels?.en?.value);
        const name = localized || chipName(english);
        return name ? [{ name, english, wikidataId: id }] : [];
      });
    })();
    for (const wl of langs) {
      const title = text(entity?.sitelinks?.[`${wl}wiki`]?.title);
      const titles = title
        ? [title]
        : entity
          ? []
          : [
              query,
              ...(wl === "tr" ? [`${query} (müzik)`] : []),
              `${query} (music genre)`,
              `${query} (genre)`,
              `${query} (music)`,
              `${query} music`,
            ];
      for (const candidate of titles) {
        const wiki = await runSource(
          "wikipedia",
          `https://${wl}.wikipedia.org/api/rest_v1/page/summary/${wikiPath(candidate)}`,
        );
        if (wiki === undefined) break;
        const extract = text(wiki?.extract),
          evidence = `${text(wiki?.description)} ${extract}`;
        if (
          wiki?.type !== "standard" ||
          !extract ||
          (!title && (!music.test(evidence) || excluded.test(evidence)))
        )
          continue;
        startGrace();
        info.description = clip(extract);
        info.descLang = wl;
        info.descSource = "wikipedia";
        info.title = text(wiki.title) || info.title;
        info.descUrl = `https://${wl}.wikipedia.org/wiki/${wikiPath(text(wiki.title) || candidate)}`;
        info.attribution.push("Wikipedia · CC BY-SA 4.0");
        break;
      }
      if (info.description) break;
    }
    const [musicalyst, related] = await Promise.all([
      alternate,
      relatedLabels,
      otherArtists,
    ]);
    if (!info.description && musicalyst?.description) {
      info.description = clip(musicalyst.description);
      info.descLang = "en";
      info.descSource = "musicalyst";
      info.descUrl = musicalyst.url;
    }
    if (
      info.descSource === "musicalyst" ||
      info.playlistHint ||
      mirrorRelated.length ||
      (musicalyst &&
        info.artists.length &&
        !info.attribution.includes("MusicBrainz (CC0)"))
    )
      info.attribution.push("Musicalyst (EveryNoise)");
    if (!info.description && entityDescription) {
      info.description = clip(entityDescription);
      info.descLang = trShort ? "tr" : "en";
      info.descSource = "wikidata";
      info.descUrl = `https://www.wikidata.org/wiki/${info.wikidataId}`;
    }
    info.fallbackNote = !!info.description && info.descLang !== lang;
    if (trShort && info.description && info.descLang === "en") {
      info.description = `${clip(trShort)}\n${info.description}`;
      info.descLang = "tr";
    }
    const aliases = new Map(
      related
        .filter((item) => item.english)
        .map((item) => [foldedName(item.english), item]),
    );
    const chips = mirrorRelated.map(
      ({ name }) =>
        aliases.get(foldedName(name)) ?? {
          name: chipName(name),
          wikidataId: undefined,
        },
    );
    const seen = new Set([relatedKey(query)]);
    info.related = [...related, ...chips]
      .flatMap(({ name, wikidataId }) => {
        const key = relatedKey(name);
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ name, wikidataId }];
      })
      .slice(0, 12);
  } finally {
    clearTimeout(graceTimer);
  }
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (info.wikidataId) info.attribution.push("Wikidata (CC0)");
  // A usable EN result may have been clipped by the optional enrichment window.
  // Do not cache such a TR result: the next lookup could obtain a better TR source.
  if (
    !blocked &&
    !deadline.aborted &&
    (!grace.signal.aborted || (lang === "en" && info.description))
  ) {
    const lifetime =
      info.descSource === "wikidata" || grace.signal.aborted
        ? ttl.partial
        : info.description
          ? ttl.success
          : ttl.negative;
    try {
      store?.setItem(
        key,
        JSON.stringify({
          revision: cacheRevision(lang),
          until: now + lifetime,
          value: info,
        }),
      );
    } catch {}
  }
  return info;
}

export function resolveInfoLang(
  spotifyLocale: string,
  setting: "auto" | Lang,
): Lang {
  return resolveLang(setting, spotifyLocale);
}
