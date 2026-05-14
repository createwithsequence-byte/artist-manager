export type ArtistInput = {
  name: string;
  spotifyUrl?: string;
  instagram?: string;
  tiktok?: string;
};

export type Release = {
  date: string;
  type: string;
  title: string;
};

export type Event = {
  date: string;
  venue: string;
  city: string;
  ticketUrl?: string;
  withArtist?: string;
};

export type RecentGig = {
  date: string;
  venue: string;
  city: string;
  country?: string;
};

export type SocialChannel = {
  handle: string;
  lastPost?: string;
  status: string;
};

export type SpotifyTopTrack = {
  name: string;
  playcount?: number | null;
  uri?: string;
};

export type SpotifyTopCity = {
  city: string;
  country?: string;
  region?: string;
  listeners?: number;
};

export type SpotifyInfo = {
  id?: string;
  name?: string;
  verified?: boolean;
  monthlyListeners?: number;
  followers?: number;
  topCity?: string;
  topCities?: SpotifyTopCity[];
  imageUrl?: string;
  latestRelease?: { name?: string; type?: string; date?: string };
  topTracks?: SpotifyTopTrack[];
  biography?: string;
};

export type ArtistLocation = {
  country?: string;
  area?: string;
  beginArea?: string;
  source: "musicbrainz" | "songfinch" | "unknown";
};

export type DeepDiveFact = {
  fact: string;
  category:
    | "biographical"
    | "career"
    | "creative"
    | "collaborations"
    | "personal"
    | "trivia";
  source: string;
};

export type DeepDive = {
  artist: string;
  context: string;
  facts: DeepDiveFact[];
  sourcesChecked: string[];
  sourcesRejected?: { url: string; reason: string }[];
  generatedAt: string;
};

export type SocialActivity = {
  instagram?: SocialChannel;
  tiktok?: SocialChannel;
};

export type Signal =
  | "active-touring"
  | "between-cycles"
  | "recent-release"
  | "industry-writer"
  | "quiet"
  | "new-artist";

export type ArtistReport = {
  name: string;
  summary: string;
  signals: Signal[];
  followers?: number;
  bandsintownUrl?: string;
  releases: Release[];
  events: Event[];
  recentGigs?: RecentGig[];
  socialActivity?: SocialActivity;
  spotify?: SpotifyInfo;
  location?: ArtistLocation;
  deepDive?: DeepDive;
  // CSV-provided Spotify URL — authoritative identity anchor.
  // Always prefer this over `spotify.id` (which can be wrong if fuzzy-matched).
  csvSpotifyUrl?: string;
  notes?: string;
};

export type ScoutEvent =
  | { type: "start"; artist: string; index: number; total: number }
  | { type: "step"; artist: string; step: string }
  | { type: "report"; artist: string; report: ArtistReport }
  | { type: "error"; artist: string; message: string }
  | { type: "done" };
