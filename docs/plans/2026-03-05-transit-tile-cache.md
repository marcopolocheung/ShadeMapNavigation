# Transit Tile-Cache + Server-Race Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the broken LRU bbox cache and single-endpoint Overpass fetch with a 0.25° tile-grid cache + 3-server race so transit stops appear instantly from cache and cold-load in 3–8 s instead of 30 s+.

**Architecture:** The world is tiled into 0.25° squares; each tile is fetched once and stored by key. Three Overpass endpoints are raced simultaneously (`Promise.any`); the first JSON-200 response wins. Page.tsx shows cached stops instantly, then updates when background tile fetches complete (stale-while-revalidate via a sequence counter).

**Tech Stack:** TypeScript, Vitest (tests), MapLibre GL (page.tsx), Overpass API (3 endpoints)

**Design doc:** `docs/plans/2026-03-05-transit-tile-cache-design.md`

---

### Task 1: Add tile-grid helpers to transit.ts

**Files:**
- Modify: `app/lib/transit.ts`
- Modify: `app/lib/__tests__/transit.test.ts`

#### Step 1: Add failing tests for tile helpers

Add this new `describe` block at the top of the `fetchTransitStops` describe section in `app/lib/__tests__/transit.test.ts`. Also update the import line at the top to include the new exports:

```ts
// Update import at top of file:
import { inferMode, rankThresholdForZoom, fetchTransitStops, getStopsFromCache, tileKey, tilesForBbox, clearTileCache } from "../transit";
```

Add new `afterEach` to clear tile cache between tests (replace the existing `afterEach` line):
```ts
afterEach(() => {
  vi.unstubAllGlobals();
  clearTileCache();
});
```

Add at the end of the file (before the closing `}`):
```ts
describe("tileKey", () => {
  it("formats latFloor and lonFloor to 2 decimal places", () => {
    expect(tileKey(48, 11.25)).toBe("lat48.00_lon11.25");
  });
  it("floors lat 48.12 → tile lat48.00", () => {
    // tilesForBbox does the flooring; tileKey just formats
    expect(tileKey(48.0, 11.0)).toBe("lat48.00_lon11.00");
  });
  it("handles negative lat", () => {
    expect(tileKey(-34.0, 151.0)).toBe("lat-34.00_lon151.00");
  });
});

describe("tilesForBbox", () => {
  it("returns one tile when bbox fits entirely within one 0.25° cell", () => {
    const tiles = tilesForBbox(48.10, 11.30, 48.12, 11.32);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].key).toBe("lat48.00_lon11.25");
  });
  it("tile object has correct south/west/north/east covering the full 0.25° square", () => {
    const [t] = tilesForBbox(48.10, 11.30, 48.12, 11.32);
    expect(t.s).toBeCloseTo(48.00);
    expect(t.w).toBeCloseTo(11.25);
    expect(t.n).toBeCloseTo(48.25);
    expect(t.e).toBeCloseTo(11.50);
  });
  it("returns two tiles when bbox crosses a longitude tile boundary", () => {
    // 11.20–11.30 spans tile at lon11.00 and tile at lon11.25
    const tiles = tilesForBbox(48.10, 11.20, 48.12, 11.30);
    expect(tiles).toHaveLength(2);
    const keys = tiles.map(t => t.key);
    expect(keys).toContain("lat48.00_lon11.00");
    expect(keys).toContain("lat48.00_lon11.25");
  });
  it("returns four tiles when bbox crosses both lat and lon boundaries", () => {
    const tiles = tilesForBbox(48.20, 11.20, 48.30, 11.30);
    expect(tiles).toHaveLength(4);
  });
});
```

#### Step 2: Run tests to confirm they fail

```bash
cd /home/unusn/shademapnav && npm test -- --reporter=verbose transit 2>&1 | tail -30
```

Expected: several failures mentioning `tileKey is not a function`, `tilesForBbox is not a function`, `clearTileCache is not a function`.

#### Step 3: Add tile helpers to transit.ts

Add after the `rankThresholdForZoom` function and before the `// ─── Overpass fetch` section:

```ts
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

/** Only for tests — clears all in-memory tile state between test cases. */
export function clearTileCache(): void {
  tileCache.clear();
  inFlightTiles.clear();
}
```

Also declare the module-level maps (they're referenced by `clearTileCache` but defined in the next task — declare them here so TS is happy):

```ts
const tileCache    = new Map<string, TransitStop[]>();
const inFlightTiles = new Map<string, Promise<TransitStop[] | null>>();
```

Place the two `const` declarations immediately before `clearTileCache` (they're module-level, so order matters for declaration, not for use across tasks since all code is in the same file).

#### Step 4: Run tests — all tile helper tests should pass

```bash
npm test -- --reporter=verbose transit 2>&1 | tail -30
```

Expected: `tileKey` and `tilesForBbox` tests pass. The existing `fetchTransitStops` tests will likely still pass (old code untouched yet) except for tests involving `getStopsFromCache` (not yet implemented — those should fail).

#### Step 5: Commit

```bash
git add app/lib/transit.ts app/lib/__tests__/transit.test.ts
git commit -m "feat: add tile-grid helpers (tileKey, tilesForBbox, clearTileCache) to transit.ts"
```

---

### Task 2: Replace Overpass fetch with server-racing raceOverpass

**Files:**
- Modify: `app/lib/transit.ts`
- Modify: `app/lib/__tests__/transit.test.ts`

#### Step 1: Add failing tests for multi-server race behavior

Add this describe block in `transit.test.ts` (inside the `fetchTransitStops` describe or as a sibling):

```ts
describe("raceOverpass (tested via fetchTransitStops)", () => {
  it("succeeds when the primary endpoint fails but a fallback responds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("overpass-api.de")) return Promise.reject(new Error("Network error"));
      return Promise.resolve({ ok: true, status: 200,
        text: async () => JSON.stringify({ elements: [] }) });
    }));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).not.toBeNull();
  });

  it("returns null when all three endpoints fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).toBeNull();
  });

  it("returns null when all endpoints return HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).toBeNull();
  });

  it("returns null when all endpoints return XML (rate-limited)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => '<?xml version="1.0"?><osm/>',
    }));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).toBeNull();
  });
});
```

#### Step 2: Run tests to confirm new tests fail

```bash
npm test -- --reporter=verbose transit 2>&1 | grep -E "(FAIL|PASS|✓|×)" | tail -20
```

Expected: the "fallback responds" test fails because the current code only tries one server at a time.

#### Step 3: Replace the Overpass fetch infrastructure in transit.ts

Remove the entire old Overpass section (everything from `// ─── Overpass fetch` down to the end of the file). Replace with:

```ts
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
```

#### Step 4: Also update the existing tests that check query content

The old query had `public_transport=stop_position`; the new one does not. Find the test "query includes bus_stop, railway, public_transport, ferry_terminal" and update it:

```ts
it("query includes bus_stop, railway, ferry_terminal but not public_transport=stop_position", async () => {
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) });
  vi.stubGlobal("fetch", fn);
  await fetchTransitStops(...nextBbox());
  const body = decodeURIComponent((fn.mock.calls[0][1] as RequestInit).body as string).replace(/^data=/, "");
  expect(body).toContain("bus_stop");
  expect(body).toContain("railway");
  expect(body).toContain("ferry_terminal");
  expect(body).not.toContain("public_transport");
});
```

#### Step 5: Run tests

```bash
npm test -- --reporter=verbose transit 2>&1 | tail -30
```

Expected: race tests pass. Existing parse/dedup tests may temporarily fail because `fetchTransitStops` itself isn't wired up yet (still references old removed code). That's OK — we'll wire it in Task 3–4.

#### Step 6: Commit what compiles so far

```bash
git add app/lib/transit.ts app/lib/__tests__/transit.test.ts
git commit -m "feat: add raceOverpass with 3-endpoint race and simplified Overpass query"
```

---

### Task 3: Add tile cache + fetchTile + in-flight deduplication

**Files:**
- Modify: `app/lib/transit.ts`

#### Step 1: Add failing tests for tile-level cache behavior

Add to `transit.test.ts`:

```ts
describe("tile cache and in-flight deduplication", () => {
  it("second fetchTransitStops for the same tile area does not re-fetch", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 700, lat: 48.1, lon: 11.3, tags: { highway: "bus_stop", name: "Stop A" } },
      ]}) });
    vi.stubGlobal("fetch", fn);
    const b: [number, number, number, number] = [48.10, 11.30, 48.12, 11.32]; // fits in tile lat48.00_lon11.25
    await fetchTransitStops(...b, 14, 30);
    const countAfterFirst = fn.mock.calls.length; // 3 (one per endpoint race)
    await fetchTransitStops(...b, 14, 30); // same tile → cache hit
    expect(fn.mock.calls.length).toBe(countAfterFirst); // no new fetches
  });

  it("concurrent fetchTransitStops for the same tile only fires one set of requests", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [] }) });
    vi.stubGlobal("fetch", fn);
    const b: [number, number, number, number] = [48.10, 11.30, 48.12, 11.32];
    await Promise.all([
      fetchTransitStops(...b, 14, 30),
      fetchTransitStops(...b, 14, 30),
    ]);
    const totalAfterBoth = fn.mock.calls.length;
    // Third call should hit cache
    await fetchTransitStops(...b, 14, 30);
    expect(fn.mock.calls.length).toBe(totalAfterBoth);
  });
});
```

#### Step 2: Run to confirm they fail

```bash
npm test -- --reporter=verbose transit 2>&1 | grep -E "tile cache" -A 10
```

#### Step 3: Add fetchTile to transit.ts

Add this after `raceOverpass`:

```ts
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
```

#### Step 4: Run tests

```bash
npm test -- --reporter=verbose transit 2>&1 | tail -30
```

Expected: tile cache and dedup tests pass.

#### Step 5: Commit

```bash
git add app/lib/transit.ts app/lib/__tests__/transit.test.ts
git commit -m "feat: add tile cache and fetchTile with in-flight deduplication"
```

---

### Task 4: Add getStopsFromCache + new fetchTransitStops + prefetchAdjacentTiles; update broken old tests

**Files:**
- Modify: `app/lib/transit.ts`
- Modify: `app/lib/__tests__/transit.test.ts`

#### Step 1: Add failing tests for getStopsFromCache and new fetchTransitStops

Add to `transit.test.ts`:

```ts
describe("getStopsFromCache", () => {
  it("returns empty array when no tiles cached", () => {
    const stops = getStopsFromCache(2.0, 2.0, 2.1, 2.1);
    expect(stops).toEqual([]);
  });

  it("returns stops synchronously after a completed fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 800, lat: 48.11, lon: 11.31, tags: { highway: "bus_stop", name: "SyncStop" } },
      ]}) }));
    const b: [number, number, number, number] = [48.10, 11.30, 48.12, 11.32];
    await fetchTransitStops(...b, 14, 30);
    const cached = getStopsFromCache(...b, 14, 30);
    expect(cached.length).toBeGreaterThan(0);
    expect(cached[0].name).toBe("SyncStop");
  });

  it("applies zoom rank threshold when reading from cache", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 801, lat: 48.11, lon: 11.31, tags: { highway: "bus_stop", name: "BusStop" } },
        { type: "node", id: 802, lat: 48.11, lon: 11.31, tags: { railway: "subway_entrance", name: "Metro" } },
      ]}) }));
    const b: [number, number, number, number] = [48.10, 11.30, 48.12, 11.32];
    await fetchTransitStops(...b, 14, 30);
    // zoom=11 → threshold 80 → only subway (90) survives
    const cached = getStopsFromCache(...b, 11, 30);
    expect(cached.every(s => s.rankScore >= 80)).toBe(true);
    expect(cached.some(s => s.mode === "bus")).toBe(false);
  });
});

describe("fetchTransitStops tile-based", () => {
  it("merges stops from two tiles, deduplicating by id", async () => {
    // bbox spanning two lat tiles: 48.20–48.30 crosses the 48.25 boundary
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 900, lat: 48.22, lon: 11.31, tags: { highway: "bus_stop", name: "StopX" } },
      ]}) }));
    const stops = await fetchTransitStops(48.20, 11.30, 48.30, 11.32, 14, 30);
    expect(stops).not.toBeNull();
    // StopX appears in one tile; the same stop should appear only once even if both tiles return it
    const ids = stops!.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns empty array (not null) for zoom < 9", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const result = await fetchTransitStops(0, 0, 1, 1, 8, 30);
    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
```

#### Step 2: Run to see failures

```bash
npm test -- --reporter=verbose transit 2>&1 | grep -E "(✗|×|FAIL)" | head -20
```

#### Step 3: Add getStopsFromCache, composeTiles, fetchTransitStops, and prefetchAdjacentTiles to transit.ts

Add after `fetchTile`:

```ts
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
```

#### Step 4: Fix the old broken "caches" test

Find and update the existing `"caches result and does not re-fetch for a sub-bbox"` test:

```ts
it("caches result and does not re-fetch for same tile area", async () => {
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200,
    text: async () => JSON.stringify({ elements: [] }) });
  vi.stubGlobal("fetch", fn);
  const [s, w, n, e] = nextBbox(); // e.g. [60, 60, 60.01, 60.01]
  await fetchTransitStops(s, w, n, e);
  const countAfterFirst = fn.mock.calls.length; // 1–3 (race endpoints)
  // Sub-bbox is in the same tile → should hit cache, no new fetches
  await fetchTransitStops(s + 0.001, w + 0.001, n - 0.001, e - 0.001);
  expect(fn.mock.calls.length).toBe(countAfterFirst);
});
```

#### Step 5: Run all tests

```bash
npm test -- --reporter=verbose transit 2>&1 | tail -40
```

Expected: all transit tests pass.

#### Step 6: TypeScript check

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

#### Step 7: Commit

```bash
git add app/lib/transit.ts app/lib/__tests__/transit.test.ts
git commit -m "feat: add getStopsFromCache, tile-based fetchTransitStops, prefetchAdjacentTiles"
```

---

### Task 5: Update page.tsx — seq counter, stale-while-revalidate, prefetch

**Files:**
- Modify: `app/page.tsx`

#### Step 1: Update the import line for transit

Find the line:
```ts
import { fetchTransitStops } from "./lib/transit";
```
Replace with:
```ts
import { fetchTransitStops, getStopsFromCache, prefetchAdjacentTiles } from "./lib/transit";
```

#### Step 2: Replace fetchTransitForViewport and its refs

Find the block:
```ts
const transitFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const fetchTransitForViewport = useCallback(async () => {
  ...
}, []);
```

Replace the entire block (refs + callback) with:

```ts
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
```

#### Step 3: Clean up prefetchTimerRef in the useEffect cleanup

Find the existing `useEffect` for transit (the one with `map.on("moveend", handler)`). Update its cleanup to also clear `prefetchTimerRef`:

```ts
return () => {
  map.off("moveend", handler);
  if (transitFetchTimerRef.current) clearTimeout(transitFetchTimerRef.current);
  if (prefetchTimerRef.current)     clearTimeout(prefetchTimerRef.current);
};
```

#### Step 4: TypeScript check

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

#### Step 5: Run full test suite

```bash
npm test 2>&1 | tail -15
```

Expected: all tests pass.

#### Step 6: Commit

```bash
git add app/page.tsx
git commit -m "feat: stale-while-revalidate transit display with seq counter and adjacent-tile prefetch"
```

---

### Task 6: Final verification

#### Step 1: Full test suite

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all 6 test files pass, 120+ tests.

#### Step 2: TypeScript clean

```bash
npx tsc --noEmit
```

Expected: no output (zero errors).

#### Step 3: Manual smoke test checklist

Open `npm run dev` and:
- [ ] Toggle transit on at zoom 14 in a city: stops appear within 15 s cold, instantly on second pan
- [ ] Zoom to 10: only subway/rail markers visible
- [ ] Pan slowly: stops update smoothly, no 30 s waits
- [ ] Open Network tab: verify no duplicate in-flight requests for same tile
- [ ] Check console: no TypeScript or runtime errors
