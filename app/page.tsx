"use client";

import dynamic from "next/dynamic";
import { useState, useRef, useCallback, useEffect } from "react";
import type maplibregl from "maplibre-gl";
import LocationSearch from "./components/LocationSearch";
import TimelineSlider from "./components/TimelineSlider";
import AccumulationPanel from "./components/AccumulationPanel";
import NavigationPanel from "./components/NavigationPanel";
import SettingsPanel from "./components/SettingsPanel";
import DateInput from "./components/DateInput";
import DaySlider from "./components/DaySlider";
import type { AccumulationOptions } from "./components/MapView";
import { fetchRoutingGraph } from "./lib/overpass";
import { fetchTransitStops, getStopsFromCache, prefetchAdjacentTiles } from "./lib/transit";
import type { TransitStop } from "./lib/transit";
import { findBestHybridCandidate, hybridCandidateToRouteOption } from "./lib/hybrid-routing";
import { geocodeReverse } from "./lib/nominatim";
import { snapToEdge, paretoRoutes, graphToGeoJSON, haversineMeters, bfsReachable, snapToReachableEdge, RouteOption } from "./lib/routing";
import type { GraphEdge, RoutingGraph } from "./lib/routing";
import { recordRoutingRun, computeDerivedKpis } from "./lib/metrics";
import { snapOutsideBuilding } from "./lib/building-snap";
import type { MapBuildingQuery } from "./lib/building-snap";
import { longitudeToUtcOffsetMin, toMapLocal, fromMapLocal } from "./lib/timezone";

// MapView is client-only (uses browser APIs); skip SSR entirely
const MapView = dynamic(() => import("./components/MapView"), { ssr: false });

function todayAt(hours: number): Date {
  const d = new Date();
  d.setHours(hours, 0, 0, 0);
  return d;
}

function formatTime12h(d: Date, utcOffsetMin: number): string {
  const { hours: h24, minutes: m } = toMapLocal(d, utcOffsetMin);
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
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

function dateToDayOfYear(d: Date, utcOffsetMin: number): number {
  const { year, month, day } = toMapLocal(d, utcOffsetMin);
  return Math.floor(
    (Date.UTC(year, month, day) - Date.UTC(year, 0, 1)) / 86400000
  );
}

function TimeInput({ date, onChange, utcOffsetMin }: { date: Date; onChange: (d: Date) => void; utcOffsetMin: number }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const shouldCommit = useRef(true);

  function startEdit() {
    shouldCommit.current = true;
    setText(formatTime12h(date, utcOffsetMin));
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
      const next = fromMapLocal(date, utcOffsetMin, Math.floor(mins / 60), mins % 60);
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
      {formatTime12h(date, utcOffsetMin)}
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
  projectFn: (lng: number, lat: number) => [number, number],
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
      const [px, py] = projectFn(lng, lat);
      const x = Math.round(px * dpr);
      const y = Math.round(py * dpr);
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
  const [waypointALabel, setWaypointALabel] = useState<string | null>(null);
  const [waypointBLabel, setWaypointBLabel] = useState<string | null>(null);
  const [pendingSlot, setPendingSlot] = useState<'A' | 'B' | null>(null);
  const pendingSlotRef = useRef<'A' | 'B' | null>(null);
  pendingSlotRef.current = pendingSlot;

  // Transit state
  const [showTransit, setShowTransit]           = useState(false);
  const [transitStops, setTransitStops]         = useState<TransitStop[]>([]);
  const [transitPopupStop, setTransitPopupStop] = useState<TransitStop | null>(null);
  const showTransitRef   = useRef(showTransit);
  showTransitRef.current = showTransit;
  const transitStopsRef   = useRef<TransitStop[]>(transitStops);
  transitStopsRef.current = transitStops;

  const [isPlaying, setIsPlaying] = useState(false);
  const [sliderMode, setSliderMode] = useState<"time" | "day">("time");
  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Map center for passing to the timeline slider's sunrise/sunset calculation
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);

  const [mapUtcOffsetMin, setMapUtcOffsetMin] = useState<number>(
    () => -new Date().getTimezoneOffset()
  );
  const mapUtcOffsetMinRef = useRef(mapUtcOffsetMin);
  mapUtcOffsetMinRef.current = mapUtcOffsetMin;

  // Hold the map instance in a ref so changes don't trigger re-renders
  const mapRef = useRef<maplibregl.Map | null>(null);

  // Refs so imperative callbacks always see current values without re-creating
  const waypointARef = useRef(waypointA);
  const waypointBRef = useRef(waypointB);
  const calcGenRef = useRef(0); // incremented on every waypoint-clear to cancel in-flight calculations
  const waypointALabelRef = useRef(waypointALabel);
  const waypointBLabelRef = useRef(waypointBLabel);
  const dateRef = useRef(date);
  const sliderModeRef = useRef<"time" | "day">("time");
  waypointARef.current = waypointA;
  waypointBRef.current = waypointB;
  waypointALabelRef.current = waypointALabel;
  waypointBLabelRef.current = waypointBLabel;
  dateRef.current = date;
  sliderModeRef.current = sliderMode;

  // Advance 2 minutes per tick at 50ms → ~24s per full day
  useEffect(() => {
    if (isPlaying) {
      animTimerRef.current = setInterval(() => {
        setDate((prev) => {
          const offsetMin = mapUtcOffsetMinRef.current;
          if (sliderModeRef.current === "day") {
            const { year: yr, hours, minutes } = toMapLocal(prev, offsetMin);
            const doy = dateToDayOfYear(prev, offsetMin);
            const isLeap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
            const nextDoy = (doy + 1) % (isLeap ? 366 : 365);
            return new Date(
              Date.UTC(yr, 0, 1) + nextDoy * 86400000 - offsetMin * 60000 + (hours * 60 + minutes) * 60000
            );
          } else {
            const { hours, minutes } = toMapLocal(prev, offsetMin);
            const totalMins = (hours * 60 + minutes + 2) % 1440;
            return fromMapLocal(prev, offsetMin, Math.floor(totalMins / 60), totalMins % 60);
          }
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingSlot(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleMapReady = useCallback((map: maplibregl.Map) => {
    mapRef.current = map;
    const { lat, lng } = map.getCenter();
    setMapCenter([lat, lng]);
    const initialOffset = longitudeToUtcOffsetMin(lng);
    setMapUtcOffsetMin(initialOffset);
    setDate(new Date());
    map.on("moveend", () => {
      const c = map.getCenter();
      setMapCenter([c.lat, c.lng]);
      setMapUtcOffsetMin(longitudeToUtcOffsetMin(c.lng));
    });
  }, []);

  const handleSliderChange = useCallback((m: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { hours, minutes } = toMapLocal(prev, offsetMin);
      if (hours * 60 + minutes === m) return prev;
      return fromMapLocal(prev, offsetMin, Math.floor(m / 60), m % 60);
    });
  }, []);

  const handleDayOfYearChange = useCallback((day: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { year, hours, minutes } = toMapLocal(prev, offsetMin);
      return new Date(
        Date.UTC(year, 0, 1) + day * 86400000 - offsetMin * 60000 + (hours * 60 + minutes) * 60000
      );
    });
  }, []);

  const adjustYear = useCallback((delta: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { year, month, day, hours, minutes } = toMapLocal(prev, offsetMin);
      return new Date(
        Date.UTC(year + delta, month, day) - offsetMin * 60000 + (hours * 60 + minutes) * 60000
      );
    });
  }, []);

  const flyTo = useCallback((center: [number, number], zoom: number) => {
    mapRef.current?.flyTo({ center, zoom });
    // center is [lng, lat]
    const newOffset = longitudeToUtcOffsetMin(center[0]);
    setMapUtcOffsetMin(newOffset);
    setDate(new Date());
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
      const slot = pendingSlotRef.current;
      if (!slot) return;
      setNavError(null);
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      if (slot === 'A') {
        setWaypointA(lngLat);
        setWaypointALabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointALabel(lbl); });
        setPendingSlot(waypointBRef.current ? null : 'B');
      } else {
        setWaypointB(lngLat);
        setWaypointBLabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointBLabel(lbl); });
        setPendingSlot(null);
      }
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    []
  );

  const handleClear = useCallback(() => {
    calcGenRef.current++;
    setIsCalculating(false);
    setWaypointA(null);
    setWaypointB(null);
    setWaypointALabel(null);
    setWaypointBLabel(null);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
    setNavError(null);
    setRouteSolarIntensity(null);
    setPendingSlot(null);
  }, []);

  const handleToggleNavMode = useCallback(() => {
    setNavMode((prev) => {
      if (prev) {
        setWaypointA(null);
        setWaypointB(null);
        setWaypointALabel(null);
        setWaypointBLabel(null);
        setNavRoutes([]);
        setSelectedRouteIndex(0);
        setNavError(null);
        setRouteSolarIntensity(null);
        setPendingSlot(null);
      }
      return !prev;
    });
  }, []);

  const handleSetWaypointA = useCallback((coord: [number, number], label: string) => {
    setWaypointA(coord);
    setWaypointALabel(label);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
    const map = mapRef.current;
    if (map) map.flyTo({ center: coord, zoom: Math.max(map.getZoom(), 15) });
  }, []);

  const handleSetWaypointB = useCallback((coord: [number, number], label: string) => {
    setWaypointB(coord);
    setWaypointBLabel(label);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
    const map = mapRef.current;
    if (map) map.flyTo({ center: coord, zoom: Math.max(map.getZoom(), 15) });
  }, []);

  const handleSwapWaypoints = useCallback(() => {
    const a = waypointARef.current;
    const b = waypointBRef.current;
    const aLabel = waypointALabelRef.current;
    const bLabel = waypointBLabelRef.current;
    setWaypointA(b);
    setWaypointB(a);
    setWaypointALabel(bLabel);
    setWaypointBLabel(aLabel);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
  }, []);

  const handleClearWaypointA = useCallback(() => {
    calcGenRef.current++;
    setIsCalculating(false);
    setWaypointA(null);
    setWaypointALabel(null);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
  }, []);

  const handleMarkerDragEnd = useCallback(
    (slot: 'A' | 'B', coord: { lng: number; lat: number }) => {
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      setNavRoutes([]);
      setSelectedRouteIndex(0);
      if (slot === 'A') {
        setWaypointA(lngLat);
        setWaypointALabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointALabel(lbl); });
      } else {
        setWaypointB(lngLat);
        setWaypointBLabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointBLabel(lbl); });
      }
    },
    []
  );

  const handleClearWaypointB = useCallback(() => {
    calcGenRef.current++;
    setIsCalculating(false);
    setWaypointB(null);
    setWaypointBLabel(null);
    setNavRoutes([]);
    setSelectedRouteIndex(0);
  }, []);

  const calculateRoute = useCallback(async () => {
    const rawA = waypointARef.current;
    const rawB = waypointBRef.current;
    if (!rawA || !rawB) return;
    const map = mapRef.current;
    if (!map) {
      setNavError("Map not ready");
      return;
    }

    // Snap waypoints to outside any building they may be inside, so the routing
    // bbox always covers the streets around the building and snapToEdge finds a
    // nearby road rather than one on the far side of the structure.
    const a = snapOutsideBuilding(rawA, map as unknown as MapBuildingQuery);
    const b = snapOutsideBuilding(rawB, map as unknown as MapBuildingQuery);
    if (process.env.NODE_ENV !== "production") {
      if (a[0] !== rawA[0] || a[1] !== rawA[1])
        console.log(`[routing] waypoint A snapped out of building: [${rawA}] → [${a}]`);
      if (b[0] !== rawB[0] || b[1] !== rawB[1])
        console.log(`[routing] waypoint B snapped out of building: [${rawB}] → [${b}]`);
    }

    const myGen = ++calcGenRef.current;
    setIsCalculating(true);
    setNavError(null);

    const t0 = performance.now();
    let graphFetchMs = 0;
    let canvasReadMs = 0;
    let shadeSampleMs = 0;
    let dijkstraMs = 0;

    try {
      // 1. Bounding box with adaptive padding (~0.3× straight-line, clamped 0.002°–0.004°)
      const straightLineDistM = haversineMeters(a, b);
      // Minimum 0.005° (~555 m) ensures streets on all sides of large buildings
      // (e.g. Palazzo Vecchio) are always included even when a waypoint is
      // placed inside the building footprint.
      const padding = Math.max(0.005, Math.min(0.008, straightLineDistM / 111000 * 0.3));
      const south = Math.min(a[1], b[1]) - padding;
      const north = Math.max(a[1], b[1]) + padding;
      const west = Math.min(a[0], b[0]) - padding;
      const east = Math.max(a[0], b[0]) + padding;

      // 2. Fetch road graph; fit viewport only when the route bbox isn't already
      //    fully visible. fitBounds + map.once("idle") waits for all tiles to load
      //    before canvas capture — this is necessary to avoid shadeFactor=0 on
      //    off-screen edges, but is expensive when tiles are already present.
      //    Skipping it when the bbox is already visible saves 5–30 s per call.
      const tFetch = performance.now();
      const currentBounds = map.getBounds();
      const bboxInView =
        currentBounds.getWest()  <= west  &&
        currentBounds.getEast()  >= east  &&
        currentBounds.getSouth() <= south &&
        currentBounds.getNorth() >= north;

      const [graph] = await Promise.all([
        fetchRoutingGraph(south, west, north, east),
        bboxInView
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              map.fitBounds(
                [[west, south], [east, north]] as [[number, number], [number, number]],
                { padding: 50, duration: 0 }
              );
              map.once("idle", resolve);
            }),
      ]);
      graphFetchMs = performance.now() - tFetch;

      // 3. Read canvas once for shade sampling.
      //    With preserveDrawingBuffer:true the WebGL framebuffer is stable;
      //    drawImage transfers it directly to a 2D canvas without the
      //    toBlob → PNG-encode → createImageBitmap → PNG-decode round-trip
      //    that was adding 1–3 s on retina displays.
      const tCanvas = performance.now();
      const canvas = map.getCanvas();
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d")!;
      ctx2d.drawImage(canvas, 0, 0);
      const imageData = ctx2d.getImageData(0, 0, tmp.width, tmp.height);
      const dpr = window.devicePixelRatio || 1;
      canvasReadMs = performance.now() - tCanvas;

      // Build fast inline Mercator projection (avoids map.project() allocations per sample)
      const _mX = (lng: number) => (lng + 180) / 360;
      const _mY = (lat: number) => {
        const s = Math.sin(lat * Math.PI / 180);
        return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      };
      const _scale = Math.pow(2, map.getZoom()) * 512;
      const _mc = map.getCenter();
      const _cx = _mX(_mc.lng) * _scale;
      const _cy = _mY(_mc.lat) * _scale;
      const _W2 = canvas.width / dpr / 2;
      const _H2 = canvas.height / dpr / 2;
      const projectFast = (lng: number, lat: number): [number, number] => [
        _mX(lng) * _scale - _cx + _W2,
        _mY(lat) * _scale - _cy + _H2,
      ];

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
          // Sample density: ~1 sample per 25 m, minimum 3.
          const samples = Math.max(3, Math.ceil(edge.distanceM / 25));
          // Canonical from/to (low→high nodeId) for consistent left/right.
          const canonFrom: [number, number] = fromId < edge.toId
            ? [fromNode.lon, fromNode.lat] : [toNode.lon, toNode.lat];
          const canonTo: [number, number] = fromId < edge.toId
            ? [toNode.lon, toNode.lat] : [fromNode.lon, fromNode.lat];
          edgeShadeCache.set(key, sampleBothSidewalks(projectFast, imageData, dpr, canonFrom, canonTo, samples));
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
      if (process.env.NODE_ENV !== "production") {
        const snapA = routingGraph.nodes.get(startId);
        const snapB = routingGraph.nodes.get(endId);
        if (snapA) console.log(`[routing] A [${a}] snapped to road at [${snapA.lon},${snapA.lat}] (${haversineMeters(a, [snapA.lon, snapA.lat]).toFixed(1)} m)`);
        if (snapB) console.log(`[routing] B [${b}] snapped to road at [${snapB.lon},${snapB.lat}] (${haversineMeters(b, [snapB.lon, snapB.lat]).toFixed(1)} m)`);
      }

      // Connectivity fallback: if a waypoint snapped to a dead-end segment
      // (e.g. an OSM path inside a walled courtyard, disconnected from the
      // street network), re-snap to the nearest REACHABLE edge instead.
      const removeVirtual = (vid: number) => {
        routingGraph.nodes.delete(vid);
        routingGraph.adj.delete(vid);
        for (const edges of routingGraph.adj.values()) {
          const i = edges.findIndex((e) => e.toId === vid);
          if (i !== -1) edges.splice(i, 1);
        }
      };

      const MAX_SNAP_DIST_M = 100;
      let effectiveStartId = startId;
      let effectiveEndId   = endId;

      const reachableFromEnd = bfsReachable(routingGraph, endId);
      if (!reachableFromEnd.has(startId)) {
        removeVirtual(-1);
        const fallback = snapToReachableEdge(a, routingGraph, reachableFromEnd, -1);
        if (!fallback) {
          throw new Error(
            "The start point is in an area with no walkable streets nearby. Move it to a street or public footpath."
          );
        }
        if (fallback.distM > MAX_SNAP_DIST_M) {
          throw new Error(
            `The start point is ${Math.round(fallback.distM)} m from the nearest walkable street. Move it closer to a street.`
          );
        }
        effectiveStartId = fallback.id;
        if (process.env.NODE_ENV !== "production") {
          const sn = routingGraph.nodes.get(effectiveStartId);
          if (sn) console.log(`[routing] A re-snapped to connected road at [${sn.lon},${sn.lat}] (${fallback.distM.toFixed(1)} m)`);
        }
      }

      // Check end is also reachable (handles the symmetric case where B is isolated).
      const reachableFromStart = bfsReachable(routingGraph, effectiveStartId);
      if (!reachableFromStart.has(effectiveEndId)) {
        removeVirtual(-2);
        const fallback = snapToReachableEdge(b, routingGraph, reachableFromStart, -2);
        if (!fallback) {
          throw new Error(
            "The destination is in an area with no walkable streets nearby. Move it to a street or public footpath."
          );
        }
        if (fallback.distM > MAX_SNAP_DIST_M) {
          throw new Error(
            `The destination is ${Math.round(fallback.distM)} m from the nearest walkable street. Move it closer to a street.`
          );
        }
        effectiveEndId = fallback.id;
        if (process.env.NODE_ENV !== "production") {
          const sn = routingGraph.nodes.get(effectiveEndId);
          if (sn) console.log(`[routing] B re-snapped to connected road at [${sn.lon},${sn.lat}] (${fallback.distM.toFixed(1)} m)`);
        }
      }

      // 7. Compute solar context and run adaptive Dijkstra.
      const midLat = (a[1] + b[1]) / 2;
      const midLng = (a[0] + b[0]) / 2;
      const solarIntensity = computeSolarIntensity(dateRef.current, midLat, midLng);
      const CROSSING_PENALTY_M = 15; // ~15s wait at exposed intersection
      const opts = { crossingPenaltyM: CROSSING_PENALTY_M, solarIntensity, straightLineDistM };

      const paretoResults = paretoRoutes(routingGraph, effectiveStartId, effectiveEndId, opts);
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

      // Hybrid route (only when transit toggle is on and stops are available)
      if (showTransitRef.current && transitStopsRef.current.length >= 2) {
        const { hours: mapHour } = toMapLocal(dateRef.current, mapUtcOffsetMinRef.current);
        const candidate = findBestHybridCandidate({
          a,
          b,
          stops: transitStopsRef.current,
          walkRoutes: options,
          mapLocalHour: mapHour,
        });
        if (candidate) {
          const hybridOption = hybridCandidateToRouteOption(candidate);
          // Stitch full geometry: A → board → alight → B
          hybridOption.geojson = {
            type: "Feature",
            properties: { isTransit: true },
            geometry: {
              type: "LineString",
              coordinates: [
                [a[0], a[1]],
                [candidate.boardStop.lon, candidate.boardStop.lat],
                [candidate.alightStop.lon, candidate.alightStop.lat],
                [b[0], b[1]],
              ],
            },
          };
          options.push(hybridOption);
        }
      }

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

      // 8. Update state — bail if a waypoint was removed while we were computing
      if (calcGenRef.current !== myGen) return;
      setNavRoutes(options);
      setSelectedRouteIndex(0);
      setRouteSolarIntensity(solarIntensity);
    } catch (e) {
      setNavError(e instanceof Error ? e.message : "Routing failed");
    } finally {
      setIsCalculating(false);
    }
  }, []);

  const transitFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchSeqRef          = useRef(0);

  const fetchTransitForViewport = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !showTransitRef.current) return;
    const zoom = map.getZoom();
    // Safety floor: continent-scale bboxes cause Overpass timeouts
    if (zoom < 9) return;
    // Time-of-day gate: no transit midnight–5 AM map-local time
    const localHours = toMapLocal(dateRef.current, mapUtcOffsetMinRef.current).hours;
    if (localHours < 5) { setTransitStops([]); return; }

    const seq = ++fetchSeqRef.current;
    const b = map.getBounds();
    const [s, w, n, e] = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];

    // Phase 1: show cached stops immediately (zero latency)
    const cached = getStopsFromCache(s, w, n, e, zoom, 30);
    if (cached.length > 0 && seq === fetchSeqRef.current && showTransitRef.current) {
      setTransitStops(cached);
    }

    // Phase 2: fetch missing tiles in background, update when done
    const full = await fetchTransitStops(s, w, n, e, zoom, 30);
    if (seq === fetchSeqRef.current && showTransitRef.current && full !== null) {
      setTransitStops(full);
    }

    // Phase 3: prefetch adjacent tiles after 1.5 s idle
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = setTimeout(() => {
      if (seq === fetchSeqRef.current) prefetchAdjacentTiles(s, w, n, e);
    }, 1500);
  }, []);

  useEffect(() => {
    if (!showTransit) { setTransitStops([]); return; }
    fetchTransitForViewport();
    const map = mapRef.current;
    if (!map) return;
    // Debounce moveend: rapid panning fires many events; wait 400 ms after the last one
    const handler = () => {
      if (transitFetchTimerRef.current) clearTimeout(transitFetchTimerRef.current);
      transitFetchTimerRef.current = setTimeout(fetchTransitForViewport, 400);
    };
    map.on("moveend", handler);
    return () => {
      map.off("moveend", handler);
      if (transitFetchTimerRef.current) clearTimeout(transitFetchTimerRef.current);
      if (prefetchTimerRef.current)     clearTimeout(prefetchTimerRef.current);
    };
  }, [showTransit, fetchTransitForViewport]);

  // Strip hybrid route cards when transit is toggled off
  useEffect(() => {
    if (showTransit) return;
    setNavRoutes((prev) => {
      const filtered = prev.filter((r) => !r.transitLeg);
      if (filtered.length !== prev.length) setSelectedRouteIndex(0);
      return filtered;
    });
  }, [showTransit]);

  const selectedNavRoute = navRoutes[selectedRouteIndex]?.geojson ?? null;
  const selectedRoute = navRoutes[selectedRouteIndex];
  const navTransitLeg = selectedRoute?.transitLeg
    ? {
        boardLngLat:  [selectedRoute.transitLeg.boardStop.lon,  selectedRoute.transitLeg.boardStop.lat]  as [number, number],
        alightLngLat: [selectedRoute.transitLeg.alightStop.lon, selectedRoute.transitLeg.alightStop.lat] as [number, number],
        mode: selectedRoute.transitLeg.boardStop.mode,
      }
    : null;

  const { hours: _localH, minutes: _localM, year: _localYear } = toMapLocal(date, mapUtcOffsetMin);
  const mapLocalMins = _localH * 60 + _localM;

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
        mapClickActive={pendingSlot !== null}
        onMarkerDragEnd={handleMarkerDragEnd}
        transitStops={transitStops}
        showTransitStops={showTransit}
        onTransitStopClick={setTransitPopupStop}
        navTransitLeg={navTransitLeg}
      />

      {/* Pending waypoint selection banner */}
      {pendingSlot && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none flex items-center gap-2 bg-black/80 backdrop-blur-md border border-amber-400/40 rounded-full px-4 py-1.5 text-sm text-amber-300 select-none">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
          Click map to place waypoint {pendingSlot}
          <span className="text-white/30 text-xs ml-1">— Esc to cancel</span>
        </div>
      )}

      {/* Top-left overlay: search — hidden when nav sidebar is active (it moves inside sidebar) */}
      {!navMode && (
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
          <LocationSearch onSelect={flyTo} />
        </div>
      )}

      {/* Full-width timeline ruler + controls */}
      {!accumulation.enabled && (
        <div className="absolute bottom-0 left-0 right-0 z-10 bg-black/70 backdrop-blur-sm border-t border-white/10">
          {/* Floating tooltip — shows time in time mode, month name in month mode */}
          <div
            className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none z-20"
            style={{ bottom: "calc(100% + 6px)" }}
          >
            <div className="bg-amber-500 text-black text-[11px] font-bold px-2.5 py-0.5 rounded-md tabular-nums shadow-md whitespace-nowrap">
              {sliderMode === "time"
                ? formatTime12h(date, mapUtcOffsetMin)
                : new Date(date.getTime() + mapUtcOffsetMin * 60000)
                    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
            </div>
            <div
              style={{
                width: 0,
                height: 0,
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderTop: "5px solid #f59e0b",
              }}
            />
          </div>

          {/* Ruler — time or day of year */}
          {sliderMode === "time" ? (
            <TimelineSlider
              minutes={mapLocalMins}
              onChange={handleSliderChange}
              date={date}
              latDeg={mapCenter?.[0]}
              lngDeg={mapCenter?.[1]}
              utcOffsetMin={mapUtcOffsetMin}
            />
          ) : (
            <DaySlider
              dayOfYear={dateToDayOfYear(date, mapUtcOffsetMin)}
              year={_localYear}
              onChange={handleDayOfYearChange}
            />
          )}

          {/* Controls row */}
          <div className="flex items-center justify-center gap-3 px-4 py-2">
            {/* Play/pause */}
            <button
              onClick={() => setIsPlaying((p) => !p)}
              className="text-white/60 hover:text-amber-400 transition-colors flex items-center justify-center w-11 h-11 rounded-lg hover:bg-white/5"
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

            {/* Slider mode toggle — clock (time) / calendar (day) */}
            <button
              onClick={() => setSliderMode((m) => m === "time" ? "day" : "time")}
              className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-white/[0.05] hover:bg-white/10 border border-white/[0.08] transition-colors"
              title={sliderMode === "time" ? "Switch to day of year" : "Switch to time of day"}
            >
              {/* Clock icon */}
              <svg
                className={sliderMode === "time" ? "text-amber-400" : "text-white/30"}
                width="12" height="12" viewBox="0 0 12 12" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              >
                <circle cx="6" cy="6" r="5" />
                <polyline points="6,3.5 6,6 7.5,7.5" />
              </svg>
              <span className="text-[9px] text-white/25">/</span>
              {/* Calendar icon */}
              <svg
                className={sliderMode === "day" ? "text-amber-400" : "text-white/30"}
                width="12" height="12" viewBox="0 0 12 12" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              >
                <rect x="1" y="2" width="10" height="9" rx="1" />
                <line x1="1" y1="5" x2="11" y2="5" />
                <line x1="4" y1="1" x2="4" y2="3" />
                <line x1="8" y1="1" x2="8" y2="3" />
              </svg>
            </button>

            {/* Date / time inputs (time mode) or year picker (day mode) */}
            {sliderMode === "time" ? (
              <>
                <DateInput date={date} onChange={setDate} utcOffsetMin={mapUtcOffsetMin} />
                <TimeInput date={date} onChange={setDate} utcOffsetMin={mapUtcOffsetMin} />
              </>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => adjustYear(-1)}
                  className="text-white/50 hover:text-white/90 transition-colors w-9 h-9 flex items-center justify-center rounded-lg hover:bg-white/5"
                  aria-label="Previous year"
                >
                  <svg width="6" height="10" viewBox="0 0 6 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="5,1 1,5 5,9" />
                  </svg>
                </button>
                <span className="text-white/70 text-sm tabular-nums w-12 text-center">
                  {_localYear}
                </span>
                <button
                  onClick={() => adjustYear(+1)}
                  className="text-white/50 hover:text-white/90 transition-colors w-9 h-9 flex items-center justify-center rounded-lg hover:bg-white/5"
                  aria-label="Next year"
                >
                  <svg width="6" height="10" viewBox="0 0 6 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="1,1 5,5 1,9" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bottom-right overlay: view tools */}
      <div className="absolute bottom-20 right-3 z-10">
        <div className="bg-black/60 backdrop-blur-sm rounded-xl border border-white/[0.07] p-1.5 flex flex-col gap-1">
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
          <a
            href="/about"
            className="text-[10px] text-white/30 hover:text-white/60 transition-colors px-1.5 pt-0.5 pb-0.5"
          >
            About / API
          </a>
        </div>
      </div>
      {/* Navigation sidebar — self-positions absolutely (see NavigationPanel) */}
      <NavigationPanel
        navMode={navMode}
        onToggleNavMode={handleToggleNavMode}
        waypointA={waypointA}
        waypointB={waypointB}
        waypointALabel={waypointALabel}
        waypointBLabel={waypointBLabel}
        onSetWaypointA={handleSetWaypointA}
        onSetWaypointB={handleSetWaypointB}
        onSwapWaypoints={handleSwapWaypoints}
        onClearWaypointA={handleClearWaypointA}
        onClearWaypointB={handleClearWaypointB}
        onClear={handleClear}
        onCalculate={calculateRoute}
        isCalculating={isCalculating}
        routes={navRoutes}
        selectedRouteIndex={selectedRouteIndex}
        onSelectRoute={setSelectedRouteIndex}
        error={navError}
        solarIntensity={routeSolarIntensity}
        pendingSlot={pendingSlot}
        onSetPendingSlot={setPendingSlot}
        locationSearchSlot={navMode ? <LocationSearch onSelect={flyTo} /> : undefined}
        showTransit={showTransit}
        onToggleTransit={() => setShowTransit((t) => !t)}
        transitPopupStop={transitPopupStop}
        onDismissTransitPopup={() => setTransitPopupStop(null)}
      />
    </div>
  );
}
