import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = esbuild.buildSync({
  entryPoints: [path.join(here, "../layout.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { placeRow } = await import(
  "data:text/javascript;base64," +
    Buffer.from(out.outputFiles[0].text).toString("base64")
);

// host at y=1170, 20px tall -> default row top 20, height 17 -> bottom 1207
const base = {
  hostHeight: 20,
  hostTop: 1170,
  rowHeight: 17,
  clipBottom: Infinity,
};

test("layout: bar overlaps row -> visible and top clamped smaller", () => {
  const r = placeRow({ ...base, barTop: 1193 });
  assert.equal(r.hidden, false);
  assert.equal(r.action, "shifted");
  assert.ok(r.top < 20 && r.top >= 0, `top=${r.top}`);
  assert.equal(r.top, 1193 - 4 - 17 - 1170); // 2
});

test("layout: no room above bar -> hidden last resort", () => {
  const r = placeRow({ ...base, barTop: 1100 });
  assert.equal(r.hidden, true);
  assert.equal(r.action, "hidden");
  assert.equal(r.top, 0);
});

test("layout: no bar -> visible, top unchanged", () => {
  const r = placeRow({ ...base, barTop: Infinity });
  assert.equal(r.hidden, false);
  assert.equal(r.action, "keep");
  assert.equal(r.top, 20);
});

test("layout: clipped with room -> shifted; clipped without room -> hidden", () => {
  const a = placeRow({ ...base, barTop: Infinity, clipBottom: 1200 });
  assert.equal(a.hidden, false);
  assert.ok(a.top < 20);
  const b = placeRow({ ...base, barTop: Infinity, clipBottom: 1180 });
  assert.equal(b.hidden, true);
});

test("layout: visibility hidden appears only in the last-resort branch", () => {
  const src = fs.readFileSync(path.join(here, "../app.tsx"), "utf8");
  const hits = src.match(/visibility = "hidden"/g) ?? [];
  assert.equal(hits.length, 1);
  assert.match(
    src,
    /LAST RESORT[\s\S]{0,200}visibility = "hidden";[\s\S]{0,120}data-wtg-hidden/,
  );
});
