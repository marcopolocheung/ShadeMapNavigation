# Navigation System — How It Works

The navigation feature finds pedestrian walking routes between two points and ranks them by how much shade they receive at the current time of day. The entire pipeline runs client-side — no routing server, no tiles, no pre-computed data.

---

## Overview

1. User enters "Navigate" mode and clicks two map points (A and B)
2. The app fetches the walkable street graph for that area from Overpass (OSM)
3. The current map canvas is read as pixel data to determine which streets are currently shaded
4. Dijkstra runs three times with different shade preferences to produce up to three route options
5. Routes are drawn on the map and displayed as selectable cards

---

## State (all in `page.tsx`)

| State | Type | Purpose |
|---|---|---|
| `navMode` | `boolean` | Whether nav mode is active (map clicks set waypoints) |
| `waypointA` | `[lng, lat] \| null` | Start point, green marker |
| `waypointB` | `[lng, lat] \| null` | End point, red marker |
| `navRoutes` | `RouteOption[]` | Computed route options (0–3) |
| `selectedRouteIndex` | `number` | Index of the route currently drawn on map |
| `isCalculating` | `boolean` | True while Overpass + Dijkstra are running |
| `navError` | `string \| null` | Error message to display in the panel |

`waypointARef` and `waypointBRef` mirror the state values into refs. This is necessary because `handleMapClick` and `calculateRoute` are stable `useCallback` closures — they would see stale waypoint values if they read state directly.

---

## User Interaction Flow

### Entering navigation mode

`NavigationPanel` renders a "Navigate" toggle button. Clicking it calls `handleToggleNavMode`, which flips `navMode`. When turning **off** nav mode it also clears all waypoints, routes, and any error.

### Placing waypoints

While `navMode` is true, every map click fires `handleMapClick`:

```
No A yet       → set A
A set, no B    → set B
Both A and B   → reset: new click becomes A, clear B and routes
```

`MapView.tsx` always registers the click handler via `onMapClickRef` (a ref that mirrors the `onMapClick` prop). The ref pattern prevents the map's `"click"` listener from being re-added every time the prop changes.

### Waypoint markers

`MapView.tsx` has a `useEffect` that watches the `navWaypoints` prop `{ a?, b? }`. On every change it removes both existing markers and re-creates them:

- Point A → green MapLibre `Marker` (`color: "#22c55e"`)
- Point B → red MapLibre `Marker` (`color: "#ef4444"`)

### Triggering route calculation

The "Find Shaded Route" button in `NavigationPanel` is enabled only when both waypoints are set and `isCalculating` is false. Clicking it calls `calculateRoute` in `page.tsx`.

---

## Routing Pipeline (`calculateRoute` in `page.tsx`)

### Step 1 — Bounding box

```ts
const padding = 0.005; // ~500 m at mid-latitudes
const south = Math.min(a[1], b[1]) - padding;
const north = Math.max(a[1], b[1]) + padding;
const west  = Math.min(a[0], b[0]) - padding;
const east  = Math.max(a[0], b[0]) + padding;
```

The padding ensures that paths that go slightly outside the direct A–B corridor are still included.

### Step 2 — Fetch road graph from Overpass (`overpass.ts`)

`fetchRoutingGraph(south, west, north, east)` POSTs an Overpass QL query:

```
[out:json][timeout:25];
(
  way["highway"~"^(footway|path|pedestrian|living_street|residential|
                   unclassified|tertiary|secondary|service|cycleway|steps)$"]
  (<bbox>);
);
out body;
>;
out skel qt;
```

The highway filter is pedestrian-only — motorways, trunks, and primary roads are excluded.

The response is parsed into a `RoutingGraph`:

```ts
interface RoutingGraph {
  nodes: Map<number, OsmNode>;       // OSM node id → { id, lat, lon }
  adj:   Map<number, GraphEdge[]>;   // bidirectional adjacency list
}

interface GraphEdge {
  toId:       number;
  distanceM:  number;   // haversine metres
  shadeFactor: number;  // 0–1; filled in at step 4
}
```

Every OSM way is split into consecutive node pairs and each pair becomes **two directed edges** (A→B and B→A). `shadeFactor` is initialised to 0 for all edges here.

If Overpass returns no nodes or ways an error is thrown immediately.

### Step 3 — Read the map canvas

```ts
const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res));
const bmp  = await createImageBitmap(blob);
const tmp  = document.createElement("canvas");
tmp.width  = canvas.width;
tmp.height = canvas.height;
const ctx2d = tmp.getContext("2d")!;
ctx2d.drawImage(bmp, 0, 0);
const imageData = ctx2d.getImageData(0, 0, tmp.width, tmp.height);
```

The canvas is read **once** and the raw RGBA `ImageData` is used for all subsequent edge sampling. This avoids repeated GPU readbacks.

`canvas.toBlob` → `createImageBitmap` → 2D canvas is the correct cross-browser path for reading a WebGL canvas. Direct `getImageData` on the WebGL canvas is not possible; the 2D canvas acts as a staging buffer.

`preserveDrawingBuffer: true` must be set on the MapLibre map (it is) — without it the WebGL backbuffer is cleared after each frame and `toBlob` returns a blank image.

### Step 4 — Assign shade factors to graph edges

For every directed edge in the graph `sampleEdgeShade(map, imageData, dpr, from, to)` is called:

```ts
function sampleEdgeShade(
  map:       maplibregl.Map,
  imageData: ImageData,
  dpr:       number,
  from:      [lng, lat],
  to:        [lng, lat],
  samples = 5          // 6 points: i = 0, 1, 2, 3, 4, 5
): number
```

The function samples 6 evenly-spaced points along the edge:

1. **Geo-interpolate** `t` from 0 to 1 across `samples` steps
2. **Project** each `[lng, lat]` to screen pixel coordinates via `map.project()`
3. **Scale** by `devicePixelRatio` (the canvas is physically larger on HiDPI screens)
4. **Bounds-check** — skip pixels outside the canvas
5. **Read** R and B channels from the `imageData` buffer
6. **Test shade**: `(r === 0 ? 1 : b / r) > 1.8`

The threshold `B/R > 1.8` exploits ShadeMap's shadow overlay color `#01112f` (R:1, G:17, B:47). Shaded pixels are dominated by blue; neutral basemap grays have roughly equal RGB. A pixel passing the test adds 1 to `shadeSum`.

The return value is `shadeSum / count` — the fraction of sampled pixels that are shaded (0.0 = fully sunlit, 1.0 = fully shaded).

### Step 5 — Snap waypoints to graph nodes

```ts
const startId = snapToGraph(a, graph);
const endId   = snapToGraph(b, graph);
```

`snapToGraph` does a brute-force linear scan over all nodes and returns the ID of the node closest to the given `[lng, lat]` by haversine distance. No spatial index — fast enough for the graph sizes returned by Overpass at this scale.

### Step 6 — Dijkstra × 3

Three route variants are computed with increasing shade preference:

| Label | `shadeStrength` |
|---|---|
| Shortest | 0.0 |
| Balanced | 0.5 |
| Most shaded | 1.0 |

**Edge cost formula:**

```
cost = distanceM × (1 − shadeStrength × shadeFactor × MAX_SHADE_SAVING)
MAX_SHADE_SAVING = 0.7
```

At `shadeStrength = 0` cost is pure distance. At `shadeStrength = 1` a fully-shaded edge costs only 30% of its real distance (capped at 70% saving). The `MAX_SHADE_SAVING` cap prevents Dijkstra from routing through absurdly long detours just to stay in shade — fully-shaded edges still carry 30% of their real distance cost.

`dijkstra` in `routing.ts` uses a custom binary min-heap (`MinHeap<{ id, cost }>`) for O((V + E) log V) complexity. It exits early once the destination node is popped.

After each run the result is **deduplicated** by the string `nodeIds.join(",")`. If two different `shadeStrength` values produce the identical sequence of nodes (common when all nearby paths are either fully shaded or fully sunlit), only the first is kept. This prevents showing multiple identical cards.

### Step 7 — Build route options

Each unique Dijkstra result is converted to a `RouteOption`:

```ts
interface RouteOption {
  label:         string;   // "Shortest" | "Balanced" | "Most shaded"
  geojson:       GeoJSON.Feature<GeoJSON.LineString>;
  distanceM:     number;   // total edge-distance sum in metres
  shadeCoverage: number;   // shadedDist / totalDist  (0–1)
}
```

`shadeCoverage` is computed by walking the reconstructed path and accumulating `edge.distanceM * edge.shadeFactor` — a distance-weighted average shade fraction over the whole route.

`graphToGeoJSON` maps node IDs → `OsmNode` coords → `[lon, lat]` array → `GeoJSON.Feature<LineString>`.

---

## Route Rendering in MapView

`MapView.tsx` watches the `navRoute` prop (the selected route's GeoJSON feature) in a `useEffect`:

- **No route**: removes `nav-route-line` layer and `nav-route` source if they exist
- **Route, source not yet added**: creates source + layer
- **Route, source already exists**: calls `source.setData(navRoute)` to update in place

Layer style:
```ts
{ "line-color": "#f59e0b", "line-width": 4, "line-opacity": 0.9 }
```

(Amber, 4 px wide, slightly transparent.)

Selecting a different route card updates `selectedRouteIndex` in `page.tsx`, which re-derives `selectedNavRoute = navRoutes[selectedRouteIndex]?.geojson ?? null` and passes it down to `MapView` as `navRoute`.

---

## NavigationPanel UI (`components/NavigationPanel.tsx`)

The panel renders in the bottom-left overlay below `AccumulationPanel`.

- **Toggle button** — "Navigate" (inactive) / "Navigating — click to exit" (active, amber)
- **Expanded panel** (shown when `navMode = true`):
  - Green/red dot + coordinate or "Click map to set A/B" prompts
  - "Find Shaded Route" button with spinner — disabled until both waypoints placed
  - "Clear" button — resets both waypoints and routes
  - Route cards — one per unique route, selectable; shows label, distance (m / km), % shaded
  - Error display — red text below route cards

---

## Error Cases

| Condition | Error message |
|---|---|
| No walkable roads in bounding box | "No walkable roads found in this area. Try a more urban location or zoom closer." |
| No path connects A to B | "No walkable path found between the selected points. Try points on connected streets." |
| Canvas read failed (lost WebGL context) | "Canvas read failed — WebGL context may be lost" |
| Overpass HTTP error | "Overpass API error: {status} {statusText}" |
| Map not initialised | "Map not ready" |

---

## Limitations

- **Shade is a snapshot**: shade factors are sampled from the canvas at the moment "Find Shaded Route" is pressed. Dragging the time slider after calculating does not update route shade weights; re-press "Find Shaded Route" to recalculate.
- **Viewport only**: `sampleEdgeShade` skips pixels outside the current canvas bounds. Graph edges that fall off-screen get `shadeFactor = 0` (treated as fully sunlit). Zoomed-out views may under-shade distant edges.
- **Straight-line shade sampling**: each edge is sampled at 6 linearly-interpolated points between its endpoint nodes. For long curved ways this is an approximation.
- **Flat shade model**: shade is detected from the rendered pixel color, which is the result of ShadeMap's real-time GPU shadow pass. It reflects the current date and time but not per-way surface attributes.
- **Overpass rate limits**: the public Overpass API has rate limits. Very large bounding boxes or rapid repeated requests may return errors or be slow.
