export type TransitMode = "subway" | "rail" | "tram" | "bus" | "ferry";

export interface TransitStop {
  id: number;
  lat: number;
  lon: number;
  name: string;
  mode: TransitMode;
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

/** Fetches transit stops from OSM for the bounding box. Never throws — returns [] on any error. */
export async function fetchTransitStops(
  south: number, west: number, north: number, east: number
): Promise<TransitStop[]> {
  for (const entry of stopCache) {
    if (cacheContains(entry, south, west, north, east)) return entry.stops;
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
    return [];
  }
  clearTimeout(tid);
  if (!res.ok) return [];

  const text = await res.text();
  if (text.trimStart().startsWith("<")) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: any[] = (JSON.parse(text) as { elements?: any[] }).elements ?? [];
  const seen = new Set<number>();
  const stops: TransitStop[] = [];

  for (const el of elements) {
    if (el.type !== "node" || seen.has(el.id)) continue;
    seen.add(el.id);
    const tags: Record<string, string | undefined> = el.tags ?? {};
    stops.push({ id: el.id, lat: el.lat, lon: el.lon, name: tags.name ?? tags["name:en"] ?? "", mode: inferMode(tags) });
  }

  stopCache.unshift({ south, west, north, east, stops });
  if (stopCache.length > STOP_CACHE_MAX) stopCache.pop();
  return stops;
}
