import "./styles.scss";
import type { MusicalystData } from "./types/musicalyst";
import { camelize, debounce, replaceAll, waitForElement } from "./utils";

// https://developer.spotify.com/documentation/web-api
// https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/spotify-api/index.d.ts

let cachedGenres: string[] = [];
let lastTrackKey = "";

type GenreResult = {
	genres: string[];
	source: "Discogs" | "Apple Music";
};

export default async function main() {
	while (!Spicetify?.Player || !Spicetify?.CosmosAsync || !Spicetify?.showNotification) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	const genreContainer = document.createElement("div");
	genreContainer.className = "main-trackInfo-genres";

	const refresh = async () => {
		try {
			await injectGenres(genreContainer);
		} catch (error) {
			console.error("[HermesGenre] render failed", error);
		}
	};

	Spicetify.Player.addEventListener("songchange", refresh);
	window.addEventListener(
		"resize",
		debounce(async () => {
			if (genreContainer.parentElement) await mountGenreContainer(genreContainer);
		})
	);

	// Spotify can restore a playing track without emitting songchange.
	await refresh();
	setTimeout(refresh, 1200);
}

async function injectGenres(genreContainer: HTMLDivElement) {
	const data = Spicetify.Player.data;
	if (!data?.item) {
		setTimeout(() => injectGenres(genreContainer), 1000);
		return;
	}

	const metadata = data.item.metadata || ({} as Spicetify.PlayerTrack["metadata"]);
	const title = data.item.name || metadata.title || "";
	let artist = data.item.artists?.[0]?.name || metadata.artist_name || metadata.album_artist_name || "";
	if (!artist && String(metadata.title || "").includes(" • ")) {
		artist = String(metadata.title).split(" • ").at(-1) || "";
	}
	const album = data.item.album?.name || metadata.album_title || "";
	const durationMs = data.item.duration?.milliseconds || Number(metadata.duration || 0);
	const artistId = metadata.artist_uri?.split(":")[2] || "";
	const trackKey = `${data.item.uri}|${title}|${artist}|${album}`;
	lastTrackKey = trackKey;

	genreContainer.className = "main-trackInfo-genres";
	genreContainer.innerHTML = '<span class="genre-loading">Genre aranıyor…</span>';
	await mountGenreContainer(genreContainer);

	const result = await resolveGenres({ artistId, title, artist, album, durationMs });
	if (lastTrackKey !== trackKey) return;

	cachedGenres = result?.genres || [];
	if (result && result.genres.length > 0) {
		await renderGenres(genreContainer, result.genres, result.source);
		return;
	}

	genreContainer.innerHTML = '<span class="genre-unavailable">Genre bulunamadı</span>';
}

async function resolveGenres(track: {
	artistId: string;
	title: string;
	artist: string;
	album: string;
	durationMs: number;
}): Promise<GenreResult | undefined> {
	// Persistent per-track cache so we never re-hit the network for a song we
	// already resolved (also keeps us well under Discogs' 25 req/min limit).
	const cacheKey = `hermesGenre:${normalize(track.artist)}|${normalizeTitle(track.title)}`;
	const cached = readCache(cacheKey);
	if (cached) return cached;

	// Spotify no longer exposes genres in the client API. Primary source is
	// Discogs (rich genre[] + sub-style[]); fall back to Apple Music (coarse
	// single genre) so the bar is never blank.
	let result: GenreResult | undefined;
	const discogs = await fetchDiscogsGenres(track);
	if (discogs && discogs.length) {
		result = { genres: discogs, source: "Discogs" };
	} else {
		const appleGenre = await fetchAppleGenre(track);
		if (appleGenre) result = { genres: [appleGenre], source: "Apple Music" };
	}

	if (result) writeCache(cacheKey, result);
	return result;
}

function readCache(key: string): GenreResult | undefined {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (parsed && Array.isArray(parsed.genres) && parsed.genres.length) return parsed as GenreResult;
	} catch {}
	return;
}

function writeCache(key: string, value: GenreResult) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {}
}

// Discogs public database search works from the browser with no token
// (Access-Control-Allow-Origin: *). We aggregate genre[] + style[] across the
// artist's matching releases and rank by frequency so the label reflects the
// artist's actual catalogue, not one random compilation.
async function fetchDiscogsGenres(track: {
	title: string;
	artist: string;
	album: string;
}): Promise<string[] | undefined> {
	if (!track.artist) return;
	const normArtist = normalize(track.artist);
	const q = (params: string) => `https://api.discogs.com/database/search?${params}&type=release&per_page=25`;
	const urls = [
		track.album ? q(`artist=${encodeURIComponent(track.artist)}&release_title=${encodeURIComponent(track.album)}`) : "",
		track.title ? q(`artist=${encodeURIComponent(track.artist)}&track=${encodeURIComponent(track.title)}`) : "",
		q(`artist=${encodeURIComponent(track.artist)}`),
	].filter(Boolean);

	for (const url of urls) {
		let results: any[] = [];
		try {
			const res = await fetch(url);
			if (!res.ok) continue;
			const payload = await res.json();
			results = Array.isArray(payload?.results) ? payload.results : [];
		} catch (error) {
			console.warn("[HermesGenre] Discogs lookup failed", url, error);
			continue;
		}

		// Only trust releases whose title contains our artist (search is fuzzy).
		const relevant = results.filter((item: any) => {
			const t = normalize(item.title || "");
			return tokenSubset(normArtist, t) || t.includes(normArtist);
		});
		const pool = relevant.length ? relevant : results;
		if (!pool.length) continue;

		const genreCounts = new Map<string, number>();
		const styleCounts = new Map<string, number>();
		for (const item of pool) {
			for (const g of item.genre || []) genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
			for (const st of item.style || []) styleCounts.set(st, (styleCounts.get(st) || 0) + 1);
		}
		// Prefer fine-grained styles (e.g. "Synth-pop", "Nu-Disco"); fall back to
		// broad genres ("Electronic") when a release has no styles listed.
		const ranked = (styleCounts.size ? styleCounts : genreCounts);
		const labels = [...ranked.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
		if (labels.length) return labels.slice(0, 5);
	}
	return;
}

async function fetchAppleGenre(track: {
	title: string;
	artist: string;
	album: string;
	durationMs: number;
}): Promise<string | undefined> {
	if (!track.title || !track.artist) return;
	const query = encodeURIComponent(`${track.title} ${track.artist}`);
	const urls = [
		`https://itunes.apple.com/search?term=${query}&entity=song&limit=25&country=us`,
		`https://itunes.apple.com/search?term=${query}&entity=song&limit=25&country=tr`,
	];
	let results: any[] = [];
	for (const url of urls) {
		try {
			const response = await fetch(url);
			if (!response.ok) continue;
			const payload = await response.json();
			results = results.concat(Array.isArray(payload?.results) ? payload.results : []);
		} catch (error) {
			console.warn("[HermesGenre] Apple Music lookup failed", url, error);
		}
	}
	const normalizedTitle = normalizeTitle(track.title);
	const normalizedArtist = normalize(track.artist);
	const normalizedAlbum = normalize(track.album);

	const candidates = results
		.map((item: any) => {
			const candTitle = normalizeTitle(item.trackName || "");
			const candArtist = normalize(item.artistName || "");
			const titleScore = similarity(normalizedTitle, candTitle);
			const artistScore = similarity(normalizedArtist, candArtist);
			// Spotify often lists only the lead artist ("Justice") while iTunes lists
			// the full credit ("Justice & Tame Impala"). Accept when every Spotify
			// artist token is present in the iTunes credit (subset match).
			const artistSubset = tokenSubset(normalizedArtist, candArtist);
			const albumScore = normalizedAlbum ? similarity(normalizedAlbum, normalize(item.collectionName || "")) : 0;
			const durationDiff = track.durationMs && item.trackTimeMillis
				? Math.abs(track.durationMs - Number(item.trackTimeMillis))
				: Number.POSITIVE_INFINITY;
			const durationScore = durationDiff <= 2500 ? 1 : durationDiff <= 7000 ? 0.5 : 0;
			const artistOk = artistScore >= 0.9 || artistSubset;
			// Strong identity: exact/near title + artist match + plausible duration.
			const exactCore = titleScore >= 0.92 && artistOk && durationDiff <= 6000;
			const artistCombined = Math.max(artistScore, artistSubset ? 0.9 : 0);
			const score = titleScore * 0.46 + artistCombined * 0.36 + albumScore * 0.1 + durationScore * 0.08;
			return { item, exactCore, score, durationDiff };
		})
		.filter(({ item, exactCore, score }: any) => item.primaryGenreName && exactCore && score >= 0.82)
		.sort((a: any, b: any) => b.score - a.score || a.durationDiff - b.durationDiff);

	if (!candidates.length) return;
	const winner = candidates[0];
	// If two equally plausible releases disagree on genre, prefer the current album;
	// otherwise fail closed instead of attaching a random compilation genre.
	const tied = candidates.filter((candidate: any) => Math.abs(winner.score - candidate.score) < 0.015);
	const tiedGenres = new Set(tied.map((candidate: any) => normalize(candidate.item.primaryGenreName)));
	if (tiedGenres.size > 1 && normalizedAlbum) {
		const sameAlbum = tied.find((candidate: any) => similarity(normalizedAlbum, normalize(candidate.item.collectionName || "")) >= 0.94);
		if (sameAlbum) return sameAlbum.item.primaryGenreName;
	}
	if (tiedGenres.size > 1) return;
	return winner.item.primaryGenreName;
}

function normalizeTitle(value: string): string {
	return normalize(value)
		.replace(/\b(remaster(?:ed)?|radio edit|single version|album version|explicit|clean)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalize(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function tokenSubset(a: string, b: string): boolean {
	if (!a || !b) return false;
	const bb = new Set(b.split(" ").filter(Boolean));
	const aa = a.split(" ").filter(Boolean);
	if (!aa.length) return false;
	return aa.every((token) => bb.has(token));
}

function similarity(a: string, b: string): number {
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
	const aa = new Set(a.split(" "));
	const bb = new Set(b.split(" "));
	let intersection = 0;
	for (const token of aa) if (bb.has(token)) intersection++;
	return intersection / Math.max(aa.size, bb.size);
}

async function mountGenreContainer(genreContainer: HTMLDivElement) {
	const infoContainer = await waitForElement(".main-nowPlayingWidget-trackInfo", 5000);
	if (infoContainer && genreContainer.parentElement !== infoContainer) infoContainer.appendChild(genreContainer);
}

async function renderGenres(
	genreContainer: HTMLDivElement,
	genres: string[],
	source: "Discogs" | "Apple Music"
) {
	genreContainer.className = "main-trackInfo-genres";
	genreContainer.innerHTML = "";

	const tooltip = source === "Discogs" ? "Kaynak: Discogs (genre + style)" : "Parça eşleşmesi: Apple Music";
	for (const genre of genres) {
		const genreTag = document.createElement("a");
		genreTag.className = "TextElement-marginal-textSubdued-text encore-text-marginal genre-tag";
		genreTag.textContent = camelize(genre);
		genreTag.setAttribute("genre", genre);
		genreTag.title = tooltip;
		genreTag.addEventListener("click", () => clickGenreTag(genre));
		genreContainer.appendChild(genreTag);
	}

	const badge = document.createElement("span");
	badge.className = "genre-source-badge";
	badge.textContent = source === "Discogs" ? "DISCOGS" : "TRACK";
	badge.title = source === "Discogs"
		? "Türler Discogs kataloğundan (genre + alt-stiller)"
		: "Discogs'ta bulunamadı; parça Apple Music ile eşleştirildi";
	genreContainer.appendChild(badge);

	await mountGenreContainer(genreContainer);

	// If the tags are wider than the now-playing bar, mark it so CSS can
	// auto-scroll on hover instead of letting Spotify wrap/clip mid-word.
	requestAnimationFrame(() => {
		try {
			const overflowPx = genreContainer.scrollWidth - genreContainer.clientWidth;
			const overflow = overflowPx > 2;
			genreContainer.classList.toggle("genres-overflow", overflow);
			if (overflow) {
				genreContainer.style.setProperty("--genres-scroll", `${overflowPx + 12}px`);
				genreContainer.title = genreContainer.textContent || "";
			} else {
				genreContainer.style.removeProperty("--genres-scroll");
			}
		} catch (error) {
			console.warn("[HermesGenre] overflow check failed", error);
		}
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

async function fetchMusicalyst(genre: string): Promise<MusicalystData | undefined> {
	const escaped = replaceAll(replaceAll(genre, " ", "-"), ":", "");
	const url = `https://lucasoe.github.io/spicetify-genres/api/${escaped}.json`;
	try {
		const initialRequest = await fetch(url);
		const response = await initialRequest.json();
		return response.pageProps;
	} catch {
		Spicetify.showNotification(`Couldn't find genre on Musicalyst: ${camelize(genre)}`, true);
		return;
	}
}

async function fetchSpotifyPlaylistURI(genre: string): Promise<SpotifyApi.SinglePlaylistResponse | undefined> {
	const name = `The Sound of ${camelize(genre)}`;
	// The limit parameter maximum value has been reduced from 50 to 10
	// https://developer.spotify.com/documentation/web-api/references/changes/february-2026
	const searchResponse: SpotifyApi.PlaylistSearchResponse = await Spicetify.CosmosAsync.get(
		`https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=playlist&limit=10`
	);

	for (const item of searchResponse.playlists.items) {
		if (item.owner.id === "thesoundsofspotify" && item.name.toLowerCase() === name.toLowerCase()) {
			return Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/playlists/${item.id}`);
		}
	}

	Spicetify.showNotification(`Couldn't find playlist: ${name}`, true);
	return;
}

async function createContent(
	data: MusicalystData,
	playlist: SpotifyApi.PlaylistObjectFull | undefined
): Promise<HTMLDivElement> {
	const contentContainer = document.createElement("div");
	contentContainer.className = "genre-description-container";
	contentContainer.appendChild(await createDescription(data));
	contentContainer.appendChild(await createRelated(data));
	if (playlist) contentContainer.appendChild(await createPlaylist(playlist));
	contentContainer.appendChild(await createTopArtists(data));
	return contentContainer;
}

async function createDescription(data: MusicalystData): Promise<HTMLDivElement> {
	const descriptionContainer = document.createElement("div");
	descriptionContainer.innerHTML = `<p>${data.genresAdvancedInfo.description}</p>`;
	return descriptionContainer;
}

async function createRelated(data: MusicalystData): Promise<HTMLDivElement> {
	const genreContainer = document.createElement("div");
	genreContainer.className = "related-genres-container";
	data.relatedGenres.forEach((relatedGenre) => {
		const genreTag = document.createElement("div");
		genreTag.className = "TextElement-marginal-textSubdued-text encore-text-marginal genre-tag";
		genreTag.innerHTML = camelize(relatedGenre.genre);
		genreTag.onclick = async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			await clickGenreTag(relatedGenre.genre);
		};

		genreContainer.appendChild(genreTag);
	});

	return genreContainer;
}

async function createPlaylist(playlist: SpotifyApi.PlaylistObjectFull): Promise<HTMLDivElement> {
	const playlistContainer = document.createElement("div");
	playlistContainer.innerHTML = /* HTML */ `
		<a href=${playlist.uri} onclick="Spicetify.PopupModal.hide()" class="playlist-container">
			<img src="${playlist.images[0].url}" class="playlist-image" />
			<div class="playlist-description">
				<h1 class="playlist-title">${playlist.name}</h1>
				<p class="playlist-stats">
					${playlist.owner.display_name} • ${playlist.followers.total} likes • ${playlist.items?.total || 0} songs
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
				<a href=${artistURI} onclick="Spicetify.PopupModal.hide()" class="main-card-card">
					<div class="main-cardImage-imageWrapper">
						<img
							class="main-image-image main-cardImage-image"
							draggable="false"
							loading="lazy"
							src="${artist.images[2].url}"
						/>
					</div>
					<div class="main-cardHeader-text TypeElement-balladBold-textBase-type-paddingBottom_4px">
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
