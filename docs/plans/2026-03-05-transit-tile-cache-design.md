# Transit Tile-Cache + Server-Race Design

**Date:** 2026-03-05
**Status:** Approved

---

## Problem

Transit stops take 1+ minute to load or never appear. Root causes:

1. **Overpass API is a slow shared server** — P50 10–20 s, P95 30 s+. Single-endpoint fallback only fires on 5xx, not on slow-but-200 responses.
2. **Redundant query** — four union clauses; `public_transport=stop_position` duplicates nearly everything already matched by `highway=bus_stop` and `railway=…`, inflating response 2–3×.
3. **No request cancellation** — old in-flight fetches run alongside new ones, congesting the shared server.
4. **Cache never hits in practice** — LRU check requires new bbox to be *entirely inside* a cached bbox. Any pan causes a miss and a full re-fetch.
5. **No stale display** — user sees nothing until the full Overpass round-trip completes.

---

## Architecture

### Three pillars

#### 1. Tile-grid cache

The world is divided into fixed `TILE_SIZE = 0.25°` tiles (~25 km at mid-latitudes). Each tile has a deterministic key:

```
tileKey(lat, lon) → "lat48.00_lon11.25"
```

A module-level `Map<string, TransitStop[]>` stores stops by tile key. Fetches decompose the viewport bbox into the overlapping tile set and only request uncached tiles. Cached tiles are returned instantly.

After the viewport is idle for **1.5 s**, the 1-tile ring surrounding the current viewport is prefetched silently in the background (fires and forgets; only populates the cache, never updates UI state).

**Tile count guard:** if the viewport spans more than 6 tiles (typically zoom < 12), fall back to a single-bbox fetch instead of spawning many parallel requests.

#### 2. Server racing

Three Overpass endpoints are queried simultaneously:

- `https://overpass-api.de/api/interpreter`
- `https://overpass.kumi.systems/api/interpreter`
- `https://overpass.private.coffee/api/interpreter`

`Promise.any()` resolves with the first endpoint that returns a valid JSON (non-XML) 200 response, including the full response body text. The other two requests are then aborted. If all three fail or time out, the function returns `null`.

Per-tile in-flight deduplication: a `Map<tileKey, Promise<TransitStop[] | null>>` ensures that if two viewport changes both need the same tile, only one Overpass request fires — both callers await the same promise.

#### 3. Stale-while-revalidate display

When the viewport changes:

1. **Immediately** (sync): call `getStopsFromCache(...)` — compose stops from all cached tiles, apply rank threshold and limit, `setTransitStops(cached)`.
2. **Background** (async): call `fetchTransitStops(...)` — triggers fetches for uncached tiles, awaits all, returns merged+ranked+filtered result, `setTransitStops(full)`.

A monotonic sequence counter (`fetchSeqRef`) is incremented on every new viewport. Both steps check the counter before updating state, so stale results from a previous viewport are silently discarded. The background fetches still complete and populate the tile cache even if their results are discarded.

---

## Query Changes

Remove `public_transport=stop_position` clause (major source of duplicate nodes). Keep:

```overpassql
node["highway"="bus_stop"](...bbox...);
node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](...bbox...);
node["amenity"="ferry_terminal"](...bbox...);
```

Add `[maxsize:1000000]` (1 MB cap) to fail fast on unexpectedly large responses.

---

## API Surface (transit.ts)

```ts
// Synchronous — returns only what is already in the tile cache
export function getStopsFromCache(
  south: number, west: number, north: number, east: number,
  zoom?: number, limit?: number
): TransitStop[]

// Async — fires fetches for uncached tiles, returns when all tiles are resolved
export async function fetchTransitStops(
  south: number, west: number, north: number, east: number,
  zoom?: number, limit?: number
): Promise<TransitStop[] | null>
```

Both apply `rankThresholdForZoom(zoom)` and the limit cap before returning.

Unexported helpers:

```ts
function tileKey(latFloor: number, lonFloor: number): string
function tilesForBbox(s, w, n, e): Array<{ key: string; s: number; w: number; n: number; e: number }>
function raceOverpass(query: string, signal?: AbortSignal): Promise<string | null>
async function fetchTile(s, w, n, e, key): Promise<TransitStop[] | null>
```

---

## page.tsx Changes

```ts
const fetchSeqRef = useRef(0);
const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const fetchTransitForViewport = useCallback(async () => {
  const map = mapRef.current;
  if (!map || !showTransitRef.current) return;
  const zoom = map.getZoom();
  if (zoom < 9) return;
  const localHours = toMapLocal(dateRef.current, mapUtcOffsetMinRef.current).hours;
  if (localHours < 5) { setTransitStops([]); return; }

  const seq = ++fetchSeqRef.current;
  const b = map.getBounds();

  // Phase 1: instant display from cache
  const cached = getStopsFromCache(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), zoom, 30);
  if (cached.length > 0 && seq === fetchSeqRef.current) setTransitStops(cached);

  // Phase 2: background fetch for missing tiles
  const full = await fetchTransitStops(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), zoom, 30);
  if (seq === fetchSeqRef.current && showTransitRef.current && full !== null) setTransitStops(full);

  // Phase 3: prefetch adjacent tiles after 1.5 s idle
  if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
  prefetchTimerRef.current = setTimeout(() => {
    if (seq === fetchSeqRef.current) prefetchAdjacentTiles(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
  }, 1500);
}, []);
```

`prefetchAdjacentTiles` expands the bbox by one tile in each direction and calls `fetchTile` for any uncached tiles (results stored in tile cache; UI not updated).

---

## Files Changed

| File | Nature of change |
|---|---|
| `app/lib/transit.ts` | Major refactor: tile grid, tile cache, in-flight dedup, server race, simplified query, `getStopsFromCache` |
| `app/page.tsx` | seq counter, stale-while-revalidate pattern, prefetch timer |
| `app/lib/__tests__/transit.test.ts` | Update existing tests + add tile, race, cache-hit, and dedup tests |

---

## Acceptance Criteria

1. At zoom 14 in a city, stops appear within 15 s on cold load, and **instantly** on any subsequent pan within ~25 km.
2. At zoom 10, only subway/rail stops appear (rankScore ≥ 80 threshold).
3. Panning rapidly produces at most one Overpass request per uncached tile (no duplicate in-flight requests for the same tile).
4. All transit tests pass (`npm test -- transit`).
5. TypeScript reports no errors (`npx tsc --noEmit`).
