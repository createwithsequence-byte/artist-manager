"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";

// Tile-style toggle: four free, no-token providers covering the spectrum
// from "data viz clean" to "what's actually on the ground." Voyager is the
// new default — more roads, terrain hints, and place labels than Positron,
// which felt washed-out as a working map.
type TileStyle = "voyager" | "positron" | "terrain" | "dark";
const TILES: Record<
  TileStyle,
  { url: string; attribution: string; subdomains: string; label: string }
> = {
  voyager: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: "© OpenStreetMap · © CARTO",
    subdomains: "abcd",
    label: "VOYAGER",
  },
  positron: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: "© OpenStreetMap · © CARTO",
    subdomains: "abcd",
    label: "CLEAN",
  },
  terrain: {
    url: "https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}{r}.png",
    attribution:
      "© Stadia Maps · © Stamen Design · © OpenMapTiles · © OpenStreetMap",
    subdomains: "",
    label: "TERRAIN",
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: "© OpenStreetMap · © CARTO",
    subdomains: "abcd",
    label: "DARK",
  },
};

// leaflet.heat augments L at runtime but ships no types. Narrow cast.
type HeatLatLng = [number, number, number];
type LeafletWithHeat = typeof L & {
  heatLayer: (points: HeatLatLng[], opts?: Record<string, unknown>) => L.Layer;
};

type Stop = {
  lat: number;
  lng: number;
  city: string;
  date: string;
  venue: string;
};
type Suggestion = {
  lat: number;
  lng: number;
  city: string;
  customers: number;
};
type Point = { lat: number; lng: number; weight: number };

const RED = "#F23222";
const BLUE = "#1E2DDB";
const INK = "#0A0A0A";
const CREAM = "#F4EFE6";
const MILES_TO_METERS = 1609.34;

/** Numbered sequence pin so the route reads as an ordered journey (1→N).
 *  Provisional what-if stops render blue + dashed. */
function stopIcon(
  label: string,
  provisional: boolean,
  selected: boolean,
): L.DivIcon {
  const fill = provisional ? BLUE : RED;
  const size = selected ? 26 : 22;
  return L.divIcon({
    className: "",
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${provisional ? CREAM : fill};
      border:2px ${provisional ? "dashed" : "solid"} ${fill};
      color:${provisional ? fill : CREAM};
      font:700 ${selected ? 13 : 11}px 'JetBrains Mono',monospace;
      display:flex;align-items:center;justify-content:center;
      box-shadow:${selected ? `0 0 0 4px ${RED}33` : "none"};
    ">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function TourMap({
  stops,
  customerPoints,
  suggestions,
  radiusMiles,
  selectedLeg = null,
  provisionalKeys,
  onSelectStop,
  onSelectLeg,
}: {
  stops: Stop[];
  customerPoints: Point[];
  suggestions: Suggestion[];
  radiusMiles: number;
  /** Index i highlights the leg stops[i] → stops[i+1]. null = whole route. */
  selectedLeg?: number | null;
  /** "<date>|<city>" keys of provisional what-if stops, for distinct styling. */
  provisionalKeys?: Set<string>;
  onSelectStop?: (index: number) => void;
  onSelectLeg?: (index: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const [tileStyle, setTileStyle] = useState<TileStyle>("voyager");
  // Fan-density heat is OFF by default — the route + pins are the heroes; the
  // heatmap is an on-demand overlay, not a permanent wash (per the redesign).
  const [densityOn, setDensityOn] = useState(false);

  // Init once. Tile layer initialised with the default style; subsequent
  // style changes swap it in a separate effect (cheaper than re-init).
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      scrollWheelZoom: false,
      zoomControl: true,
      attributionControl: true,
    }).setView([39.5, -98.35], 4);
    const def = TILES.voyager;
    tileLayerRef.current = L.tileLayer(def.url, {
      attribution: def.attribution,
      subdomains: def.subdomains,
      maxZoom: 19,
    }).addTo(map);
    overlayRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
      tileLayerRef.current = null;
    };
  }, []);

  // Swap tile layer when the user toggles style. Leaflet's TileLayer.setUrl
  // would work for same-provider switches, but subdomains differ across our
  // four options (CARTO {a,b,c,d} vs Stadia {""}), so a fresh layer is
  // simpler and avoids quirks where the old subdomain list lingers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    const cfg = TILES[tileStyle];
    tileLayerRef.current = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      subdomains: cfg.subdomains,
      maxZoom: 19,
    }).addTo(map);
  }, [tileStyle]);

  // Redraw overlays on data / radius / selection change.
  useEffect(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    overlay.clearLayers();
    const isProvisional = (s: Stop) =>
      provisionalKeys?.has(`${s.date}|${s.city}`) ?? false;

    // 1. Customer density heatmap — single-hue red wash (faint→solid), only
    //    when the user opts in. The old blue→purple→red ramp at full opacity
    //    was the eye-dying "mold" smear; one calm hue reads as a reference
    //    layer, not a competing canvas.
    if (densityOn && customerPoints.length > 0) {
      const maxW = Math.max(...customerPoints.map((p) => p.weight), 1);
      overlay.addLayer(
        (L as LeafletWithHeat).heatLayer(
          customerPoints.map(
            (p) => [p.lat, p.lng, p.weight / maxW] as HeatLatLng,
          ),
          {
            radius: 22,
            blur: 20,
            minOpacity: 0.12,
            gradient: { 0.25: "#F2322255", 0.6: "#F2322299", 1.0: RED },
          },
        ),
      );
    }

    // 2. Route as PER-LEG segments — selected leg lit, others dimmed.
    for (let i = 0; i < stops.length - 1; i++) {
      const sel = selectedLeg === i;
      const seg = L.polyline(
        [
          [stops[i].lat, stops[i].lng],
          [stops[i + 1].lat, stops[i + 1].lng],
        ],
        {
          color: INK,
          weight: sel ? 4 : 2,
          opacity: sel ? 0.9 : 0.22,
          lineCap: "round",
        },
      );
      if (onSelectLeg) seg.on("click", () => onSelectLeg(i));
      overlay.addLayer(seg);
    }

    // 3. Radius rings — faint for all stops, stronger on the selected leg.
    stops.forEach((s, i) => {
      const onSelected = selectedLeg === i || selectedLeg === i - 1;
      overlay.addLayer(
        L.circle([s.lat, s.lng], {
          radius: radiusMiles * MILES_TO_METERS,
          color: RED,
          weight: 1,
          opacity: onSelected ? 0.4 : 0.12,
          fillColor: RED,
          fillOpacity: onSelected ? 0.06 : 0.02,
        }),
      );
    });

    // 4. Numbered sequence pins (date order → reads as a journey).
    stops.forEach((s, i) => {
      const prov = isProvisional(s);
      const selected = selectedLeg === i || selectedLeg === i - 1;
      const marker = L.marker([s.lat, s.lng], {
        icon: stopIcon(prov ? "+" : String(i + 1), prov, selected),
      }).bindPopup(
        `<strong>${s.venue}</strong><br>${s.city} · ${s.date}${
          prov ? "<br><em>additive</em>" : ""
        }`,
      );
      if (onSelectStop) marker.on("click", () => onSelectStop(i));
      overlay.addLayer(marker);
    });

    // 5. Fill candidates (blue ◇) + dashed spur to nearest stop.
    for (const sug of suggestions) {
      if (stops.length > 0) {
        let nearest = stops[0];
        let best = Infinity;
        for (const s of stops) {
          const d = (s.lat - sug.lat) ** 2 + (s.lng - sug.lng) ** 2;
          if (d < best) {
            best = d;
            nearest = s;
          }
        }
        overlay.addLayer(
          L.polyline(
            [
              [sug.lat, sug.lng],
              [nearest.lat, nearest.lng],
            ],
            { color: BLUE, weight: 1.5, opacity: 0.5, dashArray: "3 5" },
          ),
        );
      }
      overlay.addLayer(
        L.circleMarker([sug.lat, sug.lng], {
          radius: 6,
          color: BLUE,
          weight: 2,
          fillColor: CREAM,
          fillOpacity: 1,
        }).bindPopup(
          `<strong>+ ${sug.city}</strong><br>${sug.customers} customers · fill candidate`,
        ),
      );
    }
  }, [
    stops,
    customerPoints,
    suggestions,
    radiusMiles,
    selectedLeg,
    provisionalKeys,
    densityOn,
    onSelectStop,
    onSelectLeg,
  ]);

  // Camera — decoupled from redraw so dragging the radius slider never moves
  // the view. Smoothly flies to the selected leg, or frames the whole route.
  const routeKey = stops.map((s) => `${s.lat},${s.lng}`).join("|");
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (
      selectedLeg !== null &&
      selectedLeg >= 0 &&
      selectedLeg < stops.length - 1
    ) {
      const a = stops[selectedLeg];
      const b = stops[selectedLeg + 1];
      map.flyToBounds(
        L.latLngBounds([
          [a.lat, a.lng],
          [b.lat, b.lng],
        ]).pad(0.4),
        { duration: 0.6 },
      );
      return;
    }
    const pts: [number, number][] = stops.map((s) => [s.lat, s.lng]);
    const fit =
      pts.length > 0
        ? pts
        : customerPoints.map((p) => [p.lat, p.lng] as [number, number]);
    if (fit.length === 1) map.flyTo(fit[0], 7, { duration: 0.6 });
    else if (fit.length > 1)
      map.flyToBounds(L.latLngBounds(fit).pad(0.2), { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLeg, routeKey]);

  return (
    <div className="relative w-full h-[380px] md:h-[460px]">
      <div
        ref={containerRef}
        className="w-full h-full border border-ink/15"
        style={{ background: CREAM }}
      />
      {/* Tile-style toggle — absolute-positioned overlay so the map fills its
          container and the chooser sits over it without reflowing. Mono caps
          + ink/cream chips match the panel's typographic register. */}
      <div
        className="absolute top-2 right-2 flex border border-ink/40 bg-cream/95 backdrop-blur mono text-[10px] z-[1000]"
        role="radiogroup"
        aria-label="Map tile style"
      >
        {(Object.keys(TILES) as TileStyle[]).map((k, i) => (
          <button
            key={k}
            role="radio"
            aria-checked={tileStyle === k}
            onClick={() => setTileStyle(k)}
            className={`px-2 h-7 transition-colors ${
              i > 0 ? "border-l border-ink/25" : ""
            } ${
              tileStyle === k
                ? "bg-ink text-cream"
                : "text-ink/60 hover:text-ink"
            }`}
          >
            {TILES[k].label}
          </button>
        ))}
      </div>
      {/* Fan-density overlay toggle — off by default; the route + pins lead,
          density is an opt-in reference layer. Bottom-left so it doesn't
          collide with the tile chooser or Leaflet's zoom control. */}
      <button
        onClick={() => setDensityOn((v) => !v)}
        aria-pressed={densityOn}
        title="Overlay fan-density heatmap"
        className={`absolute bottom-6 right-2 flex items-center gap-1.5 px-2 h-7 border mono text-[10px] z-[1000] backdrop-blur transition-colors ${
          densityOn
            ? "bg-red text-cream border-red"
            : "bg-cream/95 text-ink/60 border-ink/40 hover:text-ink"
        }`}
      >
        {densityOn ? "◉" : "○"} DENSITY
      </button>
    </div>
  );
}
