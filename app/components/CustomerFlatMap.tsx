"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";
import type { CityAggregate } from "@/lib/customerCrossover";

// leaflet.heat ships no types — narrow cast for heatLayer.
type HeatLatLng = [number, number, number];
type LeafletWithHeat = typeof L & {
  heatLayer: (points: HeatLatLng[], opts?: Record<string, unknown>) => L.Layer;
};

const RED = "#F23222";
const LIME = "#C9F33A";
const INK = "#0A0A0A";
const CREAM = "#F4EFE6";

/**
 * 2D fallback for the globe. CARTO Positron tiles (light, terse) with two
 * overlapping layers:
 *   1. Heatmap — broad audience density at-a-glance
 *   2. Top-N city dots — weighted radius + lime accent on the densest 5,
 *      with click → popup showing city/state/count
 *
 * Why both? Heat alone shows clusters but hides individual cities; dots alone
 * lose the gestalt. Together they answer "where's the audience?" and
 * "which cities specifically?" at the same time.
 */
export default function CustomerFlatMap({
  aggregate,
}: {
  aggregate: CityAggregate[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);

  // Init once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      scrollWheelZoom: true,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
    }).setView([39.5, -98.35], 4);
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution: "© OpenStreetMap · © CARTO",
        subdomains: "abcd",
        maxZoom: 19,
      },
    ).addTo(map);
    mapRef.current = map;
    overlayRef.current = L.layerGroup().addTo(map);

    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Redraw whenever the aggregate changes.
  useEffect(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    overlay.clearLayers();
    if (aggregate.length === 0) return;

    const maxCount = aggregate[0]?.count ?? 1;
    const top5 = new Set(aggregate.slice(0, 5).map((a) => a.city));

    // Heatmap — weight by count, sqrt-scaled so megacities don't drown
    // long-tail markets visually.
    const heatPoints: HeatLatLng[] = aggregate.map((a) => [
      a.lat,
      a.lng,
      Math.sqrt(a.count / maxCount),
    ]);
    const Lh = L as LeafletWithHeat;
    Lh.heatLayer(heatPoints, {
      radius: 22,
      blur: 18,
      maxZoom: 7,
      gradient: {
        0.2: "#1E2DDB55",
        0.4: "#1E2DDB",
        0.7: "#F23222",
        1.0: "#C9F33A",
      },
    }).addTo(overlay);

    // City dots — top-N get lime accent, all others red. Radius sqrt-scaled.
    aggregate.forEach((a) => {
      const r = Math.max(3, Math.sqrt(a.count / maxCount) * 14);
      const isTop = top5.has(a.city);
      const dot = L.circleMarker([a.lat, a.lng], {
        radius: r,
        color: isTop ? LIME : RED,
        weight: 1.5,
        fillColor: isTop ? LIME : RED,
        fillOpacity: 0.6,
      });
      dot.bindPopup(
        `<div style="font-family:'JetBrains Mono',monospace;
                     font-size:11px;letter-spacing:0.04em;
                     background:${CREAM};color:${INK};
                     padding:6px 8px;border:1px solid ${INK};">
          <div style="font-weight:700">${a.city.toUpperCase()}, ${a.stateCode}</div>
          <div style="color:${RED};margin-top:2px">${a.count.toLocaleString()} FANS</div>
         </div>`,
        { className: "sf-popup" },
      );
      dot.addTo(overlay);
    });

    // Fly to the data envelope (US-centric for SF, but bounds-driven so an
    // international upload would still frame correctly).
    const bounds = L.latLngBounds(
      aggregate.map((a) => [a.lat, a.lng] as L.LatLngTuple),
    );
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.1), { animate: true, duration: 0.6 });
    }
  }, [aggregate]);

  return (
    <div ref={containerRef} className="w-full h-[560px] border border-ink/15" />
  );
}
