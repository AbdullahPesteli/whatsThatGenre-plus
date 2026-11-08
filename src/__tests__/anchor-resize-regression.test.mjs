// Hotfix F2 regression slice: the genre row must anchor to the content
// boundary (clear of the cover, under the full title+artist byline) and
// re-measure when the byline re-flows internally (+18px) WITHOUT a
// window.resize. The production app.tsx bundle is loaded unchanged; a footer
// export exposes its module-internal functions, so the same test drives the
// base (RED) and fixed (GREEN) source alike. Rects are explicit stubs (no
// layout engine); all geometry assertions are rectangle intersections.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- minimal DOM stub ----------

function matchCompound(el, sel) {
  let s = sel.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(s);
  if (tag) {
    if (el.tagName !== tag[0].toUpperCase()) return false;
    s = s.slice(tag[0].length);
  }
  while (s.length) {
    if (s[0] === ".") {
      const m = /^\.([\w-]+)/.exec(s);
      const cls = el.getAttribute("class") || "";
      if (!m || !cls.split(/\s+/).includes(m[1])) return false;
      s = s.slice(m[0].length);
      continue;
    }
    const m = /^\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]/.exec(s);
    if (!m) return false;
    const val = el.getAttribute(m[1]);
    if (m[2] === "=") {
      if (val !== m[3]) return false;
    } else if (m[2] === "^=") {
      if (!val || !val.startsWith(m[3])) return false;
    } else if (m[2] === "*=") {
      if (!val || !val.includes(m[3])) return false;
    } else if (val === null) return false;
    s = s.slice(m[0].length);
  }
  return true;
}

function matches(el, selector) {
  return selector.split(",").some((part) => matchCompound(el, part));
}

class FakeEl {
  constructor(tag, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...(opts.attrs || {}) };
    this._rect = {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      ...(opts.rect || {}),
    };
    this.children = [];
    this.parentElement = null;
    this._offsetParent = undefined;
    this.clientTop = opts.clientTop || 0;
    this.clientLeft = opts.clientLeft || 0;
    this.offsetHeight = opts.offsetHeight || 0;
    this.clientWidth = opts.clientWidth || 0;
    this.scrollWidth = opts.scrollWidth || 0;
    this._overflow = opts.overflow || "visible";
    this.textContent = opts.textContent || "";
    this.title = "";
    this._runs = 0;
    this.style = {
      setProperty(k, v) {
        this[k] = v;
      },
      removeProperty(k) {
        delete this[k];
      },
    };
    const self = this;
    this.classList = {
      toggle() {
        self._runs += 1;
      },
    };
  }
  get offsetParent() {
    return this._offsetParent === undefined
      ? this.parentElement
      : this._offsetParent;
  }
  set offsetParent(v) {
    this._offsetParent = v;
  }
  getBoundingClientRect() {
    const r = this._rect;
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.right - r.left,
      height: r.bottom - r.top,
      x: r.left,
      y: r.top,
    };
  }
  setRect(rect) {
    this._rect = { ...this._rect, ...rect };
  }
  appendChild(el) {
    el.parentElement = this;
    this.children.push(el);
    return el;
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  matches(sel) {
    return matches(this, sel);
  }
  closest(sel) {
    for (let el = this; el; el = el.parentElement) {
      if (matches(el, sel)) return el;
    }
    return null;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  contains(el) {
    for (let e = el; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
}

class FakeDoc {
  constructor() {
    this.root = null;
  }
  get body() {
    return this.root;
  }
  querySelector(sel) {
    return this.root ? this.root.querySelector(sel) : null;
  }
}

class FakeResizeObserver {
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.targets = new Set();
    this.observeCalls = 0;
    this.disconnects = 0;
    FakeResizeObserver.instances.push(this);
  }
  observe(el) {
    this.targets.add(el);
    this.observeCalls += 1;
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
    this.disconnects += 1;
  }
  fire() {
    this.cb(
      [...this.targets].map((target) => ({ target })),
      this,
    );
  }
}

const fakeDoc = new FakeDoc();
globalThis.document = fakeDoc;
globalThis.getComputedStyle = (el) => ({
  overflow: (el && el._overflow) || "visible",
});
globalThis.ResizeObserver = FakeResizeObserver;

// ---------- load the production app.tsx bundle (source untouched) ----------

const bundle = esbuild.buildSync({
  entryPoints: [path.join(here, "../app.tsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  target: "es2022",
  loader: { ".scss": "text" },
}).outputFiles[0].text;
// Mechanical footer: expose module-internal production functions so the test
// runs the real layoutGenreContainer on both base and head (no source edits).
const code =
  bundle +
  "\nexport const __wtg = {" +
  ' layout: typeof layoutGenreContainer === "function" ? layoutGenreContainer : null,' +
  ' dispose: typeof disposeGenreLayoutWatch === "function" ? disposeGenreLayoutWatch : null' +
  "};\n";
const __wtg = (
  await import(
    "data:text/javascript;base64," + Buffer.from(code).toString("base64")
  )
).__wtg;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COVER_GAP_MIN = 4; // the row must clear the cover by a positive gap

// ---------- geometry fixtures (viewport coords, host shapes per OZET) ----------

const GENRE_ROW_HEIGHT = 14;

function makeContainer() {
  const c = new FakeEl("div", {
    attrs: { class: "main-trackInfo-genres" },
    offsetHeight: GENRE_ROW_HEIGHT,
  });
  for (let i = 0; i < 5; i += 1) {
    c.appendChild(new FakeEl("a", { attrs: { class: "genre-tag" } }));
  }
  c.appendChild(
    new FakeEl("span", {
      attrs: { class: "genre-source-badge" },
      rect: { left: 0, top: 0, right: 44, bottom: 12 },
    }),
  );
  return c;
}

function mountUnder(container, host, offsetParent) {
  container.style.position = "absolute";
  container.style.left = "0";
  container.offsetParent = offsetParent;
  host.appendChild(container);
}

function rowRectOf(container) {
  const p = container.offsetParent;
  const pr = p.getBoundingClientRect();
  const left = pr.left + (p.clientLeft || 0) + parseFloat(container.style.left);
  const top = pr.top + (p.clientTop || 0) + parseFloat(container.style.top);
  return {
    left,
    top,
    right: left + parseFloat(container.style.width),
    bottom: top + container.offsetHeight,
  };
}

function intersectArea(a, b) {
  const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return x * y;
}

function intersections(scene, container) {
  const rr = rowRectOf(container);
  return {
    cover: intersectArea(rr, scene.cover.getBoundingClientRect()),
    title: intersectArea(rr, scene.title.getBoundingClientRect()),
    artist: intersectArea(rr, scene.artist.getBoundingClientRect()),
    bar: intersectArea(rr, scene.seek.getBoundingClientRect()),
    rr,
  };
}

function rectLog(scene, container) {
  const rr = rowRectOf(container);
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return [b.left, b.top, b.right, b.bottom].map(Math.round).join(",");
  };
  return JSON.stringify({
    row: [rr.left, rr.top, rr.right, rr.bottom].map(Math.round).join(","),
    cover: r(scene.cover),
    title: r(scene.title),
    artist: r(scene.artist),
    bar: r(scene.seek),
  });
}

function assertZeroIntersections(t, scene, container, label) {
  const got = intersections(scene, container);
  t.diagnostic(`rects ${label} ${rectLog(scene, container)}`);
  for (const k of ["cover", "title", "artist", "bar"]) {
    assert.equal(got[k], 0, `${label}: row must not intersect ${k}`);
  }
  return got;
}

/**
 * Modern host = the widget/bar scope itself: wide box that includes the cover
 * (GitHub #1 failure mode 1 — left:0 lands on the cover). Title/artist are
 * flat full-width links, so the cover clamp is what clears the row.
 * `area` = available row area; bar.left is placed to produce it exactly.
 */
function buildScopeScene(area) {
  const root = new FakeEl("body");
  const shell = root.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "now-playing-bar" },
      rect: { left: 0, top: 300, right: 800, bottom: 372 },
    }),
  );
  const widget = shell.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "now-playing-widget" },
      rect: { left: 8, top: 308, right: 700, bottom: 356 },
      clientLeft: 2,
      clientTop: 2,
    }),
  );
  const cover = widget.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "CoverSlotContainer" },
      rect: { left: 16, top: 312, right: 72, bottom: 368 },
    }),
  );
  const title = widget.appendChild(
    new FakeEl("a", {
      attrs: { href: "/track/abc123", class: "track-title" },
      rect: { left: 8, top: 312, right: 700, bottom: 330 },
    }),
  );
  const artist = widget.appendChild(
    new FakeEl("a", {
      attrs: { href: "/artist/xyz789", class: "artist" },
      rect: { left: 8, top: 334, right: 700, bottom: 352 },
    }),
  );
  const barLeft = 80 + 8 + area; // row left 80 + gap + area
  const seek = shell.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "playback-progressbar" },
      rect: { left: barLeft, top: 420, right: barLeft + 400, bottom: 424 },
    }),
  );
  return { root, shell, widget, cover, title, artist, seek };
}

/**
 * Wrapper host (post-F1 shape): the host IS the title+artist byline and does
 * not include the cover. Must behave exactly like the legacy baseline.
 */
function buildWrapperScene(area) {
  const root = new FakeEl("body");
  const shell = root.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "now-playing-widget" },
      rect: { left: 8, top: 308, right: 700, bottom: 380 },
    }),
  );
  const cover = shell.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "CoverSlotContainer" },
      rect: { left: 16, top: 312, right: 72, bottom: 368 },
    }),
  );
  const wrapper = shell.appendChild(
    new FakeEl("div", {
      rect: { left: 88, top: 312, right: 648, bottom: 352 },
    }),
  );
  const title = wrapper.appendChild(
    new FakeEl("a", {
      attrs: { href: "/track/abc123", class: "track-title" },
      rect: { left: 88, top: 312, right: 488, bottom: 330 },
    }),
  );
  const artist = wrapper.appendChild(
    new FakeEl("a", {
      attrs: { href: "/artist/xyz789", class: "artist" },
      rect: { left: 88, top: 334, right: 388, bottom: 352 },
    }),
  );
  const barLeft = 88 + 8 + area;
  const seek = shell.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "playback-progressbar" },
      rect: { left: barLeft, top: 420, right: barLeft + 400, bottom: 424 },
    }),
  );
  return { root, shell, host: wrapper, cover, title, artist, seek };
}

/** Legacy trackInfo host: title+artist inside, cover outside. Baseline guard. */
function buildLegacyScene(area) {
  const root = new FakeEl("body");
  const shell = root.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "now-playing-bar" },
      rect: { left: 0, top: 300, right: 800, bottom: 372 },
    }),
  );
  const cover = shell.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "CoverSlotContainer" },
      rect: { left: 16, top: 312, right: 72, bottom: 368 },
    }),
  );
  const trackInfo = shell.appendChild(
    new FakeEl("div", {
      attrs: { class: "main-nowPlayingWidget-trackInfo" },
      rect: { left: 88, top: 312, right: 648, bottom: 352 },
    }),
  );
  const title = trackInfo.appendChild(
    new FakeEl("a", {
      attrs: { href: "/track/abc123", class: "track-title" },
      rect: { left: 88, top: 312, right: 488, bottom: 330 },
    }),
  );
  const artist = trackInfo.appendChild(
    new FakeEl("a", {
      attrs: { href: "/artist/xyz789", class: "artist" },
      rect: { left: 88, top: 334, right: 388, bottom: 352 },
    }),
  );
  const barLeft = 88 + 8 + area;
  const seek = shell.appendChild(
    new FakeEl("div", {
      attrs: { "data-testid": "playback-progressbar" },
      rect: { left: barLeft, top: 420, right: barLeft + 400, bottom: 424 },
    }),
  );
  return { root, shell, host: trackInfo, cover, title, artist, seek };
}

function fresh() {
  FakeResizeObserver.instances.length = 0;
  if (__wtg.dispose) __wtg.dispose();
}

function layout(scene, host, container) {
  fakeDoc.root = scene.root;
  mountUnder(container, host, host);
  assert.ok(__wtg.layout, "production layoutGenreContainer must be reachable");
  __wtg.layout(container);
}

// ---------- tests ----------

for (const area of [200, 320, 457]) {
  test(`scope host @${area}: mount — row clears cover, zero intersections`, (t) => {
    fresh();
    const scene = buildScopeScene(area);
    const container = makeContainer();
    layout(scene, scene.widget, container);
    const got = assertZeroIntersections(t, scene, container, `scope@${area}`);
    assert.ok(
      got.rr.left >= scene.cover.getBoundingClientRect().right + COVER_GAP_MIN,
      "row left start must clear cover.right+gap (not stay under it)",
    );
    assert.equal(
      got.rr.top,
      scene.artist.getBoundingClientRect().bottom + 2,
      "row anchors under the full title+artist byline",
    );
  });

  test(`scope host @${area}: internal reflow +18px re-measures without window.resize`, async (t) => {
    fresh();
    const scene = buildScopeScene(area);
    const container = makeContainer();
    layout(scene, scene.widget, container);
    const ro = FakeResizeObserver.instances.at(-1);
    assert.ok(ro, "layout must register a ResizeObserver on host/byline");
    // title wraps to two lines -> byline moves 18px down; scope box unchanged.
    scene.title.setRect({ bottom: 348 });
    scene.artist.setRect({ top: 352, bottom: 370 });
    ro.fire(); // the browser would fire this on the observed byline resize
    await sleep(400);
    const got = assertZeroIntersections(
      t,
      scene,
      container,
      `scope-reflow@${area}`,
    );
    assert.equal(
      got.rr.top,
      scene.artist.getBoundingClientRect().bottom + 2,
      "row must follow the byline down without a window.resize",
    );
  });
}

test("wrapper host: mount — host-box anchor preserved (legacy behavior)", (t) => {
  fresh();
  const scene = buildWrapperScene(320);
  const container = makeContainer();
  layout(scene, scene.host, container);
  const got = assertZeroIntersections(t, scene, container, "wrapper");
  assert.equal(
    got.rr.top,
    scene.host.getBoundingClientRect().bottom + 2,
    "host that contains title+artist is the anchor box",
  );
  assert.equal(
    got.rr.left,
    scene.host.getBoundingClientRect().left,
    "no cover inside the host -> row starts at the host's left edge",
  );
});

test("wrapper host: internal reflow +18px re-measures without window.resize", async (t) => {
  fresh();
  const scene = buildWrapperScene(320);
  const container = makeContainer();
  layout(scene, scene.host, container);
  const ro = FakeResizeObserver.instances.at(-1);
  assert.ok(ro, "layout must register a ResizeObserver on host/byline");
  scene.title.setRect({ bottom: 348 });
  scene.artist.setRect({ top: 352, bottom: 370 });
  scene.host.setRect({ bottom: 370 });
  ro.fire();
  await sleep(400);
  const got = assertZeroIntersections(t, scene, container, "wrapper-reflow");
  assert.equal(
    got.rr.top,
    scene.host.getBoundingClientRect().bottom + 2,
    "row must follow the grown byline host down",
  );
});

test("legacy trackInfo: baseline placement unchanged", (t) => {
  fresh();
  const scene = buildLegacyScene(320);
  const container = makeContainer();
  layout(scene, scene.host, container);
  const got = assertZeroIntersections(t, scene, container, "legacy");
  assert.equal(
    got.rr.top,
    scene.host.getBoundingClientRect().bottom + 2,
    "legacy row stays at hostRect.bottom + 2",
  );
  assert.equal(
    got.rr.left,
    scene.host.getBoundingClientRect().left,
    "legacy row stays at the host's left edge",
  );
});

test("wide host + bar close below: no fake bar collision from the full-width host", (t) => {
  fresh();
  const scene = buildScopeScene(200);
  // Move the bar just under the row so the vertical test bites. The bar starts
  // right of the row's real x-range, so only a host-wide h-test can collide.
  scene.seek.setRect({ top: 362, bottom: 366 });
  const container = makeContainer();
  layout(scene, scene.widget, container);
  const got = assertZeroIntersections(t, scene, container, "bar-h");
  assert.equal(
    container.getAttribute("data-wtg-hidden"),
    null,
    "row must not be hidden by a bar it never intersects",
  );
});

test("observer lifecycle: single watcher, no feedback loop, dispose + remount clean", async (t) => {
  fresh();
  const scene = buildWrapperScene(320);
  const container = makeContainer();
  fakeDoc.root = scene.root;
  mountUnder(container, scene.host, scene.host);
  __wtg.layout(container);
  __wtg.layout(container);
  __wtg.layout(container);
  assert.equal(FakeResizeObserver.instances.length, 1, "one watcher total");
  const ro = FakeResizeObserver.instances[0];
  assert.equal(
    ro.observeCalls,
    ro.targets.size,
    "each target observed exactly once (no churn across layouts)",
  );
  assert.ok(
    !ro.targets.has(container),
    "the absolute row itself must never be observed (no feedback loop)",
  );
  const before = container._runs;
  ro.fire();
  ro.fire();
  ro.fire();
  await sleep(400);
  assert.equal(
    container._runs,
    before + 1,
    "observer bursts debounce to exactly one relayout",
  );
  const settled = container._runs;
  await sleep(400);
  assert.equal(container._runs, settled, "no runaway relayout loop");
  if (__wtg.dispose) {
    __wtg.dispose();
    assert.equal(ro.disconnects, 1, "dispose disconnects the watcher");
    ro.fire();
    await sleep(400);
    assert.equal(container._runs, settled, "dead watcher must not relayout");
  }
  __wtg.layout(container);
  assert.equal(
    FakeResizeObserver.instances.length,
    2,
    "remount creates a fresh watcher (old one not reused)",
  );
  assert.equal(
    FakeResizeObserver.instances[0].disconnects,
    1,
    "old watcher stays disconnected",
  );
  t.diagnostic(
    `observer ${JSON.stringify({
      instances: FakeResizeObserver.instances.length,
      observeCalls: ro.observeCalls,
      targets: ro.targets.size,
      disconnects: FakeResizeObserver.instances[0].disconnects,
      layoutRuns: container._runs,
    })}`,
  );
});
