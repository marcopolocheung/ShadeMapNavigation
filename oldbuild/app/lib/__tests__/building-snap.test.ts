/**
 * Unit tests for app/lib/building-snap.ts
 *
 * Tests use real geometry — no mocking of the geometry math itself.
 * Only the MapLibre API (querySourceFeatures) is mocked.
 */

import { describe, it, expect } from "vitest";
import { snapOutsideBuilding } from "../building-snap";
import type { MapBuildingQuery } from "../building-snap";

// ── Test fixtures ─────────────────────────────────────────────────────────────

// A simple 0.001° × 0.001° building (≈111 m × 111 m at equator).
// Outer ring wound counterclockwise (GeoJSON convention).
const SQUARE_POLYGON: [number, number][] = [
  [0, 0],
  [0.001, 0],
  [0.001, 0.001],
  [0, 0.001],
  [0, 0], // closed
];

function mockMap(
  polygons: [number, number][][]
): MapBuildingQuery {
  const features = polygons.map((ring) => ({
    geometry: {
      type: "Polygon" as const,
      coordinates: [ring],
    },
  }));
  return {
    querySourceFeatures: () => features,
  };
}

// Independent PIP (ray casting) used only in tests to verify results —
// does NOT share implementation with production code.
function pip(point: [number, number], ring: [number, number][]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("snapOutsideBuilding", () => {
  it("returns the original coord when it is not inside any building", () => {
    const outside: [number, number] = [0.002, 0.002]; // clearly outside
    const map = mockMap([SQUARE_POLYGON]);

    const result = snapOutsideBuilding(outside, map);

    expect(result).toEqual(outside);
  });

  it("returns a coord outside the building polygon when marker is inside", () => {
    const inside: [number, number] = [0.0005, 0.0005]; // center of building
    const map = mockMap([SQUARE_POLYGON]);

    const result = snapOutsideBuilding(inside, map);

    // Result must NOT be inside the building
    expect(pip(result, SQUARE_POLYGON)).toBe(false);
    // Result must be different from the original
    expect(result).not.toEqual(inside);
  });

  it("places the snapped point within a reasonable distance of the original", () => {
    // Marker just inside the north wall (near [0.0005, 0.0009])
    const inside: [number, number] = [0.0005, 0.0009];
    const map = mockMap([SQUARE_POLYGON]);

    const result = snapOutsideBuilding(inside, map);

    expect(pip(result, SQUARE_POLYGON)).toBe(false);
    // Should be close — no more than ~20 m away in either degree axis
    // (building is 0.001° wide; snap + 3 m buffer ≈ 0.001 + 0.00003 ≈ 0.00103°)
    const dLng = Math.abs(result[0] - inside[0]);
    const dLat = Math.abs(result[1] - inside[1]);
    expect(dLng + dLat).toBeLessThan(0.002);
  });

  it("handles MultiPolygon buildings", () => {
    // Two separate polygons (e.g., a building group)
    const poly2: [number, number][] = [
      [0.01, 0.01],
      [0.011, 0.01],
      [0.011, 0.011],
      [0.01, 0.011],
      [0.01, 0.01],
    ];

    const features = [
      { geometry: { type: "MultiPolygon" as const, coordinates: [[SQUARE_POLYGON], [poly2]] } },
    ];
    const map: MapBuildingQuery = { querySourceFeatures: () => features };

    const insidePoly2: [number, number] = [0.0105, 0.0105];

    const result = snapOutsideBuilding(insidePoly2, map);

    expect(pip(result, poly2)).toBe(false);
    expect(result).not.toEqual(insidePoly2);
  });

  it("returns coord unchanged when building query returns no features", () => {
    const coord: [number, number] = [0.0005, 0.0005];
    const map: MapBuildingQuery = { querySourceFeatures: () => [] };

    expect(snapOutsideBuilding(coord, map)).toEqual(coord);
  });

  it("does not snap a coord that sits inside a polygon hole (courtyard)", () => {
    // A 0.003° × 0.003° building with a 0.001° × 0.001° courtyard hole in the center.
    // Outer ring: the full complex perimeter.
    // Inner ring (hole): the courtyard opening.
    //
    // A coord inside the hole is geometrically OUTSIDE the solid building —
    // snapping it to just outside the outer ring would move it the wrong direction
    // (could push it through solid building material or another walled area).
    // The correct behaviour is to leave it in place so snapToEdge can find the
    // nearest walkable street edge.
    const outer: [number, number][] = [
      [0, 0], [0.003, 0], [0.003, 0.003], [0, 0.003], [0, 0],
    ];
    const hole: [number, number][] = [
      [0.001, 0.001], [0.002, 0.001], [0.002, 0.002], [0.001, 0.002], [0.001, 0.001],
    ];

    const features = [
      {
        geometry: {
          type: "Polygon" as const,
          coordinates: [outer, hole], // outer ring + one inner ring (the courtyard)
        },
      },
    ];
    const map: MapBuildingQuery = { querySourceFeatures: () => features };

    // Centre of the hole
    const inHole: [number, number] = [0.0015, 0.0015];

    // Should NOT snap — the coord is inside a courtyard (hole), not the solid building
    const result = snapOutsideBuilding(inHole, map);
    expect(result).toEqual(inHole);
  });
});
