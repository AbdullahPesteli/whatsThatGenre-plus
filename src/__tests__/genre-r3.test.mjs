import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../sources/genre-info.ts", import.meta.url),
);
const replacement = process.env.WTG_R3_MUTANT_FILE;
const { outputFiles } = await build({
  entryPoints: [source],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: replacement
    ? [
        {
          name: "r3-single-file-mutant",
          setup(build) {
            build.onLoad({ filter: /genre-info\.ts$/ }, async (args) =>
              args.path === source
                ? {
                    loader: "ts",
                    contents: await readFile(replacement, "utf8"),
                  }
                : undefined,
            );
          },
        },
      ]
    : [],
});
const api = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
);
const json = (body) => new Response(JSON.stringify(body));
const claim = (id) => ({ mainsnak: { datavalue: { value: { id } } } });
const miss = () => new Response(null, { status: 404 });
function fixture({
  trWiki = false,
  descTr = "Türkçe kısa açıklama",
  related = [],
  chips = [],
  description = "",
  artists = [],
  wiki = true,
  musicalyst,
  searchStatus,
  mb,
  longRetry = false,
} = {}) {
  return async (url, opts) => {
    const u = new URL(url);
    if (u.hostname === "www.wikidata.org") {
      if (searchStatus)
        return new Response(null, {
          status: searchStatus,
          headers: { "Retry-After": longRetry ? "60" : "0" },
        });
      if (u.searchParams.get("action") === "wbsearchentities")
        return json({ search: [{ id: "Q1" }] });
      if (u.searchParams.get("props") === "labels")
        return json({
          entities: Object.fromEntries(
            related.map((labels, i) => [`Q${i + 2}`, { labels }]),
          ),
        });
      return json({
        entities: {
          Q1: {
            descriptions: {
              tr: { value: descTr },
              en: { value: "English short" },
            },
            claims: {
              P31: [claim("Q188451")],
              P279: related.map((_, i) => claim(`Q${i + 2}`)),
            },
            sitelinks: {
              enwiki: { title: "Genre" },
              ...(trWiki ? { trwiki: { title: "Tür" } } : {}),
            },
          },
        },
      });
    }
    if (u.hostname.endsWith("wikipedia.org"))
      return wiki
        ? json({
            type: "standard",
            extract: u.hostname.startsWith("tr.")
              ? "Türkçe özet aynen kalır."
              : "English paragraph about a music genre.",
          })
        : miss();
    if (u.hostname === "lucasoe.github.io")
      return musicalyst
        ? musicalyst(url, opts)
        : json({
            pageProps: {
              genresAdvancedInfo: { description },
              relatedGenres: chips.map((genre) => ({ genre })),
              topArtists: artists,
            },
          });
    if (u.hostname === "musicbrainz.org" && mb) return mb(opts);
    return miss();
  };
}
const fetchInfo = async (lang, options, query = "Demo genre") => {
  api.resetGenreInfoStateForTests();
  return api.fetchGenreInfo(query, lang, { fetcher: fixture(options) });
};
const label = (tr, en) => ({ tr: { value: tr }, en: { value: en } });

test("R3-P1 TR lead precedes the English Wikipedia paragraph", async () => {
  const x = await fetchInfo("tr", {});
  assert.equal(x.descLang, "tr");
  assert.equal(
    x.description,
    "Türkçe kısa açıklama\nEnglish paragraph about a music genre.",
  );
  assert.equal(x.fallbackNote, true);
  assert.equal(x.descSource, "wikipedia");
});
test("R3-P1 TR lead precedes Musicalyst and a TR Wikipedia summary stays intact", async () => {
  const x = await fetchInfo("tr", {
    wiki: false,
    description: "Musicalyst paragraph.",
  });
  assert.equal(x.description, "Türkçe kısa açıklama\nMusicalyst paragraph.");
  assert.equal(x.fallbackNote, true);
  const y = await fetchInfo("tr", {
    trWiki: true,
    description: "Musicalyst paragraph.",
  });
  assert.equal(y.description, "Türkçe özet aynen kalır.");
  assert.equal(y.fallbackNote, false);
  assert.equal(
    (await fetchInfo("en", {})).description,
    "English paragraph about a music genre.",
  );
});
test("R3-P2-1 use TR labels from known Wikidata IDs, formatting unmatched chips", async () => {
  const x = await fetchInfo("tr", {
    related: [
      label("Türk sanat müziği", "Turkish art music"),
      label("", "dance-pop"),
    ],
    chips: ["turkish art music", "post disco"],
  });
  assert.deepEqual(
    x.related.map((g) => g.name),
    ["Türk sanat müziği", "Dance-Pop", "Post Disco"],
  );
});
test("R3-P2-2 collapse accents, case and music suffixes across sources and exclude self", async () => {
  const x = await fetchInfo(
    "tr",
    {
      related: [label("Póp müzik", "Different label")],
      chips: ["pop", "Bossa Nóva", "bossa nova music", "dans müzik"],
    },
    "Dans",
  );
  assert.deepEqual(
    x.related.map((g) => g.name),
    ["Póp müzik", "Bossa Nóva"],
  );
});
test("R3-P2-3 hangs after the first valid summary cannot consume the full budget", async () => {
  let first;
  const run = fixture({ descTr: "", mb: () => new Promise(() => {}) });
  const x = await api.fetchGenreInfo("Fast with hanging artist source", "en", {
    fetcher: async (u, opts) => {
      if (u.includes("en.wikipedia.org")) first = performance.now();
      return run(u, opts);
    },
  });
  assert.equal(x.descSource, "wikipedia");
  assert.ok(Number.isFinite(first));
  assert.ok(
    performance.now() - first < 2350,
    "card waited past the 2 s grace window",
  );
});
test("R3-P2-4 long Wikidata Retry-After leaves time for a Wikipedia title lookup", async () => {
  const x = await fetchInfo("en", { searchStatus: 429, longRetry: true });
  assert.equal(x.descSource, "wikipedia");
  assert.equal(x.description, "English paragraph about a music genre.");
});
test("R3-P2-4 reject non-music homonyms and try a Turkish music-qualified title", async () => {
  api.resetGenreInfoStateForTests();
  const x = await api.fetchGenreInfo("Metal", "tr", {
    fetcher: async (url) => {
      const u = new URL(url);
      if (u.hostname === "tr.wikipedia.org") {
        const title = decodeURIComponent(u.pathname.split("/").at(-1));
        if (title === "Metal")
          return json({
            type: "standard",
            title,
            description: "birçok kimyasal elementin ait olduğu grup",
            extract: "Metal, yüksek elektrik ve ısı iletkenliğine sahiptir.",
          });
        if (title === "Metal_(müzik)")
          return json({
            type: "standard",
            title: "Heavy metal",
            extract: "Heavy metal bir rock müzik türüdür.",
          });
      }
      return miss();
    },
  });
  assert.equal(x.description, "Heavy metal bir rock müzik türüdür.");
  assert.equal(x.descLang, "tr");
});
test("R3-P2-5 only exact HTTPS Spotify CDN URLs from the artist images field are accepted", async () => {
  const cdn = "https://i.scdn.co/image/real";
  const x = await fetchInfo("en", {
    artists: [
      {
        name: "Good",
        images: [{ url: cdn }, {}, { url: "https://example.invalid/foreign" }],
      },
      { name: "Other", images: [{ url: "https://example.invalid/other" }] },
      {
        name: "Lookalike",
        images: [{ url: "https://i.scdn.co.example.invalid/fake" }],
      },
      { name: "Plain", images: [{ url: "http://i.scdn.co/image/plain" }] },
      { name: "Wrong field", image: cdn },
    ],
  });
  assert.deepEqual(
    x.artists.map((a) => a.image),
    [cdn, undefined, undefined, undefined, undefined],
  );
});

const arabeskChips = [
  "turkish folk",
  "turkish pop",
  "deep turkish pop",
  "oyun havasi",
  "turk sanat muzigi",
];

test("R4 Arabesk shows five Turkish chip names without searching for chips", async () => {
  api.resetGenreInfoStateForTests();
  const requests = [];
  const recorded = fixture({ chips: arabeskChips });
  const x = await api.fetchGenreInfo("Arabesk", "tr", {
    fetcher: (url, opts) => {
      requests.push(new URL(url));
      return recorded(url, opts);
    },
  });
  assert.deepEqual(x.related, [
    { name: "Türk halk müziği", wikidataId: undefined },
    { name: "Türk pop", wikidataId: undefined },
    { name: "Türk pop (derin)", wikidataId: undefined },
    { name: "Oyun havası", wikidataId: undefined },
    { name: "Türk sanat müziği", wikidataId: undefined },
  ]);
  assert.deepEqual(
    requests
      .filter((url) => url.hostname === "www.wikidata.org")
      .map(
        (url) => url.searchParams.get("search") ?? url.searchParams.get("ids"),
      ),
    ["Arabesk", "Q1"],
  );
});

test("R4 a known Wikidata chip uses its TR label before the table, then localizes an EN-only label", async () => {
  const x = await fetchInfo("tr", {
    chips: ["turkish folk", "turkish pop", "post disco"],
    related: [
      label("Türkiye halk müziği", "Turkish Folk"),
      label("", "Turkish Pop"),
    ],
  });
  assert.deepEqual(x.related, [
    { name: "Türkiye halk müziği", wikidataId: "Q2" },
    { name: "Türk pop", wikidataId: "Q3" },
    { name: "Post Disco", wikidataId: undefined },
  ]);
});

test("R4 English Arabesk names are unchanged", async () => {
  const x = await fetchInfo("en", { chips: arabeskChips }, "Arabesk");
  assert.deepEqual(
    x.related.map(({ name }) => name),
    [
      "Turkish Folk",
      "Turkish Pop",
      "Deep Turkish Pop",
      "Oyun Havasi",
      "Turk Sanat Muzigi",
    ],
  );
});
