import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const { outputFiles } = esbuild.buildSync({
  entryPoints: [new URL("../app.tsx", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  loader: { ".scss": "text" },
  footer: { js: "export { avoidLocalText };" },
});
const { avoidLocalText } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].text).toString("base64")
);
const box = { left: 80, right: 280, top: 10, bottom: 46 };
function reserve(rects, styles = {}) {
  const nodes = rects.map((rect) => ({
    textContent: "Lossless",
    children: [],
    closest: () => null,
    getBoundingClientRect: () => ({ width: 60, height: 18, ...rect }),
  }));
  globalThis.getComputedStyle = () => ({
    visibility: "visible",
    display: "block",
    ...styles,
  });
  try {
    return avoidLocalText(
      { querySelectorAll: () => nodes },
      { contains: () => false },
      box,
      14,
    );
  } finally {
    delete globalThis.getComputedStyle;
  }
}
test("quality line below artist reserves its rendered line-height", () => {
  assert.deepEqual(reserve([{ left: 80, right: 140, top: 46, bottom: 64 }]), {
    ...box,
    top: 64,
    bottom: 64,
  });
});
for (const [name, rect, style] of [
  ["transparent", {}, { opacity: "0" }],
  [
    "clipped screen reader",
    { width: 1, height: 1 },
    { clip: "rect(0px, 0px, 0px, 0px)" },
  ],
  ["zero width", { width: 0 }, {}],
  ["tiny", { width: 2, height: 2 }, {}],
  ["unrelated timer", { left: 180, right: 230 }, {}],
]) {
  test(`ignore ${name} text`, () => {
    assert.equal(
      reserve([{ left: 80, right: 140, top: 46, bottom: 64, ...rect }], style),
      box,
    );
  });
}
test("without quality line the original anchor is unchanged", () => {
  assert.equal(reserve([]), box);
});
test("unrelated quality text outside row x-range does not move tags", () => {
  assert.equal(reserve([{ left: 300, right: 360, top: 46, bottom: 64 }]), box);
});
test("multiple occupied lines cannot lift tags back onto quality text", () => {
  assert.equal(
    reserve([
      { left: 80, right: 140, top: 46, bottom: 64 },
      { left: 80, right: 140, top: 64, bottom: 82 },
    ]).top,
    82,
  );
});
