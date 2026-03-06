export type TransitMode = "subway" | "rail" | "tram" | "bus" | "ferry";

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

export const TILE_SIZE = 0.25; // degrees per tile edge (~25 km at mid-latitudes)

export function tileKey(latFloor: number, lonFloor: number): string {
  return `lat${latFloor.toFixed(2)}_lon${lonFloor.toFixed(2)}`;
}

export function tilesForBbox(
  s: number, w: number, n: number, e: number
): Array<{ key: string; s: number; w: number; n: number; e: number }> {
  const T = TILE_SIZE;
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const latStart = round2(Math.floor(s / T) * T);
  const lonStart = round2(Math.floor(w / T) * T);
  const tiles: Array<{ key: string; s: number; w: number; n: number; e: number }> = [];
  for (let lat = latStart; lat < n; lat = round2(lat + T)) {
    for (let lon = lonStart; lon < e; lon = round2(lon + T)) {
      tiles.push({ key: tileKey(lat, lon), s: lat, w: lon, n: round2(lat + T), e: round2(lon + T) });
    }
  }
  return tiles;
}

const tileCache    = new Map<string, TransitStop[]>();
const inFlightTiles = new Map<string, Promise<TransitStop[] | null>>();

/** Only for tests — clears all in-memory tile state between test cases. */
export function clearTileCache(): void {
  tileCache.clear();
  inFlightTiles.clear();
}

// ─── Overpass fetch ───────────────────────────────────────────────────────────

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const FETCH_TIMEOUT_MS = 20_000;

function buildQuery(south: number, west: number, north: number, east: number): string {
  return `[out:json][timeout:18][maxsize:1000000];
(
  node["highway"="bus_stop"](${south},${west},${north},${east});
  node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](${south},${west},${north},${east});
  node["amenity"="ferry_terminal"](${south},${west},${north},${east});
);
out body;`;
}

/** Race all Overpass endpoints; returns the first valid JSON response body, or null if all fail. */
async function raceOverpass(query: string, signal?: AbortSignal): Promise<string | null> {
  const body = `data=${encodeURIComponent(query)}`;
  const tryEndpoint = async (url: string): Promise<string> => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ShadeMapNav/1.0" },
      body,
      signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.trimStart().startsWith("<")) throw new Error("XML response (rate-limited)");
    return text;
  };
  try {
    return await Promise.any(OVERPASS_ENDPOINTS.map(url => tryEndpoint(url)));
  } catch {
    return null;
  }
}

function parseStops(text: string): TransitStop[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: any[] = (JSON.parse(text) as { elements?: any[] }).elements ?? [];
  const seen = new Set<number>();
  const stops: TransitStop[] = [];
  for (const el of elements) {
    if (el.type !== "node" || seen.has(el.id)) continue;
    seen.add(el.id);
    const tags: Record<string, string | undefined> = el.tags ?? {};
    const mode = inferMode(tags);
    stops.push({ id: el.id, lat: el.lat, lon: el.lon, name: tags.name ?? tags["name:en"] ?? "", mode, rankScore: modeRankScore(mode) });
  }
  stops.sort((a, b) => b.rankScore - a.rankScore);
  return stops;
}

async function fetchTile(s: number, w: number, n: number, e: number, key: string): Promise<TransitStop[] | null> {
  if (tileCache.has(key)) return tileCache.get(key)!;
  if (inFlightTiles.has(key)) return inFlightTiles.get(key)!;

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  const promise = (async (): Promise<TransitStop[] | null> => {
    try {
      const text = await raceOverpass(buildQuery(s, w, n, e), ctrl.signal);
      if (!text) return null;
      const stops = parseStops(text);
      tileCache.set(key, stops);
      return stops;
    } catch {
      return null;
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
  zoom = 14, limit = 30
): TransitStop[] {
  const tiles = tilesForBbox(south, west, north, east);
  const cached = tiles.map(t => tileCache.get(t.key)).filter((s): s is TransitStop[] => s !== undefined);
  return cached.length === 0 ? [] : composeTiles(cached, zoom, limit);
}

/**
 * Fetches transit stops for the viewport bbox using tile-grid caching.
 * Returns TransitStop[] on success (may be empty), null on complete failure.
 * Callers should call getStopsFromCache first for instant display.
 */
export async function fetchTransitStops(
  south: number, west: number, north: number, east: number,
  zoom = 14, limit = 30
): Promise<TransitStop[] | null> {
  if (zoom < 9) return [];

  const tiles = tilesForBbox(south, west, north, east);

  if (tiles.length > TILE_FETCH_LIMIT) {
    // Bbox too large for tile caching — single-bbox fallback (low zoom, rare)
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const text = await raceOverpass(buildQuery(south, west, north, east), ctrl.signal);
      if (!text) return null;
      return composeTiles([parseStops(text)], zoom, limit);
    } catch {
      return null;
    } finally {
      clearTimeout(tid);
    }
  }

  const results = await Promise.all(tiles.map(t => fetchTile(t.s, t.w, t.n, t.e, t.key)));
  const successful = results.filter((r): r is TransitStop[] => r !== null);
  if (successful.length === 0 && results.some(r => r === null)) return null;
  return composeTiles(successful, zoom, limit);
}

/** Silently prefetches tiles adjacent to the given bbox (1-tile ring) to warm the cache. */
export function prefetchAdjacentTiles(south: number, west: number, north: number, east: number): void {
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
