import type { NextRequest } from "next/server";
import { generateDeepDive } from "@/lib/deepDive";
import type { ArtistLocation, SpotifyInfo } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });
  }

  const body = (await req.json()) as {
    name?: string;
    location?: ArtistLocation;
    spotifyId?: string;
    bandsintownUrl?: string;
    spotify?: SpotifyInfo;
  };
  const name = body.name?.trim();
  if (!name) {
    return Response.json({ error: "name required" }, { status: 400 });
  }

  try {
    const dive = await generateDeepDive({
      name,
      location: body.location,
      spotifyId: body.spotifyId,
      bandsintownUrl: body.bandsintownUrl,
      spotify: body.spotify,
    });
    return Response.json({ ok: true, dive });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
