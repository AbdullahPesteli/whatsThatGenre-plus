import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = esbuild.buildSync({
  entryPoints: [path.join(here, "../settings/panel.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  target: "es2022",
});
const panel = await import(
  "data:text/javascript;base64," +
    Buffer.from(out.outputFiles[0].text).toString("base64")
);
const hooks = { storage: () => undefined, refreshNow() {}, changed() {} };
const stubEl = () => {
  const l = {};
  return { l, addEventListener: (t, f) => (l[t] = f) };
};
const withModal = (fn) => {
  let shown = 0;
  globalThis.Spicetify = {
    React: { createElement: () => ({}) },
    PopupModal: { display: () => shown++ },
    ...(fn?.() ?? {}),
  };
  return () => shown;
};

test("settings-entry: contextmenu on the row calls openPanel and preventDefault", () => {
  const shown = withModal();
  const el = stubEl();
  assert.equal(panel.attachSettingsGestures(el, hooks), true);
  let prevented = 0;
  el.l.contextmenu({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.equal(shown(), 1);
  delete globalThis.Spicetify;
});

test("settings-entry: dblclick opens the same panel", () => {
  const shown = withModal();
  const el = stubEl();
  panel.attachSettingsGestures(el, hooks);
  el.l.dblclick({ preventDefault() {} });
  assert.equal(shown(), 1);
  delete globalThis.Spicetify;
});

test("settings-entry: no Menu API / no Topbar -> no throw", () => {
  const logs = [];
  const orig = console.info;
  console.info = (...a) => logs.push(a.join(" "));
  try {
    globalThis.Spicetify = {};
    assert.equal(panel.registerSettingsButton(hooks), false);
    globalThis.Spicetify = {
      Topbar: {
        Button: class {
          constructor() {
            throw new Error("x");
          }
        },
      },
      SVGIcons: { gear: "g" },
    };
    assert.doesNotThrow(() => panel.registerSettingsButton(hooks));
    delete globalThis.Spicetify;
    assert.doesNotThrow(() => panel.registerSettingsButton(hooks));
    assert.equal(panel.attachSettingsGestures(null, hooks), false);
  } finally {
    console.info = orig;
    delete globalThis.Spicetify;
  }
  assert.ok(logs.includes("[WTG] settings button: no API"));
});

test("settings-entry: ContextMenu.Item registered when present, skipped when absent", () => {
  let args,
    registered = 0;
  globalThis.Spicetify = {
    ContextMenu: {
      Item: class {
        constructor(...a) {
          args = a;
        }
        register() {
          registered++;
        }
      },
    },
  };
  assert.equal(panel.registerSettingsButton(hooks), true);
  assert.equal(args[0], "What's That Genre? Plus");
  assert.equal(args[3], "settings");
  assert.equal(args[2](), true);
  assert.equal(registered, 1);
  globalThis.Spicetify = {};
  const orig = console.info;
  console.info = () => {};
  try {
    assert.equal(panel.registerSettingsButton(hooks), false);
  } finally {
    console.info = orig;
    delete globalThis.Spicetify;
  }
});
