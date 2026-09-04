# What's That Genre? Plus

A [Spicetify](https://spicetify.app) extension that shows the **genres and sub-styles of the currently playing track** in Spotify's now-playing bar — **even for niche tracks**.

> **Why "Plus"?** Spotify removed genre data from its client (the artist `genres` field is deprecated/empty and there is no genre field in the GraphQL `artistUnion`). So the original genre extensions now show nothing for most tracks. This fork ignores Spotify's dead genre source entirely and resolves genres **per-track** from open music databases.

<p align="center">
  <a href="./preview.mp4">
    <img alt="What's That Genre? Plus — track detection, Discogs match, and playbar genre output" src="./preview.png" />
  </a>
</p>

<p align="center">
  <strong><a href="./preview.mp4">▶ Watch the 7-second product walkthrough</a></strong>
  &nbsp;·&nbsp;
  <a href="https://github.com/AbdullahPesteli/whatsThatGenre-plus/releases/download/v2.0.0/preview-remotion-v3.mp4">Mobile/direct download</a>
</p>

The walkthrough uses a real niche catalog result: **Simon Le Grec — Lonely Hearts, Pt. II** → *Ambient, Downtempo, Progressive House, House, Electro*. No personal Spotify data is shown.

## How it works

Genres are resolved in a chain and cached per track (in `localStorage`):

1. **Discogs API** (primary) — rich `genre[]` + `style[]` (e.g. *Electro, Synth-Pop, Nu-Disco, French House*). No API key required; queried directly with `fetch()` (Discogs returns permissive CORS). Falls back from release match to artist styles.
2. **Apple Music / iTunes Search API** (fallback) — keyless, for tracks missing from Discogs. Exact match by title + artist (+ album/duration).
3. Otherwise shows *"Genre not found"* — never guesses silently.

A small badge (`DISCOGS` / `TRACK`) tells you which source a label came from. Long tag rows stay on one line (no mid-word wrapping) and scroll horizontally on hover.

**No API keys. No local database. No configuration. Install and forget.**

## Install (Spicetify Marketplace)

Open Spotify → Marketplace → search **"What's That Genre? Plus"** → Install.

## Install manually

Download `dist/whatsThatGenre-plus.js` and copy it into your Spicetify extensions folder:

| Platform | Path |
|----------|------|
| macOS/Linux | `~/.config/spicetify/Extensions` |
| Windows | `%userprofile%/.spicetify/Extensions/` |

```bash
spicetify config extensions whatsThatGenre-plus.js
spicetify apply
```

## Build from source

```bash
npm install
npm run build-local   # outputs dist/whatsThatGenre-plus.js
```

## Credits

- Forked from [**LucasOe/spicetify-genres**](https://github.com/LucasOe/spicetify-genres) ("What's That Genre?"), itself inspired by Tetrax-10 and soapu. Original code is MIT-licensed.
- Genre/style data: [Discogs](https://www.discogs.com) and [Apple Music](https://music.apple.com) — all trademarks belong to their owners. This extension only reads their public search endpoints for personal listening.
- Built with [Spicetify Creator](https://github.com/spicetify/spicetify-creator).

## License

MIT — see [LICENSE](./LICENSE).
