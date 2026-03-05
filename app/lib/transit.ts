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

const OVERPASS_URL          = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK_URL = "https://overpass.kumi.systems/api/interpreter";
const FETCH_TIMEOUT_MS      = 30_000;

async function postOverpass(url: string, body: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "ShadeMapNav/1.0" },
    body,
    signal,
  });
}

interface StopCacheEntry { south: number; west: number; north: number; east: number; stops: TransitStop[] }
const STOP_CACHE_MAX = 5;
const stopCache: StopCacheEntry[] = [];

function cacheContains(e: StopCacheEntry, s: number, w: number, n: number, east: number): boolean {
  return e.south <= s && e.west <= w && e.north >= n && e.east >= east;
}

/**
 * Fetches transit stops from OSM for the bounding box.
 * Returns TransitStop[] on success (may be empty for areas with no stops).
 * Returns null on any network/API error — callers should keep their previous result.
 */
export async function fetchTransitStops(
  south: number, west: number, north: number, east: number,
  zoom = 14, limit = 30
): Promise<TransitStop[] | null> {
  if (zoom < 9) return [];
  for (const entry of stopCache) {
    if (cacheContains(entry, south, west, north, east)) {
      const minRank = rankThresholdForZoom(zoom);
      return entry.stops.filter(s => s.rankScore >= minRank).slice(0, Math.min(limit, 60));
    }
  }

  const query = `[out:json][timeout:25];
(
  node["highway"="bus_stop"](${south},${west},${north},${east});
  node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](${south},${west},${north},${east});
  node["public_transport"="stop_position"](${south},${west},${north},${east});
  node["amenity"="ferry_terminal"](${south},${west},${north},${east});
);
out body;`;

  const body = `data=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await postOverpass(OVERPASS_URL, body, ctrl.signal);
    if (!res.ok && res.status >= 500) res = await postOverpass(OVERPASS_FALLBACK_URL, body, ctrl.signal);
  } catch {
    clearTimeout(tid);
    return null;
  }
  clearTimeout(tid);
  if (!res.ok) return null;

  const text = await res.text();
  if (text.trimStart().startsWith("<")) return null;

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
  stopCache.unshift({ south, west, north, east, stops });
  if (stopCache.length > STOP_CACHE_MAX) stopCache.pop();

  const minRank = rankThresholdForZoom(zoom);
  return stops.filter(s => s.rankScore >= minRank).slice(0, Math.min(limit, 60));
}
