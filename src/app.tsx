import { findTrackInfoHost } from "./host";
import {
  anchorTop,
  barWidthCeiling,
  placeRowGeo,
  rowWidth,
  type Box,
} from "./layout";
import "./styles.scss";
import {
  attachSettingsGestures,
  registerSettingsButton,
} from "./settings/panel";
import { currentLang, loadSettings, tr } from "./settings/store";
import type { MusicalystData } from "./types/musicalyst";
import {
  MSG_LOOKING,
  MSG_RETRY,
  camelize,
  flushCacheIndex,
  debounce,
  lookupGenres,
  runCanary,
  sourceBadge,
  replaceAll,
  waitForElement,
  type GenreResult,
  type LookupOutcome,
} from "./utils";

// https://developer.spotify.com/documentation/web-api
// https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/spotify-api/index.d.ts

let cachedGenres: string[] = [];
let lastTrackKey = "";

/** Upper bound for the genre row, in px. The real width is measured from the host (see layoutGenreContainer). */
const MAX_GENRE_WIDTH = 640;
const MIN_GENRE_WIDTH = 120;

let hasWarnedAboutMissingHost = false;

/** Tears down the previous main() so a second call never leaves duplicate listeners/timers. */
let teardownPrevious: (() => void) | undefined;

/** Inline `position` the host had before we forced it to "relative" (restored on cleanup). */
let hostRestore: { host: HTMLElement; position: string } | undefined;
let disposed = false;
let settingsButtonRegistered = false;
/** Set by injectGenres: re-search the current track, ignoring the cache. */
let forceRefreshHook: (() => void) | undefined;
const T = (text: string) => tr(text, currentLang(safeStorage()));
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export default async function main() {
  teardownPrevious?.();
  teardownPrevious = undefined;
  disposed = false;

  while (
    !Spicetify?.Player ||
    !Spicetify?.CosmosAsync ||
    !Spicetify?.showNotification
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (disposed) return;

  const genreContainer = document.createElement("div");
  genreContainer.className = "main-trackInfo-genres";

  const panelHooks = {
    storage: safeStorage,
    refreshNow: () => forceRefreshHook?.(),
    changed: () => void refresh(),
  };
  attachSettingsGestures(genreContainer, panelHooks);
  if (!settingsButtonRegistered)
    settingsButtonRegistered = registerSettingsButton(panelHooks);

  const refresh = async () => {
    if (disposed) return;
    try {
      await injectGenres(genreContainer);
    } catch (error) {
      console.error("[HermesGenre] render failed", error);
    }
  };

  const onResize = debounce(() => {
    if (!disposed && genreContainer.parentElement)
      layoutGenreContainer(genreContainer);
  });

  Spicetify.Player.addEventListener("songchange", refresh);
  window.addEventListener("resize", onResize);
  // Back online: re-validate the current track (offline/stale records).
  window.addEventListener("online", refresh);

  // Spotify can restore a playing track without emitting songchange.
  const restoreTimer = setTimeout(refresh, 1200);

  teardownPrevious = () => {
    disposed = true;
    // Present at runtime (spicetify-cli Player) but missing from the bundled typings.
    (
      Spicetify.Player as unknown as {
        removeEventListener(t: string, f: () => void): void;
      }
    ).removeEventListener("songchange", refresh);
    window.removeEventListener("resize", onResize);
    onResize.cancel();
    disposeGenreLayoutWatch();
    clearTimeout(restoreTimer);
    window.removeEventListener("online", refresh);
    flushCacheIndex(safeStorage());
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    genreContainer.remove();
    if (hostRestore) {
      hostRestore.host.style.position = hostRestore.position;
      hostRestore = undefined;
    }
  };

  await refresh();
}

async function injectGenres(genreContainer: HTMLDivElement) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;

  const data = Spicetify.Player.data;
  if (!data?.item) {
    if (!disposed)
      retryTimer = setTimeout(() => injectGenres(genreContainer), 1000);
    return;
  }

  const metadata =
    data.item.metadata || ({} as Spicetify.PlayerTrack["metadata"]);
  const title = data.item.name || metadata.title || "";
  let artist =
    data.item.artists?.[0]?.name ||
    metadata.artist_name ||
    metadata.album_artist_name ||
    "";
  if (!artist && String(metadata.title || "").includes(" • ")) {
    artist = String(metadata.title).split(" • ").at(-1) || "";
  }
  const album = data.item.album?.name || metadata.album_title || "";
  const durationMs =
    data.item.duration?.milliseconds || Number(metadata.duration || 0);
  const artistId = metadata.artist_uri?.split(":")[2] || "";
  const trackUri = data.item.uri;
  const trackKey = `${data.item.uri}|${title}|${artist}|${album}`;
  lastTrackKey = trackKey;

  genreContainer.className = "main-trackInfo-genres";
  genreContainer.innerHTML = `<span class="genre-loading">${T(MSG_LOOKING)}</span>`;
  await mountGenreContainer(genreContainer);
  // daily self-test (max 1/day, 2 fixed requests, no user data)
  void runCanary({
    fetch: (url, init) => fetch(url, init),
    storage: safeStorage(),
  }).catch(() => undefined);

  const run = async (force = false) => {
    const outcome = await lookupGenres(
      { artistId, title, artist, album, durationMs, uri: trackUri },
      {
        fetch: (url, init) => fetch(url, init),
        storage: safeStorage(),
        force,
        sourceOrder: loadSettings(safeStorage()).sourceOrder,
      },
    );
    if (disposed || lastTrackKey !== trackKey) return;
    await showOutcome(genreContainer, outcome, () => {
      genreContainer.innerHTML = `<span class="genre-loading">${T(MSG_LOOKING)}</span>`;
      void run(true);
    });
  };
  forceRefreshHook = () => {
    if (disposed || lastTrackKey !== trackKey) return;
    genreContainer.innerHTML = `<span class="genre-loading">${T(MSG_LOOKING)}</span>`;
    void run(true);
  };
  await run();
}

async function showOutcome(
  genreContainer: HTMLDivElement,
  outcome: LookupOutcome,
  retry: () => void,
) {
  if (outcome.status === "ok") {
    cachedGenres = outcome.result.genres;
    await renderGenres(
      genreContainer,
      outcome.result.genres,
      outcome.result.source,
      outcome.result.confidence,
    );
    if (outcome.label) {
      const note = document.createElement("span");
      note.className = "genre-state-note";
      note.textContent = T(outcome.label);
      genreContainer.appendChild(note);
    }
    if (outcome.canRetry)
      genreContainer.appendChild(retryButton(outcome, retry));
    if (outcome.refresh) {
      const trackKey = lastTrackKey;
      const next = await outcome.refresh;
      if (disposed || lastTrackKey !== trackKey) return;
      await showOutcome(genreContainer, next, retry);
    }
    return;
  }

  cachedGenres = [];
  genreContainer.innerHTML = "";
  const span = document.createElement("span");
  span.className =
    outcome.status === "error" ? "genre-error" : "genre-unavailable";
  span.textContent = T(outcome.message);
  genreContainer.appendChild(span);
  genreContainer.appendChild(retryButton(outcome, retry));
  layoutGenreContainer(genreContainer);
}

function retryButton(
  outcome: { retryLabel?: string } | object,
  retry: () => void,
): HTMLElement {
  const button = document.createElement("a");
  button.className = "genre-retry";
  button.textContent = T(
    (outcome as { retryLabel?: string }).retryLabel ?? MSG_RETRY,
  );
  button.setAttribute("role", "button");
  button.addEventListener("click", retry);
  return button;
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The byline column is a grid, so a child added to it would trigger implicit
 * placement into a new column and squeeze the title and artist to one character
 * each. The row is therefore taken out of flow (absolute) and positioned from
 * measurements, see layoutGenreContainer.
 */
async function mountGenreContainer(genreContainer: HTMLDivElement) {
  const host = (await waitForElement(
    findTrackInfoHost,
    5000,
  )) as HTMLElement | null;
  if (!host) {
    if (!hasWarnedAboutMissingHost) {
      hasWarnedAboutMissingHost = true;
      console.warn("[WTG] host: none of the selectors matched");
      Spicetify.showNotification(
        "What's That Genre? Plus: could not find the now-playing track info.",
        true,
      );
    }
    return;
  }
  if (disposed) return;

  if (genreContainer.parentElement !== host) {
    // Undo a previous host's forced positioning before moving on.
    if (hostRestore && hostRestore.host !== host) {
      hostRestore.host.style.position = hostRestore.position;
      hostRestore = undefined;
    }
    if (getComputedStyle(host).position === "static") {
      if (!hostRestore) hostRestore = { host, position: host.style.position };
      host.style.position = "relative";
    }
    genreContainer.style.position = "absolute";
    genreContainer.style.left = "0";
    genreContainer.style.flex = "";
    genreContainer.style.order = "";
    genreContainer.style.margin = "0";
    host.appendChild(genreContainer);
  }
  layoutGenreContainer(genreContainer);
}

/** Gap kept between the cover's right edge and the row's left start, px. */
const COVER_GAP = 8;

/** Content boundary the row anchors to, in viewport coordinates. */
interface ContentAnchor {
  /** Vertical gap under `.bottom`; lift floor at `.top`. `.left` is the row's left start. */
  box: Box;
  /** Elements whose resize must re-trigger the layout (host + byline). */
  watch: Element[];
}

/**
 * The row must not collide with the cover or the full title+artist byline:
 *  - host contains title+artist and is not widget/bar-wide (legacy trackInfo,
 *    byline wrapper) -> the host box itself is the boundary (unchanged legacy
 *    placement);
 *  - host is as wide as the widget/bar scope (cover included) -> the real
 *    track/byline rect is the boundary, and when the cover rect is included
 *    the row's left start never stays left of cover.right + COVER_GAP.
 */
function resolveContentAnchor(host: HTMLElement): ContentAnchor {
  const scope =
    host.closest<HTMLElement>(
      '[data-testid="now-playing-widget"], [data-testid="now-playing-bar"]',
    ) ?? host;
  const pick = (sel: string): HTMLElement | null => {
    const local = host.matches(sel)
      ? host
      : host.querySelector<HTMLElement>(sel);
    if (local) return local;
    return scope === host ? null : scope.querySelector<HTMLElement>(sel);
  };
  const title = pick('a[href*="/track/"]');
  let artist = pick('a[href*="/artist/"]');
  const cover = pick('[data-testid^="CoverSlot"]');
  if (!artist && title) {
    // A non-link byline can be a sibling of the title or of its wrapper.
    // Only accept a unique text leaf below the title in that content branch;
    // controls elsewhere in the widget and our own row are not boundaries.
    const titleBox = title.getBoundingClientRect();
    for (let branch: Element = title; branch.parentElement;) {
      const parent = branch.parentElement;
      const candidates: HTMLElement[] = [];
      for (const sibling of Array.from(parent.children)) {
        if (
          sibling === branch ||
          (cover && sibling.contains(cover)) ||
          sibling.closest(".main-trackInfo-genres")
        )
          continue;
        const leaves = [
          ...(sibling.matches("span, button") ? [sibling] : []),
          ...Array.from(sibling.querySelectorAll("span, button")),
        ];
        for (const leaf of leaves) {
          if (
            leaf.children.length ||
            !leaf.textContent?.trim() ||
            leaf.closest(".main-trackInfo-genres")
          )
            continue;
          const rect = leaf.getBoundingClientRect();
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= titleBox.bottom - 1 &&
            rect.left < titleBox.right &&
            rect.right > titleBox.left
          )
            candidates.push(leaf as HTMLElement);
        }
      }
      if (candidates.length) {
        if (candidates.length === 1) artist = candidates[0];
        break; // Ambiguous text must retain the existing fallback.
      }
      if (parent === scope) break;
      branch = parent;
    }
  }

  const hostRect = host.getBoundingClientRect();
  const wide =
    scope === host || hostRect.width >= scope.getBoundingClientRect().width - 1;
  const bylineInHost =
    !!title && !!artist && host.contains(title) && host.contains(artist);

  let box: Box;
  const watch: Element[] = [host];
  if (bylineInHost && !wide) {
    box = hostRect;
  } else if (title || artist) {
    for (const el of [title, artist]) if (el) watch.push(el);
    const parent = title && artist ? title.parentElement : null;
    if (parent && parent !== host && artist && parent.contains(artist)) {
      box = parent.getBoundingClientRect();
      watch.push(parent);
    } else {
      const rects = [title, artist]
        .filter((el): el is HTMLElement => !!el)
        .map((el) => el.getBoundingClientRect());
      box = {
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      };
    }
  } else {
    box = hostRect;
  }

  if (cover && host.contains(cover)) {
    // Cover rect included in the host: keep the row's left start clear of it.
    box = {
      ...box,
      left: Math.max(box.left, cover.getBoundingClientRect().right + COVER_GAP),
    };
  }
  return { box, watch };
}

/** Debounced relayout watcher for byline re-flows without a window.resize. */
interface AnchorWatch {
  observer: ResizeObserver;
  mutations?: MutationObserver;
  relayout: { (): void; cancel(): void };
  targets: Set<Element>;
  dead: boolean;
}
let anchorWatch: AnchorWatch | undefined;

function watchAnchor(genreContainer: HTMLDivElement, els: Element[]): void {
  if (typeof ResizeObserver === "undefined") return;
  if (!anchorWatch) {
    const watch: AnchorWatch = {
      observer: undefined as unknown as ResizeObserver,
      relayout: debounce(() => {
        if (!disposed && genreContainer.parentElement)
          layoutGenreContainer(genreContainer);
      }),
      targets: new Set<Element>(),
      dead: false,
    };
    watch.observer = new ResizeObserver(() => {
      // The row itself is never observed, so this cannot feed back into it.
      if (!watch.dead) watch.relayout();
    });
    const scope =
      genreContainer.parentElement?.closest<HTMLElement>(
        '[data-testid="now-playing-widget"], [data-testid="now-playing-bar"]',
      ) ?? genreContainer.parentElement;
    if (scope && typeof MutationObserver !== "undefined") {
      watch.mutations = new MutationObserver((records) => {
        if (watch.dead) return;
        // Ignore all our own row/marquee DOM writes to avoid feedback.
        if (
          records.some((record) => {
            if (genreContainer.contains(record.target)) return false;
            if (record.type !== "childList") return true;
            return [
              ...Array.from(record.addedNodes),
              ...Array.from(record.removedNodes),
            ].some(
              (node) =>
                node !== genreContainer && !genreContainer.contains(node),
            );
          })
        )
          watch.relayout();
      });
      watch.mutations.observe(scope, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "aria-hidden"],
      });
    }
    anchorWatch = watch;
  }
  const watch = anchorWatch;
  for (const el of els) {
    if (el && !watch.targets.has(el)) {
      watch.targets.add(el);
      watch.observer.observe(el);
    }
  }
}

/** Tears down the reflow watcher (disconnect + pending debounce cancel). */
function disposeGenreLayoutWatch(): void {
  const watch = anchorWatch;
  anchorWatch = undefined;
  if (!watch) return;
  watch.dead = true;
  watch.observer.disconnect();
  watch.mutations?.disconnect();
  watch.relayout.cancel();
}

/**
 * Size and place the row from live measurements:
 *  - width: the space between the row's left start (content boundary, clear of
 *    the cover) and the now-playing widget's right edge, clamped to
 *    [MIN_GENRE_WIDTH, MAX_GENRE_WIDTH];
 *  - top: directly under the content boundary (host bottom, or the byline's
 *    real rect for a widget/bar-wide host), but only if the row fits above the
 *    seek bar. If it would overlap the progress bar (or be clipped by an
 *    overflow:hidden ancestor) it is hidden and the genres go to the host's
 *    tooltip instead.
 */
/** Reserve rendered local text, including Spotify's optional quality line.
 * No client-specific quality class or translated label is required. Only text
 * intersecting the proposed row matters; unrelated controls stay out of scope.
 */
function avoidLocalText(
  scope: HTMLElement,
  row: HTMLElement,
  box: Box,
  height: number,
): Box {
  const obstacles: DOMRect[] = [];
  for (const parent of Array.from(scope.querySelectorAll<HTMLElement>("*"))) {
    if (
      parent.children.length ||
      row.contains(parent) ||
      !parent.textContent?.trim()
    )
      continue;
    if (
      parent.closest(
        "script, style, button, [role='button'], [hidden], [aria-hidden='true']",
      )
    )
      continue;
    const style = getComputedStyle(parent);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      Number(style.opacity ?? 1) === 0 ||
      (style.clip && style.clip !== "auto") ||
      (style.clipPath && style.clipPath !== "none")
    )
      continue;
    const rect = parent.getBoundingClientRect();
    // Ignore clock controls, not translated quality labels. All other visible
    // local text uses horizontal intersection, not an x-start tolerance.
    if (/^\d{1,2}:\d{2}$/.test(parent.textContent.trim())) continue;
    if (
      rect.width < 4 ||
      rect.height < 4 ||
      rect.height > Math.max(height * 2, box.bottom - box.top) ||
      rect.right <= box.left ||
      rect.left >= box.right
    )
      continue;
    // Reserve the complete rendered label line, not just its glyph bounds.
    obstacles.push(rect);
  }
  let bottom = box.bottom;
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const top = anchorTop({ ...box, bottom }, 0);
    const hits = obstacles.filter(
      (r) =>
        r.width > 0 &&
        r.height > 0 &&
        r.left < box.right &&
        r.right > box.left &&
        r.top < top + height &&
        r.bottom > top,
    );
    const next = Math.max(bottom, ...hits.map((r) => r.bottom));
    if (next === bottom) break;
    bottom = next;
  }
  return bottom === box.bottom ? box : { ...box, top: bottom, bottom };
}

function layoutGenreContainer(genreContainer: HTMLDivElement) {
  const host = genreContainer.parentElement as HTMLElement | null;
  if (!host) return;

  const { box, watch } = resolveContentAnchor(host);
  // Re-measure on byline/host reflow (title/artist re-wrap) without a
  // window.resize; the watcher dedupes targets and never observes the row.
  watchAnchor(genreContainer, watch);
  const widget = host.closest(
    '[data-testid="now-playing-widget"], [data-testid="now-playing-bar"]',
  );
  const limitRight = widget ? widget.getBoundingClientRect().right : box.right;
  const barEl = document.querySelector('[data-testid="playback-progressbar"]');
  const barRect = barEl ? barEl.getBoundingClientRect() : null;
  const ceiling = barWidthCeiling(box, barRect);
  const available = Math.floor(
    ceiling !== null
      ? ceiling
      : Math.max(box.right - box.left, limitRight - box.left),
  );
  const badgeEl = genreContainer.querySelector(
    ".genre-source-badge",
  ) as HTMLElement | null;
  const badgeW = badgeEl
    ? Math.ceil(badgeEl.getBoundingClientRect().width) + 4
    : 0;
  const { width } = rowWidth(
    available,
    badgeW,
    MIN_GENRE_WIDTH,
    MAX_GENRE_WIDTH,
  );
  genreContainer.style.width = `${width}px`;
  genreContainer.style.maxWidth = `${width}px`;
  const anchorParent =
    (genreContainer.offsetParent as HTMLElement | null) || host;
  const parentRect = anchorParent.getBoundingClientRect();
  const parentTop = parentRect.top + (anchorParent.clientTop || 0);
  const parentLeft = parentRect.left + (anchorParent.clientLeft || 0);
  const defaultTop = anchorTop(box, parentTop);
  genreContainer.style.top = `${defaultTop}px`;

  const rowHeight = genreContainer.offsetHeight;
  const barTop = barRect ? barRect.top : Number.POSITIVE_INFINITY;
  let clipBottom = Number.POSITIVE_INFINITY;
  for (
    let el = host.parentElement;
    el && el !== document.body;
    el = el.parentElement
  ) {
    if (getComputedStyle(el).overflow !== "visible") {
      clipBottom = el.getBoundingClientRect().bottom;
      break;
    }
  }
  // placeRowGeo anchors below `bottom`, lifts no higher than `top`, and runs
  // the progress-bar x-test against the box given here: hand it the row's REAL
  // x-range so a full-width host never fakes a bar collision.
  const rowBox: Box = {
    top: box.top,
    bottom: box.bottom,
    left: box.left,
    right: box.left + width,
  };
  const geo = placeRowGeo({
    host: avoidLocalText(
      host.closest<HTMLElement>(
        '[data-testid="now-playing-widget"], [data-testid="now-playing-bar"]',
      ) ?? host,
      genreContainer,
      rowBox,
      rowHeight,
    ),
    bar: barRect,
    rowHeight,
    clipBottom,
  });
  const placed = {
    left: box.left - parentLeft,
    top: geo.top - parentTop,
    hidden: geo.hidden,
    action: geo.action,
    overlaps: geo.overlaps,
  };
  console.info("[WTG] layout", {
    height: rowHeight,
    left: placed.left,
    top: placed.top,
    barTop,
    overlaps: placed.overlaps,
    action: placed.action,
  });
  genreContainer.style.left = `${placed.left}px`;
  genreContainer.style.top = `${placed.top}px`;
  if (placed.hidden) {
    // LAST RESORT: row cannot fit even after shifting up; fall back to tooltip.
    genreContainer.style.visibility = "hidden";
    genreContainer.setAttribute("data-wtg-hidden", "1");
    host.title = genreContainer.textContent || "";
  } else {
    genreContainer.style.visibility = "";
    genreContainer.removeAttribute("data-wtg-hidden");
    if (host.title && host.title === (genreContainer.textContent || "")) {
      host.removeAttribute("title");
    }
  }
  updateOverflow(genreContainer);
}

/** Marquee: clientWidth is the measured visible width (set above), so scrollWidth-clientWidth is the real overflow. */
function updateOverflow(genreContainer: HTMLDivElement) {
  try {
    const overflowPx = genreContainer.scrollWidth - genreContainer.clientWidth;
    const overflow = overflowPx > 2;
    genreContainer.classList.toggle("genres-overflow", overflow);
    if (overflow) {
      genreContainer.style.setProperty(
        "--genres-scroll",
        `${overflowPx + 12}px`,
      );
      genreContainer.title = genreContainer.textContent || "";
    } else {
      genreContainer.style.removeProperty("--genres-scroll");
    }
  } catch (error) {
    console.warn("[HermesGenre] overflow check failed", error);
  }
}

async function renderGenres(
  genreContainer: HTMLDivElement,
  genres: string[],
  source: GenreResult["source"],
  confidence = 1,
) {
  genreContainer.className = "main-trackInfo-genres";
  genreContainer.innerHTML = "";

  const sb = sourceBadge({ source, confidence });
  const tooltip = sb.title;
  for (const genre of genres) {
    const genreTag = document.createElement("a");
    genreTag.className =
      "TextElement-marginal-textSubdued-text encore-text-marginal genre-tag";
    genreTag.textContent = camelize(genre);
    genreTag.setAttribute("genre", genre);
    genreTag.title = tooltip;
    genreTag.addEventListener("click", () => clickGenreTag(genre));
    genreContainer.appendChild(genreTag);
  }

  const badge = document.createElement("span");
  badge.className = "genre-source-badge";
  badge.textContent = sb.text.toUpperCase();
  badge.title = sb.title;
  genreContainer.appendChild(badge);

  await mountGenreContainer(genreContainer);
  requestAnimationFrame(() => {
    if (!disposed) layoutGenreContainer(genreContainer);
  });
}

async function clickGenreTag(genre: string) {
  // Show Skeleton while loading
  const skeleton = document.createElement("div");
  skeleton.className = "genre-description-container";
  skeleton.innerHTML = /* HTML */ `
    <div class="skeleton" style="height: 144px;"></div>
    <div class="skeleton" style="height: 86px;"></div>
    <div class="skeleton" style="height: calc(75vh - 375px);"></div>
  `;

  Spicetify.PopupModal.display({
    title: camelize(genre),
    content: skeleton,
    isLarge: true,
  });

  const playlist = await fetchSpotifyPlaylistURI(genre);
  const data = await fetchMusicalyst(genre);

  if (!data || !playlist) {
    Spicetify.PopupModal.hide();
    return;
  }

  // Check if the skeleton still exist to display the content
  if (document.querySelector("div.genre-description-container")) {
    Spicetify.PopupModal.display({
      title: camelize(genre),
      content: await createContent(data, playlist),
      isLarge: true,
    });
  }
}

async function fetchMusicalyst(
  genre: string,
): Promise<MusicalystData | undefined> {
  const escaped = replaceAll(replaceAll(genre, " ", "-"), ":", "");
  const url = `https://lucasoe.github.io/spicetify-genres/api/${escaped}.json`;
  try {
    const initialRequest = await fetch(url);
    const response = await initialRequest.json();
    return response.pageProps;
  } catch {
    Spicetify.showNotification(
      `Couldn't find genre on Musicalyst: ${camelize(genre)}`,
      true,
    );
    return;
  }
}

async function fetchSpotifyPlaylistURI(
  genre: string,
): Promise<SpotifyApi.SinglePlaylistResponse | undefined> {
  const name = `The Sound of ${camelize(genre)}`;
  // The limit parameter maximum value has been reduced from 50 to 10
  // https://developer.spotify.com/documentation/web-api/references/changes/february-2026
  const searchResponse: SpotifyApi.PlaylistSearchResponse =
    await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=playlist&limit=10`,
    );

  for (const item of searchResponse.playlists.items) {
    if (
      item.owner.id === "thesoundsofspotify" &&
      item.name.toLowerCase() === name.toLowerCase()
    ) {
      return Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/playlists/${item.id}`,
      );
    }
  }

  Spicetify.showNotification(`Couldn't find playlist: ${name}`, true);
  return;
}

async function createContent(
  data: MusicalystData,
  playlist: SpotifyApi.PlaylistObjectFull | undefined,
): Promise<HTMLDivElement> {
  const contentContainer = document.createElement("div");
  contentContainer.className = "genre-description-container";
  contentContainer.appendChild(await createDescription(data));
  contentContainer.appendChild(await createRelated(data));
  if (playlist) contentContainer.appendChild(await createPlaylist(playlist));
  contentContainer.appendChild(await createTopArtists(data));
  return contentContainer;
}

async function createDescription(
  data: MusicalystData,
): Promise<HTMLDivElement> {
  const descriptionContainer = document.createElement("div");
  descriptionContainer.innerHTML = `<p>${data.genresAdvancedInfo.description}</p>`;
  return descriptionContainer;
}

async function createRelated(data: MusicalystData): Promise<HTMLDivElement> {
  const genreContainer = document.createElement("div");
  genreContainer.className = "related-genres-container";
  data.relatedGenres.forEach((relatedGenre) => {
    const genreTag = document.createElement("div");
    genreTag.className =
      "TextElement-marginal-textSubdued-text encore-text-marginal genre-tag";
    genreTag.innerHTML = camelize(relatedGenre.genre);
    genreTag.onclick = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await clickGenreTag(relatedGenre.genre);
    };

    genreContainer.appendChild(genreTag);
  });

  return genreContainer;
}

async function createPlaylist(
  playlist: SpotifyApi.PlaylistObjectFull,
): Promise<HTMLDivElement> {
  const playlistContainer = document.createElement("div");
  playlistContainer.innerHTML = /* HTML */ `
    <a
      href=${playlist.uri}
      onclick="Spicetify.PopupModal.hide()"
      class="playlist-container"
    >
      <img src="${playlist.images[0].url}" class="playlist-image" />
      <div class="playlist-description">
        <h1 class="playlist-title">${playlist.name}</h1>
        <p class="playlist-stats">
          ${playlist.owner.display_name} • ${playlist.followers.total} likes •
          ${playlist.tracks?.total || 0} songs
        </p>
      </div>
    </a>
  `;
  return playlistContainer;
}

async function createTopArtists(data: MusicalystData): Promise<HTMLDivElement> {
  const artists = () => {
    let result = "";
    data.topArtists.forEach(async (artist) => {
      const artistURI = `spotify:artist:${artist.id}`;
      result += /* HTML */ `
        <a
          href=${artistURI}
          onclick="Spicetify.PopupModal.hide()"
          class="main-card-card"
        >
          <div class="main-cardImage-imageWrapper">
            <img
              class="main-image-image main-cardImage-image"
              draggable="false"
              loading="lazy"
              src="${artist.images[2].url}"
            />
          </div>
          <div
            class="main-cardHeader-text TypeElement-balladBold-textBase-type-paddingBottom_4px"
          >
            ${artist.name}
          </div>
        </a>
      `;
    });
    return result;
  };

  const topArtistsContainer = document.createElement("div");
  topArtistsContainer.innerHTML = /* HTML */ `
    <div class="description-container">
      <h2 class="main-type-alto" as="h2">Top Artists</h2>
      <div class="main-gridContainer-gridContainer">${artists()}</div>
    </div>
  `;
  return topArtistsContainer;
}
