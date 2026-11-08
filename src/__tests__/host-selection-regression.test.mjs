import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

// Loads the PRODUCTION src/host.ts (never a copy of its algorithm) under
// plain node by stripping types with esbuild (ships with spicetify-creator) —
// the same pipeline as host-panel.test.mjs.
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_TS = path.join(here, "..", "host.ts");
const sourceText = fs.readFileSync(HOST_TS, "utf8");
const sourceSha = crypto.createHash("sha256").update(sourceText).digest("hex");
const out = esbuild.buildSync({
  entryPoints: [HOST_TS],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  target: "es2022",
});
const host = await import(
  "data:text/javascript;base64," +
    Buffer.from(out.outputFiles[0].text).toString("base64")
);

/** Minimal stub element tree with selector support for the few selectors used. */
function el(attrs = {}, kids = [], cls = "", tag = "div", text = "") {
  const n = {
    tagName: tag.toUpperCase(),
    attrs,
    cls,
    kids,
    text,
    parentElement: null,
    dataset: {},
    children: kids,
    getAttribute: (k) => attrs[k] ?? null,
    get textContent() {
      return n.text + n.kids.map((k) => k.textContent).join("");
    },
    contains: (o) => {
      for (let x = o; x; x = x.parentElement) if (x === n) return true;
      return false;
    },
    querySelector: (sel) => find(n, sel),
  };
  kids.forEach((k) => (k.parentElement = n));
  return n;
}
function find(root, sel) {
  for (const k of root.kids) {
    if (match(k, sel)) return k;
    const d = find(k, sel);
    if (d) return d;
  }
  return null;
}
function match(n, sel) {
  if (sel === ".main-nowPlayingWidget-trackInfo")
    return n.cls.split(" ").includes("main-nowPlayingWidget-trackInfo");
  let m = /^\[data-testid="(.+)"\]$/.exec(sel);
  if (m) return n.attrs["data-testid"] === m[1];
  m = /^a\[href\*="(.+)"\]$/.exec(sel);
  if (m) return n.tagName === "A" && (n.attrs.href ?? "").includes(m[1]);
  return false;
}
const doc = (...roots) => {
  const top = el({}, roots);
  return { querySelector: (s) => find(top, s) };
};
const link = (href, text) => el({ href }, [], "", "a", text);
const coverSlot = () =>
  el({ "data-testid": "CoverSlotContainer" }, [], "", "div", "");

const TITLE = "Break Up To Make Up";
const ARTIST = "The Stylistics";

test("kaynak pin: yüklenen modül gerçek src/host.ts", () => {
  const resolved = fs.realpathSync(HOST_TS);
  console.log("[kaynak-pin]", resolved, "sha256", sourceSha);
  assert.ok(resolved.endsWith(path.join("src", "host.ts")));
  assert.match(sourceText, /export function findTrackInfoHost/);
  assert.equal(typeof host.findTrackInfoHost, "function");
  assert.equal(host.LEGACY_HOST_SELECTOR, ".main-nowPlayingWidget-trackInfo");
  assert.equal(typeof host.resetHostLog, "function");
});

test("F1 T1 (REPRO-A): düz kardeş linkler — host sanatçıyı contains() ile kapsar", () => {
  const trackLink = link("/track/1", TITLE);
  const artistLink = link("/artist/2", ARTIST);
  const widget = el({ "data-testid": "now-playing-widget" }, [
    trackLink,
    artistLink,
  ]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r.contains(artistLink), true, "host sanatçı linkini içermeli");
  assert.equal(r.contains(trackLink), true, "host başlık linkini içermeli");
  assert.match(r.textContent, new RegExp(ARTIST));
  assert.match(r.textContent, new RegExp(TITLE));
});

test("F1 T2 (REPRO-B): span sanatçı — host sanatçı metnini kapsar", () => {
  const titleDiv = el({}, [], "track-title", "div", TITLE);
  const artistSpan = el({}, [], "artist", "span", ARTIST);
  const widget = el({ "data-testid": "now-playing-widget" }, [
    titleDiv,
    artistSpan,
  ]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r.contains(artistSpan), true, "host sanatçı satırını içermeli");
  assert.equal(r.contains(titleDiv), true, "host başlık satırını içermeli");
  assert.match(r.textContent, new RegExp(ARTIST));
  assert.match(r.textContent, new RegExp(TITLE));
});

test("F1: farklı alt ağaçlardaki linkler — ortak ata scope, sanatçı kapsanır", () => {
  const trackWrap = el({}, [link("/track/1", TITLE)]);
  const artistWrap = el({}, [link("/artist/2", ARTIST)]);
  const widget = el({ "data-testid": "now-playing-widget" }, [
    trackWrap,
    artistWrap,
  ]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r.contains(artistWrap), true, "host sanatçı dalını içermeli");
  assert.equal(r.contains(trackWrap), true, "host başlık dalını içermeli");
  assert.match(r.textContent, new RegExp(ARTIST));
});

test("F1: iç içe byline sarmalayıcı (metin) — sarmalayıcı host olur", () => {
  const titleDiv = el({}, [], "track-title", "div", TITLE);
  const artistSpan = el({}, [], "artist", "span", ARTIST);
  const byline = el({}, [titleDiv, artistSpan], "byline");
  const widget = el({ "data-testid": "now-playing-widget" }, [byline]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r, byline, "ortak byline sarmalayıcısı seçilmeli");
  assert.equal(r.contains(artistSpan), true);
  assert.match(r.textContent, new RegExp(ARTIST));
  assert.equal(r.dataset.wtgHost, "links");
});

test("F1: iç içe byline sarmalayıcı (linkler) — LCA sarmalayıcı, byline içerir", () => {
  const trackWrap = el({}, [link("/track/1", TITLE)]);
  const artistWrap = el({}, [link("/artist/2", ARTIST)]);
  const byline = el({}, [trackWrap, artistWrap], "byline");
  const widget = el({ "data-testid": "now-playing-widget" }, [byline]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r, byline);
  assert.equal(r.contains(artistWrap), true);
  assert.equal(r.contains(trackWrap), true);
  assert.match(r.textContent, new RegExp(ARTIST));
});

test("F1 legacy (M1): byline kapsayan legacy host korunur", () => {
  const titleLink = link("/track/1", TITLE);
  const artistLink = link("/artist/2", ARTIST);
  const byline = el({}, [titleLink, artistLink], "byline");
  const legacy = el({}, [byline], "main-nowPlayingWidget-trackInfo");
  const widget = el({ "data-testid": "now-playing-widget" }, [legacy]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r, legacy, "legacy seçici her zaman kazanmalı");
  assert.equal(r.dataset.wtgHost, "legacy");
  assert.equal(r.contains(artistLink), true);
  assert.match(r.textContent, new RegExp(ARTIST));
});

test("F1 cover first: CoverSlot asla tek başına host değil, sanatçı kapsanır", () => {
  const cover = coverSlot();
  const titleDiv = el({}, [], "track-title", "div", TITLE);
  const artistSpan = el({}, [], "artist", "span", ARTIST);
  const widget = el({ "data-testid": "now-playing-widget" }, [
    cover,
    titleDiv,
    artistSpan,
  ]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.notEqual(r, cover, "CoverSlot host olamaz");
  assert.notEqual(r, titleDiv, "başlık tek başına host olamaz");
  // düz kardeş iki satır → tek ortak ata scope (raporlanan yatay sınır)
  assert.equal(r, widget);
  assert.equal(r.contains(artistSpan), true, "host sanatçıyı içermeli");
  assert.equal(r.contains(titleDiv), true, "host başlığı içermeli");
  assert.match(r.textContent, new RegExp(ARTIST));
});

test("F1 cover first: tek satırlık byline'da mevcut ilk-metinli-çocuk sözleşmesi", () => {
  const cover = coverSlot();
  const titleDiv = el({}, [], "track-title", "div", TITLE);
  const widget = el({ "data-testid": "now-playing-widget" }, [cover, titleDiv]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r, titleDiv, "sanatçı yokken ilk metinli çocuk sözleşmesi");
  assert.equal(r.contains(titleDiv), true);
});

test("F1 no-track: hiçbir seçici eşleşmezse null (H5 sözleşmesi)", () => {
  const orphan = el({}, [link("/track/1", TITLE)], "mystery");
  assert.equal(host.findTrackInfoHost(doc(orphan)), null);
});

test("F1 no-track: kapsam metin içermiyorsa scope döner", () => {
  const widget = el({ "data-testid": "now-playing-widget" }, [], "", "div", "");
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r, widget);
  assert.equal(r.dataset.wtgHost, "widget");
});
