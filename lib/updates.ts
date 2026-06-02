/**
 * Artist announcements — upcoming releases / tours / merch / news the team
 * writes in, then broadcasts to the fanbase. Pure module (types + template
 * builder), no DB import, so the scout UI can use it client-side. Persistence
 * lives in lib/customers.ts.
 */

export type AnnouncementType = "release" | "tour" | "merch" | "news";

export type Announcement = {
  id: string;
  type: AnnouncementType;
  headline: string;
  /** Optional: release date, tour start, drop date. Free-form display string. */
  date?: string;
  /** Optional link — the song, the store, the ticket page. */
  url?: string;
  /** Optional extra detail. */
  blurb?: string;
  createdAt: string;
};

export const ANNOUNCEMENT_LABEL: Record<AnnouncementType, string> = {
  release: "RELEASE",
  tour: "TOUR",
  merch: "MERCH",
  news: "NEWS",
};

/** The one true announcement type-guard + normalizer. */
export function normalizeType(t: unknown): AnnouncementType {
  return t === "tour" || t === "merch" || t === "news" ? t : "release";
}

/**
 * Compose a fanbase-broadcast email for an announcement, in the artist's voice
 * with the Songfinch connection up top (the reason this fan knows them). No em
 * dashes. The body is a scaffold the sender edits before sending.
 */
export function buildBroadcastEmail(
  a: Announcement,
  artistName: string,
): { subject: string; body: string } {
  const headline = a.headline?.trim() || "some news";
  const subjectByType: Record<AnnouncementType, string> = {
    release: `${artistName} just released ${headline}`,
    tour: `${artistName} on tour: ${headline}`,
    merch: `New from ${artistName}: ${headline}`,
    news: `${artistName}: ${headline}`,
  };
  const leadByType: Record<AnnouncementType, string> = {
    release: `I just put out something new, ${headline}, and I wanted you to be among the first to hear it.`,
    tour: `I'm hitting the road, ${headline}, and I'd love to see you at a show.`,
    merch: `I've got something new for you, ${headline}.`,
    news: `I wanted to share some news with you. ${headline}.`,
  };
  const lines = [
    `Hey there! This is ${artistName} from Songfinch. I made a song for you a while back, and that connection still means a lot to me.`,
    ``,
    leadByType[a.type],
  ];
  if (a.date) lines.push(``, `When: ${a.date}`);
  if (a.blurb?.trim()) lines.push(``, a.blurb.trim());
  if (a.url?.trim()) lines.push(``, `Here's the link: ${a.url.trim()}`);
  lines.push(``, `Thank you for being part of this.`, `Best,`, artistName);
  return { subject: subjectByType[a.type], body: lines.join("\n") };
}
