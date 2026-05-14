const BASE = "https://api.genius.com";

export type GeniusArtist = {
  id: number;
  name: string;
  url: string;
  description?: string;
  alternate_names?: string[];
  facebook?: string;
  instagram?: string;
  twitter?: string;
  songs?: { title: string; url: string; description?: string }[];
};

type SearchHit = {
  result: {
    primary_artist?: { id: number; name: string; url: string };
  };
};

type ArtistResponse = {
  response: {
    artist: {
      id: number;
      name: string;
      url: string;
      description?: { plain?: string };
      alternate_names?: string[];
      facebook_name?: string;
      instagram_name?: string;
      twitter_name?: string;
    };
  };
};

type SongsResponse = {
  response: {
    songs: { title: string; url: string }[];
  };
};

async function geniusFetch<T>(path: string): Promise<T | null> {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchGenius(name: string): Promise<GeniusArtist | null> {
  const search = await geniusFetch<{ response: { hits: SearchHit[] } }>(
    `/search?q=${encodeURIComponent(name)}`,
  );
  if (!search) return null;

  // Find first hit whose primary artist matches the search
  const nameLower = name.trim().toLowerCase();
  const matching =
    search.response.hits.find(
      (h) => h.result.primary_artist?.name?.toLowerCase().trim() === nameLower,
    ) ?? search.response.hits[0];
  const artistId = matching?.result?.primary_artist?.id;
  if (!artistId) return null;

  const detail = await geniusFetch<ArtistResponse>(
    `/artists/${artistId}?text_format=plain`,
  );
  if (!detail) return null;

  const a = detail.response.artist;

  // Pull top songs for context
  const songsRes = await geniusFetch<SongsResponse>(
    `/artists/${artistId}/songs?per_page=8&sort=popularity`,
  );

  return {
    id: a.id,
    name: a.name,
    url: a.url,
    description: a.description?.plain,
    alternate_names: a.alternate_names,
    facebook: a.facebook_name,
    instagram: a.instagram_name,
    twitter: a.twitter_name,
    songs: songsRes?.response?.songs?.map((s) => ({
      title: s.title,
      url: s.url,
    })),
  };
}
