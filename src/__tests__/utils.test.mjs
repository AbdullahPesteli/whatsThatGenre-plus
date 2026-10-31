import test from "node:test";
import assert from "node:assert/strict";
import { utils as u } from "./_load.mjs";

const mem = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }; };
const json = (body, status = 200, headers = {}) => ({ ok: status < 400, status, headers: { get: (n) => headers[n] ?? null }, json: async () => body });
const noSleep = async () => {};
const track = (artist, title, extra = {}) => ({ artist, title, album: "", durationMs: 0, ...extra });

// ---- B1 / acceptance 3
test("cache keys: Cyrillic, CJK, Turkish -> 3 distinct non-empty keys", () => {
	const keys = [
		u.cacheKeyFor("Кино", "Группа крови"),
		u.cacheKeyFor("坂本龍一", "async"),
		u.cacheKeyFor("Tarkan", "Karma"),
	];
	assert.ok(keys.every((k) => k && k !== "hermesGenre:|"));
	assert.equal(new Set(keys).size, 3);
});
test("cache key empty when nothing survives normalisation; nothing written", async () => {
	assert.equal(u.cacheKeyFor("!!!", "???"), "");
	const s = mem();
	const f = async (url) => json({ results: [{ title: "x - y", genre: ["Rock"], style: ["Punk"] }] });
	await u.lookupGenres(track("!!!", "???"), { fetch: f, storage: s, sleep: noSleep });
	assert.equal(s.m.size, 0);
});
test("normalizeText: NFKD folds accents, keeps letters/digits of any script", () => {
	assert.equal(u.normalizeText("Beyoncé & Jay-Z"), "beyonce and jay z");
	assert.equal(u.normalizeText("Ёлка"), "елка");
});

// ---- B2 / acceptance 4
const apple = (artistName, trackName, extra = {}) => ({ artistName, trackName, primaryGenreName: "Rock", collectionName: "", ...extra });
test("tribute/cover/karaoke are not accepted", () => {
	const cases = [
		[track("Radiohead", "Creep"), apple("Radiohead Tribute Band", "Creep")],
		[track("Queen", "Bohemian Rhapsody"), apple("Queen Tribute", "Bohemian Rhapsody")],
		[track("Adele", "Hello"), apple("Adele Experience", "Hello")],
		[track("Adele", "Hello"), apple("Adele", "Hello (Karaoke Version)")],
		[track("Adele", "Hello"), apple("Adele", "Hello (In the Style of Adele)")],
		[track("Adele", "Hello"), apple("Adele", "Hello", { collectionName: "Hits Cover Versions" })],
	];
	for (const [t, c] of cases) assert.equal(u.evaluateAppleCandidate(t, c).accept, false, JSON.stringify(c));
});
test("genuine match is still accepted", () => {
	assert.equal(u.evaluateAppleCandidate(track("Radiohead", "Creep"), apple("Radiohead", "Creep")).accept, true);
});
test("tribute band end-to-end: not shown, not cached", async () => {
	const s = mem();
	const f = async (url) => url.includes("itunes")
		? json({ results: [apple("Radiohead Tribute Band", "Creep")] })
		: json({ results: [] });
	const r = await u.lookupGenres(track("Radiohead", "Creep"), { fetch: f, storage: s, sleep: noSleep });
	assert.equal(r.status, "not_found");
	assert.equal(s.m.size, 0);
});
test("low-confidence result is returned but never cached; high-confidence is cached", async () => {
	const s = mem();
	const low = async (url) => json({ results: [{ title: "Someone Else - Album", genre: ["Pop"], style: [] }] });
	const r = await u.lookupGenres(track("Radiohead", "Creep"), { fetch: low, storage: s, sleep: noSleep });
	assert.equal(r.status, "ok");
	assert.equal(s.m.size, 0);
	const hi = async (url) => json({ results: [{ title: "Radiohead - Pablo Honey", genre: ["Rock"], style: ["Alt Rock"] }] });
	await u.lookupGenres(track("Radiohead", "Creep"), { fetch: hi, storage: s, sleep: noSleep });
	assert.equal(s.m.size, 1);
});

// ---- B3: threshold pinned
test("whole-word title comparison; threshold pinned", () => {
	assert.equal(u.TITLE_MIN_SIMILARITY, 0.92);
	assert.equal(u.wordSimilarity("bohemian rhapsody", "bohemian rhapsodyx"), 0.5);
	assert.equal(u.evaluateAppleCandidate(track("Queen", "Bohemian Rhapsody"), apple("Queen", "Bohemian RhapsodyX")).accept, false);
	assert.equal(u.evaluateAppleCandidate(track("Queen", "Bohemian Rhapsody"), apple("Queen", "Bohemian Rhapsody")).accept, true);
});

// ---- B4
test("missing duration is neutral (exact title+artist still accepted); mismatching duration rejected", () => {
	const q = track("Queen", "Bohemian Rhapsody");
	assert.equal(u.evaluateAppleCandidate(q, apple("Queen", "Bohemian Rhapsody")).accept, true);
	assert.equal(u.evaluateAppleCandidate({ ...q, durationMs: 354000 }, apple("Queen", "Bohemian Rhapsody")).accept, true);
	assert.equal(u.evaluateAppleCandidate({ ...q, durationMs: 354000 }, apple("Queen", "Bohemian Rhapsody", { trackTimeMillis: 354500 })).accept, true);
	assert.equal(u.evaluateAppleCandidate({ ...q, durationMs: 354000 }, apple("Queen", "Bohemian Rhapsody", { trackTimeMillis: 200000 })).accept, false);
});

// ---- B5 / acceptance 5
test("fetch rejects -> connection error, not 'Genre not found'", async () => {
	const f = async () => { throw new TypeError("Failed to fetch"); };
	const r = await u.lookupGenres(track("Queen", "Bohemian Rhapsody"), { fetch: f, storage: mem(), sleep: noSleep });
	assert.equal(r.status, "error");
	assert.notEqual(r.message, u.MSG_NOT_FOUND);
	assert.match(r.message, /connection/i);
});
test("empty results -> not_found (distinct from error)", async () => {
	const r = await u.lookupGenres(track("Queen", "x"), { fetch: async () => json({ results: [] }), storage: mem(), sleep: noSleep });
	assert.equal(r.status, "not_found");
});
test("429 -> one retry honouring Retry-After, then success", async () => {
	let calls = 0; const slept = [];
	const f = async () => (++calls === 1 ? json({}, 429, { "Retry-After": "2" }) : json({ ok: 1 }));
	const out = await u.fetchJson("https://x", { fetch: f, sleep: async (ms) => void slept.push(ms) });
	assert.equal(out.kind, "ok"); assert.equal(calls, 2); assert.deepEqual(slept, [2000]);
});
test("persistent 5xx -> at most 1 retry", async () => {
	let calls = 0;
	const out = await u.fetchJson("https://x", { fetch: async () => (calls++, json({}, 503)), sleep: noSleep });
	assert.equal(calls, 2); assert.equal(out.kind, "http");
});
test("timeout aborts the request", async () => {
	const f = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
	const out = await u.fetchJson("https://x", { fetch: f, timeoutMs: 20, sleep: noSleep });
	assert.equal(out.kind, "network");
});
test("Retry-After is capped", () => assert.equal(u.parseRetryAfter("9999"), u.MAX_RETRY_AFTER_MS));

// ---- B8
test("Discogs requests carry an identifying User-Agent", async () => {
	const seen = [];
	await u.lookupGenres(track("Queen", "x"), { fetch: async (url, init) => (seen.push([url, init.headers]), json({ results: [] })), storage: mem(), sleep: noSleep });
	const d = seen.filter(([url]) => url.includes("discogs"));
	assert.ok(d.length > 0);
	for (const [, h] of d) assert.match(h["User-Agent"], /WhatsThatGenrePlus/);
});

// ---- B6 / acceptance 6
test("replaceAll treats metacharacters literally", () => {
	assert.equal(u.replaceAll("hip.hop and hipxhop", "hip.hop", "Hip Hop"), "Hip Hop and hipxhop");
	assert.equal(u.replaceAll("c++ c++", "c++", "cpp"), "cpp cpp");
	assert.equal(u.replaceAll("x (indietronica) y", "(indietronica)", "indie"), "x indie y");
	assert.equal(u.replaceAll("a.b", ".", "$&"), "a$&b");
});

// ---- A6 helper
test("debounce.cancel drops a pending call", async () => {
	let n = 0; const d = u.debounce(() => n++, 10);
	d(); d.cancel(); await new Promise((r) => setTimeout(r, 30));
	assert.equal(n, 0);
});

// ---- B9
test("user-visible strings are English", () => {
	for (const m of [u.MSG_LOOKING, u.MSG_NOT_FOUND, u.MSG_NETWORK_ERROR]) assert.doesNotMatch(m, /[çğıöşüÇĞİÖŞÜ]/);
	assert.equal(u.MSG_LOOKING, "Looking for genre...");
	assert.equal(u.MSG_NOT_FOUND, "Genre not found");
});
