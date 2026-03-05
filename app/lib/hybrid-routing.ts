/**
 * Hybrid walk+transit routing — pure function, no browser APIs, no fetch.
 *
 * Architecture decision: Option A (waypoint injection).
 * Re-uses the existing shade router for both walking legs. Transit leg is
 * a straight line between stops with mode-specific sun exposure (0 = underground,
 * 0.25 = above-ground vehicle). Only offered when ≥8 pp better than best walk route.
 */

import { haversineMeters } from "./routing";
import type { RouteOption, TransitLeg } from "./routing";
import type { TransitStop } from "./transit";
import { TRANSIT_SUN_EXPOSURE } from "./transit";

export const MAX_WALK_TO_STOP_M        = 600;
export const MIN_HYBRID_IMPROVEMENT_PP = 8;

export interface HybridCandidate {
  boardStop: TransitStop;
  alightStop: TransitStop;
  totalDistM: number;
  sunCoverage: number;      // 0–1
  walkToBoardM: number;
  walkFromAlightM: number;
  transitDistM: number;
}

/**
 * Find the best hybrid candidate or null if transit doesn't meaningfully help.
 *
 * Walking legs are estimated at 50% sun exposure (conservative, no shade data
 * available at planning time — actual shade routing runs later in page.tsx).
 */
export function findBestHybridCandidate(input: {
  a: [number, number];
  b: [number, number];
  stops: TransitStop[];
  walkRoutes: RouteOption[];
  mapLocalHour: number;
}): HybridCandidate | null {
  const { a, b, stops, walkRoutes, mapLocalHour } = input;

  if (mapLocalHour < 5) return null;
  if (stops.length < 2) return null;
  if (haversineMeters(a, b) < 200) return null;

  const bestWalkShadeCoverage = walkRoutes.reduce((best, r) => Math.max(best, r.shadeCoverage), 0);
  const bestWalkSunCoverage   = 1 - bestWalkShadeCoverage;

  const nearA = stops.filter((s) => haversineMeters(a, [s.lon, s.lat]) <= MAX_WALK_TO_STOP_M);
  const nearB = stops.filter((s) => haversineMeters(b, [s.lon, s.lat]) <= MAX_WALK_TO_STOP_M);
  if (nearA.length === 0 || nearB.length === 0) return null;

  let best: HybridCandidate | null = null;

  for (const board of nearA) {
    for (const alight of nearB) {
      if (board.id === alight.id) continue;

      const walkToBoardM    = haversineMeters(a, [board.lon, board.lat]);
      const transitDistM    = haversineMeters([board.lon, board.lat], [alight.lon, alight.lat]);
      const walkFromAlightM = haversineMeters([alight.lon, alight.lat], b);

      if (transitDistM < 50) continue;

      // Reject if alight stop is not closer to B than board stop is (wrong direction)
      const boardToB  = haversineMeters([board.lon, board.lat], b);
      const alightToB = haversineMeters([alight.lon, alight.lat], b);
      if (alightToB >= boardToB) continue;

      const totalDistM = walkToBoardM + transitDistM + walkFromAlightM;
      const transitSun = TRANSIT_SUN_EXPOSURE[board.mode];
      const WALK_SUN   = 0.5; // conservative estimate for unshaded walk legs
      const sunCoverage =
        (walkToBoardM * WALK_SUN + transitDistM * transitSun + walkFromAlightM * WALK_SUN) / totalDistM;

      if (!best || sunCoverage < best.sunCoverage) {
        best = { boardStop: board, alightStop: alight, totalDistM, sunCoverage, walkToBoardM, walkFromAlightM, transitDistM };
      }
    }
  }

  if (!best) return null;
  if ((bestWalkSunCoverage - best.sunCoverage) * 100 < MIN_HYBRID_IMPROVEMENT_PP) return null;
  return best;
}

/** Convert a HybridCandidate into a RouteOption ready for the route card list. */
export function hybridCandidateToRouteOption(c: HybridCandidate): RouteOption {
  const leg: TransitLeg = {
    boardStop:  { id: c.boardStop.id,  lat: c.boardStop.lat,  lon: c.boardStop.lon,  name: c.boardStop.name,  mode: c.boardStop.mode },
    alightStop: { id: c.alightStop.id, lat: c.alightStop.lat, lon: c.alightStop.lon, name: c.alightStop.name, mode: c.alightStop.mode },
    transitDistM: c.transitDistM,
    sunExposure: TRANSIT_SUN_EXPOSURE[c.boardStop.mode],
    walkToBoardM: c.walkToBoardM,
    walkFromAlightM: c.walkFromAlightM,
  };
  return {
    label: "Via Transit",
    geojson: {
      type: "Feature",
      properties: { isTransit: true },
      geometry: { type: "LineString", coordinates: [[c.boardStop.lon, c.boardStop.lat], [c.alightStop.lon, c.alightStop.lat]] },
    },
    distanceM: c.totalDistM,
    shadeCoverage: 1 - c.sunCoverage,
    longestContinuousShadeM: c.transitDistM,
    shadeTransitions: 2,
    detourRatio: 1.0,
    turnCount: 0,
    transitLeg: leg,
  };
}
