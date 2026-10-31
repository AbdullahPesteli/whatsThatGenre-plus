import { findTrackInfoHost } from "./host";
import "./styles.scss";
import { registerSettingsButton } from "./settings/panel";
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
const MAX_GENRE_WIDTH = 340;
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

  if (!settingsButtonRegistered)
    settingsButtonRegistered = registerSettingsButton({
      storage: safeStorage,
      refreshNow: () => forceRefreshHook?.(),
      changed: () => void refresh(),
    });

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

/**
 * Size and place the row from live measurements:
 *  - width: the space between the host's left edge and the now-playing widget's
 *    right edge, clamped to [MIN_GENRE_WIDTH, MAX_GENRE_WIDTH];
 *  - top: directly under the host, but only if the row fits above the seek bar.
 *    If it would overlap the progress bar (or be clipped by an overflow:hidden
 *    ancestor) it is hidden and the genres go to the host's tooltip instead.
 */
function layoutGenreContainer(genreContainer: HTMLDivElement) {
  const host = genreContainer.parentElement as HTMLElement | null;
  if (!host) return;

  const hostRect = host.getBoundingClientRect();
  const widget = host.closest(
    '[data-testid="now-playing-widget"], [data-testid="now-playing-bar"]',
  );
  const limitRight = widget
    ? widget.getBoundingClientRect().right
    : hostRect.right;
  const available = Math.floor(
    Math.max(hostRect.width, limitRight - hostRect.left),
  );
  const width = Math.min(MAX_GENRE_WIDTH, Math.max(MIN_GENRE_WIDTH, available));
  genreContainer.style.width = `${width}px`;
  genreContainer.style.maxWidth = `${width}px`;
  genreContainer.style.top = `${host.offsetHeight}px`;
  genreContainer.style.visibility = "";

  const rowHeight = genreContainer.offsetHeight;
  const rowTop = hostRect.bottom;
  const bar = document.querySelector('[data-testid="playback-progressbar"]');
  const barTop = bar
    ? bar.getBoundingClientRect().top
    : Number.POSITIVE_INFINITY;
  let clipped = false;
  for (
    let el = host.parentElement;
    el && el !== document.body;
    el = el.parentElement
  ) {
    if (getComputedStyle(el).overflow !== "visible") {
      clipped = rowTop + rowHeight > el.getBoundingClientRect().bottom + 0.5;
      break;
    }
  }
  const overlapsBar = rowTop + rowHeight > barTop + 0.5;
  if (overlapsBar || clipped) {
    genreContainer.style.visibility = "hidden";
    host.title = genreContainer.textContent || "";
  } else if (host.title && host.title === (genreContainer.textContent || "")) {
    host.removeAttribute("title");
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
