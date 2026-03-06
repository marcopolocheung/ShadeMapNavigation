# Timezone Auto-Resolve Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When the user navigates to a location, snap the displayed time to the current local time there; keep sunrise/sunset markers and all time displays correct for the map's longitude at all times.

**Architecture:** Add `mapUtcOffsetMin` state (positive = ahead of UTC, opposite sign from JS `getTimezoneOffset()`). Three pure utility functions in `app/lib/timezone.ts` handle all UTC↔map-local conversions. The `date` state stays as an absolute UTC `Date` — ShadeMap and solar math are unchanged. All time display/input is rerouted through these utilities. `mapUtcOffsetMin` updates on map ready, location search, and moveend; the time itself only jumps to "now" on map ready and location search.

**Tech Stack:** Vitest for tests, pure TypeScript (no new packages), React state/refs.

---

### Task 1: Create `app/lib/timezone.ts`

**Files:**
- Create: `app/lib/timezone.ts`
- Create: `app/lib/__tests__/timezone.test.ts`

**Step 1: Write the failing tests**

Create `app/lib/__tests__/timezone.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { longitudeToUtcOffsetMin, toMapLocal, fromMapLocal } from "../timezone";

describe("longitudeToUtcOffsetMin", () => {
  it("returns 0 for Greenwich (0°)", () => {
    expect(longitudeToUtcOffsetMin(0)).toBe(0);
  });

  it("returns +540 for Tokyo (~135.7°)", () => {
    // round(135.7 / 15) = 9, 9 * 60 = 540
    expect(longitudeToUtcOffsetMin(135.7)).toBe(540);
  });

  it("returns -300 for New York (~-74°)", () => {
    // round(-74 / 15) = round(-4.93) = -5, -5 * 60 = -300
    expect(longitudeToUtcOffsetMin(-74)).toBe(-300);
  });

  it("returns +60 for Paris (~2.3°)", () => {
    expect(longitudeToUtcOffsetMin(2.3)).toBe(60);
  });

  it("handles antimeridian (180°) without error", () => {
    expect(longitudeToUtcOffsetMin(180)).toBe(720);
    expect(longitudeToUtcOffsetMin(-180)).toBe(-720);
  });
});

describe("toMapLocal", () => {
  it("reads Tokyo noon (UTC+9) from UTC 03:00", () => {
    // 3:00 AM UTC = 12:00 PM JST
    const d = new Date("2026-03-04T03:00:00.000Z");
    const { hours, minutes, year, month, day } = toMapLocal(d, 540);
    expect(hours).toBe(12);
    expect(minutes).toBe(0);
    expect(year).toBe(2026);
    expect(month).toBe(2); // 0-indexed March
    expect(day).toBe(4);
  });

  it("reads New York 6 PM EST from UTC 23:00", () => {
    // 23:00 UTC = 18:00 EST (UTC-5 = -300 min)
    const d = new Date("2026-03-04T23:00:00.000Z");
    const { hours, minutes } = toMapLocal(d, -300);
    expect(hours).toBe(18);
    expect(minutes).toBe(0);
  });

  it("handles day rollover: Tokyo 1 AM is previous UTC date", () => {
    // 1:00 AM JST = 16:00 UTC previous day
    const d = new Date("2026-03-03T16:00:00.000Z");
    const { hours, day } = toMapLocal(d, 540);
    expect(hours).toBe(1);
    expect(day).toBe(4); // JST is already March 4
  });
});

describe("fromMapLocal", () => {
  it("round-trips with toMapLocal (Tokyo noon)", () => {
    const original = new Date("2026-03-04T03:00:00.000Z"); // noon JST
    const { hours, minutes } = toMapLocal(original, 540);
    const result = fromMapLocal(original, 540, hours, minutes);
    expect(result.getTime()).toBe(original.getTime());
  });

  it("changes hours while keeping the map-local date", () => {
    // Start: 2026-03-04T03:00:00Z (noon JST March 4)
    // Set to 6 PM JST March 4 → 09:00 UTC
    const base = new Date("2026-03-04T03:00:00.000Z");
    const result = fromMapLocal(base, 540, 18, 0);
    expect(result.getTime()).toBe(new Date("2026-03-04T09:00:00.000Z").getTime());
  });

  it("round-trips with toMapLocal (New York evening)", () => {
    const original = new Date("2026-03-04T23:00:00.000Z"); // 6 PM EST
    const { hours, minutes } = toMapLocal(original, -300);
    const result = fromMapLocal(original, -300, hours, minutes);
    expect(result.getTime()).toBe(original.getTime());
  });
});
```

**Step 2: Run to verify failure**

```bash
cd /home/unusn/shademapnav && npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../timezone'`

**Step 3: Implement `app/lib/timezone.ts`**

```typescript
/**
 * UTC offset in minutes derived from longitude.
 * Convention: positive = ahead of UTC (e.g. Tokyo UTC+9 → +540).
 * Accuracy: ±30 min for ~90% of locations; up to ±90 min for edge cases
 * (India +5:30, Iran +3:30, China uniform +8 nationwide).
 */
export function longitudeToUtcOffsetMin(lng: number): number {
  return Math.round(lng / 15) * 60;
}

/**
 * Read time/date components in the map's local timezone without touching
 * the browser's local timezone. Returns 0-indexed month (like JS Date).
 */
export function toMapLocal(
  d: Date,
  utcOffsetMin: number
): { hours: number; minutes: number; year: number; month: number; day: number } {
  const shifted = new Date(d.getTime() + utcOffsetMin * 60000);
  return {
    hours:   shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    year:    shifted.getUTCFullYear(),
    month:   shifted.getUTCMonth(),
    day:     shifted.getUTCDate(),
  };
}

/**
 * Build a Date where the map-local time = {hours, mins}, preserving the
 * map-local calendar day derived from `prev`.
 *
 * Example: prev = 2026-03-04T03:00Z (noon JST), utcOffsetMin = 540,
 *          hours = 18, mins = 0  →  2026-03-04T09:00Z (6 PM JST)
 */
export function fromMapLocal(
  prev: Date,
  utcOffsetMin: number,
  hours: number,
  mins: number
): Date {
  // Shift prev into the map-local frame to extract the local calendar date
  const shifted = new Date(prev.getTime() + utcOffsetMin * 60000);
  // UTC timestamp of that local midnight
  const midnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  // Local midnight in UTC = midnightUtc - utcOffsetMin, then add the requested local time
  return new Date(midnightUtc - utcOffsetMin * 60000 + (hours * 60 + mins) * 60000);
}
```

**Step 4: Run tests to verify they pass**

```bash
cd /home/unusn/shademapnav && npm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: All timezone tests PASS.

**Step 5: Commit**

```bash
cd /home/unusn/shademapnav && git add app/lib/timezone.ts app/lib/__tests__/timezone.test.ts && git commit -m "feat: add timezone utility — longitudeToUtcOffsetMin, toMapLocal, fromMapLocal"
```

---

### Task 2: Fix `TimelineSlider.tsx`

**Files:**
- Modify: `app/components/TimelineSlider.tsx`

The fix is in `computeSunriseSetMinutes`. Currently it uses `date.getTimezoneOffset()` (browser's timezone), which breaks sunrise/sunset markers for any location not in the user's own timezone.

**Step 1: Add `utcOffsetMin` prop to the interface**

At `app/components/TimelineSlider.tsx:5-11` change:

```typescript
interface Props {
  minutes: number; // 0–1439
  onChange: (minutes: number) => void;
  date?: Date;       // used for sunrise/sunset calculation
  latDeg?: number;   // map center latitude
  lngDeg?: number;   // map center longitude
}
```

to:

```typescript
interface Props {
  minutes: number; // 0–1439
  onChange: (minutes: number) => void;
  date?: Date;          // used for sunrise/sunset calculation
  latDeg?: number;      // map center latitude
  lngDeg?: number;      // map center longitude
  utcOffsetMin?: number; // map location's UTC offset; defaults to -date.getTimezoneOffset()
}
```

**Step 2: Fix `computeSunriseSetMinutes`**

At line 37, change:

```typescript
  const solarNoonLocal = 720 - lngDeg * 4 - date.getTimezoneOffset();
```

to:

```typescript
  const solarNoonLocal = 720 - lngDeg * 4 + utcOffsetMin;
```

Note: `getTimezoneOffset()` returns negative for UTC+ (e.g. Tokyo = -540), so `- getTimezoneOffset()` = `+ 540` = `+ utcOffsetMin`. We now pass `utcOffsetMin` directly.

**Step 3: Update the function signature and call**

Change the function signature at line 18:

```typescript
function computeSunriseSetMinutes(
  date: Date,
  latDeg: number,
  lngDeg: number
): { riseMin: number; setMin: number } | null {
```

to:

```typescript
function computeSunriseSetMinutes(
  date: Date,
  latDeg: number,
  lngDeg: number,
  utcOffsetMin: number
): { riseMin: number; setMin: number } | null {
```

**Step 4: Update the component to pass `utcOffsetMin` to the function**

Change the component signature at line 82:

```typescript
export default function TimelineSlider({ minutes, onChange, date, latDeg, lngDeg }: Props) {
```

to:

```typescript
export default function TimelineSlider({ minutes, onChange, date, latDeg, lngDeg, utcOffsetMin: utcOffsetMinProp }: Props) {
```

And at lines 83-88 where `computeSunriseSetMinutes` is called:

```typescript
  const sunRiseSet =
    date !== undefined && latDeg !== undefined && lngDeg !== undefined
      ? computeSunriseSetMinutes(date, latDeg, lngDeg)
      : null;
```

change to:

```typescript
  const effectiveOffset = utcOffsetMinProp ?? (date ? -date.getTimezoneOffset() : 0);
  const sunRiseSet =
    date !== undefined && latDeg !== undefined && lngDeg !== undefined
      ? computeSunriseSetMinutes(date, latDeg, lngDeg, effectiveOffset)
      : null;
```

**Step 5: Verify TypeScript compiles**

```bash
cd /home/unusn/shademapnav && npx tsc --noEmit 2>&1 | head -30
```

Expected: Errors only about `utcOffsetMin` not yet passed from `page.tsx` (will be fixed in Task 4). Zero errors inside `TimelineSlider.tsx` itself.

**Step 6: Commit**

```bash
cd /home/unusn/shademapnav && git add app/components/TimelineSlider.tsx && git commit -m "fix: TimelineSlider sunrise/sunset uses map location timezone, not browser timezone"
```

---

### Task 3: Fix `DateInput.tsx`

**Files:**
- Modify: `app/components/DateInput.tsx`

**Step 1: Add import and update props interface**

At the top of `app/components/DateInput.tsx`, add the import:

```typescript
import { toMapLocal, fromMapLocal } from "../lib/timezone";
```

Change `DateInputProps` at line 49:

```typescript
interface DateInputProps {
  date: Date;
  onChange: (d: Date) => void;
  utcOffsetMin: number;
}
```

**Step 2: Fix `formatDateDisplay`**

Replace lines 7-9:

```typescript
function formatDateDisplay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
```

with:

```typescript
function formatDateDisplay(d: Date, utcOffsetMin: number): string {
  const { year, month, day } = toMapLocal(d, utcOffsetMin);
  return `${MONTHS[month]} ${day}, ${year}`;
}
```

**Step 3: Fix `parseDateText`**

Replace the entire function (lines 17-47):

```typescript
function parseDateText(s: string, base: Date, utcOffsetMin: number): Date | null {
  s = s.trim();
  const { hours, minutes } = toMapLocal(base, utcOffsetMin);

  // Helper: produce a Date where the map-local date is year/month/day and
  // the map-local time is preserved from `base`.
  const makeDate = (year: number, month: number, day: number): Date | null => {
    const d = new Date(Date.UTC(year, month, day) - utcOffsetMin * 60000 + (hours * 60 + minutes) * 60000);
    return isNaN(d.getTime()) ? null : d;
  };

  // ISO: 2026-03-03
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return makeDate(+iso[1], +iso[2] - 1, +iso[3]);

  // MM/DD or MM/DD/YY or MM/DD/YYYY
  const mdy = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (mdy) {
    const { year: baseYear } = toMapLocal(base, utcOffsetMin);
    const rawYear = mdy[3] ? +mdy[3] : baseYear;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return makeDate(year, +mdy[1] - 1, +mdy[2]);
  }

  // Natural: "Mar 3", "March 3", "3 Mar" — try native parser with current map-local year
  const { year: baseYear } = toMapLocal(base, utcOffsetMin);
  const attempt = new Date(`${s} ${baseYear}`);
  if (!isNaN(attempt.getTime())) {
    return makeDate(baseYear, attempt.getMonth(), attempt.getDate());
  }

  return null;
}
```

**Step 4: Thread `utcOffsetMin` through the component**

Update the component function signature and all internal usages:

```typescript
export default function DateInput({ date, onChange, utcOffsetMin }: DateInputProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const shouldCommit = useRef(true);

  function startEdit() {
    shouldCommit.current = true;
    setText(formatDateDisplay(date, utcOffsetMin));
    setEditing(true);
  }

  function commit(val: string) {
    if (!shouldCommit.current) {
      shouldCommit.current = true;
      return;
    }
    setEditing(false);
    const next = parseDateText(val, date, utcOffsetMin);
    if (next) onChange(next);
  }

  if (editing) {
    return (
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            shouldCommit.current = false;
            setEditing(false);
          }
        }}
        className="bg-white/10 rounded px-2 py-1 text-white text-xs border border-amber-400/60 focus:outline-none w-32 text-center"
        autoFocus
      />
    );
  }

  return (
    <button
      onClick={startEdit}
      className="text-white/70 hover:text-white/90 text-xs tabular-nums w-32 text-center rounded px-2 py-1 hover:bg-white/10 transition-colors"
      title="Click to set date (e.g. Mar 3, 3/3/2026)"
    >
      {formatDateDisplay(date, utcOffsetMin)}
    </button>
  );
}
```

**Step 5: Verify TypeScript compiles (errors only about prop not yet passed)**

```bash
cd /home/unusn/shademapnav && npx tsc --noEmit 2>&1 | head -30
```

Expected: Error that `utcOffsetMin` is missing where `DateInput` is used in `page.tsx` — this is fine and expected. Zero errors inside `DateInput.tsx` itself.

**Step 6: Commit**

```bash
cd /home/unusn/shademapnav && git add app/components/DateInput.tsx && git commit -m "fix: DateInput uses map location timezone for display and date parsing"
```

---

### Task 4: Wire everything in `page.tsx`

**Files:**
- Modify: `app/page.tsx`

This is the largest task. Work through it section by section.

**Step 1: Add the import**

At the top of `page.tsx`, after the existing imports add:

```typescript
import { longitudeToUtcOffsetMin, toMapLocal, fromMapLocal } from "./lib/timezone";
```

**Step 2: Fix `formatTime12h`**

Replace the function (lines 31-37):

```typescript
function formatTime12h(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}
```

with:

```typescript
function formatTime12h(d: Date, utcOffsetMin: number): string {
  const { hours: h24, minutes: m } = toMapLocal(d, utcOffsetMin);
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}
```

**Step 3: Fix `dateToDayOfYear`**

Replace (lines 73-76):

```typescript
function dateToDayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}
```

with:

```typescript
function dateToDayOfYear(d: Date, utcOffsetMin: number): number {
  const { year, month, day } = toMapLocal(d, utcOffsetMin);
  return Math.floor(
    (Date.UTC(year, month, day) - Date.UTC(year, 0, 1)) / 86400000
  );
}
```

**Step 4: Fix `TimeInput`**

Update the `TimeInput` component signature and internals. Change:

```typescript
function TimeInput({ date, onChange }: { date: Date; onChange: (d: Date) => void }) {
```

to:

```typescript
function TimeInput({ date, onChange, utcOffsetMin }: { date: Date; onChange: (d: Date) => void; utcOffsetMin: number }) {
```

Change `startEdit` to:

```typescript
  function startEdit() {
    shouldCommit.current = true;
    setText(formatTime12h(date, utcOffsetMin));
    setEditing(true);
  }
```

Change the `commit` function's date construction:

```typescript
  function commit(val: string) {
    if (!shouldCommit.current) {
      shouldCommit.current = true;
      return;
    }
    setEditing(false);
    const mins = parseTime(val);
    if (mins !== null) {
      const next = fromMapLocal(date, utcOffsetMin, Math.floor(mins / 60), mins % 60);
      onChange(next);
    }
  }
```

Change the button's display text:

```typescript
      {formatTime12h(date, utcOffsetMin)}
```

**Step 5: Add state and ref for `mapUtcOffsetMin`**

Inside the `Home` component, add after the existing state declarations (around line 256, after `mapCenter` state):

```typescript
  const [mapUtcOffsetMin, setMapUtcOffsetMin] = useState<number>(
    () => -new Date().getTimezoneOffset()
  );
  const mapUtcOffsetMinRef = useRef(mapUtcOffsetMin);
  mapUtcOffsetMinRef.current = mapUtcOffsetMin;
```

**Step 6: Fix `handleMapReady`**

Replace:

```typescript
  const handleMapReady = useCallback((map: maplibregl.Map) => {
    mapRef.current = map;
    const { lat, lng } = map.getCenter();
    setMapCenter([lat, lng]);
    map.on("moveend", () => {
      const c = map.getCenter();
      setMapCenter([c.lat, c.lng]);
    });
  }, []);
```

with:

```typescript
  const handleMapReady = useCallback((map: maplibregl.Map) => {
    mapRef.current = map;
    const { lat, lng } = map.getCenter();
    setMapCenter([lat, lng]);
    const initialOffset = longitudeToUtcOffsetMin(lng);
    setMapUtcOffsetMin(initialOffset);
    setDate(new Date());
    map.on("moveend", () => {
      const c = map.getCenter();
      setMapCenter([c.lat, c.lng]);
      setMapUtcOffsetMin(longitudeToUtcOffsetMin(c.lng));
    });
  }, []);
```

**Step 7: Fix `flyTo`**

Replace:

```typescript
  const flyTo = useCallback((center: [number, number], zoom: number) => {
    mapRef.current?.flyTo({ center, zoom });
  }, []);
```

with:

```typescript
  const flyTo = useCallback((center: [number, number], zoom: number) => {
    mapRef.current?.flyTo({ center, zoom });
    // center is [lng, lat]
    const newOffset = longitudeToUtcOffsetMin(center[0]);
    setMapUtcOffsetMin(newOffset);
    setDate(new Date());
  }, []);
```

**Step 8: Fix `handleSliderChange`**

Replace:

```typescript
  const handleSliderChange = useCallback((m: number) => {
    setDate((prev) => {
      if (prev.getHours() * 60 + prev.getMinutes() === m) return prev;
      const next = new Date(prev);
      next.setHours(Math.floor(m / 60), m % 60, 0, 0);
      return next;
    });
  }, []);
```

with:

```typescript
  const handleSliderChange = useCallback((m: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { hours, minutes } = toMapLocal(prev, offsetMin);
      if (hours * 60 + minutes === m) return prev;
      return fromMapLocal(prev, offsetMin, Math.floor(m / 60), m % 60);
    });
  }, []);
```

**Step 9: Fix `handleDayOfYearChange`**

Replace:

```typescript
  const handleDayOfYearChange = useCallback((day: number) => {
    setDate((prev) => {
      const start = new Date(prev.getFullYear(), 0, 1);
      const next = new Date(start.getTime() + day * 86400000);
      next.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
      return next;
    });
  }, []);
```

with:

```typescript
  const handleDayOfYearChange = useCallback((day: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { year, hours, minutes } = toMapLocal(prev, offsetMin);
      return new Date(
        Date.UTC(year, 0, 1) + day * 86400000 - offsetMin * 60000 + (hours * 60 + minutes) * 60000
      );
    });
  }, []);
```

**Step 10: Fix `adjustYear`**

Replace:

```typescript
  const adjustYear = useCallback((delta: number) => {
    setDate((prev) => {
      const next = new Date(prev);
      next.setFullYear(prev.getFullYear() + delta);
      return next;
    });
  }, []);
```

with:

```typescript
  const adjustYear = useCallback((delta: number) => {
    setDate((prev) => {
      const offsetMin = mapUtcOffsetMinRef.current;
      const { year, month, day, hours, minutes } = toMapLocal(prev, offsetMin);
      return new Date(
        Date.UTC(year + delta, month, day) - offsetMin * 60000 + (hours * 60 + minutes) * 60000
      );
    });
  }, []);
```

**Step 11: Fix the animation timer (isPlaying useEffect)**

Inside the `setInterval` callback, replace the body:

```typescript
        setDate((prev) => {
          const next = new Date(prev);
          if (sliderModeRef.current === "day") {
            const doy = dateToDayOfYear(prev);
            const yr = prev.getFullYear();
            const isLeap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
            const nextDoy = (doy + 1) % (isLeap ? 366 : 365);
            const start = new Date(yr, 0, 1);
            const advanced = new Date(start.getTime() + nextDoy * 86400000);
            advanced.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
            return advanced;
          } else {
            const total = prev.getHours() * 60 + prev.getMinutes() + 2;
            next.setHours(Math.floor(total / 60) % 24, total % 60, 0, 0);
          }
          return next;
        });
```

with:

```typescript
        setDate((prev) => {
          const offsetMin = mapUtcOffsetMinRef.current;
          if (sliderModeRef.current === "day") {
            const { year: yr, hours, minutes } = toMapLocal(prev, offsetMin);
            const doy = dateToDayOfYear(prev, offsetMin);
            const isLeap = (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
            const nextDoy = (doy + 1) % (isLeap ? 366 : 365);
            return new Date(
              Date.UTC(yr, 0, 1) + nextDoy * 86400000 - offsetMin * 60000 + (hours * 60 + minutes) * 60000
            );
          } else {
            const { hours, minutes } = toMapLocal(prev, offsetMin);
            const totalMins = (hours * 60 + minutes + 2) % 1440;
            return fromMapLocal(prev, offsetMin, Math.floor(totalMins / 60), totalMins % 60);
          }
        });
```

**Step 12: Fix the JSX render — derive map-local values for display**

At the start of the `return` statement, before the JSX, add derived values:

```typescript
  const { hours: _localH, minutes: _localM, year: _localYear } = toMapLocal(date, mapUtcOffsetMin);
  const mapLocalMins = _localH * 60 + _localM;
```

**Step 13: Fix the floating tooltip**

Find the tooltip that shows above the slider (around line 845-850):

```tsx
            {sliderMode === "time"
              ? formatTime12h(date)
              : date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
```

Replace with:

```tsx
            {sliderMode === "time"
              ? formatTime12h(date, mapUtcOffsetMin)
              : new Date(date.getTime() + mapUtcOffsetMin * 60000)
                  .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
```

**Step 14: Fix `TimelineSlider` usage**

Find the `<TimelineSlider ...>` JSX and update:

```tsx
            <TimelineSlider
              minutes={date.getHours() * 60 + date.getMinutes()}
              onChange={handleSliderChange}
              date={date}
              latDeg={mapCenter?.[0]}
              lngDeg={mapCenter?.[1]}
            />
```

Replace with:

```tsx
            <TimelineSlider
              minutes={mapLocalMins}
              onChange={handleSliderChange}
              date={date}
              latDeg={mapCenter?.[0]}
              lngDeg={mapCenter?.[1]}
              utcOffsetMin={mapUtcOffsetMin}
            />
```

**Step 15: Fix `DaySlider` usage**

Find the `<DaySlider ...>` JSX and update:

```tsx
            <DaySlider
              dayOfYear={dateToDayOfYear(date)}
              year={date.getFullYear()}
              onChange={handleDayOfYearChange}
            />
```

Replace with:

```tsx
            <DaySlider
              dayOfYear={dateToDayOfYear(date, mapUtcOffsetMin)}
              year={_localYear}
              onChange={handleDayOfYearChange}
            />
```

**Step 16: Fix `TimeInput` and `DateInput` usage**

Find where `<TimeInput>` and `<DateInput>` are rendered (in the controls row):

```tsx
                <DateInput date={date} onChange={setDate} />
                <TimeInput date={date} onChange={setDate} />
```

Replace with:

```tsx
                <DateInput date={date} onChange={setDate} utcOffsetMin={mapUtcOffsetMin} />
                <TimeInput date={date} onChange={setDate} utcOffsetMin={mapUtcOffsetMin} />
```

**Step 17: Fix the year display in day mode**

Find where the year is displayed in the year picker:

```tsx
                <span className="text-white/70 text-sm tabular-nums w-12 text-center">
                  {date.getFullYear()}
                </span>
```

Replace with:

```tsx
                <span className="text-white/70 text-sm tabular-nums w-12 text-center">
                  {_localYear}
                </span>
```

**Step 18: Verify TypeScript compiles cleanly**

```bash
cd /home/unusn/shademapnav && npx tsc --noEmit 2>&1
```

Expected: zero errors. If any remain, they will reference a specific line — fix each one (likely a remaining call to `formatTime12h(date)` without the second argument, or a `dateToDayOfYear(date)` without the second argument).

**Step 19: Run all tests**

```bash
cd /home/unusn/shademapnav && npm test
```

Expected: all tests pass (no test coverage of components, but the timezone utilities are fully covered).

**Step 20: Commit**

```bash
cd /home/unusn/shademapnav && git add app/page.tsx && git commit -m "feat: auto-resolve local time from map coordinates on navigation"
```

---

## Manual Verification Checklist

After all tasks are committed, verify in the browser (`npm run dev`, open `http://localhost:3000`):

1. **Initial load**: time display shows approximately the current local time (it will be based on the map's default center longitude, not the browser's timezone — they may match for most users).
2. **Search "Tokyo"**: time jumps to current Tokyo local time (~UTC+9); sunrise/sunset markers on slider shift to Tokyo's dawn/dusk.
3. **Search "New York"**: time jumps to current New York local time (~UTC-5); sunrise/sunset markers shift again.
4. **Pan the map slowly from Tokyo to India**: sunrise/sunset markers update continuously; time label does not jump.
5. **Drag the slider**: slider and time label move together correctly in the new timezone.
6. **Type a time in TimeInput**: parsed time is in the map's local timezone.
7. **Change the date in DateInput**: correct calendar day shown; on edit, parsed date is in map-local time.
8. **Play animation in time mode**: advances 2 min/tick in map-local time.
9. **Play animation in day mode**: advances 1 day/tick, preserving map-local time of day.
10. **Search across the antimeridian** (e.g. Samoa vs. Tonga): no crash, reasonable offset.
