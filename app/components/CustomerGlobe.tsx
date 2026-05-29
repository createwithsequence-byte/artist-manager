"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import type { CityAggregate } from "@/lib/customerCrossover";

type Props = {
  aggregate: CityAggregate[];
  /** Initial auto-rotation; toggles off on user interaction. */
  autoRotate?: boolean;
  /** Layer mode: weighted dots vs. hex-bin clustering. Defaults to "points". */
  mode?: "points" | "hex";
};

const RED = "#F23222";
const BLUE = "#1E2DDB";
const LIME = "#C9F33A";
const CREAM = "#F4EFE6";

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
    return aggregate.map((a) => ({
      lat: a.lat,
      lng: a.lng,
      count: a.count,
      city: a.city,
      stateCode: a.stateCode,
      // altitude: 0 (ground) → 0.4 (top) scaled by sqrt(count)
      altitude: Math.min(0.5, Math.sqrt(a.count / maxCount) * 0.5),
      // radius: 0.15 → 1.2 sqrt-scaled
      radius: Math.max(0.15, Math.sqrt(a.count / maxCount) * 1.2),
      color: top5.has(a.city) ? LIME : RED,
    }));
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
    <div ref={containerRef} className="w-full h-[560px] bg-ink relative">
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
      />
    </div>
  );
}
