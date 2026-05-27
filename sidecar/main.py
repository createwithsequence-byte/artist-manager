"""
SpotAPI sidecar for Artist Manager.

Run: ./.venv/bin/uvicorn main:app --port 5001 --reload
Or via package script: `pnpm sidecar` from the parent directory.

Exposes one endpoint:
    GET /artist?name=Foo[&spotify_id=...]
Returns normalized artist data or 404.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import wikipediaapi  # type: ignore
from fastapi import FastAPI, HTTPException
from spotapi import Artist  # type: ignore

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("spot-sidecar")

app = FastAPI(title="Artist Manager · Spotify Sidecar")
_artist_client: Artist | None = None


def get_client(force_new: bool = False) -> Artist:
    global _artist_client
    if _artist_client is None or force_new:
        _artist_client = Artist()
    return _artist_client


def reset_client() -> Artist:
    """Re-init the Artist client. Use when the anonymous token expires."""
    log.info("re-initializing Spotify client (token likely expired)")
    return get_client(force_new=True)


def extract_spotify_id(url_or_id: str) -> str:
    """Accept raw IDs, 'spotify:artist:...' URIs, or open.spotify.com URLs."""
    if not url_or_id:
        return ""
    m = re.search(r"artist[/:]([A-Za-z0-9]{22})", url_or_id)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9]{22}", url_or_id):
        return url_or_id
    return ""


def safe_get(d: Any, *keys: Any, default: Any = None) -> Any:
    """Walk nested dicts/lists safely."""
    cur = d
    for k in keys:
        if cur is None:
            return default
        if isinstance(k, int) and isinstance(cur, list):
            cur = cur[k] if 0 <= k < len(cur) else None
        elif isinstance(cur, dict):
            cur = cur.get(k)
        else:
            return default
    return cur if cur is not None else default


def normalize_overview(raw: dict) -> dict:
    """
    SpotAPI's queryArtistOverview returns a nested GraphQL response.
    Extract the bits that matter for Artist Manager.
    """
    artist = safe_get(raw, "data", "artistUnion") or safe_get(raw, "data", "artist") or {}
    if not artist:
        return {}

    profile = artist.get("profile", {}) or {}
    stats = artist.get("stats", {}) or {}
    visuals = artist.get("visuals", {}) or {}
    discography = artist.get("discography", {}) or {}
    goods = artist.get("goods", {}) or {}

    # Latest release
    latest = safe_get(discography, "latest")
    latest_release = None
    if latest:
        latest_release = {
            "name": safe_get(latest, "name"),
            "type": safe_get(latest, "type"),
            "date": safe_get(latest, "date", "isoString")
            or safe_get(latest, "date", "year"),
            "uri": safe_get(latest, "uri"),
        }

    # Top tracks
    top_track_items = safe_get(discography, "topTracks", "items", default=[]) or []
    top_tracks = []
    for t in top_track_items[:10]:
        track = t.get("track") if isinstance(t, dict) else None
        if not track:
            continue
        top_tracks.append(
            {
                "name": track.get("name"),
                "playcount": int(track["playcount"])
                if str(track.get("playcount") or "").isdigit()
                else None,
                "uri": track.get("uri"),
            }
        )

    # Recent releases from discography (albums + singles, sorted by date)
    releases: list[dict] = []
    for group_key in ("albums", "singles", "compilations"):
        items = safe_get(discography, group_key, "items", default=[]) or []
        for item in items[:20]:
            release = item.get("releases", {}).get("items", [None])[0] if isinstance(
                item, dict
            ) else None
            release = release or item.get("release") or item
            if not isinstance(release, dict):
                continue
            releases.append(
                {
                    "name": release.get("name"),
                    "type": group_key.rstrip("s"),
                    "date": safe_get(release, "date", "isoString")
                    or safe_get(release, "date", "year"),
                    "uri": release.get("uri"),
                }
            )
    releases = [r for r in releases if r.get("date")]
    releases.sort(key=lambda r: str(r["date"]), reverse=True)

    image_url = safe_get(visuals, "avatarImage", "sources", 0, "url")

    # Top cities — up to 5, with listener count if available
    top_cities_raw = safe_get(stats, "topCities", "items", default=[]) or []
    top_cities = []
    for city_item in top_cities_raw[:5]:
        if not isinstance(city_item, dict):
            continue
        city_name = city_item.get("city")
        if not city_name:
            continue
        top_cities.append({
            "city": city_name,
            "country": city_item.get("country"),
            "region": city_item.get("region"),
            "listeners": city_item.get("numberOfListeners"),
        })

    return {
        "id": (artist.get("uri") or "").split(":")[-1] or None,
        "name": profile.get("name"),
        "verified": bool(profile.get("verified", False)),
        "monthlyListeners": stats.get("monthlyListeners"),
        "followers": stats.get("followers"),
        "topCity": top_cities[0]["city"] if top_cities else None,
        "topCities": top_cities,
        "imageUrl": image_url,
        "latestRelease": latest_release,
        "topTracks": top_tracks,
        "releases": releases[:20],
        "biography": safe_get(profile, "biography", "text"),
        "externalLinks": [
            {"name": link.get("name"), "url": link.get("url")}
            for link in (safe_get(profile, "externalLinks", "items", default=[]) or [])
        ],
        # Concerts — Spotify pulls these from Bandsintown server-side. This is
        # our route back to Bandsintown data now that Steel is Cloudflare-blocked.
        "concerts": _extract_concerts(goods),
    }


def _extract_concerts(goods: dict) -> list[dict]:
    """
    Extract upcoming concerts from artistUnion.goods.concerts.
    Spotify federates this data from Bandsintown (their partner), so we
    effectively get Bandsintown's indie tour coverage via Spotify's API.

    Filters out past concerts — Spotify's response includes recently-played
    shows alongside upcoming ones. Without this filter, "UPCOMING" sections
    in the UI show 2024 dates as if they were future shows.
    """
    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    items = safe_get(goods, "concerts", "items", default=[]) or []
    out: list[dict] = []
    for it in items[:60]:
        d = it.get("data") if isinstance(it, dict) else None
        if not isinstance(d, dict):
            continue
        loc = d.get("location") or {}
        # startDateIsoString is the canonical field; fall back to a few variants
        iso = (
            d.get("startDateIsoString")
            or safe_get(d, "startDate", "isoString")
            or safe_get(d, "date", "isoString")
        )
        date = (iso or "")[:10] if iso else None
        if not date or date < today:
            continue
        out.append({
            "date": date,
            "venue": loc.get("name") or "TBD",
            "city": loc.get("city") or "?",
            "festival": bool(d.get("festival")),
            "uri": d.get("uri"),
            "concertUrl": d.get("concertUrl") or d.get("url"),
        })
    return out


def _try_search(client: Artist, name: str) -> str | None:
    result = client.query_artists(name, limit=3)
    items = safe_get(result, "data", "searchV2", "artists", "items", default=[]) or []
    if not items:
        return None
    first = items[0]
    uri = safe_get(first, "data", "uri") or safe_get(first, "uri")
    if uri and ":" in uri:
        return uri.split(":")[-1]
    return None


def search_for_id(name: str) -> str | None:
    """Search Spotify for an artist by name. Auto-recovers from expired tokens."""
    if not name.strip():
        return None
    try:
        return _try_search(get_client(), name)
    except Exception as e:
        log.warning("search failed for %r (attempt 1): %s — re-initializing", name, e)
        try:
            return _try_search(reset_client(), name)
        except Exception as e2:
            log.warning("search failed for %r (attempt 2): %s", name, e2)
            return None


_wiki: wikipediaapi.Wikipedia | None = None


def get_wiki() -> wikipediaapi.Wikipedia:
    global _wiki
    if _wiki is None:
        _wiki = wikipediaapi.Wikipedia(
            user_agent="ArtistManager/0.1 (gregcmcd@gmail.com)",
            language="en",
        )
    return _wiki


@app.get("/")
def root() -> dict[str, Any]:
    """Friendly index so hitting / in a browser isn't a confusing 404."""
    return {
        "service": "artist-manager-sidecar",
        "status": "ok",
        "endpoints": {
            "/health": "liveness check",
            "/artist?name=...": "Spotify artist lookup (also accepts &spotify_id=)",
            "/wikipedia?name=...": "Wikipedia page lookup with section text",
        },
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/wikipedia")
def wikipedia(name: str | None = None) -> dict:
    """
    Look up an artist on Wikipedia. Tries a few candidate page titles
    (e.g. "Anna Vaus", "Anna Vaus (musician)", "Anna Vaus (singer)").
    Returns summary + section text + URL, or 404 if nothing found.
    """
    if not name or not name.strip():
        raise HTTPException(400, "name required")

    wiki = get_wiki()
    candidates = [
        name.strip(),
        f"{name.strip()} (musician)",
        f"{name.strip()} (singer)",
        f"{name.strip()} (band)",
        f"{name.strip()} (rapper)",
    ]

    for title in candidates:
        page = wiki.page(title)
        if not page.exists():
            continue
        # Detect disambiguation pages — they usually link to many pages
        # and have minimal direct content.
        summary = page.summary or ""
        if "may refer to" in summary.lower() and len(summary) < 300:
            continue
        sections: list[dict] = []
        for s in page.sections[:8]:
            text = (s.text or "").strip()
            if not text:
                continue
            sections.append({"title": s.title, "text": text[:1500]})
        return {
            "title": page.title,
            "url": page.fullurl,
            "summary": summary[:2000],
            "sections": sections,
        }

    raise HTTPException(404, f"no Wikipedia page found for {name!r}")


@app.get("/artist")
def get_artist(name: str | None = None, spotify_id: str | None = None) -> dict:
    """
    Look up an artist by name OR Spotify ID (or URL).
    If spotify_id is given, skip search and go straight to overview.
    """
    if not name and not spotify_id:
        raise HTTPException(400, "name or spotify_id required")

    artist_id = extract_spotify_id(spotify_id) if spotify_id else None
    if not artist_id and name:
        artist_id = search_for_id(name)

    if not artist_id:
        raise HTTPException(404, f"no Spotify match for {name or spotify_id!r}")

    try:
        raw = get_client().get_artist(artist_id)
    except Exception as e:
        log.warning("overview failed for %s (attempt 1): %s — re-initializing", artist_id, e)
        try:
            raw = reset_client().get_artist(artist_id)
        except Exception as e2:
            log.warning("overview failed for %s (attempt 2): %s", artist_id, e2)
            raise HTTPException(502, f"spotify upstream error: {e2}") from e2

    normalized = normalize_overview(raw)
    if not normalized:
        raise HTTPException(502, "could not parse Spotify response")
    return normalized
