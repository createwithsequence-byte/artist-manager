"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import type { CityAggregate } from "@/lib/customerCrossover";

type Props = {
  aggregate: CityAggregate[];
  /** Initial auto-rotation; toggles off on user interaction. */
  autoRotate?: boolean;
  /** Base representation: weighted dots vs. hex-bin clustering. */
  mode?: "points" | "hex";
  /** Stackable overlays — all additive on top of the base mode. */
  showRings?: boolean;
  showLabels?: boolean;
  showPins?: boolean;
  showHeat?: boolean;
  showArcs?: boolean;
  /** How many top markets get city-name labels (default 10). */
  labelCount?: number;
};

const RED = "#F23222";
const BLUE = "#1E2DDB";
const LIME = "#C9F33A";
const CREAM = "#F4EFE6";
const TOP_N = 10; // top cities that get rings / labels / pins

/**
 * 3D globe of every Songfinch customer city. Renders weighted points by
 * default (one dot per city, altitude + radius scaled by customer count),
 * with an optional hex-bin layer that auto-clusters nearby cities into
 * geographic prisms — useful when zooming out hides individual dots.
 *
 * Texture is the night-earth from three-globe's CDN examples — dark base
 * reads as a working data-viz surface, not a marketing globe, and the
 * cream/red Songfinch palette pops against it.
 *
 * Auto-rotation runs on mount, cancels on first user interaction (we
 * subscribe to OrbitControls' "start" event so the rotation stops the
 * INSTANT they grab the globe). Re-enabling is a button in the parent.
 */
export default function CustomerGlobe({
  aggregate,
  autoRotate = true,
  mode = "points",
  showRings = false,
  showLabels = false,
  showPins = false,
  showHeat = false,
  showArcs = false,
  labelCount = 10,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 800, height: 560 });

  // The globe needs explicit pixel dimensions — % units collapse the canvas
  // because three.js initializes once on mount. ResizeObserver keeps the
  // canvas in sync with the container as the layout reshapes (sidebar
  // toggle, browser resize, etc.) without forcing a remount.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        setSize({
          width: Math.max(320, Math.floor(rect.width)),
          height: Math.max(360, Math.floor(rect.height)),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pre-compute the per-point visual scale once per aggregate. sqrt() softens
  // the top-end so a city with 10,000 customers doesn't dwarf one with 50
  // (linear scaling would make smaller cities invisible). Top 5 by count get
  // the lime accent so the densest markets are findable at-a-glance.
  const points = useMemo(() => {
    if (aggregate.length === 0) return [];
    const maxCount = aggregate[0]?.count ?? 1;
    const top5 = new Set(aggregate.slice(0, 5).map((a) => a.city));
    return aggregate.map((a) => {
      const t = Math.sqrt(a.count / maxCount); // 0..1, softened
      return {
        lat: a.lat,
        lng: a.lng,
        count: a.count,
        city: a.city,
        stateCode: a.stateCode,
        // altitude is in GLOBE-RADII — the default is 0.1, so anything near
        // 0.5 turns dots into planet-sized spikes. Keep it a low surface lift
        // (≤0.07) so cities read as dots with a subtle "taller = more fans"
        // pop, not porcupine quills.
        altitude: 0.004 + t * 0.06,
        // radius in angular degrees; tight range so dense metros don't blob.
        radius: 0.18 + t * 0.34,
        color: top5.has(a.city) ? LIME : RED,
      };
    });
  }, [aggregate]);

  // Top cities feed the rings / labels / pins overlays — capped so they don't
  // clutter. Each carries city + count for labels/tooltips.
  const topCities = useMemo(
    () =>
      aggregate.slice(0, TOP_N).map((a) => ({
        lat: a.lat,
        lng: a.lng,
        city: a.city,
        stateCode: a.stateCode,
        count: a.count,
      })),
    [aggregate],
  );

  // Heatmap wants an array OF datasets, each an array of weighted points.
  const heatData = useMemo(
    () => [aggregate.map((a) => ({ lat: a.lat, lng: a.lng, weight: a.count }))],
    [aggregate],
  );

  // Labels get their OWN slice — decoupled from rings/pins (TOP_N) so the user
  // can dial label density (10 / 25 / 50) without flooding the other overlays.
  const labelCities = useMemo(
    () =>
      aggregate.slice(0, Math.max(0, labelCount)).map((a) => ({
        lat: a.lat,
        lng: a.lng,
        city: a.city,
        stateCode: a.stateCode,
        count: a.count,
      })),
    [aggregate, labelCount],
  );

  // ARCS — a great-circle "spine" threading the densest markets in rank order
  // (#1→#2→#3…). Reads as the fanbase's center of gravity, not a tour route.
  const arcsData = useMemo(() => {
    const n = Math.min(TOP_N, aggregate.length);
    const seq = aggregate.slice(0, n);
    const arcs: {
      startLat: number;
      startLng: number;
      endLat: number;
      endLng: number;
    }[] = [];
    for (let i = 0; i < seq.length - 1; i++) {
      arcs.push({
        startLat: seq[i].lat,
        startLng: seq[i].lng,
        endLat: seq[i + 1].lat,
        endLng: seq[i + 1].lng,
      });
    }
    return arcs;
  }, [aggregate]);

  // Auto-rotate + camera setup. Runs after globe init. Listens to
  // orbit-controls "start" so the FIRST drag/zoom kills rotation.
  useEffect(() => {
    const g = globeRef.current;
    if (!g) return;
    const controls = g.controls();
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 0.4;
    controls.enableZoom = true;
    const onStart = () => {
      controls.autoRotate = false;
    };
    controls.addEventListener("start", onStart);
    // Initial vantage: zoomed in on the US since 99% of SF customers are US.
    g.pointOfView({ lat: 39.5, lng: -98.35, altitude: 1.7 }, 1500);
    return () => {
      controls.removeEventListener("start", onStart);
    };
  }, [autoRotate]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full min-h-[520px] bg-ink relative"
    >
      <Globe
        ref={globeRef}
        width={size.width}
        height={size.height}
        // Night-earth base — dark, terse, makes Songfinch red/lime pop.
        globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
        backgroundColor="#0A0A0A"
        atmosphereColor={BLUE}
        atmosphereAltitude={0.18}
        showGraticules={false}
        // POINTS LAYER — one weighted dot per city.
        pointsData={mode === "points" ? points : []}
        pointLat="lat"
        pointLng="lng"
        pointColor="color"
        pointAltitude="altitude"
        pointRadius="radius"
        pointResolution={6}
        pointLabel={(d: unknown) => {
          const p = d as (typeof points)[number];
          return `
            <div style="background:${CREAM};color:#0A0A0A;padding:6px 10px;
                        font-family:'JetBrains Mono',monospace;font-size:11px;
                        border:1px solid #0A0A0A;letter-spacing:0.04em;">
              <div style="font-weight:700">${p.city.toUpperCase()}, ${p.stateCode}</div>
              <div style="color:${RED};margin-top:2px">${p.count.toLocaleString()} FANS</div>
            </div>`;
        }}
        // HEX LAYER — auto-clusters cities into hexagonal prisms.
        hexBinPointsData={mode === "hex" ? points : []}
        hexBinPointLat="lat"
        hexBinPointLng="lng"
        hexBinPointWeight="count"
        hexBinResolution={4}
        hexAltitude={(d: unknown) => {
          const bin = d as { sumWeight: number };
          const maxCount = aggregate[0]?.count ?? 1;
          return Math.min(
            0.6,
            Math.sqrt(bin.sumWeight / Math.max(1, maxCount * 5)) * 0.6,
          );
        }}
        hexTopColor={() => RED}
        hexSideColor={() => BLUE}
        hexBinMerge={false}
        hexLabel={(d: unknown) => {
          const bin = d as { sumWeight: number; points: typeof points };
          const topCity = bin.points
            .slice()
            .sort((a, b) => b.count - a.count)[0];
          return `
            <div style="background:${CREAM};color:#0A0A0A;padding:6px 10px;
                        font-family:'JetBrains Mono',monospace;font-size:11px;
                        border:1px solid #0A0A0A;letter-spacing:0.04em;">
              <div style="font-weight:700">${bin.points.length} CITIES</div>
              <div style="color:${RED}">${bin.sumWeight.toLocaleString()} FANS</div>
              ${topCity ? `<div style="color:#0A0A0A99;margin-top:2px">TOP · ${topCity.city.toUpperCase()}, ${topCity.stateCode}</div>` : ""}
            </div>`;
        }}
        // RINGS — pulsing rings on the densest markets (top N).
        ringsData={showRings ? topCities : []}
        ringLat="lat"
        ringLng="lng"
        ringColor={() => (t: number) => `rgba(242,50,34,${1 - t})`}
        ringMaxRadius={(d: object) => {
          const c = (d as { count: number }).count;
          const maxCount = aggregate[0]?.count ?? 1;
          return 2 + Math.sqrt(c / maxCount) * 5;
        }}
        ringPropagationSpeed={1.4}
        ringRepeatPeriod={1500}
        // LABELS — city name on the top N markets (N = labelCount control).
        labelsData={showLabels ? labelCities : []}
        labelLat="lat"
        labelLng="lng"
        labelText={(d: object) => (d as { city: string }).city}
        labelSize={0.5}
        labelDotRadius={0.18}
        labelColor={() => CREAM}
        labelResolution={2}
        labelAltitude={0.012}
        // ARCS — great-circle spine connecting the densest markets in rank order.
        arcsData={showArcs ? arcsData : []}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcColor={() => [`rgba(30,45,219,0.05)`, `rgba(201,243,58,0.85)`]}
        arcStroke={0.5}
        arcDashLength={0.45}
        arcDashGap={0.15}
        arcDashAnimateTime={2200}
        arcAltitudeAutoScale={0.35}
        // PINS — teardrop markers on the top markets (HTML elements).
        htmlElementsData={showPins ? topCities : []}
        htmlLat="lat"
        htmlLng="lng"
        htmlAltitude={0.02}
        htmlElement={(d: object) => {
          const c = d as { city: string; stateCode: string; count: number };
          const el = document.createElement("div");
          el.style.cssText =
            "transform:translate(-50%,-100%);pointer-events:auto;cursor:pointer;";
          el.title = `${c.city}, ${c.stateCode} · ${c.count.toLocaleString()} fans`;
          el.innerHTML = `<svg width="16" height="22" viewBox="0 0 16 22" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 0C3.6 0 0 3.6 0 8c0 5.5 8 14 8 14s8-8.5 8-14c0-4.4-3.6-8-8-8z" fill="#F23222" stroke="#fff" stroke-width="1.2"/>
            <circle cx="8" cy="8" r="3" fill="#fff"/>
          </svg>`;
          return el;
        }}
        // HEAT — surface density glow (single weighted dataset).
        heatmapsData={showHeat ? heatData : []}
        heatmapPointLat="lat"
        heatmapPointLng="lng"
        heatmapPointWeight="weight"
        heatmapBandwidth={0.9}
        heatmapTopAltitude={0.0}
        heatmapColorSaturation={1.6}
      />
    </div>
  );
}
