# Timezone Auto-Resolve from Coordinates

**Date:** 2026-03-04
**Status:** Approved

## Problem

The app currently uses the browser's local timezone (`Date.getTimezoneOffset()`) everywhere:

1. `computeSunriseSetMinutes` in `TimelineSlider.tsx` computes solar noon using the browser's UTC offset. A user in New York viewing Tokyo gets sunrise/sunset markers that are wrong by ~14 hours.
2. Time display (`formatTime12h`, `DateInput`) uses `date.getHours()` / `date.getMonth()` — browser local time. Viewing Tokyo at "12:00 PM" means noon in New York, not Tokyo.
3. On page load the time initialises to noon browser-local time, not the current local time at the map's location.

## Goal

When the user navigates to a location (via location search), display the current local time at that location. Keep sunrise/sunset markers and time display correct for the map's viewed coordinates at all times.

## Approach

**Longitude-based UTC offset approximation.** `utcOffsetMin = Math.round(lng / 15) * 60`. No new packages, no network calls. Accuracy: within ±30 min for ~90% of locations; off by up to 90 min in edge cases (India +5:30, Iran +3:30, China uniform +8). For a shadow simulation app where solar position is already computed from exact longitude math, this is acceptable.

## Data Model

**New state in `page.tsx`:** `mapUtcOffsetMin: number`

- Convention: positive = ahead of UTC (Tokyo UTC+9 = +540, New York EST = −300)
- Opposite sign from JS `Date.getTimezoneOffset()`
- Default before map loads: `−new Date().getTimezoneOffset()` (browser's own offset)

**The `date` state stays as an absolute UTC `Date` — ShadeMap and all solar math are unchanged.**

**New file `app/lib/timezone.ts`:**

```typescript
// UTC offset in minutes from longitude.
export function longitudeToUtcOffsetMin(lng: number): number {
  return Math.round(lng / 15) * 60;
}

// Read local time/date components without touching browser timezone.
export function toMapLocal(d: Date, utcOffsetMin: number) {
  const s = new Date(d.getTime() + utcOffsetMin * 60000);
  return {
    hours: s.getUTCHours(), minutes: s.getUTCMinutes(),
    year: s.getUTCFullYear(), month: s.getUTCMonth(), day: s.getUTCDate(),
  };
}

// Build a Date where map-local time = {hours, mins}, preserving the map-local day.
export function fromMapLocal(prev: Date, utcOffsetMin: number, hours: number, mins: number): Date {
  const s = new Date(prev.getTime() + utcOffsetMin * 60000);
  const midnight = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  return new Date(midnight - utcOffsetMin * 60000 + (hours * 60 + mins) * 60000);
}
```

## Trigger Points

| Event | Offset update | Time jump to "now" |
|---|---|---|
| `handleMapReady` | Yes | Yes |
| `flyTo` (location search) | Yes | Yes |
| `map.on("moveend")` | Yes | No |
| Zoom / marker drag / route calc | No | No |

The time-jump on `flyTo` is the primary UX win. The `moveend` update keeps sunrise/sunset markers correct during free panning without disrupting a time the user intentionally set.

## Component Changes

### `app/lib/timezone.ts` (new)
The three utility functions above.

### `page.tsx`
- Add `mapUtcOffsetMin` state (default: `−new Date().getTimezoneOffset()`)
- `handleMapReady`: compute initial offset from map center; jump `date` to `new Date()` (current moment, which will display as current local time via the offset)
- `flyTo`: compute new offset from destination `lng`; set `date = new Date()` so the time display jumps to "now at destination"
- `moveend` handler: update `mapUtcOffsetMin` only (no date change)
- `formatTime12h(d, utcOffsetMin)`: use `toMapLocal` instead of `d.getHours()`
- `toDateInput(d, utcOffsetMin)`: use `toMapLocal` for year/month/day
- `handleSliderChange(m)`: call `fromMapLocal(prev, utcOffsetMin, floor(m/60), m%60)`
- `handleDayOfYearChange`: preserve map-local hours/mins via `fromMapLocal`
- `TimeInput`: read current time via `toMapLocal`; on commit call `fromMapLocal`
- Pass `mapUtcOffsetMin` to `TimelineSlider`, `TimeInput`, `DateInput`

### `TimelineSlider.tsx`
- Accept `utcOffsetMin: number` prop
- Fix `computeSunriseSetMinutes`: replace `- date.getTimezoneOffset()` with `+ utcOffsetMin`
  - Before: `solarNoonLocal = 720 - lngDeg * 4 - date.getTimezoneOffset()`
  - After:  `solarNoonLocal = 720 - lngDeg * 4 + utcOffsetMin`

### `DateInput.tsx`
- Accept `utcOffsetMin: number` prop
- `formatDateDisplay`: use `toMapLocal` for year/month/day
- `parseDateText`: when committing a parsed date, use `fromMapLocal`-style logic to preserve map-local hours/mins

### `AccumulationPanel.tsx`
- Out of scope. Its `startDate`/`endDate` are "hours of the day" settings (6 AM–8 PM) and can remain browser-local.

## Error Handling & Edge Cases

- **Antimeridian (±180°):** `Math.round(±180/15) * 60 = ±720` — correct, no special case needed.
- **Initial render before map loads:** defaults to browser's own timezone offset — sensible fallback.
- **Rapid panning across timezone boundaries:** offset snaps by 60 min per 15° longitude crossed. Displayed time label shifts by 1h, which is correct.
- **`DaySlider` year navigation:** preserves map-local hours/mins via `fromMapLocal` when changing year.

## Files Changed

| File | Change |
|---|---|
| `app/lib/timezone.ts` | New — 3 utility functions |
| `app/page.tsx` | Add `mapUtcOffsetMin` state; fix all time read/write; update trigger points |
| `app/components/TimelineSlider.tsx` | Accept `utcOffsetMin` prop; fix `computeSunriseSetMinutes` |
| `app/components/DateInput.tsx` | Accept `utcOffsetMin` prop; fix display and parse |
