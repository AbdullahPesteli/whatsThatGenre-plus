import fs from "node:fs";
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

const layout = await load("../layout.ts");

// stub: host rect + offset parent; row top must land at hostRect.bottom + 2
function stubTop(hostH) {
  const parentTop = 1000; // parent's viewport top
  const hostRect = { top: 1010, bottom: 1010 + hostH };
  return { top: layout.anchorTop(hostRect, parentTop), hostRect, parentTop };
}
test("bar-layout K1: host 34px -> row top = hostRect.bottom+2", () => {
  const s = stubTop(34);
  assert.equal(s.parentTop + s.top, s.hostRect.bottom + 2);
});
test("bar-layout K1: host 22px -> row top = hostRect.bottom+2", () => {
  const s = stubTop(22);
  assert.equal(s.parentTop + s.top, s.hostRect.bottom + 2);
  assert.equal(s.top, 34);
});
test("bar-layout K2: badge + 3 long genres -> width fits badge, tags get remainder", () => {
  const r = layout.rowWidth(100, 60, 120, 340);
  assert.ok(r.width >= 60 + layout.MIN_TAGS_WIDTH);
  assert.equal(r.tagsWidth, r.width - 60);
  assert.ok(r.tagsWidth >= layout.MIN_TAGS_WIDTH);
});
test("bar-layout K2: wide badge never squeezed below MIN; max respected otherwise", () => {
  assert.ok(layout.rowWidth(10, 200, 120, 340).width >= 248);
  assert.equal(layout.rowWidth(900, 50, 120, 340).width, 340);
});
test("bar-layout K2: css - badge flex-shrink 0, tags ellipsize", () => {
  const css = fs.readFileSync(path.join(here, "../styles.scss"), "utf8");
  const badge = css.match(/\.genre-source-badge \{[^}]*\}/)[0];
  const tag = css.match(/\n\.genre-tag \{[\s\S]*?\n\}/)[0];
  assert.match(badge, /flex: 0 0 auto/);
  assert.match(tag, /min-width: 0/);
  assert.match(tag, /text-overflow: ellipsis/);
  assert.match(tag, /flex: 0 1 auto/);
});
test("bar-layout K3: settings missing, gear present -> gear used", () => {
  const g = globalThis;
  const hooks = { storage: () => undefined, refreshNow() {}, changed() {} };
  let args;
  g.Spicetify = {
    SVGIcons: { gear: "<gear/>", other: "<o/>" },
    Topbar: {
      Button: class {
        constructor(...a) {
          args = a;
          this.element = {};
        }
      },
    },
  };
  assert.equal(panel.registerSettingsButton(hooks), true);
  assert.equal(args[1], "<gear/>");
  assert.equal(panel.pickSettingsIcon({ foo: "<f/>" }), "<f/>");
  delete g.Spicetify;
});
test("bar-layout K3: no icons + Menu.Item -> Menu.Item; nothing -> no throw + console trace", () => {
  const g = globalThis;
  const hooks = { storage: () => undefined, refreshNow() {}, changed() {} };
  let item;
  g.Spicetify = {
    Menu: {
      Item: class {
        constructor(...a) {
          item = a;
        }
      },
    },
  };
  assert.equal(panel.registerSettingsButton(hooks), true);
  assert.equal(item[0], "What's That Genre? Plus");
  assert.equal(item[1], false);
  g.Spicetify = {};
  const logs = [];
  const orig = console.info;
  console.info = (...a) => logs.push(a.join(" "));
  try {
    assert.equal(panel.registerSettingsButton(hooks), false);
  } finally {
    console.info = orig;
    delete g.Spicetify;
  }
  assert.deepEqual(logs, ["[WTG] settings button: no API"]);
});
