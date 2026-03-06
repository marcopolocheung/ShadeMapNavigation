"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";

export interface AccumulationOptions {
  enabled: boolean;
  startDate: Date;
  endDate: Date;
  iterations: number;
}

interface MapViewProps {
  date: Date;
  accumulation: AccumulationOptions;
  onMapReady?: (map: maplibregl.Map) => void;
  navMode?: boolean;
  onMapClick?: (coord: { lng: number; lat: number }) => void;
  navWaypoints?: { a?: [number, number]; b?: [number, number] };
  navRoute?: GeoJSON.Feature<GeoJSON.LineString> | null;
  showSunLines?: boolean;
  mapClickActive?: boolean;
  onMarkerDragEnd?: (slot: 'A' | 'B', coord: { lng: number; lat: number }) => void;
}

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_API_KEY ?? "";
const SHADEMAP_KEY = process.env.NEXT_PUBLIC_SHADEMAP_API_KEY ?? "";
const ENABLE_3D = false;

function waitForMapLoad(map: maplibregl.Map): Promise<void> {
  return new Promise((resolve) => {
    function check() {
      if (map.loaded()) { resolve(); return; }
      map.once("render", check);
    }
    check();
  });
}

// ---------------------------------------------------------------------------
// Solar math
// ---------------------------------------------------------------------------

function computeSolarAzimuth(date: Date, latDeg: number, lngDeg: number): number {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * (Math.PI / 180);
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * (Math.PI / 180);
  const epsilon = (23.439 - 0.0000004 * n) * (Math.PI / 180);
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const GMST = (280.46061837 + 360.98564736629 * n) % 360;
  const RA = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)) * (180 / Math.PI);
  const HA = ((GMST + lngDeg - RA) % 360) * (Math.PI / 180);
  const latRad = latDeg * (Math.PI / 180);
  const sinElev = Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(HA);
  const cosElev = Math.sqrt(1 - sinElev * sinElev);
  if (cosElev < 1e-10) return 0;
  const sinAz = -Math.cos(dec) * Math.sin(HA) / cosElev;
  const cosAz = (Math.sin(dec) - Math.sin(latRad) * sinElev) / (Math.cos(latRad) * cosElev);
  return (Math.atan2(sinAz, cosAz) * (180 / Math.PI) + 360) % 360;
}

function computeSunriseSetAzimuths(
  date: Date,
  latDeg: number
): { rise: number; set: number } | null {
  const noon = new Date(date);
  noon.setHours(12, 0, 0, 0);
  const noonN = noon.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * noonN) % 360;
  const g = ((357.528 + 0.9856003 * noonN) % 360) * (Math.PI / 180);
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * (Math.PI / 180);
  const epsilon = (23.439 - 0.0000004 * noonN) * (Math.PI / 180);
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const latRad = latDeg * (Math.PI / 180);
  const cosHA0 = -Math.tan(latRad) * Math.tan(dec);
  if (Math.abs(cosHA0) > 1) return null;
  const HA0 = Math.acos(cosHA0);
  const azAt = (ha: number): number => {
    const sinE = Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha);
    const cosE = Math.sqrt(1 - sinE * sinE);
    if (cosE < 1e-10) return 0;
    const sA = -Math.cos(dec) * Math.sin(ha) / cosE;
    const cA = (Math.sin(dec) - Math.sin(latRad) * sinE) / (Math.cos(latRad) * cosE);
    return (Math.atan2(sA, cA) * (180 / Math.PI) + 360) % 360;
  };
  return { rise: azAt(-HA0), set: azAt(HA0) };
}

// ---------------------------------------------------------------------------
// SVG geometry helpers (screen-space: 0° = up, clockwise)
// ---------------------------------------------------------------------------

/** Convert a screen-space angle (deg, CW from up) to an SVG [x,y] on a circle. */
function svgPt(cx: number, cy: number, r: number, screenDeg: number): [number, number] {
  const rad = (screenDeg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

/**
 * SVG path for a pie sector from startScreen to endScreen (clockwise).
 * Returns empty string for degenerate arcs.
 */
function sectorPath(
  cx: number, cy: number, r: number,
  startScreen: number, endScreen: number
): string {
  const arc = ((endScreen - startScreen) + 360) % 360;
  if (arc < 0.01 || arc > 359.99) return "";
  const [sx, sy] = svgPt(cx, cy, r, startScreen);
  const [ex, ey] = svgPt(cx, cy, r, endScreen);
  const laf = arc > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${laf} 1 ${ex.toFixed(2)} ${ey.toFixed(2)} Z`;
}

// ---------------------------------------------------------------------------
// Sun viz state type
// ---------------------------------------------------------------------------

interface SunViz {
  sunAz: number;
  riseAz: number | null;
  setAz: number | null;
  bearing: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MapView({
  date,
  accumulation,
  onMapReady,
  onMapClick,
  navWaypoints,
  navRoute,
  showSunLines = false,
  mapClickActive = false,
  onMarkerDragEnd,
}: MapViewProps) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const mapRef          = useRef<maplibregl.Map | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shadeRef        = useRef<any>(null);
  const initRef         = useRef(false);
  const dateRef         = useRef(date);
  const shadeUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMapClickRef      = useRef(onMapClick);
  const onMarkerDragEndRef = useRef(onMarkerDragEnd);
  const markerARef         = useRef<maplibregl.Marker | null>(null);
  const markerBRef         = useRef<maplibregl.Marker | null>(null);
  const showSunLinesRef    = useRef(showSunLines);

  const [sunViz, setSunViz] = useState<SunViz>({
    sunAz: 180, riseAz: null, setAz: null, bearing: 0,
  });

  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  useEffect(() => { onMarkerDragEndRef.current = onMarkerDragEnd; }, [onMarkerDragEnd]);

  // -------------------------------------------------------------------------
  // Initialize map once
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || initRef.current) return;
    initRef.current = true;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${MAPTILER_KEY}`,
      center: [0, 20],
      zoom: 2,
      maxTileCacheSize: 50,
      maxParallelImageRequests: 6,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    mapRef.current = map;
    onMapReady?.(map);

    map.on("click", (e) => {
      onMapClickRef.current?.({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    });

    // Recompute all sun viz state (bearing + azimuths)
    const refreshSunViz = () => {
      if (!showSunLinesRef.current) return;
      const { lng, lat } = map.getCenter();
      const sunAz = computeSolarAzimuth(dateRef.current, lat, lng);
      const rs    = computeSunriseSetAzimuths(dateRef.current, lat);
      setSunViz({
        sunAz,
        riseAz:  rs?.rise ?? null,
        setAz:   rs?.set  ?? null,
        bearing: map.getBearing(),
      });
    };

    // rotate only changes bearing; azimuth values are unchanged
    map.on("rotate", () => {
      if (showSunLinesRef.current) {
        setSunViz((prev) => ({ ...prev, bearing: map.getBearing() }));
      }
    });

    map.on("moveend", refreshSunViz);

    map.on("load", async () => {
      map.addLayer({
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "maptiler_planet",
        "source-layer": "building",
        paint: {
          "fill-extrusion-color": "#2a2a2a",
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 0],
          "fill-extrusion-base":   ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.8,
        },
      });

      const TERRAIN_SOURCE_SPEC: maplibregl.RasterDEMSourceSpecification = {
        type: "raster-dem",
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 14,
        encoding: "terrarium",
      };
      const update3DVisibility = () => {
        if (!ENABLE_3D) return;
        const is3D = map.getPitch() > 0;
        map.setLayoutProperty("buildings-3d", "visibility", is3D ? "visible" : "none");
        if (is3D) {
          if (!map.getSource("terrain-dem")) map.addSource("terrain-dem", TERRAIN_SOURCE_SPEC);
          map.setTerrain({ source: "terrain-dem", exaggeration: 1 });
        } else {
          map.setTerrain(null);
          if (map.getSource("terrain-dem")) map.removeSource("terrain-dem");
        }
      };
      map.on("pitchend", update3DVisibility);
      update3DVisibility();
      if (!ENABLE_3D) map.setLayoutProperty("buildings-3d", "visibility", "none");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { default: ShadeMap } = (await import("mapbox-gl-shadow-simulator")) as { default: any };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shade: any = new ShadeMap({
        apiKey: SHADEMAP_KEY,
        date,
        color: "#01112f",
        opacity: 0.7,
        terrainSource: {
          tileSize: 256,
          maxZoom: 15,
          getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) =>
            `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
          getElevation: ({ r, g, b }: { r: number; g: number; b: number; a: number }) =>
            r * 256 + g + b / 256 - 32768,
        },
        getFeatures: async () => {
          if (map.getZoom() < 12) return [];
          await waitForMapLoad(map);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const features: any[] = map.querySourceFeatures("maptiler_planet", { sourceLayer: "building" });
          features.forEach((f) => {
            if (f.properties && !f.properties.height)
              f.properties.height = f.properties.render_height ?? 3.1;
          });
          features.sort((a, b) => (a.properties?.height ?? 0) - (b.properties?.height ?? 0));
          return features;
        },
      }).addTo(map);

      shadeRef.current = shade;
      map.on("resize", () => { shadeRef.current?.setDate(dateRef.current); });

      if (accumulation.enabled) {
        shade.setSunExposure(true, {
          startDate: accumulation.startDate,
          endDate: accumulation.endDate,
          iterations: accumulation.iterations,
        });
      }

      // Seed sun viz after full map load
      refreshSunViz();
    });

    return () => {
      if (shadeUpdateTimerRef.current) clearTimeout(shadeUpdateTimerRef.current);
      shadeRef.current?.remove();
      shadeRef.current = null;
      markerARef.current?.remove();
      markerARef.current = null;
      markerBRef.current?.remove();
      markerBRef.current = null;
      map.remove();
      mapRef.current = null;
      initRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Date changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    dateRef.current = date;
    if (shadeUpdateTimerRef.current) clearTimeout(shadeUpdateTimerRef.current);
    shadeUpdateTimerRef.current = setTimeout(() => { shadeRef.current?.setDate(date); }, 1);

    const map = mapRef.current;
    if (map?.isStyleLoaded() && showSunLinesRef.current) {
      const { lng, lat } = map.getCenter();
      const sunAz = computeSolarAzimuth(date, lat, lng);
      const rs    = computeSunriseSetAzimuths(date, lat);
      setSunViz({
        sunAz,
        riseAz:  rs?.rise ?? null,
        setAz:   rs?.set  ?? null,
        bearing: map.getBearing(),
      });
    }
  }, [date]);

  // -------------------------------------------------------------------------
  // showSunLines toggle
  // -------------------------------------------------------------------------
  useEffect(() => {
    showSunLinesRef.current = showSunLines;
    if (!showSunLines) return;
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const { lng, lat } = map.getCenter();
    const sunAz = computeSolarAzimuth(dateRef.current, lat, lng);
    const rs    = computeSunriseSetAzimuths(dateRef.current, lat);
    setSunViz({
      sunAz,
      riseAz:  rs?.rise ?? null,
      setAz:   rs?.set  ?? null,
      bearing: map.getBearing(),
    });
  }, [showSunLines]);

  // -------------------------------------------------------------------------
  // Accumulation mode
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!shadeRef.current) return;
    if (accumulation.enabled) {
      shadeRef.current.setSunExposure(true, {
        startDate: accumulation.startDate,
        endDate: accumulation.endDate,
        iterations: accumulation.iterations,
      });
    } else {
      shadeRef.current.setSunExposure(false);
    }
  }, [accumulation]);

  // -------------------------------------------------------------------------
  // Navigation waypoint markers
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markerARef.current?.remove(); markerARef.current = null;
    markerBRef.current?.remove(); markerBRef.current = null;
    if (navWaypoints?.a) {
      const mA = new maplibregl.Marker({ color: "#22c55e", draggable: true })
        .setLngLat(navWaypoints.a)
        .addTo(map);
      mA.on('dragend', () => {
        const ll = mA.getLngLat();
        onMarkerDragEndRef.current?.('A', { lng: ll.lng, lat: ll.lat });
      });
      markerARef.current = mA;
    }
    if (navWaypoints?.b) {
      const mB = new maplibregl.Marker({ color: "#ef4444", draggable: true })
        .setLngLat(navWaypoints.b)
        .addTo(map);
      mB.on('dragend', () => {
        const ll = mB.getLngLat();
        onMarkerDragEndRef.current?.('B', { lng: ll.lng, lat: ll.lat });
      });
      markerBRef.current = mB;
    }
  }, [navWaypoints]);

  // -------------------------------------------------------------------------
  // Nav route GeoJSON layer
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.loaded()) return;
    if (navRoute) {
      if (!map.getSource("nav-route")) {
        map.addSource("nav-route", { type: "geojson", data: navRoute });
        map.addLayer({
          id: "nav-route-line",
          type: "line",
          source: "nav-route",
          paint: { "line-color": "#f59e0b", "line-width": 4, "line-opacity": 0.9 },
        });
      } else {
        (map.getSource("nav-route") as maplibregl.GeoJSONSource).setData(navRoute);
      }
    } else {
      if (map.getLayer("nav-route-line")) map.removeLayer("nav-route-line");
      if (map.getSource("nav-route")) map.removeSource("nav-route");
    }
  }, [navRoute]);

  // -------------------------------------------------------------------------
  // Sun compass SVG
  // -------------------------------------------------------------------------
  const CX = 200, CY = 200, R = 160; // circle center and radius in SVG px

  const sunScreen  = sunViz.sunAz  - sunViz.bearing;
  const riseScreen = sunViz.riseAz !== null ? sunViz.riseAz - sunViz.bearing : null;
  const setScreen  = sunViz.setAz  !== null ? sunViz.setAz  - sunViz.bearing : null;

  // Daytime sector: rise → set (clockwise). Nighttime: set → rise (clockwise).
  const dayPath   = (riseScreen !== null && setScreen !== null)
    ? sectorPath(CX, CY, R, riseScreen, setScreen)   : null;
  const nightPath = (riseScreen !== null && setScreen !== null)
    ? sectorPath(CX, CY, R, setScreen, riseScreen)   : null;

  // Gradient endpoints on circle edge (for linear gradient direction)
  const [riseGx, riseGy] = riseScreen !== null ? svgPt(CX, CY, R, riseScreen) : [CX, CY - R];
  const [setGx,  setGy]  = setScreen  !== null ? svgPt(CX, CY, R, setScreen)  : [CX, CY + R];

  // Rise/set line endpoints
  const [riseLx, riseLy] = riseScreen !== null ? svgPt(CX, CY, R, riseScreen) : [CX, CY];
  const [setLx,  setLy]  = setScreen  !== null ? svgPt(CX, CY, R, setScreen)  : [CX, CY];

  // Sun arrowhead: gap between circle and base, tip further out; emoji beyond tip
  const ARROW_GAP = 8;
  const [tipX, tipY]     = svgPt(CX, CY, R + ARROW_GAP + 20, sunScreen);
  const [b1x, b1y]       = svgPt(CX, CY, R + ARROW_GAP,      sunScreen - 6);
  const [b2x, b2y]       = svgPt(CX, CY, R + ARROW_GAP,      sunScreen + 6);
  const [sunEmX, sunEmY] = svgPt(CX, CY, R + ARROW_GAP + 44, sunScreen);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className={`w-full h-full${mapClickActive ? ' cursor-crosshair' : ''}`} />

      {showSunLines && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          {/*
           * Single SVG for the whole sun compass.
           * CX/CY = 200, R = 160 (320px diameter — 2× the original 160px).
           * All geometry is in screen-space (already accounts for map bearing).
           * overflow="visible" lets the arrowhead extend just past the SVG bounds.
           */}
          <svg
            width="400"
            height="400"
            viewBox="0 0 400 400"
            style={{ overflow: "visible" }}
          >
            <defs>
              {/* Daytime gradient: burnt orange at sunrise → navy at sunset */}
              <linearGradient
                id="sunDayGrad"
                gradientUnits="userSpaceOnUse"
                x1={riseGx} y1={riseGy}
                x2={setGx}  y2={setGy}
              >
                <stop offset="0%"   stopColor="#c2410c" stopOpacity="0.30" />
                <stop offset="100%" stopColor="#1e3a8a" stopOpacity="0.30" />
              </linearGradient>
            </defs>

            {/* ── Nighttime sector (dark gray) ─────────────────────────── */}
            {nightPath
              ? <path d={nightPath} fill="#374151" fillOpacity="0.22" />
              : <circle cx={CX} cy={CY} r={R} fill="#374151" fillOpacity="0.22" />
            }

            {/* ── Daytime sector (burnt-orange→navy gradient) ────────── */}
            {dayPath && (
              <path d={dayPath} fill="url(#sunDayGrad)" />
            )}

            {/* ── Circle border ──────────────────────────────────────── */}
            <circle
              cx={CX} cy={CY} r={R}
              fill="none"
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="1.5"
            />

            {/* ── Sunrise line: center → circle edge ─────────────────── */}
            {riseScreen !== null && (
              <line
                x1={CX} y1={CY} x2={riseLx} y2={riseLy}
                stroke="#c2410c"
                strokeWidth="1.5"
                strokeOpacity="0.75"
              />
            )}

            {/* ── Sunset line: center → circle edge ──────────────────── */}
            {setScreen !== null && (
              <line
                x1={CX} y1={CY} x2={setLx} y2={setLy}
                stroke="#1e40af"
                strokeWidth="1.5"
                strokeOpacity="0.75"
              />
            )}

            {/* ── Sun arrowhead (gap from circle, tip only — no tail) ─── */}
            <polygon
              points={`${tipX.toFixed(2)},${tipY.toFixed(2)} ${b1x.toFixed(2)},${b1y.toFixed(2)} ${b2x.toFixed(2)},${b2y.toFixed(2)}`}
              fill="#fde047"
              fillOpacity="0.92"
            />

            {/* ── Sun emoji beyond arrowhead tip ────────────────────────── */}
            <text
              x={sunEmX.toFixed(2)}
              y={sunEmY.toFixed(2)}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="18"
              style={{ userSelect: "none" }}
            >
              ☀
            </text>
          </svg>
        </div>
      )}
    </div>
  );
}
