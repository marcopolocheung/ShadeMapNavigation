// Pure TypeScript routing utilities — no browser dependencies

export interface OsmNode {
  id: number;
  lat: number;
  lon: number;
  isIntersection?: boolean; // true when node appears in ≥2 OSM ways
}

export interface GraphEdge {
  toId: number;
  distanceM: number;
  shadeFactor: number;
}

export interface RoutingGraph {
  nodes: Map<number, OsmNode>;
  adj: Map<number, GraphEdge[]>; // bidirectional
}

export interface RouteResult {
  nodeIds: number[];
  distanceM: number;
  shadeCoverage: number; // 0–1
  longestContinuousShadeM: number;
  shadeTransitions: number;
  detourRatio: number;
  turnCount: number;
}

export interface RouteOption {
  label: string; // "Shortest" | "Balanced" | "Most shaded"
  geojson: GeoJSON.Feature<GeoJSON.LineString>;
  distanceM: number;
  shadeCoverage: number; // 0–1
  longestContinuousShadeM: number;
  shadeTransitions: number;
  detourRatio: number;
  turnCount: number;
}

export interface DijkstraOptions {
  crossingPenaltyM?: number;  // default 0; extra meters cost per intersection traversal
  solarIntensity?: number;    // 0–1; scales MAX_SHADE_SAVING; default 1.0
  straightLineDistM?: number; // for detourRatio; defaults to 0 → ratio = 1.0
}

/** Haversine distance in meters. a/b are [lng, lat]. */
export function haversineMeters(
  a: [number, number],
  b: [number, number]
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aVal =
    sinDLat * sinDLat +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * sinDLon * sinDLon;
  return R * 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
}

/** Simple array-based binary min-heap. */
class MinHeap<T> {
  private data: T[] = [];
  constructor(private cmp: (a: T, b: T) => number) {}

  push(item: T): void {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.data.length;
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cmp(this.data[i], this.data[parent]) < 0) {
        [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private _sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.cmp(this.data[l], this.data[smallest]) < 0) smallest = l;
      if (r < n && this.cmp(this.data[r], this.data[smallest]) < 0) smallest = r;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

/** Returns the node ID in the graph closest to coord [lng, lat]. */
export function snapToGraph(
  coord: [number, number],
  graph: RoutingGraph
): number {
  let bestId = -1;
  let bestDist = Infinity;
  for (const [id, node] of graph.nodes) {
    const d = haversineMeters(coord, [node.lon, node.lat]);
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Snaps coord to the nearest point on any graph edge by projecting coord onto
 * each segment (flat-earth approximation — accurate enough for sub-kilometre
 * pedestrian routing). Inserts a virtual node at the projection point using
 * virtualId (must be negative to avoid OSM id collisions) and wires it
 * bidirectionally into the adjacency list.
 *
 * Falls back to snapToGraph if the graph has no edges.
 * Returns the nearest endpoint id directly if the projection lands on one,
 * avoiding a zero-length virtual edge.
 */
export function snapToEdge(
  coord: [number, number],
  graph: RoutingGraph,
  virtualId: number
): number {
  let bestDist: number = Infinity;
  let bestT = 0;
  let bestFromId: number | null = null;
  let bestToId = 0;
  let bestLon = coord[0];
  let bestLat = coord[1];

  for (const [fromId, edges] of graph.adj) {
    if (fromId < 0) continue; // skip previously inserted virtual nodes
    const fromNode = graph.nodes.get(fromId);
    if (!fromNode) continue;

    for (const edge of edges) {
      if (edge.toId < 0) continue; // skip virtual edges
      const toNode = graph.nodes.get(edge.toId);
      if (!toNode) continue;

      const ax = fromNode.lon, ay = fromNode.lat;
      const bx = toNode.lon,   by = toNode.lat;
      const abx = bx - ax, aby = by - ay;
      const ab2 = abx * abx + aby * aby;
      const t =
        ab2 === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                ((coord[0] - ax) * abx + (coord[1] - ay) * aby) / ab2
              )
            );

      const projLon = ax + t * abx;
      const projLat = ay + t * aby;
      const dist = haversineMeters(coord, [projLon, projLat]);

      if (dist < bestDist) {
        bestDist   = dist;
        bestT      = t;
        bestFromId = fromId;
        bestToId   = edge.toId;
        bestLon    = projLon;
        bestLat    = projLat;
      }
    }
  }

  if (bestFromId === null) return snapToGraph(coord, graph); // empty graph

  // Projection landed exactly on an endpoint — return it directly
  if (bestT === 0) return bestFromId;
  if (bestT === 1) return bestToId;

  // Insert virtual node at the projection point
  graph.nodes.set(virtualId, { id: virtualId, lat: bestLat, lon: bestLon });

  const fromNode = graph.nodes.get(bestFromId)!;
  const toNode   = graph.nodes.get(bestToId)!;
  const totalDist = haversineMeters(
    [fromNode.lon, fromNode.lat],
    [toNode.lon,   toNode.lat]
  );
  const distToFrom = totalDist * bestT;
  const distToTo   = totalDist * (1 - bestT);

  // Inherit shade factor from the split edge
  const shadeFactor =
    (graph.adj.get(bestFromId) ?? []).find((e) => e.toId === bestToId)
      ?.shadeFactor ?? 0;

  // Wire virtual node bidirectionally
  graph.adj.set(virtualId, [
    { toId: bestFromId, distanceM: distToFrom, shadeFactor },
    { toId: bestToId,   distanceM: distToTo,   shadeFactor },
  ]);
  graph.adj.get(bestFromId)!.push({ toId: virtualId, distanceM: distToFrom, shadeFactor });
  const toAdj = graph.adj.get(bestToId);
  if (toAdj) toAdj.push({ toId: virtualId, distanceM: distToTo, shadeFactor });

  return virtualId;
}

/** Cap shade saving at 70% so fully-shaded edges still cost 30% of their distance.
 *  Prevents Dijkstra from creating unbounded detours through zero-cost shaded paths. */
const MAX_SHADE_SAVING = 0.7;

/**
 * Dijkstra's shortest path.
 * Edge cost = distanceM * (1 - shadeStrength * shadeFactor * MAX_SHADE_SAVING * solarIntensity)
 *           + crossingPenaltyM (when toNode is an intersection, except destination)
 * shadeStrength=1 → maximally prefers shaded paths; 0 → shortest distance.
 */
export function dijkstra(
  graph: RoutingGraph,
  startId: number,
  endId: number,
  shadeStrength: number,
  options: DijkstraOptions = {}
): RouteResult | null {
  const { crossingPenaltyM = 0, solarIntensity = 1.0, straightLineDistM = 0 } = options;
  const effectiveMaxShadeSaving = MAX_SHADE_SAVING * solarIntensity;

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const prevEdge = new Map<number, GraphEdge>(); // tracks exact edge used to reach each node
  const heap = new MinHeap<{ id: number; cost: number }>(
    (a, b) => a.cost - b.cost
  );

  dist.set(startId, 0);
  heap.push({ id: startId, cost: 0 });

  while (heap.size > 0) {
    const { id, cost } = heap.pop()!;
    if (cost > (dist.get(id) ?? Infinity)) continue;
    if (id === endId) break;

    const edges = graph.adj.get(id) ?? [];
    for (const edge of edges) {
      const toNode = graph.nodes.get(edge.toId);
      const crossing =
        crossingPenaltyM > 0 && toNode?.isIntersection && edge.toId !== endId
          ? crossingPenaltyM
          : 0;
      const edgeCost =
        edge.distanceM * (1 - shadeStrength * edge.shadeFactor * effectiveMaxShadeSaving)
        + crossing;
      const newCost = cost + edgeCost;
      if (newCost < (dist.get(edge.toId) ?? Infinity)) {
        dist.set(edge.toId, newCost);
        prev.set(edge.toId, id);
        prevEdge.set(edge.toId, edge);
        heap.push({ id: edge.toId, cost: newCost });
      }
    }
  }

  if (!dist.has(endId)) return null;

  // Reconstruct path: push in reverse order then reverse once — O(n) not O(n²).
  // unshift() would be O(n) per call (array shift), making the loop O(n²).
  const nodeIds: number[] = [];
  let cur: number | undefined = endId;
  while (cur !== undefined) {
    nodeIds.push(cur);
    cur = prev.get(cur);
  }
  nodeIds.reverse();

  // Compute aggregate stats along the path
  const SHADE_THRESH = 0.5;
  let totalDist = 0, shadedDist = 0;
  let longestContinuousShadeM = 0, currentStreakM = 0, shadeTransitions = 0;
  let prevShaded: boolean | null = null;
  let turnCount = 0, prevBearing: number | null = null;

  for (let i = 0; i < nodeIds.length - 1; i++) {
    // Use prevEdge (the exact edge Dijkstra chose) so parallel sidewalk edges
    // are resolved correctly — find() would return whichever comes first.
    const edge = prevEdge.get(nodeIds[i + 1]);
    if (!edge || edge.toId !== nodeIds[i + 1]) continue;
    totalDist += edge.distanceM;
    shadedDist += edge.distanceM * edge.shadeFactor;

    // Shade continuity tracking
    const isShaded = edge.shadeFactor > SHADE_THRESH;
    if (isShaded) {
      currentStreakM += edge.distanceM;
      longestContinuousShadeM = Math.max(longestContinuousShadeM, currentStreakM);
    } else {
      currentStreakM = 0;
    }
    if (prevShaded !== null && isShaded !== prevShaded) shadeTransitions++;
    prevShaded = isShaded;

    // Turn counting
    const fn = graph.nodes.get(nodeIds[i])!;
    const tn = graph.nodes.get(nodeIds[i + 1])!;
    const bearing = Math.atan2(tn.lon - fn.lon, tn.lat - fn.lat) * (180 / Math.PI);
    if (prevBearing !== null) {
      let delta = Math.abs(bearing - prevBearing);
      if (delta > 180) delta = 360 - delta;
      if (delta > 30) turnCount++;
    }
    prevBearing = bearing;
  }

  const detourRatio = straightLineDistM > 0 ? totalDist / straightLineDistM : 1.0;

  return {
    nodeIds,
    distanceM: totalDist,
    shadeCoverage: totalDist > 0 ? shadedDist / totalDist : 0,
    longestContinuousShadeM,
    shadeTransitions,
    detourRatio,
    turnCount,
  };
}

// ─── Bi-criteria Pareto routing ──────────────────────────────────────────────

/**
 * Bi-criteria Pareto routing (NAMOA*-inspired label-setting).
 *
 * Finds the Pareto front of (distance, shaded distance) between start and end.
 * Returns up to 3 RouteResult objects:
 *   - Shortest (min distM)
 *   - Most shaded (max shadeM)
 *   - Balanced (knee of Pareto front — closest to ideal point in normalized space)
 *
 * Labels use integer back-pointer IDs (not embedded path arrays) so memory is
 * O(nodes × MAX_LABELS_PER_NODE) rather than O(nodes × labels × pathLength).
 * Paths are reconstructed lazily only for the 2–3 selected representatives.
 */
export function paretoRoutes(
  graph: RoutingGraph,
  startId: number,
  endId: number,
  options: DijkstraOptions = {}
): RouteResult[] {
  const { crossingPenaltyM = 0, solarIntensity = 1.0, straightLineDistM = 0 } = options;
  const effectiveSaving = MAX_SHADE_SAVING * solarIntensity;

  // Each label is stored by index in allLabels; back-pointer is parent index (-1 = start).
  interface PLabel {
    id: number;
    distM: number;
    shadeM: number;
    nodeId: number;
    parentId: number;      // allLabels index; -1 for the start label
    prevEdge: GraphEdge | null;
    evicted: boolean;
  }

  const allLabels: PLabel[] = [];
  const mkLabel = (
    distM: number, shadeM: number, nodeId: number,
    parentId: number, prevEdge: GraphEdge | null
  ): PLabel => {
    const lbl: PLabel = { id: allLabels.length, distM, shadeM, nodeId, parentId, prevEdge, evicted: false };
    allLabels.push(lbl);
    return lbl;
  };

  const MAX_LABELS_PER_NODE = 20;

  // Per-node Pareto set: array of label IDs, sorted distM asc (→ shadeM necessarily desc).
  const paretoSets = new Map<number, number[]>();
  const getSet = (id: number): number[] => {
    if (!paretoSets.has(id)) paretoSets.set(id, []);
    return paretoSets.get(id)!;
  };

  /** Returns true if a dominates b (a is at least as short AND at least as shaded). */
  const dom = (a: PLabel, b: PLabel) => a.distM <= b.distM && a.shadeM >= b.shadeM;

  /**
   * Try to insert `incoming` into the Pareto set for its node.
   * Rejects if dominated by any existing label.
   * Evicts any existing labels now dominated by incoming.
   * If still at cap after evictions, rejects incoming if it would be worst (highest distM).
   * Returns true if accepted.
   */
  const insertPareto = (incoming: PLabel): boolean => {
    const set = getSet(incoming.nodeId);
    for (const id of set) {
      if (dom(allLabels[id], incoming)) return false;
    }
    for (let i = set.length - 1; i >= 0; i--) {
      if (dom(incoming, allLabels[set[i]])) {
        allLabels[set[i]].evicted = true;
        set.splice(i, 1);
      }
    }
    // If at capacity, reject if incoming would be the new worst (tail)
    if (set.length >= MAX_LABELS_PER_NODE) {
      const worstDistM = allLabels[set[set.length - 1]].distM;
      if (incoming.distM >= worstDistM) return false;
      allLabels[set[set.length - 1]].evicted = true;
      set.pop(); // evict current worst to make room
    }
    let pos = set.length;
    for (let i = 0; i < set.length; i++) {
      if (incoming.distM < allLabels[set[i]].distM) { pos = i; break; }
    }
    set.splice(pos, 0, incoming.id);
    return true;
  };

  const destNode = graph.nodes.get(endId);
  const heuristic = (nodeId: number): number => {
    if (!destNode) return 0;
    const n = graph.nodes.get(nodeId);
    if (!n) return 0;
    return haversineMeters([n.lon, n.lat], [destNode.lon, destNode.lat]) * (1 - effectiveSaving);
  };

  const startLabel = mkLabel(0, 0, startId, -1, null);
  insertPareto(startLabel);

  const heap = new MinHeap<{ labelId: number; f: number }>((a, b) => a.f - b.f);
  heap.push({ labelId: startLabel.id, f: heuristic(startId) });

  while (heap.size > 0) {
    const { labelId } = heap.pop()!;
    const label = allLabels[labelId];

    // Skip if this label was evicted from its node's Pareto set since being pushed
    if (label.evicted) continue;

    for (const edge of graph.adj.get(label.nodeId) ?? []) {
      const toNode = graph.nodes.get(edge.toId);
      const crossing =
        crossingPenaltyM > 0 && toNode?.isIntersection && edge.toId !== endId
          ? crossingPenaltyM : 0;

      const newDistM  = label.distM  + edge.distanceM + crossing;
      const newShadeM = label.shadeM + edge.distanceM * edge.shadeFactor;

      // Pre-check dominance before allocating a label object
      const candidateSet = getSet(edge.toId);
      let dominated = false;
      for (const id of candidateSet) {
        const ex = allLabels[id];
        if (ex.distM <= newDistM && ex.shadeM >= newShadeM) { dominated = true; break; }
      }
      if (dominated) continue;

      const newLabel = mkLabel(newDistM, newShadeM, edge.toId, labelId, edge);
      if (insertPareto(newLabel)) {
        heap.push({ labelId: newLabel.id, f: newDistM + heuristic(edge.toId) });
      }
    }
  }

  const destFront = getSet(endId).map((id) => allLabels[id]);
  if (destFront.length === 0) return [];

  // Reconstruct path for a label by following parentId back-pointers.
  const reconstruct = (lbl: PLabel): { nodeIds: number[]; edgePath: GraphEdge[] } => {
    const nodeIds: number[] = [];
    const edgePath: GraphEdge[] = [];
    let cur: PLabel | null = lbl;
    while (cur !== null) {
      nodeIds.push(cur.nodeId);
      if (cur.prevEdge) edgePath.push(cur.prevEdge);
      cur = cur.parentId >= 0 ? allLabels[cur.parentId] : null;
    }
    nodeIds.reverse();
    edgePath.reverse();
    return { nodeIds, edgePath };
  };

  const buildResult = (lbl: PLabel): RouteResult & { _key: string } => {
    const { nodeIds, edgePath } = reconstruct(lbl);
    const SHADE_THRESH = 0.5;
    let totalDist = 0, shadedDist = 0;
    let longestContinuousShadeM = 0, currentStreakM = 0, shadeTransitions = 0;
    let prevShaded: boolean | null = null;
    let turnCount = 0, prevBearing: number | null = null;

    for (let i = 0; i < edgePath.length; i++) {
      const edge = edgePath[i];
      totalDist  += edge.distanceM;
      shadedDist += edge.distanceM * edge.shadeFactor;
      const isShaded = edge.shadeFactor > SHADE_THRESH;
      if (isShaded) {
        currentStreakM += edge.distanceM;
        longestContinuousShadeM = Math.max(longestContinuousShadeM, currentStreakM);
      } else {
        currentStreakM = 0;
      }
      if (prevShaded !== null && isShaded !== prevShaded) shadeTransitions++;
      prevShaded = isShaded;

      const fn = graph.nodes.get(nodeIds[i]);
      const tn = graph.nodes.get(nodeIds[i + 1]);
      if (fn && tn) {
        const bearing = Math.atan2(tn.lon - fn.lon, tn.lat - fn.lat) * (180 / Math.PI);
        if (prevBearing !== null) {
          let delta = Math.abs(bearing - prevBearing);
          if (delta > 180) delta = 360 - delta;
          if (delta > 30) turnCount++;
        }
        prevBearing = bearing;
      }
    }

    return {
      _key: nodeIds.join(","),
      nodeIds,
      distanceM: totalDist,
      shadeCoverage: totalDist > 0 ? shadedDist / totalDist : 0,
      longestContinuousShadeM,
      shadeTransitions,
      detourRatio: straightLineDistM > 0 ? totalDist / straightLineDistM : 1.0,
      turnCount,
    };
  };

  // Select representatives: shortest (min distM), most shaded (max shadeM), knee
  // destFront is sorted distM asc → shadeM desc
  const shortest   = destFront[0];
  const mostShaded = destFront[destFront.length - 1];

  const minDist  = destFront[0].distM;
  const maxDist  = destFront[destFront.length - 1].distM;
  const minShade = destFront[0].shadeM;
  const maxShade = destFront[destFront.length - 1].shadeM;
  const distRange  = maxDist  - minDist  || 1;
  const shadeRange = maxShade - minShade || 1;

  let kneeLabel = destFront[0];
  let kneeScore = Infinity;
  for (const lbl of destFront) {
    const nd = (lbl.distM  - minDist)  / distRange;
    const ns = (lbl.shadeM - minShade) / shadeRange;
    const score = Math.sqrt(nd * nd + (1 - ns) * (1 - ns));
    if (score < kneeScore) { kneeScore = score; kneeLabel = lbl; }
  }

  // Build results, deduplicating by node-path key
  const seen = new Set<string>();
  const results: RouteResult[] = [];
  const tryAdd = (lbl: PLabel) => {
    const r = buildResult(lbl);
    if (seen.has(r._key)) return;
    seen.add(r._key);
    const { _key: _unused, ...result } = r;
    void _unused;
    results.push(result);
  };

  tryAdd(shortest);
  tryAdd(kneeLabel);
  tryAdd(mostShaded);

  return results;
}

/**
 * BFS from startId — returns the set of all node IDs reachable from startId
 * in the graph (including startId itself).
 */
export function bfsReachable(
  graph: RoutingGraph,
  startId: number
): Set<number> {
  const visited = new Set<number>();
  const queue: number[] = [startId];
  visited.add(startId);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const edge of graph.adj.get(id) ?? []) {
      if (!visited.has(edge.toId)) {
        visited.add(edge.toId);
        queue.push(edge.toId);
      }
    }
  }
  return visited;
}

/**
 * Like snapToEdge, but only considers edges where BOTH endpoints are in
 * reachableIds. Returns { id, distM } where id is the snapped node ID
 * (virtual or endpoint) and distM is the distance from coord to the snap
 * point. Returns null if no reachable edge exists in the graph.
 */
export function snapToReachableEdge(
  coord: [number, number],
  graph: RoutingGraph,
  reachableIds: Set<number>,
  virtualId: number
): { id: number; distM: number } | null {
  let bestDist: number = Infinity;
  let bestT = 0;
  let bestFromId: number | null = null;
  let bestToId = 0;
  let bestLon = coord[0];
  let bestLat = coord[1];

  for (const [fromId, edges] of graph.adj) {
    if (fromId < 0) continue;
    if (!reachableIds.has(fromId)) continue;
    const fromNode = graph.nodes.get(fromId);
    if (!fromNode) continue;

    for (const edge of edges) {
      if (edge.toId < 0) continue;
      if (!reachableIds.has(edge.toId)) continue;
      const toNode = graph.nodes.get(edge.toId);
      if (!toNode) continue;

      const ax = fromNode.lon, ay = fromNode.lat;
      const bx = toNode.lon,   by = toNode.lat;
      const abx = bx - ax, aby = by - ay;
      const ab2 = abx * abx + aby * aby;
      const t =
        ab2 === 0
          ? 0
          : Math.max(0, Math.min(1,
              ((coord[0] - ax) * abx + (coord[1] - ay) * aby) / ab2
            ));
      const projLon = ax + t * abx;
      const projLat = ay + t * aby;
      const dist = haversineMeters(coord, [projLon, projLat]);

      if (dist < bestDist) {
        bestDist   = dist;
        bestT      = t;
        bestFromId = fromId;
        bestToId   = edge.toId;
        bestLon    = projLon;
        bestLat    = projLat;
      }
    }
  }

  if (bestFromId === null) return null;

  // Projection landed exactly on an endpoint
  if (bestT === 0) {
    const n = graph.nodes.get(bestFromId)!;
    return { id: bestFromId, distM: haversineMeters(coord, [n.lon, n.lat]) };
  }
  if (bestT === 1) {
    const n = graph.nodes.get(bestToId)!;
    return { id: bestToId, distM: haversineMeters(coord, [n.lon, n.lat]) };
  }

  // Insert virtual node at projection point
  graph.nodes.set(virtualId, { id: virtualId, lat: bestLat, lon: bestLon });

  const fromNode = graph.nodes.get(bestFromId)!;
  const toNode   = graph.nodes.get(bestToId)!;
  const totalDist = haversineMeters(
    [fromNode.lon, fromNode.lat],
    [toNode.lon,   toNode.lat]
  );
  const distToFrom = totalDist * bestT;
  const distToTo   = totalDist * (1 - bestT);

  const shadeFactor =
    (graph.adj.get(bestFromId) ?? []).find((e) => e.toId === bestToId)
      ?.shadeFactor ?? 0;

  graph.adj.set(virtualId, [
    { toId: bestFromId, distanceM: distToFrom, shadeFactor },
    { toId: bestToId,   distanceM: distToTo,   shadeFactor },
  ]);
  graph.adj.get(bestFromId)!.push({ toId: virtualId, distanceM: distToFrom, shadeFactor });
  const toAdj = graph.adj.get(bestToId);
  if (toAdj) toAdj.push({ toId: virtualId, distanceM: distToTo, shadeFactor });

  return { id: virtualId, distM: bestDist };
}

/** Converts a node ID path → GeoJSON LineString feature. */
export function graphToGeoJSON(
  path: number[],
  graph: RoutingGraph
): GeoJSON.Feature<GeoJSON.LineString> {
  const coords: [number, number][] = path
    .map((id) => graph.nodes.get(id))
    .filter((n): n is OsmNode => n !== undefined)
    .map((n) => [n.lon, n.lat]);

  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: coords,
    },
  };
}
