# ShadeMap Navigator — Build State

Browser-based sun shadow simulation app built with Next.js. Shadows render in real time as the user navigates a map and drags a time slider. Includes shade-aware pedestrian routing.

---

## Running the App

```bash
cp .env.local.example .env.local   # add API keys (see below)
npm run dev                         # http://localhost:3000
```

---

## Required API Keys (`.env.local`)

| Variable | Where to get it | Cost |
|---|---|---|
| `NEXT_PUBLIC_SHADEMAP_API_KEY` | https://shademap.app/about/ | Free (Educational tier, localhost only) |
| `NEXT_PUBLIC_MAPTILER_API_KEY` | https://maptiler.com/ | Free (100k tiles/month) |

---

## Stack

- **Next.js 16.1.6** (App Router), React 19, TypeScript, Tailwind CSS v4
- **`maplibre-gl` pinned to `5.9.0`** — see critical note below, do NOT upgrade
- **`mapbox-gl-shadow-simulator` ^0.67.0** — shadow rendering library
- No extra packages for GeoTIFF — custom binary TIFF writer inline in `AccumulationPanel.tsx`

### ⚠ maplibre-gl Must Stay at 5.9.0

`mapbox-gl-shadow-simulator` internally calls `canvasSource.texture.update({ width, height })` with no `data` key.

- **v5.9.0**: routes `{width, height}` (no DOM image, no `data`) to the 9-arg `texImage2D(target, 0, fmt, w, h, 0, fmt, UNSIGNED_BYTE, null)` → creates an empty-sized texture correctly ✓
- **v5.10.0+**: refactored `hasDataProperty` check routes same object to `_uploadDomImage` → `texImage2D(..., {width, height})` → WebGL2 rejects plain object → `"Overload resolution failed"` crash ✗

---

## File Structure

```
app/
  layout.tsx              # Imports maplibre-gl/dist/maplibre-gl.css + globals.css; site metadata
  globals.css             # Tailwind v4 import; html/body full-screen (overflow:hidden)
  page.tsx                # 'use client'; root page — owns all state, dynamic imports MapView
  about/
    page.tsx              # Server component — API docs, npm packages, pricing tier table
  components/
    MapView.tsx           # MapLibre map + ShadeMap shadow layer (SSR-skipped via dynamic())
    TimelineSlider.tsx    # Custom scrollable 24-h ruler; inertial drag; fixed red center cursor
    LocationSearch.tsx    # Nominatim geocoding, 400ms debounce
    AccumulationPanel.tsx # Sun exposure mode toggle + date range + quality slider + GeoTIFF export
    NavigationPanel.tsx   # Shade-aware routing UI: waypoints, route cards, errors
  lib/
    overpass.ts           # Fetches walkable road graph from Overpass API as RoutingGraph
    routing.ts            # Pure TS: types, haversine, snapToGraph, Dijkstra, graphToGeoJSON
```

### `page.tsx` layout (overlay structure)

```
┌──────────────────────────────────────────────────────┐
│ [LocationSearch]               [MapLibre zoom ctrl]   │  ← top-3 left-3 / top-right (native)
│                                                       │
│              MapView (full screen)                    │
│                                                       │
│ [AccumulationPanel]                                   │  ← absolute bottom-20 left-3
│ [NavigationPanel]                                     │
│ [About / API link]                                    │
├──────────────────────────────────────────────────────┤
│  [════════ TimelineSlider ruler (scrollable) ══════]  │  ← absolute bottom-0, full width
│          [▶]  [date picker]  [6:30 AM (editable)]     │  ← centered controls row
└──────────────────────────────────────────────────────┘
```

The timeline ruler and controls row are hidden when Sun Exposure (accumulation) mode is active.

`page.tsx` also defines module-level helpers: `formatTime12h`, `toDateInput`, `parseTime`, and the `TimeInput` component (clickable time label that becomes a text input).

---

## MapView Architecture

`MapView.tsx` is **never server-rendered** — loaded via `dynamic(() => import(...), { ssr: false })` in `page.tsx`. This is required because `maplibre-gl` uses browser APIs at import time.

**Init pattern:**
- `initRef` guards against double-init (React strict mode / HMR)
- `mapRef` and `shadeRef` hold the MapLibre map and ShadeMap instances
- `dateRef` mirrors the `date` prop so the `map.on("resize")` handler avoids stale closures
- `shadeUpdateTimerRef` holds a 1ms debounce timer for `setDate` calls — prevents GPU thrash during rapid slider drags
- `onMapClickRef` mirrors the `onMapClick` prop to avoid stale closures on the map click handler
- `markerARef` / `markerBRef` hold MapLibre Marker instances for navigation waypoints A (green) and B (red)
- Map instance is surfaced to `page.tsx` via `onMapReady(map)` callback → stored in a ref (not state) to avoid re-renders

**Map init options:**
- `maxTileCacheSize: 50` — evicts tiles once cached count exceeds limit (controls GPU VRAM)
- `maxParallelImageRequests: 6` — limits concurrent GPU texture uploads
- `canvasContextAttributes: { preserveDrawingBuffer: true }` — required for GeoTIFF export and shade sampling

**On `map.on("load")`:**
1. Add `fill-extrusion` layer (`buildings-3d`) on `maptiler_planet` / `building` source (hidden by default via `ENABLE_3D = false`)
2. Register `pitchend` handler to lazily add/remove terrain source and toggle 3D visibility (only active if `ENABLE_3D = true`)
3. Dynamically import and construct `ShadeMap` with terrain + building config
4. Register `map.on("resize")` → calls `shadeRef.current.setDate(dateRef.current)` to resize the shadow overlay texture

**`ENABLE_3D` flag (`MapView.tsx` line 26):**
Set to `false` by default. When false, the `buildings-3d` layer is hidden and the `pitchend` handler no-ops — no elevation tiles are fetched, no terrain mesh rendered. Set to `true` to restore 3D buildings and terrain mesh on map tilt.

**Resize fix explanation:**
The shadow simulator renders into a framebuffer texture sized to the viewport. On resize, calling `setDate` forces `setRenderBuffer(gl, gl.canvas.width, gl.canvas.height)` which resizes the texture to match the new dimensions, preventing shadow offset.

**Navigation layers (updated via effects):**
- Waypoint markers managed in a `useEffect` on `navWaypoints` — removes old markers and places new MapLibre Markers
- Route line managed in a `useEffect` on `navRoute` — adds/updates/removes `nav-route` GeoJSON source and `nav-route-line` layer (amber `#f59e0b`, width 4, opacity 0.9)

---

## Shade-Aware Routing

The main feature beyond shadow display. Users click "Navigate", place two waypoints on the map, then request route options.

**Pipeline (in `page.tsx` `calculateRoute`):**
1. Compute bounding box with 0.005° padding (~500 m) around the two waypoints
2. `fetchRoutingGraph(south, west, north, east)` — POST to Overpass API, returns `RoutingGraph`
3. Read the current map canvas once via `canvas.toBlob` → `createImageBitmap` → 2D canvas `getImageData`
4. For every graph edge: call `sampleEdgeShade(map, imageData, dpr, from, to, samples=5)` — samples 6 evenly-spaced pixels along the edge; a pixel is "shaded" if `B/R > 1.8` (ShadeMap's overlay color `#01112f` has heavy blue dominance)
5. Run Dijkstra × 3 with `shadeStrength` = 0.0, 0.5, 1.0 — deduplicated by node-ID key
6. Render up to 3 route cards: "Shortest", "Balanced", "Most shaded" — with distance and % shaded

**Dijkstra cost model (`routing.ts`):**
```
edge cost = distanceM * (1 - shadeStrength * shadeFactor * MAX_SHADE_SAVING)
MAX_SHADE_SAVING = 0.7   // caps saving so fully-shaded edges still cost 30% of distance
```

**Overpass query (`overpass.ts`):**
- Highway types: `footway|path|pedestrian|living_street|residential|unclassified|tertiary|secondary|service|cycleway|steps`
- Bidirectional adjacency list; all edge `shadeFactor` values initialised to 0 (caller fills in)
- Throws if no walkable roads found in the bounding box

---

## Tile Sources (all free)

| Purpose | Source | API Key? |
|---|---|---|
| Basemap + vector buildings | MapTiler `dataviz-dark` style | Yes (`NEXT_PUBLIC_MAPTILER_API_KEY`) |
| Shadow building data | `maptiler_planet` source, `building` layer (inside MapTiler style) | Same key |
| Terrain (shadows) | AWS Terrarium `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | No |
| 3D terrain mesh | Same AWS Terrarium tiles, `encoding: "terrarium"`, `raster-dem` type (lazy, only when tilted and `ENABLE_3D=true`) | No |
| Geocoding | Nominatim (`nominatim.openstreetmap.org/search`) — requires `User-Agent` header | No |
| Routing graph | Overpass API (`overpass-api.de`) — requires `User-Agent` header | No |

**Building query (`getFeatures`):**
- Source: `maptiler_planet`, layer: `building`
- Must be **async** — awaits `waitForMapLoad(map)` before calling `querySourceFeatures`
- Defaults missing heights to `render_height ?? 3.1` (one storey)
- Sorts features shortest → tallest (required by shadow simulator rasterization order)
- Returns empty array below zoom 12 (buildings not loaded at lower zooms)

---

## GeoTIFF Export (`buildGeoTIFF` in `AccumulationPanel.tsx`)

Captures map canvas → RGBA to RGB → writes a minimal uncompressed TIFF with georeferencing tags:

```
Offset   Content
0        TIFF header (8 bytes, little-endian)
8        IFD: 11 entries × 12 bytes + count + next-IFD = 138 bytes
146      BitsPerSample data: [8, 8, 8]
152      ModelPixelScaleTag: [scaleX, scaleY, 0]  (3 × float64)
176      ModelTiepointTag: [0, 0, 0, west, north, 0]  (6 × float64)
224      RGB pixel data
```

Tags: `ImageWidth`, `ImageLength`, `BitsPerSample`, `Compression=1`, `PhotometricInterpretation=2(RGB)`, `StripOffsets`, `SamplesPerPixel=3`, `RowsPerStrip`, `StripByteCounts`, `ModelPixelScaleTag(33550)`, `ModelTiepointTag(33922)`.

Canvas capture uses `canvas.toBlob` → `createImageBitmap` → 2D canvas `getImageData` (same pattern as routing shade sampling). Requires `canvasContextAttributes: { preserveDrawingBuffer: true }` on the MapLibre map.

---

## Timeline Ruler (`TimelineSlider.tsx`)

Replaces the native `<input type="range">`. The ruler is a fixed-width overflow-hidden container; a 2880 px content div (1440 min × 2 px/min) scrolls under a fixed red center cursor.

**Interaction model:**
- Drag left/right → content scrolls, red cursor stays centered → selected time = minute aligned with cursor
- `setPointerCapture` keeps drag live outside the element
- `fracMin` ref accumulates fractional pixel moves so sub-pixel drags are never lost

**Inertial scrolling:**
- EMA-smoothed velocity tracked during drag (70% new sample, 30% history)
- On pointer-up: `requestAnimationFrame` loop with `v *= e^(-0.018 * dt)` (frame-rate independent); stops at |v| < 0.04 px/ms or on boundary hit
- `dt` capped at 64 ms to avoid teleport on tab-switch; inertia cancelled immediately on next pointer-down

**Tick marks (static, computed at module load):**
- Hour ticks: 20 px, `rgba(255,255,255,0.35)` + label above
- 15-min ticks: 12 px, dimmer
- 5-min ticks: 5 px, dimmest

**Animation (in `page.tsx`):** `setInterval` at 50 ms, advances 2 min/tick (≈ 24 s/day). Play/pause uses SVG icons (triangle / two rectangles).

**`TimeInput` (in `page.tsx`):** Clicking the time label (e.g. `6:30 AM`) opens a text input. Accepts `6:30 AM`, `6:30PM`, `14:30`, `6:30`, `6 AM`, `14`, `6`. Enter/blur commits; Escape cancels.

---

## Known Working State

- ✅ Shadows render in real time as timeline ruler is dragged
- ✅ Inertial scrolling on timeline ruler with exponential decay
- ✅ Play/pause animation (2 min/tick, 50 ms interval, SVG icons)
- ✅ Editable time label (click to type; parses 12/24-hour formats)
- ✅ Terrain shadows (hills/valleys) via AWS Terrarium elevation data
- ✅ Building shadows from OSM heights via MapTiler vector tiles
- ✅ 3D extruded buildings + terrain mesh when map is tilted (`ENABLE_3D=true` required; currently `false`)
- ✅ Location search (Nominatim)
- ✅ Shadow accumulation map with configurable date range and quality (iterations 8–64)
- ✅ Sun exposure legend bar in AccumulationPanel (blue → cyan → green → yellow → red, 0 h → 12 h+)
- ✅ GeoTIFF export of accumulation map
- ✅ Shadow overlay correctly resizes when browser window is resized
- ✅ Shade-aware pedestrian routing (Shortest / Balanced / Most shaded via Dijkstra on Overpass graph)
- ✅ `/about` page with API docs and pricing tiers
