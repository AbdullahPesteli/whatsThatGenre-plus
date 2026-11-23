import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const mutant = process.env.WTG_MUTANT;
const mutations = {
  fallback: [
    "app.tsx",
    "const info = found ??",
    "if (!found?.description) return; const info = found ??",
  ],
  language: [
    "app.tsx",
    "const lang = currentLang(safeStorage());",
    'const lang = "en";',
  ],
  thrown: ["sources/genre-info.ts", "blocked = true;", "throw error;"],
  literal: ["app.tsx", "desc.textContent =", "desc.innerHTML ="],
  cache: ["sources/genre-info.ts", "if (raw) {", "if (false && raw) {"],
  stale: ["app.tsx", "if (requestId !== genreRequestId) return;", ""],
  playlist: [
    "app.tsx",
    "for (const item of search?.playlists?.items ?? []) {",
    'Spicetify.showNotification("Missing playlist", true); for (const item of search?.playlists?.items ?? []) {',
  ],
  timeout: [
    "sources/genre-info.ts",
    "const deadline = AbortSignal.timeout(12000);",
    "const deadline = new AbortController().signal;",
  ],
  variants: [
    "sources/genre-info.ts",
    "const variants = [",
    "return [raw]; const variants = [",
  ],
  initials: ["app.tsx", "circle.textContent =", "circle.dataset.initial ="],
};
const { outputFiles } = await build({
  absWorkingDir: root,
  entryPoints: ["src/app.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  loader: { ".scss": "text" },
  plugins: [
    {
      name: "genre-proof",
      setup(build) {
        build.onLoad({ filter: /\.(ts|tsx)$/ }, async ({ path }) => {
          const relative = path.split("/src/").at(-1);
          if (process.env.WTG_BASELINE && relative === "app.tsx") {
            const contents = execFileSync(
              "git",
              ["show", `${process.env.WTG_BASELINE}:src/app.tsx`],
              { cwd: root, encoding: "utf8" },
            );
            return {
              loader: "tsx",
              contents:
                contents + "\nexport {clickGenreTag, fetchSpotifyPlaylistURI};",
            };
          }
          if (mutations[mutant]?.[0] !== relative) return;
          const { readFile } = await import("node:fs/promises");
          const original = await readFile(path, "utf8");
          const [, from, to] = mutations[mutant];
          assert.equal(
            original.split(from).length,
            2,
            `mutation anchor ${mutant}`,
          );
          return {
            loader: relative.endsWith("tsx") ? "tsx" : "ts",
            contents: original.replace(from, to),
          };
        });
      },
    },
  ],
});
const { clickGenreTag, fetchSpotifyPlaylistURI } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].text).toString("base64")
);

// Only the host boundary is stubbed. The DOM double keeps literal text and markup
// operations distinct. The independent Chrome harness exercises the native DOM.
class Node {
  children = [];
  attrs = {};
  events = {};
  dataset = {};
  className = "";
  raw = "";
  constructor(tag) {
    this.tag = tag;
  }
  set textContent(str) {
    this.children = [String(str)];
  }
  get textContent() {
    return this.children
      .map((x) => (typeof x === "string" ? x : x.textContent))
      .join("");
  }
  set innerHTML(str) {
    this.raw = str;
    this.children = [];
  }
  append(...children) {
    this.children.push(...children);
  }
  appendChild(child) {
    this.append(child);
    return child;
  }
  replaceChildren(...children) {
    this.children = children;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(k, fn) {
    this.events[k] = fn;
  }
  *walk() {
    yield this;
    for (const child of this.children)
      if (child instanceof Node) yield* child.walk();
  }
}
const ok = (data) => new Response(JSON.stringify(data));
const miss = () => new Response(null, { status: 404 });
let serial = 0;
function setup({
  lang = "en",
  fetch = async () => miss(),
  cosmos = async () => ({ artists: { items: [] }, playlists: { items: [] } }),
} = {}) {
  const calls = [],
    alerts = [],
    modals = [],
    store = new Map();
  let hides = 0;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  });
  globalThis.document = { createElement: (tag) => new Node(tag) };
  globalThis.window = { localStorage: globalThis.localStorage };
  globalThis.Spicetify = {
    Locale: { getLocale: () => lang },
    PopupModal: { display: (modal) => modals.push(modal), hide: () => hides++ },
    CosmosAsync: { get: cosmos },
    showNotification: (...args) => alerts.push(args),
  };
  globalThis.fetch = async (url, opts) => {
    calls.push(new URL(url));
    return fetch(url, opts);
  };
  const latest = () => modals.at(-1).content;
  return {
    store,
    calls,
    alerts,
    modals,
    latest,
    nodes: () => [...latest().walk()],
    hides: () => hides,
    name: `Demo-${++serial}`,
  };
}
const wiki = (u) => /\.wikipedia\.org/.test(u);
const musicalyst = (u) => u.includes("lucasoe.github.io");
const song = (description, extra = {}) =>
  ok({ pageProps: { genresAdvancedInfo: { description }, ...extra } });
const entity = {
  claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q188451" } } } }] },
  sitelinks: { trwiki: { title: "Tür" }, enwiki: { title: "Genre" } },
};
const wdFixture = (u) =>
  u.includes("wbsearchentities")
    ? ok({ search: [{ id: "Q1" }] })
    : u.includes("wbgetentities")
      ? ok({ entities: { Q1: entity } })
      : undefined;

test("fallback: missing sources settle open popup and keep localized links", async () => {
  const h = setup({ lang: "tr-TR" });
  await clickGenreTag(h.name);
  assert.equal(h.latest().attrs["aria-busy"], undefined);
  assert.ok(h.latest().textContent.includes("Bu tür için açıklama bulunamadı"));
  const hosts = h
    .nodes()
    .filter((n) => n.tag === "a")
    .map((n) => new URL(n.href).hostname);
  assert.deepEqual(
    new Set(hosts),
    new Set(["tr.wikipedia.org", "www.discogs.com", "open.spotify.com"]),
  );
});
test("language: TR wiki is preferred and missing TR is explicitly marked EN", async () => {
  let trExists = true;
  for (const [word, note] of [
    ["Türkçe açıklama", false],
    ["English summary", true],
  ]) {
    const h = setup({
      lang: "tr-TR",
      fetch: async (u) =>
        wdFixture(u) ??
        (u.includes("tr.wikipedia") && trExists
          ? ok({ type: "standard", extract: "Türkçe açıklama" })
          : u.includes("en.wikipedia")
            ? ok({ type: "standard", extract: "English summary" })
            : miss()),
    });
    await clickGenreTag(h.name);
    assert.ok(h.latest().textContent.includes(word), h.latest().textContent);
    assert.equal(h.latest().textContent.includes("İngilizce kaynak"), note);
    assert.equal(
      h.calls.some((x) => x.hostname === "en.wikipedia.org"),
      note,
    );
    trExists = false;
  }
});
test("thrown: a provider failure still reaches another source", async () => {
  const h = setup({
    fetch: async (u) => {
      if (wiki(u)) throw Error("offline");
      return musicalyst(u) ? song("Provider fallback") : miss();
    },
  });
  await clickGenreTag(h.name);
  assert.ok(h.latest().textContent.includes("Provider fallback"));
});
test("literal: provider description remains literal text, not DOM markup", async () => {
  const marker = '<img onerror="void 0">';
  const h = setup({
    fetch: async (u) =>
      musicalyst(u)
        ? song(marker)
        : u.includes("wbsearchentities")
          ? ok({ search: [] })
          : ok({}),
  });
  await clickGenreTag(h.name);
  assert.ok(h.latest().textContent.includes(marker));
  assert.equal(
    h.nodes().some((x) => x.raw.includes(marker) || x.tag === "img"),
    false,
  );
});
test("cache: reopening uses saved entry without any open-source request", async () => {
  const h = setup({
    fetch: async (u) =>
      musicalyst(u)
        ? song("Cached description")
        : u.includes("wbsearchentities")
          ? ok({ search: [] })
          : ok({ type: "standard", extract: "Music genre." }),
  });
  await clickGenreTag(h.name);
  assert.ok(h.calls.length > 0);
  assert.ok([...h.store.keys()].some((k) => k.startsWith("wtg:genre:v1:")));
  const before = h.calls.length;
  await clickGenreTag(h.name);
  assert.equal(h.calls.length, before);
});
test("stale: the old response never replaces or edits any newer content", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const h = setup({
    fetch: async (u) => {
      if (musicalyst(u))
        return u.includes("slow") ? held : song("Fresh selection");
      return ok({ type: "standard", extract: "No match" });
    },
  });
  const old = clickGenreTag("slow");
  const oldNode = h.latest();
  const newer = clickGenreTag("fresh");
  release(song("Outdated selection"));
  await Promise.all([old, newer]);
  assert.equal(h.modals.length, 2);
  assert.ok(!oldNode.textContent.includes("Outdated selection"));
  assert.ok(h.latest().textContent.includes("Fresh selection"));
});
test("playlist: no matches returns undefined and is quiet", async () => {
  const h = setup();
  assert.equal(await fetchSpotifyPlaylistURI("none"), undefined);
  assert.deepEqual(h.alerts, []);
});
test("timeout: hanging sources end with the fallback within the total budget", async (t) => {
  t.mock.method(AbortSignal, "timeout", (ms) => {
    const signal = new AbortController();
    if (ms === 12000) setTimeout(() => signal.abort(), 50);
    return signal.signal;
  });
  const h = setup({ fetch: async () => new Promise(() => {}) });
  const limit = AbortSignal.abort();
  let timer;
  try {
    await Promise.race([
      clickGenreTag(h.name),
      new Promise(
        (_, reject) => (timer = setTimeout(() => reject(limit.reason), 400)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(h.latest().textContent.includes("no description available"));
});
test("variants: normalized Musicalyst probes stop at first reply and stay bounded", async () => {
  const h = setup({
    fetch: async (u) =>
      u.endsWith("dance-pop.json")
        ? song("Normalized mirror result")
        : wiki(u)
          ? ok({ type: "standard", extract: "Not relevant" })
          : miss(),
  });
  await clickGenreTag("Dance Pop");
  const probes = h.calls.filter((x) => x.hostname === "lucasoe.github.io");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].pathname.split("/").at(-1), "dance-pop.json");
  assert.ok(h.latest().textContent.includes("Normalized mirror result"));
});
test("initials: Spotify artist lookup uses a genre query and a missing photo gets an initial", async () => {
  const id = "1234567890123456789012";
  const queries = [];
  const h = setup({
    fetch: async () => ok({}),
    cosmos: async (u) => {
      queries.push(new URL(u));
      return { artists: { items: [{ id, name: "Édith" }] } };
    },
  });
  await clickGenreTag(h.name);
  const a = h
    .nodes()
    .find((x) => x.className.includes("wtg-info-artist") && x.tag === "a");
  assert.equal(a?.href, `spotify:artist:${id}`);
  assert.ok(a.textContent.startsWith("ÉÉdith"));
  assert.equal(queries[0].searchParams.get("q"), `genre:"${h.name}"`);
  a.events.click();
  assert.equal(h.hides(), 1);
});
