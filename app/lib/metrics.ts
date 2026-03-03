/**
 * Routing instrumentation — captures KPIs for every calculateRoute() call.
 *
 * In development, results are logged to the console and exposed at:
 *   window.__shadeMapMetrics.latest   — most recent run
 *   window.__shadeMapMetrics.history  — last 20 runs
 *   window.__shadeMapMetrics.summary  — p50/p95 aggregates
 *
 * Three headline KPIs:
 *   1. routeComputeMs  — end-to-end calculateRoute latency
 *   2. shadeCoverageGain — percentage-point improvement from Shortest → Most Shaded
 *   3. pathLengthDeltaPct — how much longer Most Shaded is vs Shortest (% overhead)
 */

export interface RoutingPhaseMs {
  graphFetch: number; // fetchRoutingGraph (cache hit or network)
  canvasRead: number; // blob → ImageBitmap → ImageData
  shadeSample: number; // edge shade-factor sampling loop
  dijkstra: number; // snap + all Dijkstra passes
  total: number; // wall-clock end-to-end
}

export interface RouteMetricSnapshot {
  label: string;
  distanceM: number;
  shadeCoverage: number; // 0–1
}

export interface RoutingRunMetrics {
  /** Unix timestamp (ms) when calculateRoute was invoked. */
  timestamp: number;
  phases: RoutingPhaseMs;
  graphNodeCount: number;
  /** Total directed edges iterated during shade sampling (both directions). */
  graphDirectedEdges: number;
  routes: RouteMetricSnapshot[];

  // ── Derived KPIs ──────────────────────────────────────────────────────────
  /**
   * KPI 1: Route compute latency (ms).
   * Target: < 3000 ms on a typical urban bbox (network-limited by Overpass).
   * Cache hit target: < 500 ms (canvas read + sampling + dijkstra only).
   */
  routeComputeMs: number;

  /**
   * KPI 2: Shade coverage gain (percentage points, 0–100).
   * Difference in shadeCoverage between the Most Shaded and Shortest routes.
   * null when only one route was found.
   * Target: > 10 pp for routes where a shade-aware detour exists.
   */
  shadeCoverageGainPp: number | null;

  /**
   * KPI 3: Path length overhead (%).
   * How much longer Most Shaded is compared to Shortest.
   * null when only one route was found.
   * A well-calibrated cost model keeps this below ~40% for useful shade gains.
   */
  pathLengthDeltaPct: number | null;
}

// ── Internal circular history buffer ─────────────────────────────────────────

const MAX_HISTORY = 20;
const _history: RoutingRunMetrics[] = [];

// ── Public API ────────────────────────────────────────────────────────────────

export function recordRoutingRun(m: RoutingRunMetrics): void {
  _history.unshift(m);
  if (_history.length > MAX_HISTORY) _history.pop();

  if (typeof window !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__shadeMapMetrics = {
      latest: m,
      history: _history,
      summary: getMetricsSummary(),
    };
  }

  if (process.env.NODE_ENV === "development") {
    const { phases, graphNodeCount, graphDirectedEdges } = m;
    console.groupCollapsed(
      `[ShadeMapNav] Route computed in ${phases.total.toFixed(0)} ms` +
        ` | ${graphNodeCount} nodes, ${graphDirectedEdges} directed edges`
    );
    console.table({
      "Graph fetch (ms)": phases.graphFetch.toFixed(1),
      "Canvas read (ms)": phases.canvasRead.toFixed(1),
      "Shade sample (ms)": phases.shadeSample.toFixed(1),
      "Dijkstra (ms)": phases.dijkstra.toFixed(1),
      "Total (ms)": phases.total.toFixed(1),
    });
    if (m.shadeCoverageGainPp !== null) {
      console.log(
        `[KPI] Shaded route is ${m.pathLengthDeltaPct!.toFixed(1)}% longer` +
          ` and gains ${m.shadeCoverageGainPp.toFixed(1)} pp of shade coverage`
      );
    }
    console.groupEnd();
  }
}

export interface MetricsSummary {
  runs: number;
  avgTotalMs: number;
  p95TotalMs: number;
  avgShadeSampleMs: number;
  avgDijkstraMs: number;
  avgShadeCoverageGainPp: number | null;
  avgPathLengthDeltaPct: number | null;
}

export function getMetricsSummary(): MetricsSummary | null {
  if (_history.length === 0) return null;

  const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
  const avg = (arr: number[]) => sum(arr) / arr.length;

  const totals = _history.map((h) => h.phases.total).sort((a, b) => a - b);
  const p95Idx = Math.min(
    Math.floor(totals.length * 0.95),
    totals.length - 1
  );

  const gainRuns = _history.filter((h) => h.shadeCoverageGainPp !== null);
  const deltaRuns = _history.filter((h) => h.pathLengthDeltaPct !== null);

  return {
    runs: _history.length,
    avgTotalMs: avg(totals),
    p95TotalMs: totals[p95Idx],
    avgShadeSampleMs: avg(_history.map((h) => h.phases.shadeSample)),
    avgDijkstraMs: avg(_history.map((h) => h.phases.dijkstra)),
    avgShadeCoverageGainPp:
      gainRuns.length > 0
        ? avg(gainRuns.map((h) => h.shadeCoverageGainPp!))
        : null,
    avgPathLengthDeltaPct:
      deltaRuns.length > 0
        ? avg(deltaRuns.map((h) => h.pathLengthDeltaPct!))
        : null,
  };
}

/** Returns a copy of the raw run history (newest first). */
export function getRunHistory(): readonly RoutingRunMetrics[] {
  return _history;
}

/** Clears the history buffer (useful for tests or session resets). */
export function clearMetrics(): void {
  _history.length = 0;
}

// ── Helper: compute derived KPIs from route options ───────────────────────────

export function computeDerivedKpis(routes: RouteMetricSnapshot[]): {
  shadeCoverageGainPp: number | null;
  pathLengthDeltaPct: number | null;
} {
  if (routes.length < 2) {
    return { shadeCoverageGainPp: null, pathLengthDeltaPct: null };
  }
  // Shortest is always first (label "Shortest"), Most Shaded is always last.
  const shortest = routes[0];
  const mostShaded = routes[routes.length - 1];
  if (shortest === mostShaded || shortest.distanceM === 0) {
    return { shadeCoverageGainPp: null, pathLengthDeltaPct: null };
  }
  return {
    shadeCoverageGainPp: (mostShaded.shadeCoverage - shortest.shadeCoverage) * 100,
    pathLengthDeltaPct:
      ((mostShaded.distanceM - shortest.distanceM) / shortest.distanceM) * 100,
  };
}
