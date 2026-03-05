import { describe, it, expect } from "vitest";
import { findBestHybridCandidate, hybridCandidateToRouteOption, MAX_WALK_TO_STOP_M } from "../hybrid-routing";
import { haversineMeters } from "../routing";
import type { TransitStop } from "../transit";
import type { RouteOption } from "../routing";

function stop(id: number, lon: number, lat: number, mode: TransitStop["mode"] = "subway"): TransitStop {
  return { id, lon, lat, name: `Stop ${id}`, mode };
}

const A: [number, number] = [11.500, 48.100];
const B: [number, number] = [11.510, 48.100]; // ~750 m east of A

const board  = stop(101, 11.501, 48.100, "subway"); // ~111 m from A
const alight = stop(102, 11.509, 48.100, "subway"); // ~111 m from B

function walkRoutes(shadeCoverage: number): RouteOption[] {
  return [{
    label: "Shortest",
    geojson: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
    distanceM: haversineMeters(A, B), shadeCoverage,
    longestContinuousShadeM: 0, shadeTransitions: 0, detourRatio: 1.0, turnCount: 0,
  }];
}

describe("findBestHybridCandidate", () => {
  it("returns null when mapLocalHour < 5 (night gate)", () =>
    expect(findBestHybridCandidate({ a: A, b: B, stops: [board, alight], walkRoutes: walkRoutes(0.2), mapLocalHour: 3 })).toBeNull());

  it("returns null with fewer than 2 stops", () =>
    expect(findBestHybridCandidate({ a: A, b: B, stops: [board], walkRoutes: walkRoutes(0.2), mapLocalHour: 10 })).toBeNull());

  it("returns null when A→B < 200 m", () =>
    expect(findBestHybridCandidate({ a: A, b: [11.501, 48.100], stops: [board, alight], walkRoutes: walkRoutes(0.2), mapLocalHour: 10 })).toBeNull());

  it("returns null when no stops near A", () =>
    expect(findBestHybridCandidate({ a: A, b: B, stops: [stop(1, 12.0, 48.1), alight], walkRoutes: walkRoutes(0.2), mapLocalHour: 10 })).toBeNull());

  it("returns null when no stops near B", () =>
    expect(findBestHybridCandidate({ a: A, b: B, stops: [board, stop(2, 12.0, 48.1)], walkRoutes: walkRoutes(0.2), mapLocalHour: 10 })).toBeNull());

  it("returns null when walk is already great (improvement < threshold)", () =>
    expect(findBestHybridCandidate({ a: A, b: B, stops: [board, alight], walkRoutes: walkRoutes(0.95), mapLocalHour: 10 })).toBeNull());

  it("returns a candidate for subway on a fully sunny walk", () => {
    const r = findBestHybridCandidate({ a: A, b: B, stops: [board, alight], walkRoutes: walkRoutes(0.0), mapLocalHour: 12 });
    expect(r).not.toBeNull();
    expect(r!.boardStop.id).toBe(101);
    expect(r!.alightStop.id).toBe(102);
  });

  it("candidate sunCoverage is in [0, 1]", () => {
    const r = findBestHybridCandidate({ a: A, b: B, stops: [board, alight], walkRoutes: walkRoutes(0.0), mapLocalHour: 12 })!;
    expect(r.sunCoverage).toBeGreaterThanOrEqual(0);
    expect(r.sunCoverage).toBeLessThanOrEqual(1);
  });

  it("walkToBoardM ≈ distance from A to board stop", () => {
    const r = findBestHybridCandidate({ a: A, b: B, stops: [board, alight], walkRoutes: walkRoutes(0.0), mapLocalHour: 12 })!;
    expect(r.walkToBoardM).toBeCloseTo(haversineMeters(A, [board.lon, board.lat]), 1);
  });

  it("prefers subway over bus (lower sun exposure)", () => {
    const busStop = stop(103, 11.501, 48.1005, "bus");
    const r = findBestHybridCandidate({ a: A, b: B, stops: [board, alight, busStop], walkRoutes: walkRoutes(0.0), mapLocalHour: 12 })!;
    expect(r.boardStop.mode).toBe("subway");
  });

  it("returns null at hour=4 (boundary)", () =>
    expect(findBestHybridCandidate({ a: A, b: B, stops: [board, alight], walkRoutes: walkRoutes(0.0), mapLocalHour: 4 })).toBeNull());

  it("returns a candidate at hour=5 (gate just open)", () =>
    expect(findBestHybridCandidate({ a: A, b: B, stops: [board, alight], walkRoutes: walkRoutes(0.0), mapLocalHour: 5 })).not.toBeNull());

  it("skips pairs where board and alight are the same stop", () => {
    const s = stop(50, 11.505, 48.100, "bus");
    expect(findBestHybridCandidate({ a: A, b: B, stops: [s, s], walkRoutes: walkRoutes(0.0), mapLocalHour: 12 })).toBeNull();
  });
});

describe("hybridCandidateToRouteOption", () => {
  function bestCandidate() {
    return findBestHybridCandidate({ a: A, b: B, stops: [board, alight], walkRoutes: walkRoutes(0.0), mapLocalHour: 12 })!;
  }

  it("label is 'Via Transit'", () => expect(hybridCandidateToRouteOption(bestCandidate()).label).toBe("Via Transit"));
  it("transitLeg.boardStop.id is correct", () => expect(hybridCandidateToRouteOption(bestCandidate()).transitLeg?.boardStop.id).toBe(101));
  it("transitLeg.sunExposure is 0 for subway", () => expect(hybridCandidateToRouteOption(bestCandidate()).transitLeg?.sunExposure).toBe(0.0));
  it("geojson type is LineString", () => expect(hybridCandidateToRouteOption(bestCandidate()).geojson.geometry.type).toBe("LineString"));
});
