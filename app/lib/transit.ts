export type TransitMode   = "subway" | "rail" | "tram" | "bus" | "ferry";
export type TransitSource = "transitland" | "overpass";

export interface TransitStop {
  id: number;
  lat: number;
  lon: number;
  name: string;
  mode: TransitMode;
  rankScore: number;
}

export const TRANSIT_MODE_COLOR: Record<TransitMode, string> = {
  subway: "#0070c9",
  rail:   "#ef4444",
  tram:   "#a855f7",
  bus:    "#22c55e",
  ferry:  "#06b6d4",
};

/** Sun exposure fraction per mode (0 = underground, 0.25 = windowed vehicle) */
export const TRANSIT_SUN_EXPOSURE: Record<TransitMode, number> = {
  subway: 0.0,
  rail:   0.0,
  tram:   0.25,
  bus:    0.25,
  ferry:  0.25,
};

/** Infer transit mode from OSM tags. Priority: subway > tram > rail > ferry > bus. */
export function inferMode(tags: Record<string, string | undefined>): TransitMode {
  if (tags.subway === "yes" || tags.railway === "subway_entrance" || tags.station === "subway") return "subway";
  if (tags.railway === "tram_stop") return "tram";
  if (tags.railway === "station" || tags.railway === "halt") return "rail";
  if (tags.ferry === "yes" || tags.amenity === "ferry_terminal") return "ferry";
  return "bus";
}

// ─── Ranking helpers ──────────────────────────────────────────────────────────

function modeRankScore(mode: TransitMode): number {
  if (mode === "subway") return 90;
  if (mode === "rail")   return 80;
  if (mode === "ferry" || mode === "tram") return 70;
  return 50; // bus
}

export function rankThresholdForZoom(zoom: number): number {
  if (zoom <= 11) return 80;
  if (zoom <= 13) return 65;
  if (zoom <= 15) return 45;
  if (zoom <= 17) return 20;
  return 0;
}

// ─── Tile-grid helpers ────────────────────────────────────────────────────────

export const TILE_SIZE = 0.05; // degrees per tile edge (~5 km at mid-latitudes)

export function tileKey(latFloor: number, lonFloor: number): string {
  return `lat${latFloor.toFixed(2)}_lon${lonFloor.toFixed(2)}`;
}

export function tilesForBbox(
  s: number, w: number, n: number, e: number
): Array<{ key: string; s: number; w: number; n: number; e: number }> {
  const T = TILE_SIZE;
  const round2 = (x: number) => Math.round(x * 100) / 100;
  // Avoid dividing by T (non-exact float 0.05) — work in integer units of 1/100
  const T100 = Math.round(T * 100); // 5
  const floorToTile = (x: number) => round2(Math.floor(Math.round(x * 100) / T100) * T);
  const latStart = floorToTile(s);
  const lonStart = floorToTile(w);
  const tiles: Array<{ key: string; s: number; w: number; n: number; e: number }> = [];
  for (let lat = latStart; lat < n; lat = round2(lat + T)) {
    for (let lon = lonStart; lon < e; lon = round2(lon + T)) {
      tiles.push({ key: tileKey(lat, lon), s: lat, w: lon, n: round2(lat + T), e: round2(lon + T) });
    }
  }
  return tiles;
}

const tileCache    = new Map<string, TransitStop[]>();
const inFlightTiles = new Map<string, Promise<TransitStop[]>>();

const overpassTileCache = new Map<string, TransitStop[]>();
const overpassInFlight  = new Map<string, Promise<TransitStop[]>>();

const FETCH_TIMEOUT_MS = 20_000;

/** Only for tests — clears all in-memory tile state between test cases. */
export function clearTileCache(): void {
  tileCache.clear();
  inFlightTiles.clear();
  overpassTileCache.clear();
  overpassInFlight.clear();
}

// ─── Overpass transit fetch (subway / rail only) ─────────────────────────────

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const OVERPASS_TRANSIT_MODES = new Set<TransitMode>(["subway", "rail"]);

interface OverpassElement {
  id: number;
  type: string;
  lat?: number;                            // set for nodes
  lon?: number;                            // set for nodes
  center?: { lat: number; lon: number };  // set for ways/relations via "out center"
  tags?: Record<string, string>;
}

async function fetchOverpassTransit(
  s: number, w: number, n: number, e: number,
  signal?: AbortSignal
): Promise<{ elements: OverpassElement[] }> {
  // nwr = node/way/relation so stations stored as polygons are included.
  // "out center tags" returns the centroid for ways/relations.
  const query =
    `[out:json][timeout:25];\n` +
    `(\n` +
    `  nwr["railway"~"^(station|halt|subway_entrance)$"](${s},${w},${n},${e});\n` +
    `  nwr["station"~"^(subway|light_rail|monorail)$"](${s},${w},${n},${e});\n` +
    `);\n` +
    `out center tags;`;
  const body = `data=${encodeURIComponent(query)}`;
  let lastErr: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ShadeMapNav/1.0" },
        body,
        signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) break;
    }
  }
  throw lastErr;
}

function parseOverpassStops(elements: OverpassElement[]): TransitStop[] {
  const seen = new Set<number>();
  const stops: TransitStop[] = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (seen.has(el.id) || lat === undefined || lon === undefined) continue;
    seen.add(el.id);
    const tags = el.tags ?? {};
    const mode = inferMode(tags as Record<string, string | undefined>);
    if (!OVERPASS_TRANSIT_MODES.has(mode)) continue;
    stops.push({ id: el.id, lat, lon, name: tags.name ?? "", mode, rankScore: modeRankScore(mode) });
  }
  stops.sort((a, b) => b.rankScore - a.rankScore);
  return stops;
}

async function fetchOverpassTile(s: number, w: number, n: number, e: number, key: string): Promise<TransitStop[]> {
  if (overpassTileCache.has(key)) return overpassTileCache.get(key)!;
  if (overpassInFlight.has(key))  return overpassInFlight.get(key)!;

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const promise = (async (): Promise<TransitStop[]> => {
    try {
      const data  = await fetchOverpassTransit(s, w, n, e, ctrl.signal);
      const stops = parseOverpassStops(data.elements);
      overpassTileCache.set(key, stops);
      return stops;
    } finally {
      clearTimeout(tid);
      overpassInFlight.delete(key);
    }
  })();

  overpassInFlight.set(key, promise);
  return promise;
}

// ─── Transitland types ────────────────────────────────────────────────────────

interface TransitlandStop {
  id: number;
  stop_name: string | null;
  geometry: { coordinates: [number, number] }; // [lon, lat] GeoJSON order
  location_type: number; // 0 = stop/platform, 1 = parent station
  route_stops?: Array<{ route: { route_type: number } }>;
}

interface TransitlandResponse {
  stops: TransitlandStop[];
  meta?: { after?: number; next?: string };
}

export function modeFromRouteType(routeType: number): TransitMode {
  if (routeType === 0)  return "tram";
  if (routeType === 1)  return "subway";
  if (routeType === 2)  return "rail";
  if (routeType === 4)  return "ferry";
  if (routeType === 5 || routeType === 6) return "tram";   // cable car / gondola
  if (routeType === 7)  return "rail";    // funicular
  if (routeType === 12) return "subway";  // monorail
  return "bus"; // 3=bus, 11=trolleybus, unknown
}

// ─── Transitland fetch ────────────────────────────────────────────────────────

const TRANSITLAND_API_KEY = process.env.NEXT_PUBLIC_TRANSITLAND_API_KEY ?? "";
// No pagination — per_page=200 covers ~25 km × 25 km tiles in all known cities.

async function fetchTransitland(
  s: number, w: number, n: number, e: number,
  signal?: AbortSignal
): Promise<TransitlandResponse | null> {
  // Transitland bbox order: lon_min,lat_min,lon_max,lat_max = w,s,e,n
  const url = `https://transit.land/api/v2/rest/stops` +
    `?apikey=${TRANSITLAND_API_KEY}` +
    `&bbox=${w},${s},${e},${n}` +
    `&include_route_stops=true` +
    `&per_page=200`;
  const r = await fetch(url, {
    headers: { "User-Agent": "ShadeMapNav/1.0" },
    signal,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as TransitlandResponse;
}

function parseStops(data: TransitlandResponse): TransitStop[] {
  const seen = new Set<number>();
  const stops: TransitStop[] = [];
  for (const stop of data.stops) {
    if (seen.has(stop.id) || stop.location_type === 1) continue; // skip parent stations
    seen.add(stop.id);
    const [lon, lat] = stop.geometry.coordinates;
    const rs = stop.route_stops;
    const routeType = rs && rs.length > 0 ? rs[0].route.route_type : undefined;
    const mode = routeType !== undefined ? modeFromRouteType(routeType) : "bus";
    stops.push({ id: stop.id, lat, lon, name: stop.stop_name ?? "", mode, rankScore: modeRankScore(mode) });
  }
  stops.sort((a, b) => b.rankScore - a.rankScore);
  return stops;
}

async function fetchTile(s: number, w: number, n: number, e: number, key: string): Promise<TransitStop[] | null> {
  if (tileCache.has(key)) return tileCache.get(key)!;
  if (inFlightTiles.has(key)) return inFlightTiles.get(key)!;

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  const promise = (async (): Promise<TransitStop[]> => {
    try {
      const data = await fetchTransitland(s, w, n, e, ctrl.signal);
      const stops = parseStops(data);
      tileCache.set(key, stops);
      return stops;
    } finally {
      clearTimeout(tid);
      inFlightTiles.delete(key);
    }
  })();

  inFlightTiles.set(key, promise);
  return promise;
}

const TILE_FETCH_LIMIT = 6;

function composeTiles(tileResults: TransitStop[][], zoom: number, limit: number): TransitStop[] {
  const seen = new Set<number>();
  const all: TransitStop[] = [];
  for (const stops of tileResults) {
    for (const s of stops) {
      if (!seen.has(s.id)) { seen.add(s.id); all.push(s); }
    }
  }
  const minRank = rankThresholdForZoom(zoom);
  return all
    .filter(s => s.rankScore >= minRank)
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, Math.min(limit, 60));
}

/** Synchronous — returns only what is already in the tile cache. Call before fetchTransitStops for instant display. */
export function getStopsFromCache(
  south: number, west: number, north: number, east: number,
  zoom = 14, limit = 30, source: TransitSource = "transitland"
): TransitStop[] {
  const tiles = tilesForBbox(south, west, north, east);
  const cache = source === "overpass" ? overpassTileCache : tileCache;
  const cached = tiles.map(t => cache.get(t.key)).filter((s): s is TransitStop[] => s !== undefined);
  return cached.length === 0 ? [] : composeTiles(cached, zoom, limit);
}

/**
 * Fetches transit stops for the viewport bbox using tile-grid caching.
 * Returns TransitStop[] on success (may be empty), error string on failure.
 * Callers should call getStopsFromCache first for instant display.
 * When source="overpass", only subway and rail stops are returned.
 */
export async function fetchTransitStops(
  south: number, west: number, north: number, east: number,
  zoom = 14, limit = 30, source: TransitSource = "transitland"
): Promise<TransitStop[] | string> {
  if (zoom < 9) return [];

  const tiles = tilesForBbox(south, west, north, east);

  if (source === "overpass") {
    if (tiles.length > TILE_FETCH_LIMIT) {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const data = await fetchOverpassTransit(south, west, north, east, ctrl.signal);
        return composeTiles([parseOverpassStops(data.elements)], zoom, limit);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        clearTimeout(tid);
      }
    }
    try {
      const results = await Promise.all(tiles.map(t => fetchOverpassTile(t.s, t.w, t.n, t.e, t.key)));
      return composeTiles(results, zoom, limit);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  // ── Transitland ──────────────────────────────────────────────────────────────
  if (tiles.length > TILE_FETCH_LIMIT) {
    // Bbox too large for tile caching — single-bbox fallback (low zoom, rare)
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const data = await fetchTransitland(south, west, north, east, ctrl.signal);
      return composeTiles([parseStops(data)], zoom, limit);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(tid);
    }
  }

  try {
    const results = await Promise.all(tiles.map(t => fetchTile(t.s, t.w, t.n, t.e, t.key)));
    return composeTiles(results, zoom, limit);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Silently prefetches tiles adjacent to the given bbox (1-tile ring) to warm the cache.
 *  Skipped for Overpass source — Overpass is slower and request-heavy; prefetch
 *  would leave long-lived AbortController timers and unhandled rejections. */
export function prefetchAdjacentTiles(
  south: number, west: number, north: number, east: number,
  source: TransitSource = "transitland"
): void {
  if (source === "overpass") return;
  const T = TILE_SIZE;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const expanded = tilesForBbox(r2(south - T), r2(west - T), r2(north + T), r2(east + T));
  const currentKeys = new Set(tilesForBbox(south, west, north, east).map(t => t.key));
  for (const t of expanded) {
    if (!currentKeys.has(t.key) && !tileCache.has(t.key) && !inFlightTiles.has(t.key)) {
      void fetchTile(t.s, t.w, t.n, t.e, t.key);
    }
  }
}
