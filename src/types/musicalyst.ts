/**
 * Shape of the Musicalyst genre pages served by
 * https://lucasoe.github.io/spicetify-genres/api/<genre>.json
 *
 * Only the fields this extension actually reads are declared. Reconstructed
 * from usage in src/app.tsx; see issue #2.
 */

export type MusicalystRelatedGenre = {
	genre: string;
};

export type MusicalystArtist = {
	id: string;
	name: string;
	images: { url: string }[];
};

export type MusicalystAdvancedInfo = {
	description: string;
};

/** The `pageProps` object returned by the endpoint. */
export type MusicalystData = {
	genresAdvancedInfo: MusicalystAdvancedInfo;
	relatedGenres: MusicalystRelatedGenre[];
	topArtists: MusicalystArtist[];
};