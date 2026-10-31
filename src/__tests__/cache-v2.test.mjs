import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { utils as u } from "./_load.mjs";

const mem = (limit = Infinity) => {
  const m = new Map();
  const size = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      const old = m.has(k) ? k.length + m.get(k).length : 0;
      if (size() - old + k.length + v.length > limit) {
        const e = new Error("quota");
        e.name = "QuotaExceededError";
        throw e;
      }
      m.set(k, v);
    },
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
const noSleep = async () => {};
const track = (artist = "Radiohead", title = "Creep") => ({
  artist,
  title,
  album: "",
  durationMs: 0,
});
const DAY = 86400000;
const T0 = 1_800_000_000_000;
const discogsHit = async () =>
  json({
    results: [
      {
        title: "Radiohead - Pablo Honey",
        genre: ["Rock"],
        style: ["Alt Rock"],
      },
    ],
  });
const empty = async () => json({ results: [], recordings: [] });
const counting = (impl) => {
  const f = async (...a) => {
    f.calls++;
    return impl(...a);
  };
  f.calls = 0;
  return f;
};
const base = (storage, fetch, extra = {}) => ({
  fetch,
  storage,
  sleep: noSleep,
  now: () => T0,
  isOnline: () => true,
  ...extra,
});
const rec = (over = {}) =>
  JSON.stringify({
    v: 2,
    kind: "genre",
    genres: ["Rock"],
    source: "Discogs",
    confidence: 0.9,
    cachedAt: T0,
    ttlMs: 7 * DAY,
    staleMaxMs: 90 * DAY,
    appVersion: u.EXTENSION_VERSION,
    ...over,
  });
const key = () => u.v2KeyFor(u.cacheKeyFor("Radiohead", "Creep"));

beforeEach(() => u.resetLookupState());

test("A1 fresh: 3-day-old Discogs 0.9 record -> 0 requests, state fresh", async () => {
  const s = mem();
  s.m.set(key(), rec({ cachedAt: T0 - 3 * DAY }));
  const f = counting(discogsHit);
  const r = await u.lookupGenres(track(), base(s, f));
  assert.equal(f.calls, 0);
  assert.equal(r.state, "fresh");
  assert.deepEqual(r.result.genres, ["Rock"]);
});

test("A2 stale: 40-day iTunes record -> shown at once, 1 background request, fresh after, cachedAt updated", async () => {
  const s = mem();
  s.m.set(
    key(),
    rec({
      source: "Apple Music",
      cachedAt: T0 - 40 * DAY,
      ttlMs: 30 * DAY,
      staleMaxMs: 180 * DAY,
      confidence: 0.96,
    }),
  );
  const f = counting(discogsHit);
  const r = await u.lookupGenres(track(), base(s, f));
  assert.equal(r.state, "refreshing");
  assert.deepEqual(r.result.genres, ["Rock"]);
  const done = await r.refresh;
  assert.equal(f.calls >= 1, true);
  assert.equal(done.state, "fresh");
  assert.equal(JSON.parse(s.m.get(key())).cachedAt, T0);
});

test("A3 offline: 10-day record + onLine=false -> no fetch, state offline, '10 days ago', record kept", async () => {
  const s = mem();
  s.m.set(key(), rec({ cachedAt: T0 - 10 * DAY }));
  const f = counting(discogsHit);
  const r = await u.lookupGenres(
    track(),
    base(s, f, { isOnline: () => false }),
  );
  assert.equal(f.calls, 0);
  assert.equal(r.state, "offline");
  assert.match(r.label, /10 days ago/);
  assert.ok(s.m.has(key()));
});

test("A3b last known genre shown even past staleMax when offline", async () => {
  const s = mem();
  s.m.set(key(), rec({ cachedAt: T0 - 400 * DAY }));
  const r = await u.lookupGenres(
    track(),
    base(s, counting(discogsHit), { isOnline: () => false }),
  );
  assert.equal(r.status, "ok");
  assert.match(r.label, /400 days ago/);
});

test("A3c onLine true + fetch TypeError -> network error, exponential backoff 2s/8s/30s", async () => {
  const s = mem();
  let now = T0;
  const f = counting(async () => {
    throw new TypeError("Failed to fetch");
  });
  const deps = () => base(s, f, { now: () => now });
  const r1 = await u.lookupGenres(track(), deps());
  assert.equal(r1.state, "offline");
  const c1 = f.calls;
  now += 1000; // inside 2s window -> no new fetch
  await u.lookupGenres(track(), deps());
  assert.equal(f.calls, c1);
  now += 1500; // past 2s
  await u.lookupGenres(track(), deps());
  assert.ok(f.calls > c1);
  const c2 = f.calls;
  now += 5000; // second window is 8s
  await u.lookupGenres(track(), deps());
  assert.equal(f.calls, c2);
  now += 4000;
  await u.lookupGenres(track(), deps());
  assert.ok(f.calls > c2);
  assert.equal(u.NETWORK_BACKOFF_MS.join(), "2000,8000,30000");
});

test("A4 not_found: both 200 empty -> missCount 1, 1h TTL; 30 min later no request; 'Search again' requests", async () => {
  const s = mem();
  const f = counting(empty);
  const r = await u.lookupGenres(track(), base(s, f));
  assert.equal(r.state, "not_found");
  const n = JSON.parse(s.m.get(key()));
  assert.equal(n.missCount, 1);
  assert.equal(n.ttlMs, 3600000);
  const calls = f.calls;
  const r2 = await u.lookupGenres(
    track(),
    base(s, f, { now: () => T0 + 30 * 60000 }),
  );
  assert.equal(f.calls, calls);
  assert.equal(r2.state, "not_found");
  await u.lookupGenres(
    track(),
    base(s, f, { now: () => T0 + 30 * 60000, force: true }),
  );
  assert.ok(f.calls > calls);
  assert.equal(JSON.parse(s.m.get(key())).missCount, 2);
  assert.equal(u.negativeTtlMs(1), 3600000);
  assert.equal(u.negativeTtlMs(2), 4 * 3600000);
  assert.equal(u.negativeTtlMs(3), 16 * 3600000);
  assert.equal(u.negativeTtlMs(4), 24 * 3600000);
});

test("A4b negative records are dropped when the extension version changes", async () => {
  const s = mem();
  await u.lookupGenres(
    track(),
    base(s, counting(empty), { appVersion: "1.0.0" }),
  );
  const f = counting(empty);
  await u.lookupGenres(track(), base(s, f, { appVersion: "2.0.0" }));
  assert.ok(f.calls > 0);
});

test("A5 HTTP 503 -> error, no negative record, good record kept, canRetry", async () => {
  const s = mem();
  const f = counting(async () => json({}, 503));
  const r = await u.lookupGenres(track(), base(s, f));
  assert.equal(r.state, "error");
  assert.equal(r.canRetry, true);
  assert.equal(s.m.has(key()), false);
  // with an expired-but-good record: kept and still shown
  s.m.set(key(), rec({ cachedAt: T0 - 10 * DAY }));
  const r2 = await u.lookupGenres(track(), base(s, f));
  const done = r2.refresh ? await r2.refresh : r2;
  assert.equal(done.state, "error");
  assert.equal(done.canRetry, true);
  assert.deepEqual(done.result.genres, ["Rock"]);
  const kept = JSON.parse(s.m.get(key()));
  assert.equal(kept.kind, "genre");
  assert.deepEqual(kept.genres, ["Rock"]);
  assert.equal(kept.cachedAt, T0 - 10 * DAY);
});

test("A6 full localStorage: quota error caught, oldest 20% evicted, one retry, result still returned", async () => {
  const s = mem(5_177_344);
  for (let i = 0; i < 400; i++)
    s.m.set(`wtg:v2:filler${i}`, "x".repeat(12_900));
  // seed the index so eviction knows ages
  s.m.set(
    u.CACHE_INDEX_KEY,
    JSON.stringify(
      Object.fromEntries(
        [...s.m.keys()]
          .filter((k) => k.includes("filler"))
          .map((k, i) => [k, { u: i, n: 0 }]),
      ),
    ),
  );
  const before = s.m.size;
  const r = await u.lookupGenres(track(), base(s, counting(discogsHit)));
  assert.equal(r.status, "ok");
  assert.ok(s.m.has(key()));
  assert.ok(s.m.size < before + 1);
  assert.equal(s.m.has("wtg:v2:filler0"), false); // oldest evicted
  // total failure: still no exception
  const bad = {
    getItem: () => null,
    setItem() {
      throw new Error("quota");
    },
    removeItem() {},
  };
  const r2 = await u.lookupGenres(
    track("A", "B"),
    base(bad, counting(discogsHit)),
  );
  assert.equal(r2.status, "ok");
});

test("MAX_ENTRIES: 2000 records max", async () => {
  const s = mem();
  for (let i = 0; i < u.MAX_ENTRIES; i++) s.m.set(`wtg:v2:k${i}`, rec());
  s.m.set(
    u.CACHE_INDEX_KEY,
    JSON.stringify(
      Object.fromEntries(
        [...Array(u.MAX_ENTRIES).keys()].map((i) => [
          `wtg:v2:k${i}`,
          { u: i, n: 0 },
        ]),
      ),
    ),
  );
  await u.lookupGenres(track(), base(s, counting(discogsHit)));
  const n = [...s.m.keys()].filter((k) => k !== u.CACHE_INDEX_KEY).length;
  assert.ok(n <= u.MAX_ENTRIES);
});

test("A7 migration: v1 key -> v2 (migrated, 24h TTL), v1 deleted, same genres", async () => {
  const s = mem();
  const v1 = u.cacheKeyFor("Radiohead", "Creep");
  s.m.set(v1, JSON.stringify({ genres: ["House"], confidence: 0.8 }));
  const f = counting(discogsHit);
  const r = await u.lookupGenres(track(), base(s, f));
  assert.deepEqual(r.result.genres, ["House"]);
  const m = JSON.parse(s.m.get(key()));
  assert.equal(m.migrated, true);
  assert.equal(m.ttlMs, DAY);
  assert.equal(s.m.has(v1), false);
  assert.equal(f.calls, 0);
});

test("A8 in-flight dedupe: 5 concurrent lookups -> a single request chain", async () => {
  const s = mem();
  const f = counting(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return json({
      results: [
        { title: "Radiohead - Pablo Honey", genre: ["Rock"], style: [] },
      ],
    });
  });
  const single = counting(f);
  const rs = await Promise.all(
    [1, 2, 3, 4, 5].map(() => u.lookupGenres(track(), base(s, single))),
  );
  assert.ok(rs.every((r) => r.status === "ok"));
  // a lone lookup issues N discogs requests (<=3); five must issue the same N, not 5N
  u.resetLookupState();
  const s2 = mem();
  const g = counting(f);
  await u.lookupGenres(track(), base(s2, g));
  assert.equal(single.calls, g.calls);
});

test("TTL tiers and ttlMs stored on record", async () => {
  assert.deepEqual(u.ttlFor("Discogs", 0.9), {
    ttlMs: 7 * DAY,
    staleMaxMs: 90 * DAY,
  });
  assert.deepEqual(u.ttlFor("Discogs", 0.6), {
    ttlMs: DAY,
    staleMaxMs: 30 * DAY,
  });
  assert.deepEqual(u.ttlFor("Apple Music", 0.95), {
    ttlMs: 30 * DAY,
    staleMaxMs: 180 * DAY,
  });
  assert.deepEqual(u.ttlFor("MusicBrainz", 1), {
    ttlMs: 90 * DAY,
    staleMaxMs: 365 * DAY,
  });
  assert.deepEqual(u.ttlFor("Wikidata", 1), {
    ttlMs: 90 * DAY,
    staleMaxMs: 365 * DAY,
  });
  const s = mem();
  await u.lookupGenres(track(), base(s, counting(discogsHit)));
  assert.ok(JSON.parse(s.m.get(key())).ttlMs > 0);
});

test("index is written debounced under wtg:v2:idx; v1 prefix never written", async () => {
  const s = mem();
  await u.lookupGenres(track(), base(s, counting(discogsHit)));
  assert.equal(s.m.has(u.CACHE_INDEX_KEY), false);
  await new Promise((r) => setTimeout(r, u.INDEX_DEBOUNCE_MS + 100));
  assert.ok(JSON.parse(s.m.get(u.CACHE_INDEX_KEY))[key()]);
  assert.ok(
    [...s.m.keys()].every(
      (k) => k.startsWith("wtg:v2:") || k === "wtg:health:v1",
    ),
  );
});

test("future schema (v>2) record is neither read nor deleted", async () => {
  const s = mem();
  s.m.set(key(), JSON.stringify({ v: 3, genres: ["X"] }));
  const r = await u.lookupGenres(track(), base(s, counting(discogsHit)));
  assert.equal(r.status, "ok");
});

test("no Turkish user-facing text in the repo", () => {
  const dir = new URL("..", import.meta.url).pathname;
  const files = ["utils.ts", "app.tsx"];
  const tr = /[çğıöşüÇĞİÖŞÜ]|Güncelleniyor|Çevrimdışı|bulunamadı/;
  for (const f of files)
    assert.doesNotMatch(readFileSync(dir + f, "utf8"), tr, f);
});
