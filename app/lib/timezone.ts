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
