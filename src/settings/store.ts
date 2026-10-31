/**
 * Settings + manual genre storage. Pure logic (no Spicetify, no React) so it
 * runs under plain node tests. Every reader repairs bad data silently and
 * falls back to defaults; nothing here throws.
 */

export const SETTINGS_KEY = "whatsthatgenre:settings";
export const MANUAL_KEY = "whatsthatgenre:manual";
/** Only keys with these prefixes are touched by "clear cache". */
export const WTG_CACHE_PREFIXES = ["wtg:", "hermesGenre:"];

export const SOURCE_IDS = ["discogs", "musicbrainz", "itunes"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];
export type Lang = "en" | "tr";
export type LangSetting = "auto" | Lang;

export type Settings = {
  v: 1;
  sourceOrder: SourceId[];
  lang: LangSetting;
};

export type KV = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  key?(index: number): string | null;
  readonly length?: number;
};

export const defaultSettings = (): Settings => ({
  v: 1,
  sourceOrder: [...SOURCE_IDS],
  lang: "auto",
});

const isSourceId = (x: unknown): x is SourceId =>
  typeof x === "string" && (SOURCE_IDS as readonly string[]).includes(x);

/** Strict: must be a permutation of the three sources, else null. */
export function validSourceOrder(x: unknown): SourceId[] | null {
  if (!Array.isArray(x) || x.length !== SOURCE_IDS.length) return null;
  if (!x.every(isSourceId) || new Set(x).size !== SOURCE_IDS.length)
    return null;
  return [...x] as SourceId[];
}

/** Lenient (lookup): keep valid unique ids in order, append the missing ones. */
export function completeSourceOrder(x: unknown): SourceId[] {
  const out: SourceId[] = [];
  if (Array.isArray(x))
    for (const s of x) if (isSourceId(s) && !out.includes(s)) out.push(s);
  for (const s of SOURCE_IDS) if (!out.includes(s)) out.push(s);
  return out;
}

/** Any input -> a valid Settings object. Bad fields fall back individually. */
export function normalizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  const order = validSourceOrder(r.sourceOrder);
  const lang =
    r.lang === "auto" || r.lang === "tr" || r.lang === "en" ? r.lang : d.lang;
  return { v: 1, sourceOrder: order ?? d.sourceOrder, lang };
}

export function parseSettings(raw: string | null | undefined): Settings {
  if (!raw) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

/** Read settings; if the stored value was damaged, rewrite it repaired. */
export function loadSettings(storage: KV | undefined): Settings {
  if (!storage) return defaultSettings();
  let raw: string | null = null;
  try {
    raw = storage.getItem(SETTINGS_KEY);
  } catch {
    return defaultSettings();
  }
  const s = parseSettings(raw);
  if (raw !== null && raw !== JSON.stringify(s)) saveSettings(storage, s);
  return s;
}

export function saveSettings(storage: KV | undefined, s: Settings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(s)));
    return true;
  } catch {
    return false;
  }
}

export function resetSettings(storage: KV | undefined): Settings {
  const d = defaultSettings();
  saveSettings(storage, d);
  return d;
}

/* ---------------- manual genres ---------------- */

export type ManualMap = Record<string, string>;

export function parseManual(raw: string | null | undefined): ManualMap {
  const out: ManualMap = Object.create(null);
  if (!raw) return out;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object" || Array.isArray(p)) return out;
    for (const [k, v] of Object.entries(p))
      if (typeof v === "string" && v.trim() && k) out[k] = v.trim();
  } catch {}
  return out;
}

export function loadManual(storage: KV | undefined): ManualMap {
  if (!storage) return Object.create(null);
  let raw: string | null = null;
  try {
    raw = storage.getItem(MANUAL_KEY);
  } catch {
    return Object.create(null);
  }
  const m = parseManual(raw);
  if (raw !== null && raw !== JSON.stringify(m)) writeManual(storage, m);
  return m;
}

function writeManual(storage: KV, m: ManualMap) {
  try {
    storage.setItem(MANUAL_KEY, JSON.stringify(m));
  } catch {}
}

export function getManualGenre(
  storage: KV | undefined,
  uri: string | undefined,
): string | undefined {
  if (!uri) return undefined;
  return loadManual(storage)[uri];
}

export function setManualGenre(
  storage: KV | undefined,
  uri: string,
  genre: string,
): boolean {
  const g = (genre ?? "").trim();
  if (!storage || !uri || !g) return false;
  const m = loadManual(storage);
  m[uri] = g;
  writeManual(storage, m);
  return true;
}

export function removeManualGenre(
  storage: KV | undefined,
  uri: string,
): boolean {
  if (!storage || !uri) return false;
  const m = loadManual(storage);
  if (!(uri in m)) return false;
  delete m[uri];
  writeManual(storage, m);
  return true;
}

/* ---------------- cache clear ---------------- */

/** Remove only wtg-prefixed cache keys. Never touches other keys and never calls storage.clear(). */
export function clearWtgCache(storage: KV | undefined): number {
  if (!storage) return 0;
  const doomed: string[] = [];
  try {
    const len = storage.length ?? 0;
    for (let i = 0; i < len; i++) {
      const k = storage.key?.(i);
      if (k && WTG_CACHE_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem?.(k);
  } catch {}
  return doomed.length;
}

/* ---------------- language ---------------- */

export function resolveLang(
  setting: LangSetting,
  spotifyLocale?: string | null,
): Lang {
  if (setting === "tr" || setting === "en") return setting;
  const l = String(spotifyLocale ?? "").toLowerCase();
  return l.startsWith("tr") ? "tr" : "en";
}

/** Spotify UI language, best effort. */
export function spotifyLocale(): string {
  try {
    const S = (globalThis as any).Spicetify;
    const loc = S?.Locale?.getLocale?.();
    if (typeof loc === "string" && loc) return loc;
  } catch {}
  try {
    return (
      (globalThis as any).document?.documentElement?.lang ||
      (globalThis as any).navigator?.language ||
      ""
    );
  } catch {
    return "";
  }
}

export function currentLang(storage: KV | undefined): Lang {
  return resolveLang(loadSettings(storage).lang, spotifyLocale());
}

/* Existing EN strings stay as the source of truth; TR is looked up by EN text. */
const TR: Record<string, string> = {
  "Looking for genre...": "Tür aranıyor...",
  "Genre not found": "Tür bulunamadı",
  "Couldn't reach Discogs/Apple Music - check your connection":
    "Discogs/Apple Music'e ulaşılamadı - bağlantını kontrol et",
  "Updating...": "Güncelleniyor...",
  "You're offline, no saved genre for this track":
    "Çevrimdışısın, bu parça için kayıtlı tür yok",
  "Couldn't get the genre right now": "Tür şu an alınamadı",
  "Update failed": "Güncelleme başarısız",
  "Try again": "Tekrar dene",
  "Search again": "Tekrar ara",
};

/** Translate a user-visible message (EN in, EN/TR out). */
export function tr(text: string, lang: Lang): string {
  if (lang !== "tr") return text;
  if (TR[text]) return TR[text];
  const m = /^Offline - last known genre \((\d+) days? ago\)$/.exec(text);
  if (m) return `Çevrimdışı - bilinen son tür (${m[1]} gün önce)`;
  return text;
}

type PanelKey =
  | "title"
  | "version"
  | "secSource"
  | "descSource"
  | "secLang"
  | "descLang"
  | "secTrack"
  | "descTrack"
  | "langAuto"
  | "manualPlaceholder"
  | "save"
  | "noTrack"
  | "refreshNow"
  | "descRefresh"
  | "clearCache"
  | "descClear"
  | "confirm"
  | "source_discogs"
  | "source_musicbrainz"
  | "source_itunes"
  | "sourceFirst";

const PANEL: Record<Lang, Record<PanelKey, string>> = {
  en: {
    title: "What's That Genre? Plus",
    version: "Version",
    secSource: "Where to look for the genre?",
    descSource:
      "The first place we ask; the others are used if it has no answer.",
    secLang: "Language",
    descLang: "Language of this panel and the notes under the genre.",
    secTrack: "This track",
    descTrack:
      "Type your own genre for the song playing now. Leave empty to remove it.",
    langAuto: "Same as Spotify",
    manualPlaceholder: "e.g. Post-Rock",
    save: "Save",
    noTrack: "No track playing",
    refreshNow: "Refresh",
    descRefresh: "Look up the genre of the current song again.",
    clearCache: "Clear cache",
    descClear: "Forget every genre found so far. Your own genres are kept.",
    confirm: "Click again to confirm",
    source_discogs: "Discogs",
    source_musicbrainz: "MusicBrainz",
    source_itunes: "iTunes",
    sourceFirst: "First source",
  },
  tr: {
    title: "What's That Genre? Plus",
    version: "Sürüm",
    secSource: "Türü nereden arasın?",
    descSource: "Önce burada aranır; cevap yoksa diğerlerine bakılır.",
    secLang: "Dil",
    descLang: "Bu panelin ve türün altındaki notların dili.",
    secTrack: "Bu parça",
    descTrack: "Çalan şarkı için kendi türünü yaz. Boş bırakırsan silinir.",
    langAuto: "Spotify ile aynı",
    manualPlaceholder: "örn. Post-Rock",
    save: "Kaydet",
    noTrack: "Çalan parça yok",
    refreshNow: "Yenile",
    descRefresh: "Çalan şarkının türünü yeniden ara.",
    clearCache: "Önbelleği temizle",
    descClear: "Bulunan tüm türler unutulur. Kendi yazdıkların kalır.",
    confirm: "Onaylamak için tekrar tıkla",
    source_discogs: "Discogs",
    source_musicbrainz: "MusicBrainz",
    source_itunes: "iTunes",
    sourceFirst: "İlk kaynak",
  },
};

export function panelText(lang: Lang, key: PanelKey): string {
  return PANEL[lang][key];
}
export type { PanelKey };
