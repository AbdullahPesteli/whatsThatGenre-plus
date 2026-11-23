import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const memory = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => memory.set(k, v),
    removeItem: (k) => memory.delete(k),
  },
});
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const { outputFiles } = await build({
  entryPoints: [path.join(root, "src/sources/genre-info.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const api = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].text).toString("base64")
);
const response = (data, ok = true) => ({
  ok,
  status: ok ? 200 : 404,
  json: async () => data,
});
test("none gives fallback object", async () => {
  api.resetGenreInfoStateForTests();
  const x = await api.fetchGenreInfo("absent-genre", "en", {
    fetcher: async () => response({}, false),
  });
  assert.equal(x.description, null);
});
test("Turkish UI falls back to English with note when no tr sitelink", async () => {
  api.resetGenreInfoStateForTests();
  let sawEn = false;
  const x = await api.fetchGenreInfo("dance-pop-test", "tr", {
    fetcher: async (u) => {
      if (u.includes("wbsearchentities"))
        return response({ search: [{ id: "Q1" }] });
      if (u.includes("wbgetentities"))
        return response({
          entities: {
            Q1: {
              claims: {
                P31: [
                  { mainsnak: { datavalue: { value: { id: "Q188451" } } } },
                ],
              },
              sitelinks: { enwiki: { title: "Dance-pop" } },
            },
          },
        });
      if (u.startsWith("https://en.wikipedia.org")) {
        sawEn = true;
        return response({
          type: "standard",
          extract: "English text",
          content_urls: {
            desktop: { page: "https://en.wikipedia.org/wiki/Dance-pop" },
          },
        });
      }
      return response({}, false);
    },
  });
  assert.equal(sawEn, true);
  assert.equal(x.descLang, "en");
  assert.equal(x.fallbackNote, true);
});
test("thrown source proceeds to later source", async () => {
  api.resetGenreInfoStateForTests();
  let musicalyst = false;
  const x = await api.fetchGenreInfo("jazz-test", "en", {
    fetcher: async (u) => {
      if (u.includes("wbsearchentities")) throw Error("no network");
      if (u.includes("lucasoe.github.io")) {
        musicalyst = true;
        return response({
          pageProps: { genresAdvancedInfo: { description: "Jazz" } },
        });
      }
      return response({}, false);
    },
  });
  assert.equal(musicalyst, true);
  assert.equal(x.description, "Jazz");
});
test("cache serves second lookup without network", async () => {
  api.resetGenreInfoStateForTests();
  memory.clear();
  let calls = 0;
  const fetcher = async (u) => {
    calls++;
    if (u.includes("wbsearchentities")) return response({ search: [] });
    if (u.includes("lucasoe.github.io"))
      return response({
        pageProps: { genresAdvancedInfo: { description: "cached" } },
      });
    return response({}, false);
  };
  const x = await api.fetchGenreInfo("cache-genre-test", "en", { fetcher });
  const before = calls;
  const y = await api.fetchGenreInfo("cache-genre-test", "en", { fetcher });
  assert.equal(x.description, "cached");
  assert.equal(calls, before);
  assert.equal(y.cached, true);
});
test("recorded Synth-pop slug resolves and exposes the nested playlist hint", async () => {
  api.resetGenreInfoStateForTests();
  const playlistId = "2ZIRxkFuqNPMnlY7vL54uK";
  const result = await api.fetchGenreInfo("Synth-pop", "en", {
    fetcher: async (url) => {
      if (url.endsWith("/synthpop.json"))
        return response({
          pageProps: {
            genresAdvancedInfo: {
              description: "Synthpop",
              playlists: [playlistId],
            },
          },
        });
      return response({}, false);
    },
  });
  assert.equal(result.description, "Synthpop");
  assert.equal(result.playlistHint, playlistId);
});

test("four ordinary 404 responses do not open the circuit", async () => {
  api.resetGenreInfoStateForTests();
  let searchCalls = 0;
  const fetcher = async (url) => {
    if (url.includes("wbsearchentities")) {
      searchCalls++;
      return response({}, false);
    }
    if (url.includes("wikipedia.org"))
      return response({ type: "standard", extract: "Music genre." });
    return response({});
  };
  for (const name of [
    "missing one",
    "missing two",
    "missing three",
    "missing four",
  ]) {
    const result = await api.fetchGenreInfo(name, "en", { fetcher });
    assert.equal(
      result.tried.find((x) => x.source === "wikidata-search")?.outcome,
      "miss",
    );
  }
  assert.equal(searchCalls, 4);
});
