"use client";

import dynamic from "next/dynamic";
import { useState, useRef, useCallback, useEffect } from "react";
import type maplibregl from "maplibre-gl";
import LocationSearch from "./components/LocationSearch";
import TimelineSlider from "./components/TimelineSlider";
import AccumulationPanel from "./components/AccumulationPanel";
import NavigationPanel from "./components/NavigationPanel";
import SettingsPanel from "./components/SettingsPanel";
import type { AccumulationOptions } from "./components/MapView";
import { fetchRoutingGraph } from "./lib/overpass";
import { snapToEdge, paretoRoutes, graphToGeoJSON, haversineMeters, RouteOption } from "./lib/routing";
import type { GraphEdge, RoutingGraph } from "./lib/routing";
import { recordRoutingRun, computeDerivedKpis } from "./lib/metrics";

// MapView is client-only (uses browser APIs); skip SSR entirely
const MapView = dynamic(() => import("./components/MapView"), { ssr: false });

function todayAt(hours: number): Date {
  const d = new Date();
  d.setHours(hours, 0, 0, 0);
  return d;
}

function formatTime12h(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

function toDateInput(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Parse a user-typed time string. Accepts:
 *   "6:30 AM" | "6:30AM" | "6:30 PM" | "14:30" | "6:30" | "6 AM" | "14" | "6"
 * Returns total minutes from midnight, or null if unparseable.
 */
function parseTime(s: string): number | null {
  s = s.trim();
  const pm = /pm$/i.test(s);
  const am = /am$/i.test(s);
  const hasMeridiem = am || pm;
  const core = s.replace(/\s*[ap]m\s*$/i, "").trim();
  const parts = core.split(":").map((p) => parseInt(p.trim(), 10));
  if (parts.some(isNaN)) return null;
  let h = parts[0];
  const m = parts.length > 1 ? parts[1] : 0;
  if (m < 0 || m > 59) return null;
  if (hasMeridiem) {
    if (h < 1 || h > 12) return null;
    if (am && h === 12) h = 0;
    if (pm && h !== 12) h += 12;
  } else {
    if (h < 0 || h > 23) return null;
  }
  return h * 60 + m;
}

function TimeInput({ date, onChange }: { date: Date; onChange: (d: Date) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const shouldCommit = useRef(true);

  function startEdit() {
    shouldCommit.current = true;
    setText(formatTime12h(date));
    setEditing(true);
  }

  function commit(val: string) {
    if (!shouldCommit.current) {
      shouldCommit.current = true;
      return;
    }
    setEditing(false);
    const mins = parseTime(val);
    if (mins !== null) {
      const next = new Date(date);
      next.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      onChange(next);
    }
  }

  if (editing) {
    return (
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            shouldCommit.current = false;
            setEditing(false);
          }
        }}
        className="bg-white/10 rounded px-2 py-1 text-white text-xs border border-amber-400/60 focus:outline-none w-20 text-center"
        autoFocus
      />
    );
  }

  return (
    <button
      onClick={startEdit}
      className="text-white/70 hover:text-white/90 text-xs tabular-nums w-20 text-center rounded px-2 py-1 hover:bg-white/10 transition-colors"
      title="Click to type a time (e.g. 6:30 AM, 14:30)"
    >
      {formatTime12h(date)}
    </button>
  );
}

/**
 * Sample shade independently for the left and right sidewalks of an edge.
 * ShadeMap overlay color is #01112f (R:1, G:17, B:47); shaded pixels have
 * heavy blue dominance (B/R > 1.8).
 *
 * `from`/`to` are [lng, lat] in the CANONICAL direction (used to define left/right
 * consistently). The caller is responsible for passing a canonical (low→high nodeId)
 * direction so that left/right are stable across bidirectional edge pairs.
 *
 * Returns { left, right } shade fractions (0–1), sampled at ±4 m perpendicular
 * offsets. These are assigned to separate parallel edges in the routing graph so
 * Dijkstra can pick the shaded sidewalk without any change to the core algorithm.
 */
function sampleBothSidewalks(
  map: maplibregl.Map,
  imageData: ImageData,
  dpr: number,
  from: [number, number], // [lng, lat], canonical direction
  to: [number, number],
  samples = 5
): { left: number; right: number } {
  const { data, width, height } = imageData;

  const sampleLine = (oLng: number, oLat: number): number => {
    let shadeSum = 0;
    let count = 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const lng = from[0] + t * (to[0] - from[0]) + oLng;
      const lat = from[1] + t * (to[1] - from[1]) + oLat;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pt = map.project([lng, lat] as any);
      const x = Math.round(pt.x * dpr);
      const y = Math.round(pt.y * dpr);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      // ShadeMap overlay #01112f: very dark (r+g+b~65), heavy blue (b/r>>1.8), b>>g.
      // Combined check rejects water, blue labels, and light basemap features.
      const isShaded =
        r + g + b < 200 &&
        (r === 0 ? b > 30 : b / r > 1.8) &&
        b > g * 1.5;
      shadeSum += isShaded ? 1 : 0;
      count++;
    }
    return count === 0 ? 0 : shadeSum / count;
  };

  const SIDEWALK_OFFSET_M = 4.0;
  const latMid = (from[1] + to[1]) / 2;
  const cosLat = Math.max(1e-10, Math.cos(latMid * Math.PI / 180));
  const dx = (to[0] - from[0]) * cosLat;
  const dy = to[1] - from[1];
  const len = Math.sqrt(dx * dx + dy * dy);

  let perpLng = 0, perpLat = 0;
  if (len > 1e-10) {
    perpLng = (-dy / len) * (SIDEWALK_OFFSET_M / (111195 * cosLat));
    perpLat = ( dx / len) * (SIDEWALK_OFFSET_M / 111195);
  }

  return {
    left:  sampleLine( perpLng,  perpLat),   // left  sidewalk of canonical direction
    right: sampleLine(-perpLng, -perpLat),   // right sidewalk of canonical direction
  };
}

/**
 * Computes solar intensity (0–1) proportional to sin(solar elevation angle).
 * Returns 0 at/below the horizon, ~1 at solar noon zenith.
 * Uses low-precision orbital mechanics accurate to ~1° — sufficient for
 * shade-routing weighting purposes.
 */
function computeSolarIntensity(date: Date, latDeg: number, lngDeg: number): number {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * (Math.PI / 180);
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * (Math.PI / 180);
  const epsilon = (23.439 - 0.0000004 * n) * (Math.PI / 180);
  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const GMST = (280.46061837 + 360.98564736629 * n) % 360;
  const HA = ((GMST + lngDeg - Math.atan2(
    Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)
  ) * (180 / Math.PI)) % 360) * (Math.PI / 180);
  const latRad = latDeg * (Math.PI / 180);
  const sinElev = Math.sin(latRad) * Math.sin(declination)
                + Math.cos(latRad) * Math.cos(declination) * Math.cos(HA);
  return Math.max(0, sinElev);
}


export default function Home() {
  const [date, setDate] = useState<Date>(() => todayAt(12));
  const [showSunLines, setShowSunLines] = useState(false);
  const [accumulation, setAccumulation] = useState<AccumulationOptions>({
    enabled: false,
    startDate: todayAt(6),
    endDate: todayAt(20),
    iterations: 32,
  });

  // Navigation state
  const [navMode, setNavMode] = useState(false);
  const [waypointA, setWaypointA] = useState<[number, number] | null>(null);
  const [waypointB, setWaypointB] = useState<[number, number] | null>(null);
  const [navRoutes, setNavRoutes] = useState<RouteOption[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [isCalculating, setIsCalculating] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const [routeSolarIntensity, setRouteSolarIntensity] = useState<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Map center for passing to the timeline slider's sunrise/sunset calculation
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);

  // Hold the map instance in a ref so changes don't trigger re-renders
  const mapRef = useRef<maplibregl.Map | null>(null);

  // Refs so imperative callbacks always see current values without re-creating
  const waypointARef = useRef(waypointA);
  const waypointBRef = useRef(waypointB);
  const dateRef = useRef(date);
  waypointARef.current = waypointA;
  waypointBRef.current = waypointB;
  dateRef.current = date;

  // Advance 2 minutes per tick at 50ms → ~24s per full day
  useEffect(() => {
    if (isPlaying) {
      animTimerRef.current = setInterval(() => {
        setDate((prev) => {
          const next = new Date(prev);
          const total = prev.getHours() * 60 + prev.getMinutes() + 2;
          next.setHours(Math.floor(total / 60) % 24, total % 60, 0, 0);
          return next;
        });
      }, 50);
    } else {
      if (animTimerRef.current) {
        clearInterval(animTimerRef.current);
        animTimerRef.current = null;
      }
    }
    return () => {
      if (animTimerRef.current) clearInterval(animTimerRef.current);
    };
  }, [isPlaying]);

  const handleMapReady = useCallback((map: maplibregl.Map) => {
    mapRef.current = map;
    const { lat, lng } = map.getCenter();
    setMapCenter([lat, lng]);
    map.on("moveend", () => {
      const c = map.getCenter();
      setMapCenter([c.lat, c.lng]);
    });
  }, []);

  const handleSliderChange = useCallback((m: number) => {
    setDate((prev) => {
      const next = new Date(prev);
      next.setHours(Math.floor(m / 60), m % 60, 0, 0);
      return next;
    });
  }, []);

  const flyTo = useCallback((center: [number, number], zoom: number) => {
    mapRef.current?.flyTo({ center, zoom });
  }, []);

  const getCanvas = useCallback(
    () => mapRef.current?.getCanvas(),
    []
  );

  const getBounds = useCallback(
    () => mapRef.current?.getBounds(),
    []
  );

  const handleMapClick = useCallback(
    (coord: { lng: number; lat: number }) => {
      if (!navMode) return;
      setNavError(null);
      const a = waypointARef.current;
      const b = waypointBRef.current;
      if (!a) {
        setWaypointA([coord.lng, coord.lat]);
      } else if (!b) {
        setWaypointB([coord.lng, coord.lat]);
      } else {
        // Third click: reset to new A, clear route
        setWaypointA([coord.lng, coord.lat]);
        setWaypointB(null);
        setNavRoutes([]);
        setSelectedRouteIndex(0);
      }
    },
    [navMode]
  );

  const handleClear = useCallback(() => {
    setWaypointA(null);
    setWaypointB(null);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
    setNavError(null);
    setRouteSolarIntensity(null);
  }, []);

  const handleToggleNavMode = useCallback(() => {
    setNavMode((prev) => {
      if (prev) {
        setWaypointA(null);
        setWaypointB(null);
        setNavRoutes([]);
        setSelectedRouteIndex(0);
        setNavError(null);
        setRouteSolarIntensity(null);
      }
      return !prev;
    });
  }, []);

  const calculateRoute = useCallback(async () => {
    const a = waypointARef.current;
    const b = waypointBRef.current;
    if (!a || !b) return;
    const map = mapRef.current;
    if (!map) {
      setNavError("Map not ready");
      return;
    }

    setIsCalculating(true);
    setNavError(null);

    const t0 = performance.now();
    let graphFetchMs = 0;
    let canvasReadMs = 0;
    let shadeSampleMs = 0;
    let dijkstraMs = 0;

    try {
      // 1. Bounding box with ~500m padding
      const padding = 0.005;
      const south = Math.min(a[1], b[1]) - padding;
      const north = Math.max(a[1], b[1]) + padding;
      const west = Math.min(a[0], b[0]) - padding;
      const east = Math.max(a[0], b[0]) + padding;

      // 2. Fetch road graph and fit viewport in parallel.
      //    fitBounds ensures every edge in the routing bbox is on-screen when
      //    we sample the canvas — eliminating the off-screen shadeFactor=0 bug.
      //    Both operations are independent so we race them together.
      const tFetch = performance.now();
      const [graph] = await Promise.all([
        fetchRoutingGraph(south, west, north, east),
        new Promise<void>((resolve) => {
          map.fitBounds(
            [[west, south], [east, north]] as [[number, number], [number, number]],
            { padding: 50, duration: 0 }
          );
          map.once("idle", resolve);
        }),
      ]);
      graphFetchMs = performance.now() - tFetch;

      // 3. Read canvas once for shade sampling
      const tCanvas = performance.now();
      const canvas = map.getCanvas();
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res)
      );
      if (!blob) throw new Error("Canvas read failed — WebGL context may be lost");
      const bmp = await createImageBitmap(blob);
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d")!;
      ctx2d.drawImage(bmp, 0, 0);
      const imageData = ctx2d.getImageData(0, 0, tmp.width, tmp.height);
      const dpr = window.devicePixelRatio || 1;
      canvasReadMs = performance.now() - tCanvas;

      // 4. Remove virtual nodes from a prior run on this cached graph.
      //    Done before shade sampling so the base graph is clean.
      for (const vid of [-1, -2]) {
        if (!graph.nodes.has(vid)) continue;
        graph.nodes.delete(vid);
        graph.adj.delete(vid);
        for (const edges of graph.adj.values()) {
          const i = edges.findIndex((e) => e.toId === vid);
          if (i !== -1) edges.splice(i, 1);
        }
      }

      // 5. Sample shade for each undirected edge (once per unordered pair).
      //    Canonical direction is low-nodeId → high-nodeId so left/right are
      //    consistent across the two directed copies of each undirected edge.
      const tShade = performance.now();
      let directedEdgeCount = 0;
      const edgeShadeCache = new Map<string, { left: number; right: number }>();

      for (const [fromId, edges] of graph.adj) {
        if (fromId < 0) continue;
        const fromNode = graph.nodes.get(fromId)!;
        for (const edge of edges) {
          if (edge.toId < 0) continue;
          const toNode = graph.nodes.get(edge.toId);
          if (!toNode) continue;
          directedEdgeCount++;
          const lo = Math.min(fromId, edge.toId);
          const hi = Math.max(fromId, edge.toId);
          const key = `${lo},${hi}`;
          if (edgeShadeCache.has(key)) continue;
          // Sample density: ~1 sample per 12 m, minimum 5.
          const samples = Math.max(5, Math.ceil(edge.distanceM / 12));
          // Canonical from/to (low→high nodeId) for consistent left/right.
          const canonFrom: [number, number] = fromId < edge.toId
            ? [fromNode.lon, fromNode.lat] : [toNode.lon, toNode.lat];
          const canonTo: [number, number] = fromId < edge.toId
            ? [toNode.lon, toNode.lat] : [fromNode.lon, fromNode.lat];
          edgeShadeCache.set(key, sampleBothSidewalks(map, imageData, dpr, canonFrom, canonTo, samples));
        }
      }
      shadeSampleMs = performance.now() - tShade;

      // 6. Build a sidewalk-level routing graph.
      //    Each undirected edge becomes TWO parallel directed edges per direction
      //    (one per sidewalk), so Dijkstra naturally picks the shadier sidewalk
      //    without any change to the core algorithm. The base graph (graph.adj)
      //    is never mutated here, keeping the cache clean between calls.
      //
      //    Left/right assignment for directed edge fromId→toId:
      //      canonical (fromId < toId): left = canonical-left, right = canonical-right
      //      reverse   (fromId > toId): left = canonical-right (their left when reversed)
      const tDijkstra = performance.now();
      const routingAdj = new Map<number, GraphEdge[]>();
      const ensureRA = (id: number) => { if (!routingAdj.has(id)) routingAdj.set(id, []); };

      for (const [fromId, edges] of graph.adj) {
        if (fromId < 0) continue;
        ensureRA(fromId);
        for (const edge of edges) {
          if (edge.toId < 0) continue;
          if (!graph.nodes.has(edge.toId)) continue;
          const lo = Math.min(fromId, edge.toId);
          const hi = Math.max(fromId, edge.toId);
          const { left, right } = edgeShadeCache.get(`${lo},${hi}`) ?? { left: 0, right: 0 };
          const isCanonical = fromId < edge.toId;
          const shadeA = isCanonical ? left : right;
          const shadeB = isCanonical ? right : left;
          routingAdj.get(fromId)!.push(
            { toId: edge.toId, distanceM: edge.distanceM, shadeFactor: shadeA },
            { toId: edge.toId, distanceM: edge.distanceM, shadeFactor: shadeB },
          );
        }
      }
      const routingGraph: RoutingGraph = { nodes: graph.nodes, adj: routingAdj };

      // Snap waypoints to nearest edge in the routing graph.
      // snapToEdge inserts virtual nodes into routingAdj (not graph.adj).
      const startId = snapToEdge(a, routingGraph, -1);
      const endId   = snapToEdge(b, routingGraph, -2);

      // 7. Compute solar context and run adaptive Dijkstra.
      const midLat = (a[1] + b[1]) / 2;
      const midLng = (a[0] + b[0]) / 2;
      const solarIntensity = computeSolarIntensity(dateRef.current, midLat, midLng);
      const straightLineDistM = haversineMeters(a, b);
      const CROSSING_PENALTY_M = 15; // ~15s wait at exposed intersection
      const opts = { crossingPenaltyM: CROSSING_PENALTY_M, solarIntensity, straightLineDistM };

      const paretoResults = paretoRoutes(routingGraph, startId, endId, opts);
      dijkstraMs = performance.now() - tDijkstra;

      // Assign labels: Pareto returns [shortest, knee/balanced, mostShaded] deduplicated.
      const ROUTE_LABELS = ["Shortest", "Balanced", "Most shaded"] as const;
      const options: RouteOption[] = paretoResults.map((result, i) => ({
        label: ROUTE_LABELS[i] ?? "Route",
        geojson: graphToGeoJSON(result.nodeIds, routingGraph),
        distanceM: result.distanceM,
        shadeCoverage: result.shadeCoverage,
        longestContinuousShadeM: result.longestContinuousShadeM,
        shadeTransitions: result.shadeTransitions,
        detourRatio: result.detourRatio,
        turnCount: result.turnCount,
      }));

      if (options.length === 0)
        throw new Error(
          "No walkable path found between the selected points. Try points on connected streets."
        );

      // 7. Record metrics before updating state
      const routeSnapshots = options.map((o) => ({
        label: o.label,
        distanceM: o.distanceM,
        shadeCoverage: o.shadeCoverage,
      }));
      const { shadeCoverageGainPp, pathLengthDeltaPct } =
        computeDerivedKpis(routeSnapshots);
      recordRoutingRun({
        timestamp: Date.now(),
        phases: {
          graphFetch: graphFetchMs,
          canvasRead: canvasReadMs,
          shadeSample: shadeSampleMs,
          dijkstra: dijkstraMs,
          total: performance.now() - t0,
        },
        graphNodeCount: graph.nodes.size,
        graphDirectedEdges: directedEdgeCount,
        routes: routeSnapshots,
        routeComputeMs: performance.now() - t0,
        shadeCoverageGainPp,
        pathLengthDeltaPct,
      });

      // 8. Update state
      setNavRoutes(options);
      setSelectedRouteIndex(0);
      setRouteSolarIntensity(solarIntensity);
    } catch (e) {
      setNavError(e instanceof Error ? e.message : "Routing failed");
    } finally {
      setIsCalculating(false);
    }
  }, []);

  const selectedNavRoute = navRoutes[selectedRouteIndex]?.geojson ?? null;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#0a0a0a]">
      {/* Full-screen map */}
      <MapView
        date={date}
        accumulation={accumulation}
        onMapReady={handleMapReady}
        onMapClick={handleMapClick}
        navWaypoints={{ a: waypointA ?? undefined, b: waypointB ?? undefined }}
        navRoute={selectedNavRoute}
        showSunLines={showSunLines}
      />

      {/* Top-left overlay: search */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
        <LocationSearch onSelect={flyTo} />
      </div>

      {/* Full-width timeline ruler + controls */}
      {!accumulation.enabled && (
        <div className="absolute bottom-0 left-0 right-0 z-10 bg-black/70 backdrop-blur-sm border-t border-white/10">
          <TimelineSlider
            minutes={date.getHours() * 60 + date.getMinutes()}
            onChange={handleSliderChange}
            date={date}
            latDeg={mapCenter?.[0]}
            lngDeg={mapCenter?.[1]}
          />
          {/* Centered controls row: play · date · time */}
          <div className="flex items-center justify-center gap-4 px-4 py-2">
            <button
              onClick={() => setIsPlaying((p) => !p)}
              className="text-white/60 hover:text-amber-400 transition-colors flex items-center justify-center w-5 h-5"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true">
                  <rect x="0" y="0" width="3.5" height="12" rx="0.75" />
                  <rect x="6.5" y="0" width="3.5" height="12" rx="0.75" />
                </svg>
              ) : (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true">
                  <path d="M0 0L10 6L0 12Z" />
                </svg>
              )}
            </button>
            <input
              type="date"
              value={toDateInput(date)}
              onChange={(e) => {
                const [y, m, d] = e.target.value.split("-").map(Number);
                const next = new Date(date);
                next.setFullYear(y, m - 1, d);
                setDate(next);
              }}
              className="bg-white/10 rounded px-2 py-1 text-white text-xs border border-white/10 focus:outline-none focus:border-white/30"
            />
            <TimeInput date={date} onChange={setDate} />
          </div>
        </div>
      )}

      {/* Bottom-left overlay: accumulation + navigation + about link */}
      <div className="absolute bottom-20 left-3 z-10 flex flex-col gap-2 items-start">
        <AccumulationPanel
          accumulation={accumulation}
          onChange={setAccumulation}
          getCanvas={getCanvas as () => HTMLCanvasElement | undefined}
          getBounds={getBounds as () => { getWest(): number; getEast(): number; getNorth(): number; getSouth(): number } | undefined}
        />
        <SettingsPanel
          showSunLines={showSunLines}
          onShowSunLinesChange={setShowSunLines}
        />
        <NavigationPanel
          navMode={navMode}
          onToggleNavMode={handleToggleNavMode}
          waypointA={waypointA}
          waypointB={waypointB}
          onClear={handleClear}
          onCalculate={calculateRoute}
          isCalculating={isCalculating}
          routes={navRoutes}
          selectedRouteIndex={selectedRouteIndex}
          onSelectRoute={setSelectedRouteIndex}
          error={navError}
          solarIntensity={routeSolarIntensity}
        />
        <a
          href="/about"
          className="text-xs text-white/40 hover:text-white/70 transition-colors px-1"
        >
          About / API
        </a>
      </div>
    </div>
  );
}
