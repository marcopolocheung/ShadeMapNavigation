/**
 * Unit tests for app/lib/routing.ts
 *
 * All tests use deterministic, hand-crafted graphs so results are reproducible
 * without any browser APIs, network access, or randomness.
 *
 * Graph notation used throughout:
 *   node id → [lng, lat] coordinates
 *   edges labelled with [distanceM, shadeFactor]
 *
 * Run with: npm test
 */

import { describe, it, expect } from "vitest";
import {
  haversineMeters,
  snapToGraph,
  snapToEdge,
  dijkstra,
  graphToGeoJSON,
  bfsReachable,
  snapToReachableEdge,
  type RoutingGraph,
  type OsmNode,
  type GraphEdge,
} from "../routing";

// ── Graph factories ────────────────────────────────────────────────────────────

/**
 * Linear graph: 1 -- 2 -- 3
 *   1→2: 100 m, shade=0
 *   2→3: 100 m, shade=0.5
 */
function makeLinearGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.000 }],
    [2, { id: 2, lat: 0.0, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: 100, shadeFactor: 0.0 }]],
    [2, [{ toId: 1, distanceM: 100, shadeFactor: 0.0 },
         { toId: 3, distanceM: 100, shadeFactor: 0.5 }]],
    [3, [{ toId: 2, distanceM: 100, shadeFactor: 0.5 }]],
  ]);
  return { nodes, adj };
}

/**
 * Two-path graph:
 *
 *   1 --[100m, shade=0]--> 3          (sunny shortcut)
 *   1 --[100m, shade=1]--> 2 --[100m, shade=1]--> 3  (shaded detour, 200m total)
 *
 * shade=0 Dijkstra: 1→3 direct (cost 100) vs 1→2→3 (cost 200) → 1→3
 * shade=1 Dijkstra: 1→3 cost=100*(1-0*0.7)=100 vs 1→2→3 cost=2*100*(1-0.7)=60 → 1→2→3
 */
function makeTwoPathGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.000 }],
    [2, { id: 2, lat: 0.001, lon: 0.001 }],
    [3, { id: 3, lat: 0.0, lon: 0.002 }],
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 3, distanceM: 100, shadeFactor: 0.0 },
         { toId: 2, distanceM: 100, shadeFactor: 1.0 }]],
    [2, [{ toId: 1, distanceM: 100, shadeFactor: 1.0 },
         { toId: 3, distanceM: 100, shadeFactor: 1.0 }]],
    [3, [{ toId: 1, distanceM: 100, shadeFactor: 0.0 },
         { toId: 2, distanceM: 100, shadeFactor: 1.0 }]],
  ]);
  return { nodes, adj };
}

/**
 * Disconnected graph:
 *   1 -- 2    (connected pair)
 *   3          (isolated node)
 */
function makeDisconnectedGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.000 }],
    [2, { id: 2, lat: 0.0, lon: 0.001 }],
    [3, { id: 3, lat: 1.0, lon: 1.000 }], // isolated
  ]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: 100, shadeFactor: 0 }]],
    [2, [{ toId: 1, distanceM: 100, shadeFactor: 0 }]],
    [3, []],
  ]);
  return { nodes, adj };
}

/**
 * Snap test graph — four nodes in a rough square:
 *   1 (lon=0, lat=0) -- 2 (lon=0.01, lat=0)
 *   |                   |
 *   3 (lon=0, lat=0.01) - 4 (lon=0.01, lat=0.01)
 */
function makeSquareGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.00, lon: 0.00 }],
    [2, { id: 2, lat: 0.00, lon: 0.01 }],
    [3, { id: 3, lat: 0.01, lon: 0.00 }],
    [4, { id: 4, lat: 0.01, lon: 0.01 }],
  ]);
  const d = haversineMeters([0, 0], [0.01, 0]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: d, shadeFactor: 0 },
         { toId: 3, distanceM: d, shadeFactor: 0 }]],
    [2, [{ toId: 1, distanceM: d, shadeFactor: 0 },
         { toId: 4, distanceM: d, shadeFactor: 0 }]],
    [3, [{ toId: 1, distanceM: d, shadeFactor: 0 },
         { toId: 4, distanceM: d, shadeFactor: 0 }]],
    [4, [{ toId: 2, distanceM: d, shadeFactor: 0 },
         { toId: 3, distanceM: d, shadeFactor: 0 }]],
  ]);
  return { nodes, adj };
}

// ── Scenario 1: haversineMeters accuracy ──────────────────────────────────────

describe("haversineMeters", () => {
  it("1° longitude at equator ≈ 111 195 m (±50 m)", () => {
    const d = haversineMeters([0, 0], [1, 0]);
    expect(d).toBeGreaterThan(111_145);
    expect(d).toBeLessThan(111_245);
  });

  it("1° latitude ≈ 111 195 m (±50 m)", () => {
    const d = haversineMeters([0, 0], [0, 1]);
    expect(d).toBeGreaterThan(111_145);
    expect(d).toBeLessThan(111_245);
  });

  it("same point → 0 m", () => {
    expect(haversineMeters([13.4, 52.5], [13.4, 52.5])).toBe(0);
  });

  it("is symmetric", () => {
    const a: [number, number] = [2.3, 48.8];
    const b: [number, number] = [-73.9, 40.7];
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 3);
  });
});

// ── Scenario 2: dijkstra — direct path, only one route ───────────────────────

describe("dijkstra — linear graph (single path)", () => {
  it("returns path 1→2→3", () => {
    const g = makeLinearGraph();
    const result = dijkstra(g, 1, 3, 0);
    expect(result).not.toBeNull();
    expect(result!.nodeIds).toEqual([1, 2, 3]);
  });

  it("distanceM equals sum of edge distances (200 m)", () => {
    const g = makeLinearGraph();
    const result = dijkstra(g, 1, 3, 0);
    expect(result!.distanceM).toBeCloseTo(200, 5);
  });

  it("shadeCoverage is weighted average (edge 2→3 has shade=0.5, 100m each → 0.25)", () => {
    const g = makeLinearGraph();
    const result = dijkstra(g, 1, 3, 0);
    // 100m * 0.0 + 100m * 0.5 = 50 shaded of 200 total → 0.25
    expect(result!.shadeCoverage).toBeCloseTo(0.25, 5);
  });

  it("path nodes are in start→end order (regression: must not be reversed)", () => {
    const g = makeLinearGraph();
    const result = dijkstra(g, 1, 3, 0);
    const ids = result!.nodeIds;
    expect(ids[0]).toBe(1); // must start at startId
    expect(ids[ids.length - 1]).toBe(3); // must end at endId
  });
});

// ── Scenario 3: dijkstra — shade preference changes the chosen path ───────────

describe("dijkstra — two-path graph (shade vs distance trade-off)", () => {
  it("shade=0 picks the shortest (direct 1→3, 100 m)", () => {
    const g = makeTwoPathGraph();
    const result = dijkstra(g, 1, 3, 0);
    expect(result).not.toBeNull();
    expect(result!.nodeIds).toEqual([1, 3]);
    expect(result!.distanceM).toBeCloseTo(100, 5);
  });

  it("shade=1 picks the most-shaded detour (1→2→3, 200 m, 100% shade)", () => {
    const g = makeTwoPathGraph();
    const result = dijkstra(g, 1, 3, 1.0);
    expect(result).not.toBeNull();
    // Effective cost of 1→2→3: 2 * 100 * (1 - 0.7) = 60 < 100
    expect(result!.nodeIds).toEqual([1, 2, 3]);
    expect(result!.shadeCoverage).toBeCloseTo(1.0, 5);
  });

  it("shortest and most-shaded produce different nodeId keys (no false dedup)", () => {
    const g1 = makeTwoPathGraph();
    const shortest = dijkstra(g1, 1, 3, 0.0)!;
    const g2 = makeTwoPathGraph();
    const mostShaded = dijkstra(g2, 1, 3, 1.0)!;
    expect(shortest.nodeIds.join(",")).not.toBe(mostShaded.nodeIds.join(","));
  });

  it("shade coverage is 0 on the direct (sunny) edge", () => {
    const g = makeTwoPathGraph();
    const result = dijkstra(g, 1, 3, 0);
    expect(result!.shadeCoverage).toBeCloseTo(0.0, 5);
  });
});

// ── Scenario 4: dijkstra — disconnected graph returns null ────────────────────

describe("dijkstra — disconnected graph", () => {
  it("returns null when destination is unreachable", () => {
    const g = makeDisconnectedGraph();
    expect(dijkstra(g, 1, 3, 0)).toBeNull();
  });

  it("returns a result when destination is reachable", () => {
    const g = makeDisconnectedGraph();
    expect(dijkstra(g, 1, 2, 0)).not.toBeNull();
  });
});

// ── Scenario 5: snapToGraph — nearest node selection ─────────────────────────

describe("snapToGraph", () => {
  it("returns the nearest node id", () => {
    const g = makeSquareGraph();
    // Node 1 is at (lon=0, lat=0). Coord at (lon=0.001, lat=0) is closest to 1.
    const nearest = snapToGraph([0.001, 0], g);
    expect(nearest).toBe(1);
  });

  it("returns node 4 when coord is in top-right quadrant", () => {
    const g = makeSquareGraph();
    const nearest = snapToGraph([0.009, 0.009], g);
    expect(nearest).toBe(4);
  });
});

// ── Scenario 6: snapToEdge — mid-edge virtual node insertion ─────────────────

describe("snapToEdge", () => {
  it("inserts a virtual node for a mid-edge coordinate", () => {
    // Simple 2-node graph: 1 at (lon=0,lat=0), 2 at (lon=0.01, lat=0)
    const graph: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0, lon: 0 }],
        [2, { id: 2, lat: 0, lon: 0.01 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: haversineMeters([0, 0], [0.01, 0]), shadeFactor: 0.5 }]],
        [2, [{ toId: 1, distanceM: haversineMeters([0, 0], [0.01, 0]), shadeFactor: 0.5 }]],
      ]),
    };
    const midLon = 0.005;
    const virtualId = snapToEdge([midLon, 0], graph, -99);
    expect(virtualId).toBe(-99);
    expect(graph.nodes.has(-99)).toBe(true);
    // Virtual node should be wired to both endpoints
    const vEdges = graph.adj.get(-99)!;
    expect(vEdges.some((e) => e.toId === 1)).toBe(true);
    expect(vEdges.some((e) => e.toId === 2)).toBe(true);
  });

  it("returns the endpoint id when coord projects exactly onto an endpoint (t=0)", () => {
    const graph: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0, lon: 0 }],
        [2, { id: 2, lat: 0, lon: 0.01 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 1000, shadeFactor: 0 }]],
        [2, [{ toId: 1, distanceM: 1000, shadeFactor: 0 }]],
      ]),
    };
    // Project exactly onto node 1
    const id = snapToEdge([0, 0], graph, -1);
    // t=0, so should return bestFromId directly without inserting virtual node
    expect(graph.nodes.has(-1)).toBe(false);
    expect(id).toBe(1);
  });

  it("inherits shadeFactor from the split edge", () => {
    const graph: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0, lon: 0 }],
        [2, { id: 2, lat: 0, lon: 0.01 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 1000, shadeFactor: 0.75 }]],
        [2, [{ toId: 1, distanceM: 1000, shadeFactor: 0.75 }]],
      ]),
    };
    snapToEdge([0.005, 0], graph, -1);
    const vEdges = graph.adj.get(-1)!;
    expect(vEdges.every((e) => e.shadeFactor === 0.75)).toBe(true);
  });
});

// ── Scenario 7: graphToGeoJSON — correct coordinate order ────────────────────

describe("graphToGeoJSON", () => {
  it("produces a GeoJSON LineString with correct coordinates", () => {
    const g = makeLinearGraph();
    const feat = graphToGeoJSON([1, 2, 3], g);
    expect(feat.type).toBe("Feature");
    expect(feat.geometry.type).toBe("LineString");
    const coords = feat.geometry.coordinates;
    expect(coords).toHaveLength(3);
    expect(coords[0]).toEqual([0.000, 0.0]);
    expect(coords[1]).toEqual([0.001, 0.0]);
    expect(coords[2]).toEqual([0.002, 0.0]);
  });

  it("silently skips unknown node ids", () => {
    const g = makeLinearGraph();
    const feat = graphToGeoJSON([1, 999, 3], g);
    expect(feat.geometry.coordinates).toHaveLength(2);
  });
});

// ── Scenario 8: Regression guard — route ordering and deduplication ───────────

describe("route ordering regression guard", () => {
  it("Most Shaded shadeCoverage ≥ Shortest shadeCoverage on two-path graph", () => {
    const g1 = makeTwoPathGraph();
    const g2 = makeTwoPathGraph();
    const shortest = dijkstra(g1, 1, 3, 0.0)!;
    const mostShaded = dijkstra(g2, 1, 3, 1.0)!;
    expect(mostShaded.shadeCoverage).toBeGreaterThanOrEqual(shortest.shadeCoverage);
  });

  it("Most Shaded distanceM ≥ Shortest distanceM (shaded path is a detour here)", () => {
    const g1 = makeTwoPathGraph();
    const g2 = makeTwoPathGraph();
    const shortest = dijkstra(g1, 1, 3, 0.0)!;
    const mostShaded = dijkstra(g2, 1, 3, 1.0)!;
    expect(mostShaded.distanceM).toBeGreaterThanOrEqual(shortest.distanceM);
  });

  it("nodeIds from different shade strengths differ on the two-path graph", () => {
    const g1 = makeTwoPathGraph();
    const g2 = makeTwoPathGraph();
    const r0 = dijkstra(g1, 1, 3, 0)!;
    const r1 = dijkstra(g2, 1, 3, 1)!;
    expect(r0.nodeIds.join(",")).not.toBe(r1.nodeIds.join(","));
  });

  it("uniform shade graph: shade=0 and shade=1 produce the same route (adaptive skip)", () => {
    // All edges have shadeFactor=0 → no shade preference possible
    const g1 = makeLinearGraph();
    const g2 = makeLinearGraph();
    const r0 = dijkstra(g1, 1, 3, 0)!;
    const r1 = dijkstra(g2, 1, 3, 1)!;
    // Same path → dedup check would correctly skip balanced
    expect(r0.nodeIds.join(",")).toBe(r1.nodeIds.join(","));
  });
});

// ── Scenario 9: New RouteResult fields ───────────────────────────────────────

describe("dijkstra — longestContinuousShadeM and shadeTransitions", () => {
  it("linear graph: shade=0.5 is not > SHADE_THRESH (0.5), so 0 transitions and 0 streak", () => {
    const g = makeLinearGraph();
    // edge 1→2 shade=0, edge 2→3 shade=0.5
    // SHADE_THRESH=0.5 with strict >: 0.5 > 0.5 = false → both edges sunny
    const result = dijkstra(g, 1, 3, 0);
    expect(result!.shadeTransitions).toBe(0);
    expect(result!.longestContinuousShadeM).toBe(0);
  });

  it("one sunny edge then one shaded edge → 1 transition, streak = shaded edge distance", () => {
    // Inline graph: 1→2 sunny, 2→3 shaded (shade=0.8 > 0.5 threshold)
    const g: RoutingGraph = {
      nodes: new Map([
        [1, { id: 1, lat: 0.0, lon: 0.000 }],
        [2, { id: 2, lat: 0.0, lon: 0.001 }],
        [3, { id: 3, lat: 0.0, lon: 0.002 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 100, shadeFactor: 0.0 }]],
        [2, [{ toId: 1, distanceM: 100, shadeFactor: 0.0 },
             { toId: 3, distanceM: 100, shadeFactor: 0.8 }]],
        [3, [{ toId: 2, distanceM: 100, shadeFactor: 0.8 }]],
      ]),
    };
    const result = dijkstra(g, 1, 3, 0);
    expect(result!.shadeTransitions).toBe(1);
    expect(result!.longestContinuousShadeM).toBeCloseTo(100, 5);
  });

  it("fully-shaded path has 0 transitions and streak = total distance", () => {
    const g = makeTwoPathGraph();
    // Most-shaded path: 1→2→3, both edges shade=1.0
    const result = dijkstra(g, 1, 3, 1.0);
    expect(result!.shadeTransitions).toBe(0);
    expect(result!.longestContinuousShadeM).toBeCloseTo(200, 5);
  });

  it("fully-sunny path has 0 transitions and streak = 0", () => {
    const g = makeTwoPathGraph();
    // Shortest path: 1→3 direct, shade=0
    const result = dijkstra(g, 1, 3, 0.0);
    expect(result!.shadeTransitions).toBe(0);
    expect(result!.longestContinuousShadeM).toBe(0);
  });
});

describe("dijkstra — DijkstraOptions", () => {
  it("crossingPenaltyM=50 does not change shortest (no isIntersection flags set)", () => {
    const g = makeTwoPathGraph();
    const r = dijkstra(g, 1, 3, 0, { crossingPenaltyM: 50 });
    expect(r!.nodeIds).toEqual([1, 3]); // same shortest path; no nodes are marked
  });

  it("solarIntensity=0 collapses shade routing to shortest", () => {
    const g0 = makeTwoPathGraph();
    const g1 = makeTwoPathGraph();
    const r0 = dijkstra(g0, 1, 3, 0,   { solarIntensity: 0 })!;
    const r1 = dijkstra(g1, 1, 3, 1.0, { solarIntensity: 0 })!;
    expect(r0.nodeIds.join(",")).toBe(r1.nodeIds.join(","));
    expect(r1.nodeIds).toEqual([1, 3]); // no shade benefit → same as shortest
  });

  it("detourRatio > 1 when shaded path is a detour", () => {
    const g = makeTwoPathGraph();
    // Direct edge 1→3 costs 100m; shaded detour 1→2→3 costs 200m.
    // Using the direct edge distance (100m) as the straight-line baseline
    // gives detourRatio = 200 / 100 = 2.0 > 1.
    const r = dijkstra(g, 1, 3, 1.0, { straightLineDistM: 100 })!;
    expect(r.detourRatio).toBeGreaterThan(1.0);
  });

  it("detourRatio = 1.0 when straightLineDistM is 0 (default)", () => {
    const g = makeTwoPathGraph();
    const r = dijkstra(g, 1, 3, 1.0)!;
    expect(r.detourRatio).toBe(1.0);
  });
});

// ── Scenario 10: Parallel sidewalk edges ─────────────────────────────────────

describe("dijkstra — parallel sidewalk edges (same fromId→toId, different shadeFactor)", () => {
  function makeParallelEdgeGraph(): RoutingGraph {
    // 1 → 2: two parallel edges (shaded sidewalk shade=0.9, sunny sidewalk shade=0.1)
    // 2 → 3: two parallel edges (both shaded, shade=0.8)
    return {
      nodes: new Map([
        [1, { id: 1, lat: 0.0, lon: 0.000 }],
        [2, { id: 2, lat: 0.0, lon: 0.001 }],
        [3, { id: 3, lat: 0.0, lon: 0.002 }],
      ]),
      adj: new Map([
        [1, [{ toId: 2, distanceM: 100, shadeFactor: 0.9 },
             { toId: 2, distanceM: 100, shadeFactor: 0.1 }]],
        [2, [{ toId: 1, distanceM: 100, shadeFactor: 0.9 },
             { toId: 1, distanceM: 100, shadeFactor: 0.1 },
             { toId: 3, distanceM: 100, shadeFactor: 0.8 },
             { toId: 3, distanceM: 100, shadeFactor: 0.8 }]],
        [3, [{ toId: 2, distanceM: 100, shadeFactor: 0.8 },
             { toId: 2, distanceM: 100, shadeFactor: 0.8 }]],
      ]),
    };
  }

  it("shade=1 picks the shadier sidewalk: shadeCoverage = 0.9 for edge 1→2", () => {
    const g = makeParallelEdgeGraph();
    const result = dijkstra(g, 1, 3, 1.0)!;
    expect(result).not.toBeNull();
    expect(result.nodeIds).toEqual([1, 2, 3]);
    // Edge 1→2: shaded sidewalk (0.9) chosen; edge 2→3: both 0.8
    // shadeCoverage = (100*0.9 + 100*0.8) / 200 = 0.85
    expect(result.shadeCoverage).toBeCloseTo(0.85, 5);
  });

  it("shade=0 picks the edge with lower cost (both edges same distanceM, so first found)", () => {
    const g = makeParallelEdgeGraph();
    const result = dijkstra(g, 1, 3, 0.0)!;
    expect(result).not.toBeNull();
    // shade=0 → cost = distanceM regardless of shade; both sidewalks identical cost
    expect(result.nodeIds).toEqual([1, 2, 3]);
    expect(result.distanceM).toBeCloseTo(200, 5);
  });

  it("stats reflect the actual edge chosen, not the first edge in the adj list", () => {
    const g = makeParallelEdgeGraph();
    const shaded = dijkstra(g, 1, 3, 1.0)!;
    // The shaded sidewalk (0.9) should be chosen for 1→2; not the sunny one (0.1)
    expect(shaded.shadeCoverage).toBeGreaterThan(0.5);
  });
});

// ── Scenario 11: computeDerivedKpis ──────────────────────────────────────────

import { computeDerivedKpis } from "../metrics";

describe("computeDerivedKpis", () => {
  it("returns nulls when only one route", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 200, shadeCoverage: 0.1 },
    ]);
    expect(kpis.shadeCoverageGainPp).toBeNull();
    expect(kpis.pathLengthDeltaPct).toBeNull();
  });

  it("computes shade gain correctly", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 200, shadeCoverage: 0.1 },
      { label: "Most shaded", distanceM: 250, shadeCoverage: 0.6 },
    ]);
    // (0.6 - 0.1) * 100 = 50 pp
    expect(kpis.shadeCoverageGainPp).toBeCloseTo(50, 5);
  });

  it("computes path length delta correctly", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 200, shadeCoverage: 0.1 },
      { label: "Most shaded", distanceM: 250, shadeCoverage: 0.6 },
    ]);
    // (250 - 200) / 200 * 100 = 25%
    expect(kpis.pathLengthDeltaPct).toBeCloseTo(25, 5);
  });

  it("negative delta when Most Shaded is somehow shorter (edge case)", () => {
    const kpis = computeDerivedKpis([
      { label: "Shortest", distanceM: 300, shadeCoverage: 0.0 },
      { label: "Most shaded", distanceM: 200, shadeCoverage: 1.0 },
    ]);
    // (200 - 300) / 300 * 100 = -33.33%
    expect(kpis.pathLengthDeltaPct).toBeCloseTo(-33.33, 1);
  });
});

import type { RouteOption, TransitLeg } from "../routing";

describe("TransitLeg type (compile-time check)", () => {
  it("RouteOption without transitLeg compiles (pure-walk)", () => {
    const r: RouteOption = {
      label: "Shortest",
      geojson: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
      distanceM: 200, shadeCoverage: 0.3, longestContinuousShadeM: 100,
      shadeTransitions: 1, detourRatio: 1.0, turnCount: 2,
    };
    expect(r.transitLeg).toBeUndefined();
  });

  it("RouteOption with transitLeg compiles", () => {
    const leg: TransitLeg = {
      boardStop:  { id: 1, lat: 48.1, lon: 11.5, name: "Central", mode: "subway" },
      alightStop: { id: 2, lat: 48.2, lon: 11.6, name: "North",   mode: "subway" },
      transitDistM: 1200, sunExposure: 0.0, walkToBoardM: 150, walkFromAlightM: 200,
    };
    const r: RouteOption = {
      label: "Via Transit",
      geojson: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
      distanceM: 1550, shadeCoverage: 0.1, longestContinuousShadeM: 0,
      shadeTransitions: 0, detourRatio: 1.0, turnCount: 0,
      transitLeg: leg,
    };
    expect(r.transitLeg?.sunExposure).toBe(0.0);
  });
});

// ── Graph fixture: two fully disconnected components ──────────────────────────
//
//   Component A (east):  1 --[dAB]--> 2   nodes at lon=0.1 and lon=0.2
//   Component B (west):  3 --[dCD]--> 4   nodes at lon=0.0 and lon=0.01
//
// Used to test that bfsReachable / snapToReachableEdge respect component boundaries.

function makeSplitComponentGraph(): RoutingGraph {
  const nodes = new Map<number, OsmNode>([
    [1, { id: 1, lat: 0.0, lon: 0.1 }],
    [2, { id: 2, lat: 0.0, lon: 0.2 }],
    [3, { id: 3, lat: 0.0, lon: 0.0 }],
    [4, { id: 4, lat: 0.0, lon: 0.01 }],
  ]);
  const dAB = haversineMeters([0.1, 0], [0.2, 0]);
  const dCD = haversineMeters([0.0, 0], [0.01, 0]);
  const adj = new Map<number, GraphEdge[]>([
    [1, [{ toId: 2, distanceM: dAB, shadeFactor: 0 }]],
    [2, [{ toId: 1, distanceM: dAB, shadeFactor: 0 }]],
    [3, [{ toId: 4, distanceM: dCD, shadeFactor: 0 }]],
    [4, [{ toId: 3, distanceM: dCD, shadeFactor: 0 }]],
  ]);
  return { nodes, adj };
}

// ── Tests: bfsReachable ────────────────────────────────────────────────────────

describe("bfsReachable", () => {
  it("returns all nodes when the graph is fully connected", () => {
    const graph = makeLinearGraph(); // 1-2-3 all connected
    const reachable = bfsReachable(graph, 1);
    expect(reachable).toEqual(new Set([1, 2, 3]));
  });

  it("returns only the component of the start node in a disconnected graph", () => {
    // makeDisconnectedGraph: 1-2 connected, 3 isolated
    const graph = makeDisconnectedGraph();
    const reachable = bfsReachable(graph, 1);
    expect(reachable.has(1)).toBe(true);
    expect(reachable.has(2)).toBe(true);
    expect(reachable.has(3)).toBe(false);
  });

  it("returns only the start node when it is isolated", () => {
    const graph = makeDisconnectedGraph(); // node 3 has no edges
    const reachable = bfsReachable(graph, 3);
    expect(reachable).toEqual(new Set([3]));
  });
});

// ── Tests: snapToReachableEdge ────────────────────────────────────────────────

describe("snapToReachableEdge", () => {
  it("snaps to the nearest reachable edge even when a closer unreachable edge exists", () => {
    // coord sits on edge 3-4 (unreachable component); reachable = {1,2}
    const graph = makeSplitComponentGraph();
    const coord: [number, number] = [0.005, 0.0];
    const reachable = new Set([1, 2]);

    const result = snapToReachableEdge(coord, graph, reachable, -1);

    expect(result).not.toBeNull();
    // Nearest point on the 1-2 edge to coord is endpoint 1 (t clips to 0)
    expect(result!.id).toBe(1);
  });

  it("returns null when no reachable edges exist", () => {
    const graph = makeSplitComponentGraph();
    const coord: [number, number] = [0.005, 0.0];
    const emptyReachable = new Set<number>();

    const result = snapToReachableEdge(coord, graph, emptyReachable, -1);

    expect(result).toBeNull();
  });

  it("returns a snap distance near zero when coord sits on a reachable edge", () => {
    // coord at the midpoint of edge 1-2 (both reachable)
    const graph = makeSplitComponentGraph();
    const coord: [number, number] = [0.15, 0.0];
    const reachable = new Set([1, 2]);

    const result = snapToReachableEdge(coord, graph, reachable, -1);

    expect(result).not.toBeNull();
    expect(result!.distM).toBeLessThan(1); // essentially on the edge
  });

  it("inserts a virtual node wired to the snapped edge endpoints", () => {
    // coord at midpoint of 1-2 — should create virtual node -1
    const graph = makeSplitComponentGraph();
    const coord: [number, number] = [0.15, 0.0];
    const reachable = new Set([1, 2]);

    const result = snapToReachableEdge(coord, graph, reachable, -1);

    expect(result!.id).toBe(-1); // virtual node inserted
    const vAdj = graph.adj.get(-1)!;
    const toIds = vAdj.map((e) => e.toId).sort((a, b) => a - b);
    expect(toIds).toEqual([1, 2]); // wired bidirectionally to 1 and 2
  });
});
