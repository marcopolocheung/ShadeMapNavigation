# Claude Code Implementation Sheet
## Viewport-Bounded Ranked Transit Loading

> **Goal:** Replace any unbounded "fetch everything" transit call with a Google Maps-style system: the server returns only the stops inside the current visible map area, ordered by a prominence/ridership rank, with a fixed cap on how many are returned. Higher-ranked stops surface at wider zoom levels; lower-ranked stops only appear once the user has zoomed in close. The client re-runs the query on every pan and zoom.

---

## 1  Understand the Existing Data Model

Before writing any new code, build a mental model of what fields already exist on a transit stop record.

### 1.1  Find the transit stop schema

```bash
grep -r --include='*.{ts,tsx,js,jsx,prisma,sql,py}' -n \
  'TransitStop\|BusStop\|SubwayEntrance\|transit_stop\|bus_stop' \
  src/ prisma/ db/ models/ | head -30
```

Open the file(s) found and note:
- Does a `latitude` / `longitude` or `coordinates` field already exist?
- Is there ANY numeric field that could serve as a rank proxy — e.g. `ridership`, `popularity`, `rating`, `usage_count`, `importance`?
- If no rank field exists, note that — we will add one in Step 2.

### 1.2  Find the current fetch call

```bash
grep -r --include='*.{ts,tsx,js,jsx}' -n \
  'fetchTransit\|getTransit\|loadStops\|fetchStops\|fetchMarkers\|getStops' \
  src/ | head -20
```

Open each result. Confirm whether the call passes any bounding box or limit parameter today. (It almost certainly does not — that is what we are fixing.)

---

## 2  Add a Rank Score to the Data

> **Why rank?** Rank determines which stops appear first when the result is capped at N. A major interchange station should always be visible before a tiny request stop. Rank also controls the minimum zoom at which a stop can appear at all — high-rank stops surface at wider zooms, low-rank stops only at close zooms.

### 2.1  If a rank-proxy field already exists

Skip to Step 3. Use the existing field (e.g. `ridership`) wherever `rank_score` is referenced below.

### 2.2  If NO rank field exists — add one

Add a `rank_score` column to the transit stop table. Choose the approach that matches the project's database:

**SQL migration (Postgres / SQLite / MySQL):**
```sql
ALTER TABLE transit_stops ADD COLUMN rank_score INTEGER NOT NULL DEFAULT 50;

-- Seed reasonable defaults by stop type
-- (adjust type names to match your actual data)
UPDATE transit_stops SET rank_score = 90 WHERE type IN ('subway_station', 'metro_station', 'train_station');
UPDATE transit_stops SET rank_score = 70 WHERE type IN ('bus_terminal', 'ferry_terminal');
UPDATE transit_stops SET rank_score = 50 WHERE type IN ('bus_stop');
UPDATE transit_stops SET rank_score = 30 WHERE type IN ('tram_stop', 'cable_car');
```

**Prisma schema addition:**
```prisma
model TransitStop {
  id          String  @id @default(cuid())
  name        String
  latitude    Float
  longitude   Float
  type        String
  rank_score  Int     @default(50)   // <-- add this
  // ... other fields
}
```

**NoSQL / in-memory array (if no DB):**
Add `rankScore: number` to the TypeScript type and seed it by stop type using the same tiers above.

---

## 3  Build the Bounded + Ranked Query

This is the core of the implementation. The query must accept a bounding box and a result cap, filter by geography, and order by rank descending.

### 3.1  The query contract

The function/endpoint must accept exactly these inputs:

| Parameter | Description |
|-----------|-------------|
| `north, south, east, west` | The four edges of the current map viewport in decimal degrees (the bounding box) |
| `zoom` | Current map zoom level (integer, 0–20). Used to calculate the rank threshold |
| `limit` | Maximum stops to return. Default: 30. Hard cap: 60 |

### 3.2  Rank threshold by zoom level

Do NOT return all stops inside the bbox. Apply a rank gate so that at wider zooms only major stops appear, and minor stops only appear when the user has zoomed in close. Use this ladder as the default — adjust thresholds after testing:

| Zoom level | Minimum `rank_score` to be included |
|------------|--------------------------------------|
| ≤ 11  (city-wide view) | 80 — only major hubs (main train/metro stations) |
| 12 – 13 | 65 |
| 14 – 15 | 45 — main bus routes now appear |
| 16 – 17 | 20 — most stops visible |
| ≥ 18  (street-level) | 0 — everything |

### 3.3  SQL implementation

```sql
-- Replace :north/:south/:east/:west/:min_rank/:limit with actual params
SELECT *
FROM   transit_stops
WHERE  latitude  BETWEEN :south AND :north
  AND  longitude BETWEEN :west  AND :east
  AND  rank_score >= :min_rank
ORDER  BY rank_score DESC
LIMIT  :limit;
```

### 3.4  Prisma implementation

```typescript
// In your service / repository file
export async function getTransitInViewport({
  north, south, east, west,
  zoom,
  limit = 30,
}: ViewportQuery) {
  const minRank = rankThresholdForZoom(zoom);

  return prisma.transitStop.findMany({
    where: {
      latitude:   { gte: south, lte: north },
      longitude:  { gte: west,  lte: east  },
      rank_score: { gte: minRank },
    },
    orderBy: { rank_score: 'desc' },
    take: Math.min(limit, 60), // hard cap
  });
}

function rankThresholdForZoom(zoom: number): number {
  if (zoom <= 11) return 80;
  if (zoom <= 13) return 65;
  if (zoom <= 15) return 45;
  if (zoom <= 17) return 20;
  return 0;
}
```

### 3.5  In-memory / array implementation (no database)

```typescript
export function getTransitInViewport({
  north, south, east, west, zoom, limit = 30
}: ViewportQuery) {
  const minRank = rankThresholdForZoom(zoom);

  return ALL_TRANSIT_STOPS
    .filter(s =>
      s.latitude  >= south && s.latitude  <= north &&
      s.longitude >= west  && s.longitude <= east  &&
      s.rankScore >= minRank
    )
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, Math.min(limit, 60));
}
```

---

## 4  Update or Create the API Endpoint

If the project exposes transit data through an HTTP API, update that endpoint to accept the new parameters. If the function from Step 3 is called directly (no API layer), skip to Step 5.

### 4.1  Find the existing endpoint

```bash
grep -r --include='*.{ts,tsx,js,jsx,py}' -n \
  "router\|app.get\|app.post\|@Get\|@Post\|route('/transit" \
  src/api/ src/routes/ src/server/ src/pages/api/ 2>/dev/null | head -20
```

### 4.2  Rewrite the handler

Replace the existing handler body with the pattern below. Adapt to whatever HTTP framework is in use (Express, Next.js API routes, Fastify, etc.):

```typescript
// Example: Next.js API route  /api/transit
// Express: identical logic, use req.query instead of searchParams

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const north = parseFloat(searchParams.get('north') ?? '');
  const south = parseFloat(searchParams.get('south') ?? '');
  const east  = parseFloat(searchParams.get('east')  ?? '');
  const west  = parseFloat(searchParams.get('west')  ?? '');
  const zoom  = parseInt(searchParams.get('zoom')    ?? '14', 10);
  const limit = parseInt(searchParams.get('limit')   ?? '30', 10);

  if ([north, south, east, west].some(isNaN)) {
    return Response.json({ error: 'Missing bbox params' }, { status: 400 });
  }

  const stops = await getTransitInViewport({ north, south, east, west, zoom, limit });
  return Response.json(stops);
}
```

---

## 5  Update the Client — Re-fetch on Viewport Change

This is where the Google Maps behaviour is replicated on the frontend. The fetch must fire every time the user pans or zooms — not just once on mount.

### 5.1  Get the map bounds

The exact API depends on the map library in use. Find it with:

```bash
grep -r --include='*.{ts,tsx,js,jsx}' -n \
  'getBounds\|getViewport\|onMoveEnd\|onZoomEnd\|bounds_changed\|moveend' \
  src/ | head -20
```

### 5.2  Replace the fetch hook

Locate the hook or component that currently fetches transit data and rewrite it as follows:

```typescript
import { useEffect, useState, useCallback, useRef } from 'react';

export function useTransitMarkers(map: MapInstance | null) {
  const [markers, setMarkers] = useState<TransitStop[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchForViewport = useCallback(() => {
    if (!map) return;

    const bounds = map.getBounds(); // adapt to your map library
    const zoom   = map.getZoom();

    // debounce: wait 200ms after the user stops moving
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        // Direct function call (no HTTP API):
        const stops = await getTransitInViewport({
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east:  bounds.getEast(),
          west:  bounds.getWest(),
          zoom,
          limit: 30,
        });
        setMarkers(stops);

        // HTTP API version (comment out the above and use this instead):
        // const params = new URLSearchParams({
        //   north: String(bounds.getNorth()), south: String(bounds.getSouth()),
        //   east:  String(bounds.getEast()),  west:  String(bounds.getWest()),
        //   zoom:  String(zoom),              limit: '30',
        // });
        // const res = await fetch(`/api/transit?${params}`);
        // setMarkers(await res.json());
      } catch (err) {
        console.error('[Transit] fetch failed:', err);
      }
    }, 200);
  }, [map]);

  useEffect(() => {
    if (!map) return;
    fetchForViewport();                    // initial load
    map.on('moveend', fetchForViewport);   // re-fetch on pan
    map.on('zoomend', fetchForViewport);   // re-fetch on zoom
    return () => {
      map.off('moveend', fetchForViewport);
      map.off('zoomend', fetchForViewport);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [map, fetchForViewport]);

  return markers;
}
```

> **Map library event names:** Adapt to the library in use. Mapbox GL / MapLibre: `moveend`, `zoomend`. Leaflet: `moveend` (covers both pan and zoom). Google Maps JS API: `bounds_changed` or `idle`. React-Map-GL: use the `onMoveEnd` / `onZoomEnd` props on the `Map` component.

### 5.3  Remove the old fetch call

Delete (do not comment out) the original unbounded fetch — the one that likely looked like `fetchAllTransitLocations()` or fetched without bbox params. Leaving it in will cause a race condition.

---

## 6  Wire the Markers to the Map

### 6.1  Find the current marker rendering code

```bash
grep -r --include='*.{ts,tsx,js,jsx}' -n \
  'Marker\|addLayer\|setData\|GeoJSON\|renderMarkers\|transitMarkers' \
  src/ | grep -iv 'test\|spec\|node_modules' | head -20
```

### 6.2  Replace the data source

In the component that renders the map, swap the old transit data source for the new hook:

```typescript
// In your map component
const [mapRef, setMapRef] = useState<MapInstance | null>(null);
const transitMarkers = useTransitMarkers(mapRef);

// Pass transitMarkers to however your layer currently renders stops.

// For a React component-per-marker pattern:
//   {transitMarkers.map(stop => <TransitMarker key={stop.id} stop={stop} />)}

// For a Mapbox GeoJSON source:
//   map.getSource('transit').setData(toGeoJSON(transitMarkers))
```

---

## 7  Verification Checklist

Run through every item below before closing the task. All should pass.

| # | Check | Pass condition |
|---|-------|----------------|
| 1 | Markers appear on initial load and stay visible | No flash-and-disappear |
| 2 | Pan the map — new stops load for the new area | Network tab shows a new API call per pan |
| 3 | Zoom out to zoom ≤ 11 — only major hubs visible | Small stops are absent; no console errors |
| 4 | Zoom in to zoom ≥ 18 — all local stops visible | Minor stops now appear |
| 5 | No single response exceeds 60 stops | Check Network tab response body length |
| 6 | Rapid pan/zoom generates only 1 request per gesture | Debounce working — no request spam |
| 7 | Console is clean throughout | No uncaught errors, no empty catch swallowing |
| 8 | Old unbounded fetch call is fully deleted | `grep` for old fetch name returns 0 results |

---

> **Done.** Once all 8 checks pass, the transit layer is operating on the same viewport-bounded, rank-gated model as Google Maps. The client never loads more than 60 stops at a time, always sees the most important stops first, and updates smoothly on every pan and zoom.