# Transit Log Panel + Zoom Counter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a toggleable right-side log panel showing transit API call history, and a live zoom level counter pill.

**Architecture:** All log state lives in `page.tsx`. `fetchTransitForViewport` appends entries to `transitLogs` via `setTransitLogs` (stable setter, no dep array changes needed). A new `TransitLogPanel` component renders the drawer. The zoom counter reads `mapZoom` state updated from `map.on("zoom")` in `handleMapReady`. Both controls live inside the existing `bottom-20 right-3` view tools card.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Next.js App Router

---

### Task 1: Add `TransitLogEntry` type + log state + zoom state to `page.tsx`

**Files:**
- Modify: `app/page.tsx` (imports ~line 16, state block ~line 247)

**Step 1: Add `TransitMode` to the existing transit import**

Find this line (~line 16):
```ts
import type { TransitStop } from "./lib/transit";
```
Change to:
```ts
import type { TransitStop, TransitMode } from "./lib/transit";
```

**Step 2: Add the `TransitLogEntry` interface + module-level counter just above the `todayAt` helper (~line 29)**

```ts
interface TransitLogEntry {
  id: number;
  ts: Date;
  event: "FETCH" | "CACHE_HIT" | "SKIPPED" | "ERROR";
  zoom: number;
  stopCount?: number;
  modes?: Partial<Record<TransitMode, number>>;
  reason?: string;
}
let _logSeq = 0;
```

**Step 3: Add zoom + log state inside the component body, after the existing transit state block (~line 254)**

```ts
// Debug / log state
const [mapZoom, setMapZoom]           = useState(2);
const [showTransitLog, setShowTransitLog] = useState(false);
const [transitLogs, setTransitLogs]   = useState<TransitLogEntry[]>([]);
```

**Step 4: Verify TypeScript compiles cleanly**

```bash
cd /home/unusn/shademapnav && npx tsc --noEmit
```
Expected: zero errors.

---

### Task 2: Register zoom listener + add log entries to `fetchTransitForViewport`

**Files:**
- Modify: `app/page.tsx` (`handleMapReady` ~line 327, `fetchTransitForViewport` ~line 860)

**Step 1: Add zoom listener in `handleMapReady`**

Find inside `handleMapReady` (after `map.on("moveend", ...)` block, before the closing `}, [])`):
```ts
    map.on("moveend", () => {
      const c = map.getCenter();
      setMapCenter([c.lat, c.lng]);
      setMapUtcOffsetMin(longitudeToUtcOffsetMin(c.lng));
    });
```
Add after it:
```ts
    map.on("zoom", () => setMapZoom(map.getZoom()));
    setMapZoom(map.getZoom()); // seed initial value
```

**Step 2: Define a `pushLog` helper just before `fetchTransitForViewport`**

Add this block just above `const fetchTransitForViewport = useCallback(...)` (~line 860):
```ts
  // Stable helper: setTransitLogs setter is guaranteed stable by React.
  const pushLog = useCallback((entry: Omit<TransitLogEntry, "id" | "ts">) => {
    setTransitLogs(prev => [{ ...entry, id: ++_logSeq, ts: new Date() }, ...prev].slice(0, 100));
  }, []);
```

**Step 3: Add log entries inside `fetchTransitForViewport`**

Current body:
```ts
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
```

Replace with:
```ts
  const fetchTransitForViewport = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !showTransitRef.current) return;
    const zoom = map.getZoom();
    // Safety floor: continent-scale bboxes
    if (zoom < 9) {
      pushLog({ event: "SKIPPED", zoom, reason: "zoom < 9" });
      return;
    }
    // Time-of-day gate: no transit midnight–5 AM map-local time
    const localHours = toMapLocal(dateRef.current, mapUtcOffsetMinRef.current).hours;
    if (localHours < 5) {
      pushLog({ event: "SKIPPED", zoom, reason: "time < 5 AM (local)" });
      setTransitStops([]);
      return;
    }

    const seq = ++fetchSeqRef.current;
    const b = map.getBounds();
    const [s, w, n, e] = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];

    // Phase 1: show cached stops immediately (zero latency)
    const cached = getStopsFromCache(s, w, n, e, zoom, 30);
    if (cached.length > 0 && seq === fetchSeqRef.current && showTransitRef.current) {
      setTransitStops(cached);
      const modes: Partial<Record<TransitMode, number>> = {};
      for (const stop of cached) modes[stop.mode] = (modes[stop.mode] ?? 0) + 1;
      pushLog({ event: "CACHE_HIT", zoom, stopCount: cached.length, modes });
    }

    // Phase 2: fetch missing tiles in background, update when done
    const full = await fetchTransitStops(s, w, n, e, zoom, 30);
    if (seq !== fetchSeqRef.current || !showTransitRef.current) return;
    if (full === null) {
      pushLog({ event: "ERROR", zoom, reason: "fetch returned null" });
      return;
    }
    setTransitStops(full);
    const modes: Partial<Record<TransitMode, number>> = {};
    for (const stop of full) modes[stop.mode] = (modes[stop.mode] ?? 0) + 1;
    pushLog({ event: "FETCH", zoom, stopCount: full.length, modes });
```

Note: the `pushLog` dependency needs to be added to `fetchTransitForViewport`'s `useCallback` dep array:
```ts
  }, [pushLog]);
```
(The existing `}, []);` becomes `}, [pushLog]);`)

**Step 4: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```
Expected: zero errors.

---

### Task 3: Create `TransitLogPanel` component

**Files:**
- Create: `app/components/TransitLogPanel.tsx`

**Step 1: Write the component**

```tsx
"use client";

import type { TransitMode } from "../lib/transit";

interface TransitLogEntry {
  id: number;
  ts: Date;
  event: "FETCH" | "CACHE_HIT" | "SKIPPED" | "ERROR";
  zoom: number;
  stopCount?: number;
  modes?: Partial<Record<TransitMode, number>>;
  reason?: string;
}

interface Props {
  logs: TransitLogEntry[];
  onClear: () => void;
}

const EVENT_COLOR: Record<TransitLogEntry["event"], string> = {
  FETCH:     "text-green-400",
  CACHE_HIT: "text-cyan-400",
  SKIPPED:   "text-yellow-400",
  ERROR:     "text-red-400",
};

const MODE_COLOR: Record<string, string> = {
  subway: "text-blue-400",
  rail:   "text-red-400",
  tram:   "text-purple-400",
  bus:    "text-green-400",
  ferry:  "text-cyan-400",
};

function pad2(n: number) { return String(n).padStart(2, "0"); }

function fmtTime(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function ModeBreakdown({ modes }: { modes: Partial<Record<TransitMode, number>> }) {
  const entries = Object.entries(modes).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) return null;
  return (
    <span className="ml-1">
      {entries.map(([mode, count], i) => (
        <span key={mode}>
          {i > 0 && <span className="text-white/20"> · </span>}
          <span className={MODE_COLOR[mode] ?? "text-white/50"}>{mode}×{count}</span>
        </span>
      ))}
    </span>
  );
}

export default function TransitLogPanel({ logs, onClear }: Props) {
  return (
    <div className="fixed right-0 top-0 bottom-0 w-80 z-40 flex flex-col bg-black/85 backdrop-blur-md border-l border-white/10 font-mono text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 shrink-0">
        <span className="text-white/70 font-sans text-[11px] font-semibold tracking-wide uppercase">
          Transit Log
        </span>
        <button
          onClick={onClear}
          className="text-white/30 hover:text-white/70 transition-colors text-[10px] px-2 py-0.5 rounded border border-white/10 hover:border-white/30"
        >
          Clear
        </button>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto overscroll-contain py-1">
        {logs.length === 0 ? (
          <p className="text-white/20 text-center mt-6 font-sans text-[11px]">No entries yet</p>
        ) : (
          logs.map(entry => (
            <div
              key={entry.id}
              className="px-3 py-1.5 border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors"
            >
              {/* Row 1: timestamp, event badge, zoom */}
              <div className="flex items-center gap-1.5 leading-none">
                <span className="text-white/30">{fmtTime(entry.ts)}</span>
                <span className={`font-bold ${EVENT_COLOR[entry.event]}`}>{entry.event}</span>
                <span className="text-white/25">z={entry.zoom.toFixed(1)}</span>
              </div>
              {/* Row 2: stop count + mode breakdown or reason */}
              <div className="mt-0.5 leading-none text-white/40">
                {entry.stopCount !== undefined ? (
                  <>
                    <span>{entry.stopCount} stop{entry.stopCount !== 1 ? "s" : ""}</span>
                    {entry.modes && <ModeBreakdown modes={entry.modes} />}
                  </>
                ) : entry.reason ? (
                  <span className="text-white/30 italic">{entry.reason}</span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

**Step 2: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```
Expected: zero errors.

---

### Task 4: Wire up UI — zoom counter, log toggle, render panel

**Files:**
- Modify: `app/page.tsx` (imports ~line 8, JSX ~line 1096)

**Step 1: Import `TransitLogPanel`**

Add to the imports block (after other component imports):
```ts
import TransitLogPanel from "./components/TransitLogPanel";
```

**Step 2: Add zoom counter + log toggle inside the existing `bottom-20 right-3` view tools card**

Find the bottom of the view tools card (~line 1109):
```tsx
          <a
            href="/about"
            className="text-[10px] text-white/30 hover:text-white/60 transition-colors px-1.5 pt-0.5 pb-0.5"
          >
            About / API
          </a>
        </div>
      </div>
```

Replace with:
```tsx
          <a
            href="/about"
            className="text-[10px] text-white/30 hover:text-white/60 transition-colors px-1.5 pt-0.5 pb-0.5"
          >
            About / API
          </a>

          {/* Divider */}
          <div className="h-px bg-white/[0.06] mx-1" />

          {/* Log toggle */}
          <button
            onClick={() => setShowTransitLog(v => !v)}
            title="Toggle transit API log"
            className={`text-[10px] px-1.5 py-1 rounded transition-colors text-left ${
              showTransitLog
                ? "text-cyan-400 bg-cyan-400/10"
                : "text-white/30 hover:text-white/60"
            }`}
          >
            LOG {transitLogs.length > 0 && (
              <span className="ml-0.5 text-white/20">({transitLogs.length})</span>
            )}
          </button>

          {/* Zoom counter */}
          <div className="px-1.5 py-0.5 text-[10px] text-white/25 tabular-nums select-none">
            zoom {mapZoom.toFixed(1)}
          </div>
        </div>
      </div>
```

**Step 3: Render `<TransitLogPanel>` conditionally, just before the closing `</div>` of the root element (~line 1146)**

Find:
```tsx
      {/* Navigation sidebar — self-positions absolutely (see NavigationPanel) */}
      <NavigationPanel
```

Add before it:
```tsx
      {/* Transit log panel */}
      {showTransitLog && (
        <TransitLogPanel
          logs={transitLogs}
          onClear={() => setTransitLogs([])}
        />
      )}

```

**Step 4: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```
Expected: zero errors.

**Step 5: Smoke test in browser**

```bash
npm run dev
```

Manual checks:
- [ ] Zoom counter updates live as you zoom (e.g. `zoom 13.4`)
- [ ] `LOG` button in view tools card toggles the right-side panel open/closed
- [ ] Panel is open-able with transit OFF — shows "No entries yet"
- [ ] Enable transit, pan/zoom around a city at zoom 14+ → FETCH entries appear
- [ ] Zoom out to zoom 8 → SKIPPED (zoom < 9) entry appears
- [ ] Pan to same area again → CACHE_HIT entry appears
- [ ] Mode breakdown shows correct counts (e.g. `bus×12 · subway×3`)
- [ ] Clear button empties the list
- [ ] Panel is scrollable when > ~20 entries
- [ ] MapLibre nav control (top-right) is not obscured by the panel

---

### Task 5: Commit

```bash
cd /home/unusn/shademapnav
git add app/page.tsx app/components/TransitLogPanel.tsx
git commit -m "feat: transit log panel and live zoom counter"
```
