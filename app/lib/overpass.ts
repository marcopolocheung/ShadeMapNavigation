import { haversineMeters } from "./routing";
import type { OsmNode, GraphEdge, RoutingGraph } from "./routing";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK_URL = "https://overpass.kumi.systems/api/interpreter";

async function postOverpass(url: string, body: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ShadeMapNav/1.0",
    },
    body,
  });
}

// Simple LRU graph cache: reuse a previously fetched graph whose bounding box
// fully contains the new request. Avoids redundant Overpass fetches when the
// user nudges a waypoint slightly (the most common interaction pattern).
interface CacheEntry {
  south: number;
  west: number;
  north: number;
  east: number;
  graph: RoutingGraph;
}
const GRAPH_CACHE_MAX = 5;
const graphCache: CacheEntry[] = []; // newest first

function cacheContains(
  entry: CacheEntry,
  south: number,
  west: number,
  north: number,
  east: number
): boolean {
  return (
    entry.south <= south &&
    entry.west <= west &&
    entry.north >= north &&
    entry.east >= east
  );
}

/**
 * Fetches OSM walkable road graph for the given bounding box via Overpass API.
 * All edge shadeFactor values are initialized to 0 — caller fills them in.
 * Results are cached by bbox; a cached graph is returned if it fully covers
 * the new request without re-fetching.
 */
export async function fetchRoutingGraph(
  south: number,
  west: number,
  north: number,
  east: number
): Promise<RoutingGraph> {
  // Return cached graph if a previously fetched bbox fully covers this request
  for (const entry of graphCache) {
    if (cacheContains(entry, south, west, north, east)) {
      return entry.graph;
    }
  }

  const query = `
[out:json][timeout:60];
(
  way["highway"~"^(footway|path|pedestrian|living_street|residential|unclassified|tertiary|secondary|service|cycleway|steps|track|bridleway)$"]
  (${south},${west},${north},${east});
);
out body;
>;
out skel qt;
`.trim();

  const encodedBody = `data=${encodeURIComponent(query)}`;

  let res = await postOverpass(OVERPASS_URL, encodedBody);
  if (!res.ok && res.status >= 500) {
    res = await postOverpass(OVERPASS_FALLBACK_URL, encodedBody);
  }

  if (!res.ok) {
    if (res.status === 504) {
      throw new Error(
        "The map server is busy — try a smaller area or wait a moment and retry."
      );
    }
    throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: any[] = json.elements ?? [];

  // Separate nodes and ways
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawNodes = elements.filter((e: any) => e.type === "node");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawWays = elements.filter((e: any) => e.type === "way");

  if (rawNodes.length === 0 || rawWays.length === 0) {
    throw new Error(
      "No walkable roads found in this area. Try a more urban location or zoom closer."
    );
  }

  // Count distinct ways each node appears in — marks intersections
  const nodeWayCount = new Map<number, number>();
  for (const way of rawWays) {
    const seen = new Set<number>();
    for (const nid of way.nodes ?? []) {
      if (!seen.has(nid)) {
        seen.add(nid);
        nodeWayCount.set(nid, (nodeWayCount.get(nid) ?? 0) + 1);
      }
    }
  }

  // Build node map
  const nodes = new Map<number, OsmNode>();
  for (const n of rawNodes) {
    nodes.set(n.id, {
      id: n.id, lat: n.lat, lon: n.lon,
      isIntersection: (nodeWayCount.get(n.id) ?? 0) >= 2,
    });
  }

  // Build adjacency list
  const adj = new Map<number, GraphEdge[]>();

  const ensureAdj = (id: number) => {
    if (!adj.has(id)) adj.set(id, []);
  };

  for (const way of rawWays) {
    const nodeRefs: number[] = way.nodes ?? [];
    for (let i = 0; i < nodeRefs.length - 1; i++) {
      const fromId = nodeRefs[i];
      const toId = nodeRefs[i + 1];
      const fromNode = nodes.get(fromId);
      const toNode = nodes.get(toId);
      if (!fromNode || !toNode) continue;

      const distanceM = haversineMeters(
        [fromNode.lon, fromNode.lat],
        [toNode.lon, toNode.lat]
      );

      ensureAdj(fromId);
      ensureAdj(toId);

      adj.get(fromId)!.push({ toId, distanceM, shadeFactor: 0 });
      adj.get(toId)!.push({ toId: fromId, distanceM, shadeFactor: 0 });
    }
  }

  const graph: RoutingGraph = { nodes, adj };

  // Cache newest-first; evict oldest when full
  graphCache.unshift({ south, west, north, east, graph });
  if (graphCache.length > GRAPH_CACHE_MAX) graphCache.pop();

  return graph;
}
