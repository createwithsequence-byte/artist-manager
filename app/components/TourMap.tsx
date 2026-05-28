"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";

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
const MILES_TO_METERS = 1609.34;

export default function TourMap({
  stops,
  customerPoints,
  suggestions,
  radiusMiles,
}: {
  stops: Stop[];
  customerPoints: Point[];
  suggestions: Suggestion[];
  radiusMiles: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);

  // Init the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      scrollWheelZoom: false,
      zoomControl: true,
      attributionControl: true,
    }).setView([39.5, -98.35], 4); // continental US default
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution: "© OpenStreetMap · © CARTO",
        subdomains: "abcd",
        maxZoom: 19,
      },
    ).addTo(map);
    overlayRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // Redraw overlays whenever data or radius changes.
  useEffect(() => {
    const map = mapRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    overlay.clearLayers();

    // 1. Customer density heatmap (underneath everything).
    if (customerPoints.length > 0) {
      const maxW = Math.max(...customerPoints.map((p) => p.weight), 1);
      const heat = (L as LeafletWithHeat).heatLayer(
        customerPoints.map(
          (p) => [p.lat, p.lng, p.weight / maxW] as HeatLatLng,
        ),
        {
          radius: 22,
          blur: 18,
          minOpacity: 0.25,
          gradient: {
            0.2: "#1E2DDB",
            0.45: "#C9F33A",
            0.7: "#F2A922",
            1.0: RED,
          },
        },
      );
      overlay.addLayer(heat);
    }

    // 2. Route line connecting tour stops in date order.
    if (stops.length >= 2) {
      overlay.addLayer(
        L.polyline(
          stops.map((s) => [s.lat, s.lng] as [number, number]),
          { color: INK, weight: 2, opacity: 0.55 },
        ),
      );
    }

    // 3. Radius rings + pins for each existing tour stop (red).
    for (const s of stops) {
      overlay.addLayer(
        L.circle([s.lat, s.lng], {
          radius: radiusMiles * MILES_TO_METERS,
          color: RED,
          weight: 1,
          opacity: 0.35,
          fillColor: RED,
          fillOpacity: 0.05,
        }),
      );
      overlay.addLayer(
        L.circleMarker([s.lat, s.lng], {
          radius: 6,
          color: "#fff",
          weight: 2,
          fillColor: RED,
          fillOpacity: 1,
        }).bindPopup(`<strong>${s.venue}</strong><br>${s.city} · ${s.date}`),
      );
    }

    // 4. Suggested stops (blue) + dashed spur to nearest existing stop.
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
            { color: BLUE, weight: 1.5, opacity: 0.5, dashArray: "4 4" },
          ),
        );
      }
      overlay.addLayer(
        L.circleMarker([sug.lat, sug.lng], {
          radius: 7,
          color: "#fff",
          weight: 2,
          fillColor: BLUE,
          fillOpacity: 1,
        }).bindPopup(
          `<strong>+ ${sug.city}</strong><br>${sug.customers} customers · suggested stop`,
        ),
      );
    }

    // Fit to the meaningful points (stops + suggestions; fall back to heat).
    const focus: [number, number][] = [
      ...stops.map((s) => [s.lat, s.lng] as [number, number]),
      ...suggestions.map((s) => [s.lat, s.lng] as [number, number]),
    ];
    const fitTarget =
      focus.length > 0
        ? focus
        : customerPoints.map((p) => [p.lat, p.lng] as [number, number]);
    if (fitTarget.length === 1) {
      map.setView(fitTarget[0], 7);
    } else if (fitTarget.length > 1) {
      map.fitBounds(L.latLngBounds(fitTarget).pad(0.2));
    }
  }, [stops, customerPoints, suggestions, radiusMiles]);

  return (
    <div
      ref={containerRef}
      className="w-full h-[360px] md:h-[440px] border border-ink/15"
      style={{ background: "#F4EFE6" }}
    />
  );
}
