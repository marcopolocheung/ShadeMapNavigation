/**
 * Snaps a waypoint coordinate to just outside a building footprint if it falls
 * inside one. Uses the map's maptiler_planet/building source layer — the same
 * data ShadeMap uses for shadow geometry — so no extra network requests are needed.
 */

/** Minimal MapLibre interface required for building queries (mockable in tests). */
export interface MapBuildingQuery {
  querySourceFeatures(
    sourceId: string,
    options: { sourceLayer: string }
  ): Array<{ geometry: { type: string; coordinates: unknown } }>;
}

/**
 * Point-in-polygon ray-casting test.
 * ring: closed [lng, lat] ring (GeoJSON outer ring).
 */
function pointInRing(p: [number, number], ring: [number, number][]): boolean {
  const [px, py] = p;
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

/** Returns the nearest point on segment [a, b] to point p (all [lng, lat]). */
function nearestPointOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): [number, number] {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-20) return a;
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / ab2)
  );
  return [a[0] + t * abx, a[1] + t * aby];
}

/** Returns the nearest point on any segment of a polygon ring to point p. */
function nearestPointOnRing(
  p: [number, number],
  ring: [number, number][]
): [number, number] {
  let bestDist2 = Infinity;
  let bestPt: [number, number] = ring[0];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pt = nearestPointOnSegment(p, ring[j], ring[i]);
    const dx = pt[0] - p[0], dy = pt[1] - p[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestPt = pt;
    }
  }
  return bestPt;
}

/**
 * If coord falls inside any building polygon, returns a coordinate snapped to
 * just outside the building boundary with a small outward buffer (default 3 m).
 * Otherwise returns coord unchanged.
 *
 * Uses maptiler_planet / building source layer (same source ShadeMap uses),
 * so no extra network requests are required.
 */
export function snapOutsideBuilding(
  coord: [number, number], // [lng, lat]
  map: MapBuildingQuery,
  bufferM = 3
): [number, number] {
  const features = map.querySourceFeatures("maptiler_planet", {
    sourceLayer: "building",
  });

  const cosLat = Math.cos(coord[1] * (Math.PI / 180));
  const mPerDegLat = 111195;
  const mPerDegLng = 111195 * Math.max(cosLat, 1e-10);

  for (const feature of features) {
    const geom = feature.geometry;
    if (!geom) continue;

    // Collect outer rings paired with their inner rings (holes).
    // Each entry: [outerRing, ...holeRings]
    const polygons: [number, number][][][] = [];
    if (geom.type === "Polygon") {
      const rings = geom.coordinates as [number, number][][];
      if (rings[0]) polygons.push(rings as [number, number][][]);
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates as [number, number][][][]) {
        if (poly[0]) polygons.push(poly as [number, number][][]);
      }
    } else {
      continue;
    }

    for (const rings of polygons) {
      const ring = rings[0];
      const holes = rings.slice(1);

      if (!pointInRing(coord, ring)) continue;

      // coord is inside the outer ring — but check if it is also inside a hole
      // (courtyard). If so, it is geometrically OUTSIDE the solid building and
      // snapping to the outer ring would move it the wrong direction. Skip.
      const inHole = holes.some((hole) => pointInRing(coord, hole));
      if (inHole) continue;

      // coord is inside this ring — snap to just outside
      const nearest = nearestPointOnRing(coord, ring);

      // Direction vector (in degrees) from coord toward boundary
      const dxDeg = nearest[0] - coord[0];
      const dyDeg = nearest[1] - coord[1];

      // Convert to meters for magnitude calculation
      const dxM = dxDeg * mPerDegLng;
      const dyM = dyDeg * mPerDegLat;
      const lenM = Math.sqrt(dxM * dxM + dyM * dyM);

      if (lenM < 1e-6) {
        // coord is essentially ON the boundary — push outward from centroid
        let cx = 0, cy = 0;
        for (const [x, y] of ring) { cx += x; cy += y; }
        cx /= ring.length; cy /= ring.length;
        const outDxM = (coord[0] - cx) * mPerDegLng;
        const outDyM = (coord[1] - cy) * mPerDegLat;
        const outLenM = Math.sqrt(outDxM * outDxM + outDyM * outDyM);
        if (outLenM < 1e-6) return coord; // degenerate polygon
        return [
          coord[0] + (outDxM / outLenM) * (bufferM / mPerDegLng),
          coord[1] + (outDyM / outLenM) * (bufferM / mPerDegLat),
        ];
      }

      // Place the snapped point bufferM meters past the nearest boundary point,
      // in the direction from coord → boundary (i.e., outward from the building).
      return [
        nearest[0] + (dxM / lenM) * (bufferM / mPerDegLng),
        nearest[1] + (dyM / lenM) * (bufferM / mPerDegLat),
      ];
    }
  }

  return coord;
}
