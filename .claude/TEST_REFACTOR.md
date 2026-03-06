# ShadeMap → Native Shadow Engine: ClaudeCode Migration Guide

> **Primary Directive:** Read this entire document before writing a single line of code.
> Do not modify any existing source files. All work happens in a parallel test environment.

---

## 🔴 HARD RULES — Non-Negotiable

1. **DO NOT touch existing source files.** The production codebase is read-only for the duration of Phase 1 and Phase 2.
2. **DO NOT remove the ShadeMap integration** from the existing codebase until Phase 3 is explicitly approved by the user.
3. **DO NOT introduce any API that requires a paid key or has a usage cap.**
4. **DO NOT change MapBox layer IDs, event interfaces, or the rendering pipeline structure.**
5. All shadow computation must run **entirely client-side** — no new server, no new backend.
6. **DO NOT begin Phase 3 (final refactor) without explicit user sign-off** after testing the Phase 2 test build.

---

## 📁 Project Structure Convention

```
├── [existing source files — READ ONLY]
├── src-test/                  ← All new work goes here
    └── whatever you choose to add
```

---

## 🧭 Phase 0 — Codebase Audit (Do This First, No Code Written)

Before writing anything, complete the following audit and **output a written summary** of findings as `src-test/AUDIT_REPORT.md`:

### 0.1 — Map All ShadeMap Touchpoints
- Grep the entire codebase for: `shademap`, `ShadeMap`, `shadeMap`, any import from `@shademap`, any reference to `shademap.app`
- List every file, line number, and what the call does

### 0.2 — Document the Data Contract
Answer these questions explicitly:
- What does ShadeMap **return**? (shadow polygons? raster tiles? sun angle data?)
- What format is the data in? (GeoJSON? pixel buffer? typed array?)
- When is it called? (on map move? on time change? on load?)
- What consumes the output? (which MapBox layer or WebGL call?)

### 0.3 — Catalogue the Render Pipeline
- Identify which MapBox layers render shadow output
- Identify the WebGL context usage, if any
- Note the exact event triggers that cause shadow recalculation

### 0.4 — Identify Terrain Shadow Usage
- Does the app currently show shadows cast by terrain/hills, or only buildings?
- **Report this clearly** — it determines architecture choices in Phase 1

> ⚠️ Do not proceed to Phase 1 until the audit report is written.

---

## 🧪 Phase 1 — Build the Native Shadow Engine (in `src-test/` only)

### 1.1 — Approved Libraries

Install these and only these new dependencies:

| Library | Purpose | Install |
|---|---|---|
| `suncalc` | Sun azimuth + altitude computation | `npm install suncalc` |
| `@turf/turf` | Geospatial polygon math and clipping | `npm install @turf/turf` |

**Already in stack (use freely):**
- MapBox GL JS
- WebGL context (existing)
- `@turf/*` if already present

### 1.2 — Approved Free Data Sources

| Source | What It Provides | Notes |
|---|---|---|
| **SunCalc** (client-side library) | Solar azimuth, altitude, all sun times | No API key, no network call |
| **Overpass API** (`overpass-api.de`) | OSM building polygons + heights | Free, no key, rate limit friendly if queries are cached |
| **Mapbox Terrain-RGB tiles** | Elevation data per pixel | Already authenticated in your stack |
| **OpenTopoData** (`api.opentopodata.org`) | Fallback elevation lookup | Free tier, use only if Terrain-RGB is insufficient |

### 1.3 — Sun Position Module (`src-test/shadow-engine/sun-position.js`)

```
Implement a wrapper around SunCalc that:
- Accepts: { lat, lng, datetime }
- Returns: { azimuthDeg, altitudeDeg, azimuthRad, altitudeRad, sunVector: [x, y, z] }
- Caches the last result to avoid redundant computation on unchanged inputs
- Exports a getSunPosition(lat, lng, datetime) function
```

**Accuracy requirement:** Must match ShadeMap's sun position to within 0.1 degrees. SunCalc is well within this threshold.

### 1.4 — Building Shadow Module (`src-test/shadow-engine/building-shadows.js`)

```
Implement a building shadow geometry engine that:

STEP A — Data Fetching:
- Accepts a bounding box { north, south, east, west }
- Queries Overpass API for all buildings in that bbox
  Query: [out:json]; way["building"](bbox); out geom;
- Parses building:height tag (meters), falls back to building:levels * 3.0
- Caches fetched data by bbox tile to avoid redundant network calls

STEP B — Shadow Projection:
- Accepts: building polygon (array of [lng, lat]), buildingHeightMeters, sunPosition
- Computes shadow trapezoid using:
    shadowLength = buildingHeight / tan(sunAltitudeRad)
    shadowDirection = sunAzimuthRad + π  (opposite of sun)
    Project each rooftop vertex by shadowLength in shadowDirection
- Returns GeoJSON polygon representing the shadow footprint

STEP C — Output:
- Returns a GeoJSON FeatureCollection of all shadow polygons in view
- Must match the data shape that ShadeMap returned (see Audit Report 0.2)
```

### 1.5 — Terrain Shadow Module (`src-test/shadow-engine/terrain-shadows.js`)

> ⚠️ Read the Audit Report section 0.4 before implementing this module.
> If the app does NOT currently use terrain shadows, implement a **stub** that returns an empty FeatureCollection and log a warning. Do not over-engineer.

```
If terrain shadows ARE used:
- Sample elevation along shadow rays using Mapbox Terrain-RGB tiles
- For each ray from observer point toward sun (reversed), check if terrain
  elevation exceeds the sun's line-of-sight elevation at that distance
- Mark occluded points as shadowed
- Resolution: match the current ShadeMap tile resolution, do not exceed it
- This is expensive — implement a worker-thread version using Web Workers
  if real-time performance is insufficient
```

### 1.6 — Unified Shadow API (`src-test/shadow-engine/index.js`)

```
Create a drop-in interface that:
- Exports: initShadowEngine(map, options)
- Exports: updateShadows(datetime) — mirrors ShadeMap's update call signature
- Exports: destroyShadowEngine()
- Internally orchestrates sun-position, building-shadows, terrain-shadows
- Outputs data in EXACTLY the same format ShadeMap returned (per Audit Report 0.2)
- Emits the same events ShadeMap emitted, if any
```

---

## 🖥️ Phase 2 — Test UI Integration

### 2.1 — The "Test" Button (`src-test/test-ui/test-toggle.js`)

```
Inject a persistent UI control into the existing app that:

VISUAL SPEC:
- Position: fixed, top-right corner, z-index: 9999
- Appearance: large button, clearly labeled "TEST MODE"
- Color when inactive: neutral gray (#6B7280)
- Color when active: bright amber (#F59E0B) with pulsing border animation
- Font: bold, minimum 14px, clearly readable
- Must not obscure map controls

BEHAVIOR:
- Default state: OFF (production ShadeMap engine runs as normal)
- When clicked ON: swap shadow engine from ShadeMap to native engine in real-time
- When clicked OFF: restore ShadeMap engine
- Display current mode label below button: "Engine: ShadeMap" or "Engine: Native"
- Display current sun position readout (azimuth/altitude) when Native is active
- Display a small perf counter: "Shadow calc: Xms" when Native is active

IMPLEMENTATION:
- Inject via test-entry.js, do not modify existing HTML or JS files
- Use vanilla JS DOM injection — no new framework dependencies
- The toggle must be accessible at all zoom levels and map positions
```

### 2.2 — Test Entry Point (`src-test/test-entry.js`)

```
This file:
- Imports the native shadow engine from src-test/shadow-engine/index.js
- Imports the test toggle UI from src-test/test-ui/test-toggle.js
- Wires toggle state to engine swap logic
- Is loaded as a SECONDARY script alongside (not replacing) the existing app entry point
- Must not interfere with existing app initialization
```

### 2.3 — Build Configuration

```
Add a test build script to package.json (do not modify existing build scripts):
  "build:test": "..."  ← produces a test build that includes src-test/test-entry.js
  "dev:test": "..."    ← dev server with test mode enabled

The test build must:
- Include all existing production code unchanged
- Append the test layer on top
- Be clearly distinguishable (e.g., page title: "[TEST] App Name")
```

---

## ✅ Phase 2 Acceptance Criteria (User Will Test These)

ClaudeCode must self-verify all of the following before marking Phase 2 complete:

- [ ] "TEST MODE" button is visible and functional at app load
- [ ] Toggling to Native engine produces visually comparable shadows to ShadeMap
- [ ] Sun position matches ShadeMap's sun position at the same datetime/location
- [ ] Building shadows update correctly when datetime slider is changed
- [ ] No console errors in Native mode
- [ ] No performance regression > 2x compared to ShadeMap (measure ms per update)
- [ ] Toggling back to ShadeMap restores original behavior perfectly
- [ ] App works offline in Native mode (except for initial OSM building fetch)
- [ ] Existing production code files are unmodified (run `git diff` to verify)

---

## 🔨 Phase 3 — Final Refactor (DO NOT BEGIN WITHOUT USER APPROVAL)

> The user will test Phase 2 and explicitly say "proceed to Phase 3" before this begins.

Only after user sign-off:

```
1. Copy src-test/shadow-engine/ into the main src/ directory
2. Replace all ShadeMap imports and calls with the native engine API
3. Remove the test toggle UI
4. Remove src-test/ directory
5. Remove ShadeMap from package.json dependencies
6. Update README with new architecture documentation
7. Run full visual regression check at 5+ known coordinate/time combinations
8. Verify bundle size change
```

---

## 🧱 Architecture Decision Required Before Starting

**Read section 0.4 of the audit, then answer this:**

> Does the existing app render terrain-based shadows (shadows cast by hills and mountains)?

- **If YES:** Implement full terrain raycasting in Phase 1.5. Expect higher complexity and potential Web Worker usage.
- **If NO:** Stub terrain shadows as an empty return. Focus effort on building shadows only.

**ClaudeCode must not make this decision independently.** If unclear after the audit, output a question for the user before proceeding.

---

## 📚 Reference Material for ClaudeCode

### SunCalc Usage
```javascript
import SunCalc from 'suncalc';
const pos = SunCalc.getPosition(new Date(), lat, lng);
// pos.altitude: radians above horizon
// pos.azimuth:  radians from south, clockwise
```

### Overpass API Query (Buildings with Height)
```
[out:json][timeout:25];
(
  way["building"](south,west,north,east);
  relation["building"](south,west,north,east);
);
out body geom;
```

### Shadow Vector Math
```
shadowLength = buildingHeightMeters / Math.tan(sunAltitudeRadians)
shadowDirX   = -Math.sin(sunAzimuthRadians)
shadowDirY   = -Math.cos(sunAzimuthRadians)
// Project each roof vertex by (shadowDirX * shadowLength, shadowDirY * shadowLength)
// Convert meters to degrees: 1 deg lat ≈ 111,320m; 1 deg lng ≈ 111,320 * cos(lat)
```

### Mapbox Terrain-RGB Elevation Decoding
```javascript
// From a pixel [r, g, b] sampled from terrain-rgb tile:
const elevation = -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
```

---

## 🗂️ Summary Checklist

| Phase | Task | Status |
|---|---|---|
| 0 | Audit all ShadeMap touchpoints | ⬜ |
| 0 | Document ShadeMap data contract | ⬜ |
| 0 | Identify terrain shadow usage | ⬜ |
| 0 | Write AUDIT_REPORT.md | ⬜ |
| 1 | Implement sun-position.js (SunCalc) | ⬜ |
| 1 | Implement building-shadows.js (OSM) | ⬜ |
| 1 | Implement terrain-shadows.js or stub | ⬜ |
| 1 | Implement unified shadow API index.js | ⬜ |
| 2 | Implement "TEST MODE" button | ⬜ |
| 2 | Implement test-entry.js | ⬜ |
| 2 | Add build:test and dev:test scripts | ⬜ |
| 2 | Verify all acceptance criteria | ⬜ |
| 2 | **USER APPROVAL REQUIRED** | 🔒 |
| 3 | Replace ShadeMap with native engine | ⬜ |
| 3 | Remove test scaffolding | ⬜ |
| 3 | Final regression check | ⬜ |