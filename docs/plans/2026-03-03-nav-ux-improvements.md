# Navigation UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add draggable waypoint markers, explicit pin-to-map selection (no accidental taps), a full-height collapsible left sidebar for navigation, and move the sun-exposure/settings tools to the bottom-right.

**Architecture:** NavigationPanel is rewritten as a self-contained absolutely-positioned full-height sidebar; `pendingSlot` state in page.tsx gates all map clicks; MapLibre markers get `draggable: true` with a dragend callback chain. AccumulationPanel/SettingsPanel move to a new bottom-right container.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS v4, MapLibre GL JS 5.9.0

---

## Task 1: Move tools panel to bottom-right, strip old wrapper

**Files:**
- Modify: `app/page.tsx`

The current bottom-left div wraps both the tools card (AccumulationPanel + SettingsPanel + About) and NavigationPanel together. Split them: tools go bottom-right, NavigationPanel becomes standalone (its own absolute positioning comes in Task 3).

**Step 1: Replace the combined bottom-left wrapper in `app/page.tsx`**

Find this block (around line 823):
```tsx
      {/* Bottom-left overlay: view tools dock + navigation panel */}
      <div className="absolute bottom-20 left-3 z-10 flex flex-col gap-2 items-start">
        {/* View tools — grouped into a single glass card */}
        <div className="bg-black/60 backdrop-blur-sm rounded-xl border border-white/[0.07] p-1.5 flex flex-col gap-1">
          <AccumulationPanel
            accumulation={accumulation}
            onChange={setAccumulation}
            getCanvas={getCanvas as () => HTMLCanvasElement | undefined}
            getBounds={getBounds as () => { getWest(): number; getEast(): number; getNorth(): number; getSouth(): number } | undefined}
          />
          <SettingsPanel
            showSunLines={showSunLines}
            onShowSunLinesChange={setShowSunLines}
          />
          <a
            href="/about"
            className="text-[10px] text-white/30 hover:text-white/60 transition-colors px-1.5 pt-0.5 pb-0.5"
          >
            About / API
          </a>
        </div>
        {/* Navigation — separate action panel */}
        <NavigationPanel
```

Replace with two separate sibling divs — one for tools (bottom-right), one for NavigationPanel (standalone, no wrapper div needed since it self-positions in Task 3):

```tsx
      {/* Bottom-right overlay: view tools */}
      <div className="absolute bottom-20 right-3 z-10">
        <div className="bg-black/60 backdrop-blur-sm rounded-xl border border-white/[0.07] p-1.5 flex flex-col gap-1">
          <AccumulationPanel
            accumulation={accumulation}
            onChange={setAccumulation}
            getCanvas={getCanvas as () => HTMLCanvasElement | undefined}
            getBounds={getBounds as () => { getWest(): number; getEast(): number; getNorth(): number; getSouth(): number } | undefined}
          />
          <SettingsPanel
            showSunLines={showSunLines}
            onShowSunLinesChange={setShowSunLines}
          />
          <a
            href="/about"
            className="text-[10px] text-white/30 hover:text-white/60 transition-colors px-1.5 pt-0.5 pb-0.5"
          >
            About / API
          </a>
        </div>
      </div>
      {/* Navigation sidebar — self-positions absolutely (see NavigationPanel) */}
      <NavigationPanel
```

Also remove the closing `</div>` that was the outer `bottom-20 left-3` wrapper.

**Step 2: Verify visually**

Run `npm run dev`, open http://localhost:3000. Confirm:
- AccumulationPanel / SettingsPanel / About link appear at **bottom-right**
- NavigationPanel "Navigate" button still appears somewhere (may be temporarily broken layout until Task 3)

**Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat: move view tools panel to bottom-right"
```

---

## Task 2: Add `pendingSlot` state and update map click handling in `page.tsx`

**Files:**
- Modify: `app/page.tsx`

`pendingSlot` is `'A' | 'B' | null`. Map clicks only set waypoints when a slot is pending.

**Step 1: Add state and ref near other nav state declarations (around line 236)**

```tsx
  const [pendingSlot, setPendingSlot] = useState<'A' | 'B' | null>(null);
  const pendingSlotRef = useRef<'A' | 'B' | null>(null);
  pendingSlotRef.current = pendingSlot;
```

**Step 2: Replace `handleMapClick` (around line 354)**

Old:
```tsx
  const handleMapClick = useCallback(
    (coord: { lng: number; lat: number }) => {
      if (!navMode) return;
      setNavError(null);
      const a = waypointARef.current;
      const b = waypointBRef.current;
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      if (!a) {
        setWaypointA([coord.lng, coord.lat]);
        setWaypointALabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointALabel(lbl); });
      } else if (!b) {
        setWaypointB([coord.lng, coord.lat]);
        setWaypointBLabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointBLabel(lbl); });
      } else {
        // Third click: reset to new A, clear B and routes
        setWaypointA([coord.lng, coord.lat]);
        setWaypointALabel(coordLabel);
        setWaypointB(null);
        setWaypointBLabel(null);
        setNavRoutes([]);
        setSelectedRouteIndex(0);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointALabel(lbl); });
      }
    },
    [navMode]
  );
```

New:
```tsx
  const handleMapClick = useCallback(
    (coord: { lng: number; lat: number }) => {
      const slot = pendingSlotRef.current;
      if (!slot) return;
      setNavError(null);
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      if (slot === 'A') {
        setWaypointA(lngLat);
        setWaypointALabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointALabel(lbl); });
        setPendingSlot(waypointBRef.current ? null : 'B');
      } else {
        setWaypointB(lngLat);
        setWaypointBLabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointBLabel(lbl); });
        setPendingSlot(null);
      }
      setNavRoutes([]);
      setSelectedRouteIndex(0);
    },
    []
  );
```

**Step 3: Clear `pendingSlot` in `handleToggleNavMode` when exiting nav mode**

In `handleToggleNavMode` (around line 394), inside the `if (prev)` block add:
```tsx
        setPendingSlot(null);
```

**Step 4: Clear `pendingSlot` in `handleClear`**

Add to `handleClear`:
```tsx
    setPendingSlot(null);
```

**Step 5: Add Escape key listener to cancel pendingSlot**

After the `useEffect` for animation (around line 302), add:
```tsx
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingSlot(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
```

**Step 6: Add pending-slot banner and crosshair cursor to the JSX**

Inside the root div (after the MapView element), add the floating banner:
```tsx
      {/* Pending waypoint selection banner */}
      {pendingSlot && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none flex items-center gap-2 bg-black/80 backdrop-blur-md border border-amber-400/40 rounded-full px-4 py-1.5 text-sm text-amber-300 select-none">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
          Click map to place waypoint {pendingSlot}
          <span className="text-white/30 text-xs ml-1">— Esc to cancel</span>
        </div>
      )}
```

Also apply crosshair cursor to the MapView container by wrapping it or passing a prop. Add a `mapClickActive` prop to MapView (wired in Task 4), but for now just add the banner.

**Step 7: Pass `pendingSlot` and `onSetPendingSlot` to NavigationPanel**

Add to the NavigationPanel JSX:
```tsx
          pendingSlot={pendingSlot}
          onSetPendingSlot={setPendingSlot}
```

**Step 8: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add pendingSlot gate for map click waypoint selection"
```

---

## Task 3: Rewrite NavigationPanel as full-height collapsible sidebar

**Files:**
- Modify: `app/components/NavigationPanel.tsx`

This is the largest change. The component becomes self-positioning (`absolute inset-y-0 left-0`), owns `collapsed` state internally, and exposes pin buttons per waypoint slot.

**Step 1: Update the props interface**

```tsx
export interface NavigationPanelProps {
  navMode: boolean;
  onToggleNavMode: () => void;
  waypointA: [number, number] | null;
  waypointB: [number, number] | null;
  waypointALabel: string | null;
  waypointBLabel: string | null;
  onSetWaypointA: (coord: [number, number], label: string) => void;
  onSetWaypointB: (coord: [number, number], label: string) => void;
  onSwapWaypoints: () => void;
  onClearWaypointA: () => void;
  onClearWaypointB: () => void;
  onClear: () => void;
  onCalculate: () => void;
  isCalculating: boolean;
  routes: RouteOption[];
  selectedRouteIndex: number;
  onSelectRoute: (i: number) => void;
  error: string | null;
  solarIntensity?: number | null;
  pendingSlot: 'A' | 'B' | null;
  onSetPendingSlot: (slot: 'A' | 'B' | null) => void;
  locationSearchSlot?: React.ReactNode;
}
```

**Step 2: Add internal `collapsed` state; reset when navMode turns off**

```tsx
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!navMode) setCollapsed(false);
  }, [navMode]);
```

**Step 3: Replace the render — when `!navMode`, render standalone Navigate button**

```tsx
  if (!navMode) {
    return (
      <div className="absolute bottom-6 left-3 z-20">
        <button
          onClick={onToggleNavMode}
          className="bg-black/70 backdrop-blur-sm text-white/80 hover:text-white border border-white/10 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:border-white/25"
        >
          Navigate
        </button>
      </div>
    );
  }
```

**Step 4: When `navMode`, render full-height sidebar overlay**

Replace the `navMode && (...)` block with this full sidebar structure:

```tsx
  return (
    <div className="absolute inset-y-0 left-0 z-20 flex items-stretch pointer-events-none">
      {/* Panel content — 288px when expanded, 0 when collapsed */}
      <div
        className={`relative flex flex-col overflow-hidden transition-all duration-200 ease-in-out pointer-events-auto ${
          collapsed ? 'w-0' : 'w-72'
        }`}
      >
        <div className="w-72 h-full flex flex-col bg-black/85 backdrop-blur-md border-r border-white/[0.07]">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.07] shrink-0">
            <span className="text-white/80 text-sm font-semibold tracking-wide">Navigate</span>
            <button
              onClick={onToggleNavMode}
              className="text-white/30 hover:text-white/70 transition-colors p-1 rounded"
              title="Exit navigation mode"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="1" y1="1" x2="9" y2="9" />
                <line x1="9" y1="1" x2="1" y2="9" />
              </svg>
            </button>
          </div>

          {/* LocationSearch slot */}
          {locationSearchSlot && (
            <div className="px-2 py-2 border-b border-white/[0.07] shrink-0">
              {locationSearchSlot}
            </div>
          )}

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 flex flex-col gap-3 min-h-0">
            {/* Waypoint rows */}
            <div className="flex flex-col gap-1 text-xs">
              {/* Waypoint A */}
              <div className="flex items-start gap-1.5">
                <div className="flex-1 min-w-0">
                  <WaypointInput
                    label={waypointALabel}
                    placeholder="Search or click pin for start"
                    dotColor="green"
                    onSet={onSetWaypointA}
                    onClear={onClearWaypointA}
                  />
                </div>
                <button
                  onClick={() => onSetPendingSlot(pendingSlot === 'A' ? null : 'A')}
                  className={`shrink-0 mt-0.5 p-1 rounded transition-all ${
                    pendingSlot === 'A'
                      ? 'text-amber-400 ring-1 ring-amber-400/60 bg-amber-400/10 animate-pulse'
                      : 'text-white/25 hover:text-white/60'
                  }`}
                  title="Click to place on map"
                >
                  <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                    <path d="M6 0C3.24 0 1 2.24 1 5c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5zm0 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                  </svg>
                </button>
              </div>

              {/* Swap */}
              <div className="flex items-center pl-1">
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onSwapWaypoints}
                  className="text-white/30 hover:text-white/70 transition-colors text-base leading-none px-1"
                  title="Swap start and destination"
                >
                  ⇅
                </button>
              </div>

              {/* Waypoint B */}
              <div className="flex items-start gap-1.5">
                <div className="flex-1 min-w-0">
                  <WaypointInput
                    label={waypointBLabel}
                    placeholder="Search or click pin for destination"
                    dotColor="red"
                    onSet={onSetWaypointB}
                    onClear={onClearWaypointB}
                  />
                </div>
                <button
                  onClick={() => onSetPendingSlot(pendingSlot === 'B' ? null : 'B')}
                  className={`shrink-0 mt-0.5 p-1 rounded transition-all ${
                    pendingSlot === 'B'
                      ? 'text-amber-400 ring-1 ring-amber-400/60 bg-amber-400/10 animate-pulse'
                      : 'text-white/25 hover:text-white/60'
                  }`}
                  title="Click to place on map"
                >
                  <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                    <path d="M6 0C3.24 0 1 2.24 1 5c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5zm0 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 shrink-0">
              <button
                onClick={onCalculate}
                disabled={!waypointA || !waypointB || isCalculating}
                className="flex-1 px-2 py-1.5 rounded text-xs font-medium bg-amber-500 text-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-400 transition-colors flex items-center justify-center gap-1"
              >
                {isCalculating && (
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                {isCalculating ? 'Calculating…' : 'Find Shaded Route'}
              </button>
              <button
                onClick={onClear}
                className="px-2 py-1.5 rounded text-xs text-white/60 hover:text-white/90 border border-white/10 transition-colors"
              >
                Clear
              </button>
            </div>

            {/* Route cards */}
            {routes.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-white/10 pt-2">
                {solarIntensity != null && <SolarPill intensity={solarIntensity} />}
                {routes.map((r, i) => {
                  const streak = formatShadeStreak(r.longestContinuousShadeM);
                  const transitions = formatTransitions(r.shadeTransitions);
                  const detour = formatDetour(r.detourRatio);
                  const hasSecondLine =
                    streak !== null || r.shadeTransitions > 0 || r.detourRatio > 1.05 || r.turnCount > 0;
                  return (
                    <button
                      key={i}
                      onClick={() => onSelectRoute(i)}
                      className={`text-left px-2 py-1.5 rounded text-xs transition-all ${
                        i === selectedRouteIndex
                          ? 'bg-amber-500/20 border border-amber-500 shadow-sm shadow-amber-500/20'
                          : 'border border-white/10 hover:border-white/25 hover:bg-white/[0.03]'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <span className={i === selectedRouteIndex ? 'text-amber-300 font-semibold' : 'text-white/50'}>
                          {r.label}
                        </span>
                        <span className={`text-[10px] tabular-nums ${i === selectedRouteIndex ? 'text-amber-400/70' : 'text-white/30'}`}>
                          {formatDist(r.distanceM)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-amber-400 transition-all duration-300"
                            style={{ width: `${Math.round(r.shadeCoverage * 100)}%` }}
                          />
                        </div>
                        <span className="text-white/40 text-[10px] tabular-nums w-7 text-right">
                          {Math.round(r.shadeCoverage * 100)}%
                        </span>
                      </div>
                      {hasSecondLine && (
                        <div className="text-slate-400 text-[10px] mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0">
                          {streak && <span>{streak}</span>}
                          <span>{transitions}</span>
                          {detour && <span>{detour}</span>}
                          {r.turnCount > 0 && <span>{r.turnCount} turn{r.turnCount === 1 ? '' : 's'}</span>}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="text-xs text-red-400 border-t border-white/10 pt-2 shrink-0">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Collapse toggle tab — always visible on the sidebar's right edge */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="pointer-events-auto self-center bg-black/85 backdrop-blur-md border border-l-0 border-white/[0.07] rounded-r-lg px-1 py-4 text-white/40 hover:text-white/80 transition-colors shrink-0"
        title={collapsed ? 'Expand navigation panel' : 'Collapse navigation panel'}
      >
        <svg
          width="8" height="12" viewBox="0 0 8 12"
          fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        >
          {collapsed
            ? <polyline points="2,2 6,6 2,10" />
            : <polyline points="6,2 2,6 6,10" />
          }
        </svg>
      </button>
    </div>
  );
```

**Step 5: Remove the old `navMode && (...)` panel block** — the entire old expanded-panel JSX is replaced by the above. Keep `WaypointInput` component and helper functions (`formatDist`, `formatShadeStreak`, `formatTransitions`, `formatDetour`, `SolarPill`) unchanged.

**Step 6: Verify**

Run `npm run dev`. With navMode off: small Navigate button at bottom-left. Click it: full-height sidebar appears at left. The `›/‹` tab collapses/expands. Exit button (×) closes nav mode.

**Step 7: Commit**

```bash
git add app/components/NavigationPanel.tsx
git commit -m "feat: rewrite NavigationPanel as collapsible full-height sidebar"
```

---

## Task 4: Wire `locationSearchSlot`, crosshair cursor, and `mapClickActive` in `page.tsx`

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/components/MapView.tsx`

**Step 1: Move LocationSearch into sidebar when navMode is active**

In `app/page.tsx`, find the top-left LocationSearch block:
```tsx
      {/* Top-left overlay: search */}
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
        <LocationSearch onSelect={flyTo} />
      </div>
```

Replace with a conditional:
```tsx
      {/* Top-left overlay: search — hidden when nav sidebar is active (it moves inside sidebar) */}
      {!navMode && (
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
          <LocationSearch onSelect={flyTo} />
        </div>
      )}
```

Then pass `locationSearchSlot` to NavigationPanel:
```tsx
          locationSearchSlot={navMode ? <LocationSearch onSelect={flyTo} /> : undefined}
```

**Step 2: Add `mapClickActive` prop to MapView**

In `app/components/MapView.tsx`, add to the props interface:
```tsx
  mapClickActive?: boolean;
```

Add to the destructured props:
```tsx
  mapClickActive = false,
```

Apply cursor style to the map container div:
```tsx
      <div ref={containerRef} className={`w-full h-full${mapClickActive ? ' cursor-crosshair' : ''}`} />
```

**Step 3: Pass `mapClickActive` from page.tsx**

In the MapView JSX element in `app/page.tsx`:
```tsx
        mapClickActive={pendingSlot !== null}
```

**Step 4: Verify the full pending-slot flow**

Run `npm run dev`. Enter Navigate mode. Click the pin button for A — it glows amber, banner appears at top of map, cursor is crosshair. Click map — waypoint A is set, pin auto-activates for B. Click map again — B set, banner disappears, cursor normal. Press Escape mid-flow — cancels pending selection.

**Step 5: Commit**

```bash
git add app/page.tsx app/components/MapView.tsx
git commit -m "feat: wire locationSearch into nav sidebar, add crosshair cursor and pendingSlot banner"
```

---

## Task 5: Draggable waypoint markers

**Files:**
- Modify: `app/components/MapView.tsx`
- Modify: `app/page.tsx`

**Step 1: Add `onMarkerDragEnd` prop to MapView**

In `app/components/MapView.tsx`, extend the interface:
```tsx
  onMarkerDragEnd?: (slot: 'A' | 'B', coord: { lng: number; lat: number }) => void;
```

Add a ref for the callback (same pattern as `onMapClickRef`):
```tsx
  const onMarkerDragEndRef = useRef(onMarkerDragEnd);
```

Add the effect to keep it current:
```tsx
  useEffect(() => { onMarkerDragEndRef.current = onMarkerDragEnd; }, [onMarkerDragEnd]);
```

**Step 2: Make markers draggable and wire dragend**

In the navWaypoints `useEffect` (around line 363), replace marker creation:

```tsx
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markerARef.current?.remove(); markerARef.current = null;
    markerBRef.current?.remove(); markerBRef.current = null;
    if (navWaypoints?.a) {
      const mA = new maplibregl.Marker({ color: "#22c55e", draggable: true })
        .setLngLat(navWaypoints.a)
        .addTo(map);
      mA.on('dragend', () => {
        const ll = mA.getLngLat();
        onMarkerDragEndRef.current?.('A', { lng: ll.lng, lat: ll.lat });
      });
      markerARef.current = mA;
    }
    if (navWaypoints?.b) {
      const mB = new maplibregl.Marker({ color: "#ef4444", draggable: true })
        .setLngLat(navWaypoints.b)
        .addTo(map);
      mB.on('dragend', () => {
        const ll = mB.getLngLat();
        onMarkerDragEndRef.current?.('B', { lng: ll.lng, lat: ll.lat });
      });
      markerBRef.current = mB;
    }
  }, [navWaypoints]);
```

**Step 3: Add drag handler in `page.tsx`**

```tsx
  const handleMarkerDragEnd = useCallback(
    (slot: 'A' | 'B', coord: { lng: number; lat: number }) => {
      const lngLat: [number, number] = [coord.lng, coord.lat];
      const coordLabel = `${coord.lat.toFixed(3)}, ${coord.lng.toFixed(3)}`;
      setNavRoutes([]);
      setSelectedRouteIndex(0);
      if (slot === 'A') {
        setWaypointA(lngLat);
        setWaypointALabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointALabel(lbl); });
      } else {
        setWaypointB(lngLat);
        setWaypointBLabel(coordLabel);
        geocodeReverse(coord.lat, coord.lng).then((lbl) => { if (lbl) setWaypointBLabel(lbl); });
      }
    },
    []
  );
```

**Step 4: Pass to MapView**

In the MapView JSX element in `app/page.tsx`:
```tsx
        onMarkerDragEnd={handleMarkerDragEnd}
```

**Step 5: Verify**

Run `npm run dev`. Enter Navigate mode, place both waypoints. Drag marker A to a new position — waypoint A coord updates, label reverse-geocodes, route cards clear. Drag marker B — same.

**Step 6: Commit**

```bash
git add app/components/MapView.tsx app/page.tsx
git commit -m "feat: add draggable waypoint markers with reverse geocode on dragend"
```

---

## Verification Checklist

After all tasks complete:

- [ ] AccumulationPanel / SettingsPanel / About link are at **bottom-right**
- [ ] LocationSearch is at top-left when navMode=false, inside sidebar when navMode=true
- [ ] "Navigate" button is at bottom-left when navMode=false
- [ ] Entering nav mode opens the full-height sidebar
- [ ] `›/‹` collapse tab hides/shows the sidebar content (collapses to just the tab)
- [ ] `×` exit button in sidebar header exits nav mode entirely
- [ ] Pin buttons for A/B glow amber when active; clicking same pin cancels it
- [ ] Clicking map without a pending slot does nothing
- [ ] Banner appears at top of map when a slot is pending; Escape cancels it
- [ ] Map cursor is crosshair when pending, default otherwise
- [ ] After clicking map for A, auto-advances to B if B is empty
- [ ] Waypoint markers are draggable; drag updates coord + label + clears routes
- [ ] All existing features still work: shadow rendering, accumulation, sun lines, route calculation
