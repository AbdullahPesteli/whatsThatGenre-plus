import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { utils as u } from "./_load.mjs";

const mem = () => {
  const m = new Map();
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};
const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  json: async () => body,
});
const noSleep = async () => {};
const track = (artist = "Radiohead", title = "Creep") => ({
  artist,
  title,
  album: "",
  durationMs: 238000,
});
const T0 = 1_800_000_000_000;
beforeEach(() => u.resetLookupState());

const discogsEmpty = () => json({ results: [] });
const mbSearch = () =>
  json({
    recordings: [
      {
        id: "r1",
        score: 100,
        title: "Creep",
        length: 238000,
        "artist-credit": [{ name: "Radiohead" }],
        releases: [{ id: "rel1", status: "Official" }],
      },
    ],
  });
const mbRelease = (
  genres = [
    { name: "rock", count: 5 },
    { name: "alternative rock", count: 3 },
    { name: "grunge", count: 1 },
    { name: "britpop", count: 2 },
    { name: "pop", count: 2 },
    { name: "jazz", count: 4 },
  ],
) => json({ id: "rel1", title: "Pablo Honey", genres });
const itunesHit = () =>
  json({
    results: [
      {
        trackName: "Creep",
        artistName: "Radiohead",
        collectionName: "Pablo Honey",
        primaryGenreName: "Alternative",
        trackTimeMillis: 238000,
      },
    ],
  });
const router = (o) => {
  const calls = [];
  const f = async (url, init) => {
    const host = url.includes("discogs")
      ? "discogs"
      : url.includes("musicbrainz")
        ? url.includes("/recording")
          ? "mbsearch"
          : "mbrelease"
        : "itunes";
    calls.push({ host, url, init });
    return o[host](url, init);
  };
  f.calls = calls;
  return f;
};
const deps = (fetch, storage = mem(), extra = {}) => ({
  fetch,
  storage,
  sleep: noSleep,
  isOnline: () => true,
  ...extra,
});

test("MB parse: count>=2 only, sorted by count desc, top 3", () => {
  const g = u.parseMbGenres(mbReleaseBody());
  assert.deepEqual(g, ["rock", "jazz", "alternative rock"]);
});
function mbReleaseBody() {
  return {
    genres: [
      { name: "rock", count: 5 },
      { name: "alternative rock", count: 3 },
      { name: "grunge", count: 1 },
      { name: "britpop", count: 2 },
      { name: "pop", count: 2 },
      { name: "jazz", count: 4 },
    ],
  };
}

test("MB parse: all count<2 -> empty list (not a schema error); missing genres -> null", () => {
  assert.deepEqual(u.parseMbGenres({ genres: [{ name: "x", count: 1 }] }), []);
  assert.equal(u.parseMbGenres({ title: "x" }), null);
  assert.equal(u.parseMbSearch({ nope: 1 }), null);
});

test("stub: Discogs empty + MusicBrainz filled -> genres from MusicBrainz, label 'MusicBrainz'", async () => {
  const f = router({
    discogs: discogsEmpty,
    mbsearch: mbSearch,
    mbrelease: () => mbRelease(),
    itunes: itunesHit,
  });
  const r = await u.lookupGenres(track(), deps(f));
  assert.equal(r.status, "ok");
  assert.equal(r.result.source, "MusicBrainz");
  assert.deepEqual(r.result.genres, ["rock", "jazz", "alternative rock"]);
  assert.equal(u.sourceBadge(r.result).text, "MusicBrainz");
  assert.ok(!f.calls.some((c) => c.host === "itunes"));
  // chain order: discogs before musicbrainz
  const order = f.calls.map((c) => c.host);
  assert.ok(order.lastIndexOf("discogs") < order.indexOf("mbsearch"));
});

test("MB requests carry User-Agent with contact info", async () => {
  const f = router({
    discogs: discogsEmpty,
    mbsearch: mbSearch,
    mbrelease: () => mbRelease(),
    itunes: itunesHit,
  });
  await u.lookupGenres(track(), deps(f));
  const mb = f.calls.filter((c) => c.host.startsWith("mb"));
  assert.ok(mb.length >= 2);
  for (const c of mb) {
    const ua = c.init.headers["User-Agent"];
    assert.match(
      ua,
      /^WhatsThatGenre\/2\.1\.0 \( https:\/\/github\.com\/AbdullahPesteli\/whatsThatGenre-plus \)$/,
    );
  }
});

test("MB 403 (no/blocked UA) -> counted as failure, falls through to iTunes", async () => {
  const f = router({
    discogs: discogsEmpty,
    mbsearch: () => json({}, 403),
    mbrelease: () => mbRelease(),
    itunes: itunesHit,
  });
  const st = mem();
  const r = await u.lookupGenres(track(), deps(f, st));
  assert.equal(r.status, "ok");
  assert.equal(r.result.source, "Apple Music");
  assert.equal(u.sourceBadge(r.result).text, "iTunes");
});

test("MB 429 x4 -> breaker opens, iTunes answers, user sees genres not an error", async () => {
  const st = mem();
  const f = router({
    discogs: discogsEmpty,
    mbsearch: () => json({}, 429),
    mbrelease: () => mbRelease(),
    itunes: itunesHit,
  });
  let t = T0;
  let last;
  for (let i = 0; i < 4; i++) {
    // each lookup = 2 attempts on MB (1 retry), distinct tracks to dodge cache
    last = await u.lookupGenres(
      track(),
      deps(f, st, { force: true, now: () => (t += 1000) }),
    );
    assert.equal(last.status, "ok");
    assert.equal(last.result.source, "Apple Music");
  }
  const h = JSON.parse(st.getItem("wtg:health:v1"));
  assert.equal(h.s.MusicBrainz.r.filter((x) => x[0] === "http429").length, 4);
  assert.equal(u.sourceStatus(st, "MusicBrainz"), "throttled");
  assert.ok(h.s.MusicBrainz.b, "breaker open");
  const before = f.calls.filter((c) => c.host.startsWith("mb")).length;
  await u.lookupGenres(
    track(),
    deps(f, st, { force: true, now: () => (t += 1000) }),
  );
  assert.equal(
    f.calls.filter((c) => c.host.startsWith("mb")).length,
    before,
    "MB skipped while open",
  );
});

test("MB 200 without genres field -> schema error, never written to negative cache", async () => {
  const st = mem();
  const f = router({
    discogs: discogsEmpty,
    mbsearch: mbSearch,
    mbrelease: () => json({ id: "rel1", title: "x" }),
    itunes: () => json({ results: [] }),
  });
  const r = await u.lookupGenres(track(), deps(f, st));
  assert.notEqual(r.status, "not_found");
  assert.equal(r.status, "error");
  const keys = [...st.m.keys()].filter(
    (k) => k !== "wtg:health:v1" && k !== "wtg:v2:idx",
  );
  assert.equal(keys.length, 0, "no neg record: " + keys);
  const h = JSON.parse(st.getItem("wtg:health:v1"));
  assert.ok(h.s.MusicBrainz.r.some((x) => x[0] === "schema"));
});

test("schema class: 8 of last 10 HTTP-200 lacking fields -> 'schema'; 7 -> healthy", () => {
  const mk = (n, c) => Array.from({ length: n }, () => [c, 1]);
  assert.equal(
    u.evaluateHealth([...mk(2, "ok"), ...mk(8, "schema")]),
    "schema",
  );
  assert.equal(
    u.evaluateHealth([...mk(3, "ok"), ...mk(7, "schema")]),
    "healthy",
  );
});

test("thresholds: transport >=10/20 (network+5xx), throttled >=4/20 429s", () => {
  const mk = (n, c) => Array.from({ length: n }, () => [c, 1]);
  assert.equal(
    u.evaluateHealth([...mk(10, "ok"), ...mk(10, "network")]),
    "transport",
  );
  assert.equal(
    u.evaluateHealth([
      ...mk(11, "ok"),
      ...mk(5, "network"),
      ...mk(4, "http5xx"),
    ]),
    "healthy",
  );
  assert.equal(
    u.evaluateHealth([...mk(16, "ok"), ...mk(4, "http429")]),
    "throttled",
  );
  assert.equal(
    u.evaluateHealth([...mk(17, "ok"), ...mk(3, "http429")]),
    "healthy",
  );
});

test("breaker backoff 5 -> 15 -> 60 min, recovery after 4 of last 5 ok", () => {
  const st = mem();
  let t = T0;
  const MIN = 60000;
  for (let i = 0; i < 4; i++) u.recordHealth(st, "MusicBrainz", "http429", t++);
  assert.equal(u.getBreaker(st, "MusicBrainz").level, 1);
  assert.equal(u.getBreaker(st, "MusicBrainz").until - (t - 1), 5 * MIN);
  assert.equal(u.sourceAllowed(st, "MusicBrainz", t + 4 * MIN), false);
  assert.equal(u.sourceAllowed(st, "MusicBrainz", t + 5 * MIN), true); // half-open
  t += 6 * MIN;
  u.recordHealth(st, "MusicBrainz", "http429", t); // trial fails
  assert.equal(u.getBreaker(st, "MusicBrainz").level, 2);
  assert.equal(u.getBreaker(st, "MusicBrainz").until - t, 15 * MIN);
  t += 16 * MIN;
  u.recordHealth(st, "MusicBrainz", "network", t);
  assert.equal(u.getBreaker(st, "MusicBrainz").level, 3);
  assert.equal(u.getBreaker(st, "MusicBrainz").until - t, 60 * MIN);
  t += 61 * MIN;
  u.recordHealth(st, "MusicBrainz", "network", t);
  assert.equal(u.getBreaker(st, "MusicBrainz").level, 3, "capped at 60");
  // recovery: 4 of last 5 successful
  t += 61 * MIN;
  for (let i = 0; i < 3; i++) {
    u.recordHealth(st, "MusicBrainz", "ok", t++);
    assert.ok(
      u.getBreaker(st, "MusicBrainz"),
      "still open after " + (i + 1) + " ok",
    );
  }
  u.recordHealth(st, "MusicBrainz", "ok", t++);
  // last 5 = network, ok, ok, ok, ok -> 4/5
  assert.equal(u.getBreaker(st, "MusicBrainz"), undefined);
});

test("rate budget: MusicBrainz >=1s apart, Discogs >=2.5s apart and <=20/min; queued not dropped", () => {
  const mb = [0, 1, 2].map(() => u.reserveSlot("MusicBrainz", T0));
  assert.deepEqual(mb, [0, 1000, 2000]);
  const d = Array.from({ length: 22 }, () => u.reserveSlot("Discogs", T0));
  for (let i = 1; i < 22; i++) assert.ok(d[i] - d[i - 1] >= 2500);
  // 21st call must wait for the 1st to leave the 60s window
  assert.ok(d[20] >= 60_000);
  assert.equal(d.length, 22); // all granted a slot (queued)
  // per-minute count: slots within any 60s window <= 20
  for (let i = 0; i + 20 < 22; i++) assert.ok(d[i + 20] - d[i] >= 60_000);
});

test("budget actually delays via sleep() (MB search -> release >= 1000 ms apart)", async () => {
  const slept = [];
  let clock = T0;
  const f = router({
    discogs: discogsEmpty,
    mbsearch: mbSearch,
    mbrelease: () => mbRelease(),
    itunes: itunesHit,
  });
  await u.lookupGenres(
    track(),
    deps(f, mem(), {
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    }),
  );
  assert.ok(
    slept.some((ms) => ms >= 1000),
    JSON.stringify(slept),
  );
});

test("source label + '~' on low confidence", () => {
  assert.equal(
    u.sourceBadge({ source: "Discogs", confidence: 1 }).text,
    "Discogs",
  );
  assert.equal(
    u.sourceBadge({ source: "MusicBrainz", confidence: 0.95 }).text,
    "MusicBrainz",
  );
  assert.equal(
    u.sourceBadge({ source: "Apple Music", confidence: 1 }).text,
    "iTunes",
  );
  assert.equal(
    u.sourceBadge({ source: "Discogs", confidence: 0.5 }).text,
    "~Discogs",
  );
  assert.equal(
    u.sourceBadge({ source: "MusicBrainz", confidence: 0.9 }).text,
    "~MusicBrainz",
  );
});

test("health record holds no artist/title/album/url", async () => {
  const st = mem();
  const f = router({
    discogs: discogsEmpty,
    mbsearch: mbSearch,
    mbrelease: () => mbRelease(),
    itunes: itunesHit,
  });
  await u.lookupGenres(
    track("Zzyzx Unique Artist", "Qwxv Secret Title"),
    deps(f, st),
  );
  const raw = st.getItem("wtg:health:v1");
  assert.ok(raw);
  for (const needle of [
    "zzyzx",
    "qwxv",
    "secret",
    "http",
    "unique",
    "musicbrainz.org/",
  ])
    assert.ok(!raw.toLowerCase().includes(needle), needle);
  const h = JSON.parse(raw);
  assert.deepEqual(Object.keys(h).sort(), ["s", "v"]);
});

test("canary: at most once per day, fixed 2 queries, result in health", async () => {
  const st = mem();
  const f = router({
    discogs: () =>
      json({
        results: [
          {
            title: "Radiohead - OK Computer",
            genre: ["Rock"],
            style: ["Alt Rock"],
          },
        ],
      }),
    mbsearch: mbSearch,
    mbrelease: () => mbRelease(),
    itunes: itunesHit,
  });
  const r1 = await u.runCanary(deps(f, st, { now: () => T0 }));
  assert.deepEqual(r1, { Discogs: "ok", MusicBrainz: "ok" });
  assert.equal(f.calls.length, 2);
  const r2 = await u.runCanary(deps(f, st, { now: () => T0 + 3600_000 }));
  assert.equal(r2, null);
  assert.equal(f.calls.length, 2);
  const h = JSON.parse(st.getItem("wtg:health:v1"));
  assert.equal(h.s.Discogs.r.length, 1);
  // next day, MB shape broken -> schema
  const f2 = router({
    discogs: f.calls.length ? () => json({ results: [] }) : null,
    mbrelease: () => json({ nothing: true }),
  });
  const r3 = await u.runCanary(deps(f2, st, { now: () => T0 + 25 * 3600_000 }));
  assert.equal(r3.MusicBrainz, "schema");
});

test("MB parse: release genres empty -> falls back to release-group genres, same count>=2 rule", () => {
  const g = u.parseMbGenres({
    genres: [],
    "release-group": {
      genres: [
        { name: "pop", count: 1 },
        { name: "britpop", count: 7 },
        { name: "alternative rock", count: 16 },
      ],
    },
  });
  assert.deepEqual(g, ["alternative rock", "britpop"]);
});

test("MB release order: album-title match is looked up first", async () => {
  const f = router({
    discogs: discogsEmpty,
    mbsearch: () =>
      json({
        recordings: [
          {
            id: "r1",
            score: 100,
            title: "Creep",
            length: 238000,
            "artist-credit": [{ name: "Radiohead" }],
            releases: [
              { id: "other", status: "Official", title: "The Best Of" },
              { id: "pablo", status: "Official", title: "Pablo Honey" },
            ],
          },
        ],
      }),
    mbrelease: () => mbRelease(),
    itunes: itunesHit,
  });
  const r = await u.lookupGenres({ ...track(), album: "Pablo Honey" }, deps(f));
  assert.equal(r.result.source, "MusicBrainz");
  assert.equal(r.result.confidence, 1);
  assert.ok(
    f.calls.find((c) => c.host === "mbrelease").url.includes("/pablo?"),
  );
});
