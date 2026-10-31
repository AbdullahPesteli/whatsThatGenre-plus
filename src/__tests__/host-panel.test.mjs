import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
const host = await load("../host.ts");
const panel = await load("../settings/panel.ts");

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
function match(n, sel) {
  if (sel === ".main-nowPlayingWidget-trackInfo")
    return n.cls.split(" ").includes("main-nowPlayingWidget-trackInfo");
  let m = /^\[data-testid="(.+)"\]$/.exec(sel);
  if (m) return n.attrs["data-testid"] === m[1];
  m = /^a\[href\*="(.+)"\]$/.exec(sel);
  if (m) return n.tagName === "A" && (n.attrs.href ?? "").includes(m[1]);
  return false;
}
function find(root, sel) {
  for (const k of root.kids) {
    if (match(k, sel)) return k;
    const d = find(k, sel);
    if (d) return d;
  }
  return null;
}
const doc = (...roots) => {
  const top = el({}, roots);
  return { querySelector: (s) => find(top, s) };
};
const link = (href, text) => el({ href }, [], "", "a", text);

test("host: 1 legacy class wins over testids", () => {
  const legacy = el({}, [], "main-nowPlayingWidget-trackInfo");
  const widget = el({ "data-testid": "now-playing-widget" }, [legacy]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r, legacy);
  assert.equal(r.dataset.wtgHost, "legacy");
});

test("host: 2 widget testid when no legacy class", () => {
  const widget = el(
    { "data-testid": "now-playing-widget" },
    [],
    "",
    "div",
    "x",
  );
  const bar = el({ "data-testid": "now-playing-bar" });
  const r = host.findTrackInfoHost(doc(bar, widget));
  assert.equal(r, widget);
  assert.equal(r.dataset.wtgHost, "widget");
});

test("host: 3 bar testid when no widget", () => {
  const bar = el({ "data-testid": "now-playing-bar" }, [], "", "div", "x");
  const r = host.findTrackInfoHost(doc(bar));
  assert.equal(r, bar);
  assert.equal(r.dataset.wtgHost, "bar");
});

test("host: 4 structural link scan inside a testid scope", () => {
  const inner = el({}, [link("/track/1", "t"), link("/artist/2", "a")]);
  const widget = el({ "data-testid": "now-playing-widget" }, [
    el({ "data-testid": "CoverSlot" }),
    inner,
  ]);
  const r = host.findTrackInfoHost(doc(widget));
  assert.equal(r, inner);
  assert.equal(r.dataset.wtgHost, "links");
});

test("host: 5 nothing matches -> null", () => {
  assert.equal(host.findTrackInfoHost(doc(el({}, [], "other"))), null);
});

test("topbar: icon-only button with title, skipped without SVGIcons", () => {
  const g = globalThis;
  const hooks = { storage: () => undefined, refreshNow() {}, changed() {} };
  let args;
  const setAttrs = {};
  g.Spicetify = {
    SVGIcons: { settings: "<svg/>" },
    Topbar: {
      Button: class {
        constructor(...a) {
          args = a;
          this.element = { setAttribute: (k, v) => (setAttrs[k] = v) };
        }
      },
    },
  };
  assert.equal(panel.registerSettingsButton(hooks), true);
  assert.equal(args[0], "What's That Genre? Plus");
  assert.equal(args[1], "<svg/>");
  assert.notEqual(args[0], "WTG");
  assert.equal(setAttrs.title, "What's That Genre? Plus");
  assert.equal(setAttrs["aria-label"], "What's That Genre? Plus");
  delete g.Spicetify.SVGIcons;
  assert.equal(panel.registerSettingsButton(hooks), false);
  delete g.Spicetify;
  assert.equal(panel.registerSettingsButton(hooks), false);
});

test("panel: exactly 3 sections, <=6 controls, one hint each, 13px/1.5/520", () => {
  const g = globalThis;
  const R = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (v) => [v, () => {}],
  };
  g.Spicetify = {
    React: R,
    Player: { data: { item: { uri: "spotify:track:1" } } },
  };
  const tree = panel.buildPanel({
    storage: () => undefined,
    refreshNow() {},
    changed() {},
  });
  const root = tree.type(tree.props);
  const walk = (n, f) => {
    if (!n || typeof n !== "object") return;
    f(n);
    (n.kids ?? []).flat(5).forEach((k) => walk(k, f));
  };
  let sections = 0,
    controls = 0;
  walk(root, (n) => {
    if (n.props?.["data-wtg-section"]) sections++;
    if (["select", "input", "button"].includes(n.type)) controls++;
  });
  assert.equal(sections, 3);
  assert.ok(controls <= 6, `controls=${controls}`);
  assert.equal(root.props.style.fontSize, 13);
  assert.equal(root.props.style.lineHeight, 1.5);
  assert.equal(root.props.style.width, 520);
  const txt = JSON.stringify(root);
  for (const w of ["Where to look", "Language", "This track", "Version"])
    assert.ok(txt.includes(w), w);
  delete g.Spicetify;
});

test("panel: promoteSource keeps a permutation", () => {
  assert.deepEqual(
    panel.promoteSource(["discogs", "musicbrainz", "itunes"], "itunes"),
    ["itunes", "discogs", "musicbrainz"],
  );
});
