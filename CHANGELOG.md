# Changelog

All notable changes to **What's That Genre? Plus** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
