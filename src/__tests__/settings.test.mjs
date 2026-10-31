import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { utils as u } from "./_load.mjs";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (rel) => {
  const out = esbuild.buildSync({
    entryPoints: [path.join(here, rel)],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    target: "es2022",
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(out.outputFiles[0].text).toString("base64")
  );
};
const st = await load("../settings/store.ts");
const panel = await load("../settings/panel.ts");
const pkg = JSON.parse(
  (await import("node:fs")).readFileSync(
    path.join(here, "../../package.json"),
    "utf8",
  ),
);

const mem = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
};
const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  json: async () => body,
});
const track = {
  artist: "Radiohead",
  title: "Creep",
  album: "",
  durationMs: 238000,
};
beforeEach(() => u.resetLookupState());

test("settings: valid JSON round-trips", () => {
  const s = st.parseSettings(
    JSON.stringify({
      v: 1,
      sourceOrder: ["itunes", "discogs", "musicbrainz"],
      lang: "tr",
    }),
  );
  assert.deepEqual(s.sourceOrder, ["itunes", "discogs", "musicbrainz"]);
  assert.equal(s.lang, "tr");
});

test("settings: corrupt JSON / wrong types -> defaults, never throws, repaired in storage", () => {
  for (const raw of [
    null,
    "{nope",
    "[]",
    "42",
    '"x"',
    "null",
    '{"sourceOrder":5,"lang":7}',
  ])
    assert.deepEqual(st.parseSettings(raw), st.defaultSettings());
  const s = mem({ [st.SETTINGS_KEY]: "{garbage" });
  assert.deepEqual(st.loadSettings(s), st.defaultSettings());
  assert.deepEqual(JSON.parse(s.m.get(st.SETTINGS_KEY)), st.defaultSettings());
  assert.deepEqual(st.loadSettings(undefined), st.defaultSettings());
});

test("settings: invalid sourceOrder -> default; lang kept independently", () => {
  for (const bad of [
    ["itunes", "discogs"],
    ["itunes", "itunes", "discogs"],
    ["a", "b", "c"],
    "x",
  ]) {
    const s = st.parseSettings(
      JSON.stringify({ v: 1, sourceOrder: bad, lang: "en" }),
    );
    assert.deepEqual(s.sourceOrder, ["discogs", "musicbrainz", "itunes"]);
    assert.equal(s.lang, "en");
  }
  assert.equal(st.parseSettings('{"lang":"fr"}').lang, "auto");
});

test("lang: auto follows Spotify language, falls back to en; explicit wins", () => {
  assert.equal(st.resolveLang("auto", "tr-TR"), "tr");
  assert.equal(st.resolveLang("auto", "de"), "en");
  assert.equal(st.resolveLang("auto", undefined), "en");
  assert.equal(st.resolveLang("en", "tr"), "en");
  assert.equal(st.resolveLang("tr", "en-US"), "tr");
  assert.equal(st.tr("Try again", "tr"), "Tekrar dene");
  assert.equal(st.tr("Try again", "en"), "Try again");
  assert.equal(
    st.tr("Offline - last known genre (3 days ago)", "tr"),
    "Çevrimdışı - bilinen son tür (3 gün önce)",
  );
});

test("manual genre: set / get / remove, bad entries dropped", () => {
  const s = mem();
  assert.ok(st.setManualGenre(s, "spotify:track:1", " Shoegaze "));
  assert.equal(st.getManualGenre(s, "spotify:track:1"), "Shoegaze");
  assert.equal(st.setManualGenre(s, "spotify:track:1", "  "), false);
  assert.ok(st.removeManualGenre(s, "spotify:track:1"));
  assert.equal(st.getManualGenre(s, "spotify:track:1"), undefined);
  const bad = mem({ [st.MANUAL_KEY]: '{"a":"Rock","b":5,"c":""}' });
  assert.deepEqual({ ...st.loadManual(bad) }, { a: "Rock" });
  assert.equal(bad.m.get(st.MANUAL_KEY), '{"a":"Rock"}');
  assert.deepEqual({ ...st.loadManual(mem({ [st.MANUAL_KEY]: "{{" })) }, {});
});

test("manual wins over cache and network is never touched", async () => {
  const s = mem();
  st.setManualGenre(s, "spotify:track:1", "Trip Hop");
  let calls = 0;
  const out = await u.lookupGenres(
    { ...track, uri: "spotify:track:1" },
    { fetch: async () => (calls++, json({})), storage: s },
  );
  assert.equal(out.status, "ok");
  assert.deepEqual(out.result.genres, ["Trip Hop"]);
  assert.equal(out.result.source, "manual");
  assert.equal(calls, 0);
});

test("manual shown even when cache holds a different genre; cache does not overwrite manual", async () => {
  const s = mem();
  const fetchRock = async (url) =>
    String(url).includes("discogs")
      ? url.includes("/database/search")
        ? json({
            results: [
              {
                id: 1,
                title: "Radiohead - Creep",
                genre: ["Rock"],
                style: ["Grunge"],
                year: "1992",
              },
            ],
          })
        : json({})
      : json({ results: [] });
  await u.lookupGenres(track, { fetch: fetchRock, storage: s });
  const cacheKeysBefore = [...s.m.keys()].filter((k) =>
    k.startsWith("wtg:v2:"),
  );
  st.setManualGenre(s, "spotify:track:1", "Trip Hop");
  const out = await u.lookupGenres(
    { ...track, uri: "spotify:track:1" },
    { fetch: fetchRock, storage: s, force: true },
  );
  assert.deepEqual(out.result.genres, ["Trip Hop"]);
  assert.equal(
    JSON.parse(s.m.get(st.MANUAL_KEY))["spotify:track:1"],
    "Trip Hop",
  );
  assert.deepEqual(
    [...s.m.keys()].filter((k) => k.startsWith("wtg:v2:")),
    cacheKeysBefore,
  );
});

test("source order: ['itunes','discogs'] tries iTunes first (stubbed fetch)", async () => {
  const hosts = [];
  const fetch = async (url) => {
    hosts.push(new URL(url).hostname);
    return json({ results: [] });
  };
  await u.lookupGenres(track, {
    fetch,
    storage: mem(),
    sourceOrder: ["itunes", "discogs"],
    sleep: async () => {},
  });
  assert.equal(hosts[0], "itunes.apple.com");
  assert.ok(hosts.includes("api.discogs.com"));
  assert.ok(
    hosts.indexOf("itunes.apple.com") < hosts.indexOf("api.discogs.com"),
  );
  u.resetLookupState();
  const h2 = [];
  await u.lookupGenres(track, {
    fetch: async (url) => (
      h2.push(new URL(url).hostname),
      json({ results: [] })
    ),
    storage: mem(),
    sleep: async () => {},
  });
  assert.equal(h2[0], "api.discogs.com");
  assert.deepEqual(st.completeSourceOrder(["itunes", "x", "itunes"]), [
    "itunes",
    "discogs",
    "musicbrainz",
  ]);
});

test("reset to defaults restores settings only (manual untouched)", () => {
  const s = mem();
  st.saveSettings(s, {
    v: 1,
    sourceOrder: ["itunes", "discogs", "musicbrainz"],
    lang: "tr",
  });
  st.setManualGenre(s, "u", "X");
  assert.deepEqual(st.resetSettings(s), st.defaultSettings());
  assert.deepEqual(st.loadSettings(s), st.defaultSettings());
  assert.equal(st.getManualGenre(s, "u"), "X");
});

test("clear cache removes only wtg prefixes", () => {
  const s = mem({
    "wtg:v2:a": "1",
    "wtg:v2:idx": "{}",
    "hermesGenre:old": "1",
    [st.SETTINGS_KEY]: "{}",
    [st.MANUAL_KEY]: "{}",
    "other-extension:data": "keep",
    "lyrics-plus:x": "keep",
  });
  assert.equal(st.clearWtgCache(s), 3);
  assert.deepEqual(
    [...s.m.keys()].sort(),
    [
      st.MANUAL_KEY,
      st.SETTINGS_KEY,
      "lyrics-plus:x",
      "other-extension:data",
    ].sort(),
  );
});

test("panel: uses PopupModal.display, shows package.json version, survives missing APIs", () => {
  const hooks = { storage: () => mem(), refreshNow() {}, changed() {} };
  const g = globalThis;
  delete g.Spicetify;
  assert.doesNotThrow(() => panel.openPanel(hooks));
  assert.equal(panel.registerSettingsButton(hooks), false);
  g.Spicetify = {};
  assert.doesNotThrow(() => panel.openPanel(hooks));
  assert.equal(panel.registerSettingsButton(hooks), false);

  let shown;
  let click;
  const R = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (v) => [v, () => {}],
  };
  g.Spicetify = {
    React: R,
    PopupModal: { display: (o) => (shown = o) },
    Topbar: {
      Button: class {
        constructor(l, i, f) {
          this.args = [l, i];
          click = f;
        }
      },
    },
  };
  assert.equal(panel.registerSettingsButton(hooks), true);
  click();
  assert.ok(shown && shown.content);
  assert.equal(panel.PACKAGE_VERSION, pkg.version);
  // render the Panel component with the stub React and look for the version text
  const tree = shown.content;
  const rendered = tree.type(tree.props);
  assert.ok(JSON.stringify(rendered).includes(pkg.version));
  g.Spicetify = {
    PopupModal: {
      display() {
        throw new Error("boom");
      },
    },
    React: R,
  };
  assert.doesNotThrow(() => panel.openPanel(hooks));
  delete g.Spicetify;
});
