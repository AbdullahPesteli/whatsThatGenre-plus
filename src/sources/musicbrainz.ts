/** MusicBrainz WS/2 (CC0, keyless). Pure helpers; orchestration lives in utils.ts. */
export const MB_USER_AGENT =
  "WhatsThatGenre/2.1.0 ( https://github.com/AbdullahPesteli/whatsThatGenre-plus )";
export const MB_MIN_GENRE_COUNT = 2;
export const MB_MAX_GENRES = 3;
export const MB_MAX_RELEASE_LOOKUPS = 2;

const esc = (s: string) => s.replace(/(["\\])/g, "\\$1");

export function mbSearchUrl(title: string, artist: string): string {
  const q = `recording:"${esc(title)}" AND artist:"${esc(artist)}"`;
  return `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=25`;
}

export function mbReleaseUrl(mbid: string): string {
  return `https://musicbrainz.org/ws/2/release/${encodeURIComponent(mbid)}?inc=genres+release-groups&fmt=json`;
}

export type MbRecording = {
  id: string;
  title: string;
  score: number;
  length?: number;
  artists: string[];
  releases: { id: string; status?: string; title?: string }[];
};

/** null = schema violation (HTTP 200 but no usable `recordings` array). */
export function parseMbSearch(json: any): MbRecording[] | null {
  if (!json || !Array.isArray(json.recordings)) return null;
  const out: MbRecording[] = [];
  for (const r of json.recordings) {
    if (!r || typeof r.id !== "string" || typeof r.title !== "string") continue;
    out.push({
      id: r.id,
      title: r.title,
      score: Number(r.score) || 0,
      length: typeof r.length === "number" ? r.length : undefined,
      artists: Array.isArray(r["artist-credit"])
        ? r["artist-credit"]
            .map((a: any) => a?.name ?? a?.artist?.name)
            .filter((n: unknown): n is string => typeof n === "string")
        : [],
      releases: Array.isArray(r.releases)
        ? r.releases
            .filter((x: any) => x && typeof x.id === "string")
            .map((x: any) => ({
              id: x.id,
              status: x.status,
              title: typeof x.title === "string" ? x.title : undefined,
            }))
        : [],
    });
  }
  // non-empty list where nothing parsed = shape changed
  if (json.recordings.length > 0 && out.length === 0) return null;
  return out;
}

/**
 * Release lookup -> top genres. null = schema violation (no `genres` array).
 * Rule: count >= 2 only, highest count first, at most 3.
 */
export function parseMbGenres(json: any): string[] | null {
  if (!json || !Array.isArray(json.genres)) return null;
  const pick = (list: any[]): string[] =>
    list
      .filter(
        (g: any) =>
          g &&
          typeof g.name === "string" &&
          Number(g.count) >= MB_MIN_GENRE_COUNT,
      )
      .sort((a: any, b: any) => Number(b.count) - Number(a.count))
      .slice(0, MB_MAX_GENRES)
      .map((g: any) => g.name as string);
  const own = pick(json.genres);
  if (own.length) return own;
  // Most votes live on the release-group (inc=release-groups): same count>=2 rule.
  const rg = json["release-group"]?.genres;
  return Array.isArray(rg) ? pick(rg) : own;
}
