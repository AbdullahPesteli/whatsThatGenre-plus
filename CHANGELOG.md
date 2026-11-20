# Changelog

All notable changes to **What's That Genre? Plus** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.3] - 2026-11-20

### Fixed

- Genre labels no longer overlap Spotify's Lossless/quality label when that label is a button or hidden from screen readers but still visible.

## [2.3.2] - 2026-11-14

### Fixed

- Genre labels avoid Spotify's Lossless/quality line, cover, title and artist.
- Re-layout when the quality line is added, removed or shown/hidden later; when there is no room, labels are hidden and stay in the tooltip.

### Validation scope and known limits

- Validated in isolated Chromium with the compiled bundle against a layout reconstructed from a user-reported macOS screenshot; native Spotify was not run and the real quality-line DOM was not captured.
- Existing limits remain: text sharing a non-leaf container with SVG can overlap; visually visible aria-hidden text is not treated as an obstacle; many labels in narrow windows can be clipped with a +N summary.

## [2.3.1] - 2026-11-08

### Fixed

- Fix genre placement near cover/title/artist when Spotify rearranges player; recompute after internal size changes.
- Includes non-link artist bylines in the layout boundary and resize observation.

### Validation scope

- Isolated Chromium LAB coverage only; native Spotify 1.3.6 / Spicetify exact-environment E2E was not run. No claim of compatibility with every Spotify version.

## [2.3.0] - 2026-10-31

### Added

- Old-client support (host selector chain: legacy class -> testid -> structural scan).
- Settings access via right-click / double-click (for clients without a topbar icon API).

### Fixed

- Genre row is no longer hidden; on overlap it is nudged upward, hiding is the last resort.
- Genre row width now follows the horizontal intersection with the bar (clipping fixed).
- Source badge is always fully visible.

## [2.2.0] - 2026-10-31

### Added

- Topbar settings panel + PopupModal; source order selection; manual genre assign/remove.
- UI language selection (auto/tr/en), EN + TR strings.

### Changed

- Panel actions: "refresh now", "clear cache" and "reset to defaults".

## [2.1.0] - 2026-10-31

### Added

- MusicBrainz (CC0) source tier between Discogs and iTunes, weighted by tag count (count >= 2).
- Source health tracking with a circuit breaker.
- Daily canary check for sources.
- Client-side rate budgets per source.
- Cache v2: TTL, negative cache and migration from the old format.
- Lookup state machine.

### Changed

- Genre label now shows the source name (Discogs / MusicBrainz / iTunes).

## [2.0.1] - 2026-10-31

### Added

- CI now runs two jobs: `typecheck` (`npm ci` + `npm run typecheck`) and `dist-sync`
  (`npm ci` + `npm run build-local` + `git diff --exit-code -- dist/`), so a stale
  committed `dist/whatsThatGenre-plus.js` fails the build.
- Committed `package-lock.json` and switched CI from `npm install` to `npm ci` for
  reproducible installs.
- `.nvmrc` (22) and `package.json` `engines.node: ">=22"`; CI `node-version: 22` matches.
- New scripts: `dist:build`, `lint` (`prettier --check src`) and `test`
  (`node --test src/__tests__/*.test.mjs`).

### Changed

- Structural mount for the now-playing genre row: genres are attached to a structural
  anchor instead of a class-name lookup, so the row survives Spotify client markup
  changes (PR #4, [@ubemotho](https://github.com/ubemotho)).
- Cache keys are Unicode-normalised before they reach `localStorage`, so Cyrillic, CJK
  and Turkish artist/title pairs no longer collide on one stripped key; inputs that
  normalise to nothing are never written or read.
- Apple Music candidate matching rejects tribute, cover and karaoke records
  ("in the style of", "as made famous", "originally performed", …) so a cover band's
  genre never replaces the real track's genre.
- Network failures get their own path: one retry for 429/5xx honouring `Retry-After`,
  an 8 s request timeout, and an explicit "Couldn't reach Discogs/Apple Music" message
  instead of silently reporting "Genre not found".
- All user-facing strings are English (i18n EN).

## [2.0.0] - 2026-09-04

### Added

- First release of the fork: restores genres and sub-styles for the current track in
  Spotify's now-playing bar.
- Discogs lookup (up to five ranked styles/genres, no API key) with a keyless
  Apple Music / iTunes Search fallback verified against title, artist, album and
  duration.
- `DISCOGS` / `TRACK` source badge, per-track `localStorage` cache, and a click-through
  genre detail popup with related genres and top artists.
- README walkthrough, preview assets and GitHub Pages demo.

[2.0.1]: https://github.com/AbdullahPesteli/whatsThatGenre-plus/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/AbdullahPesteli/whatsThatGenre-plus/releases/tag/v2.0.0
