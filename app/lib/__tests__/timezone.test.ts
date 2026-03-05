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

  it("returns +60 for Berlin (~13.4°)", () => {
    // round(13.4 / 15) = round(0.89) = 1, 1 * 60 = 60
    expect(longitudeToUtcOffsetMin(13.4)).toBe(60);
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
