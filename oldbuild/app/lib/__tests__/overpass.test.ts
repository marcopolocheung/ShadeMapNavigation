/**
 * Unit tests for app/lib/overpass.ts
 *
 * Uses vi.stubGlobal to mock fetch — no network access required.
 * Each test uses a unique bbox to avoid hitting the module-level LRU cache.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRoutingGraph } from "../overpass";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Helper: unique bbox counter so tests never share a cached result
let bboxIdx = 0;
function nextBbox(): [number, number, number, number] {
  bboxIdx++;
  // Place each bbox far from each other to guarantee no cache containment
  const base = bboxIdx * 5;
  return [base, base, base + 0.01, base + 0.01];
}

// ── XML error detection ───────────────────────────────────────────────────────

describe("fetchRoutingGraph — XML error detection", () => {
  it("throws a user-friendly Error (not a JSON SyntaxError) when Overpass returns XML", async () => {
    const xmlBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      "<osm><remark>Query timed out after 60 seconds</remark></osm>";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        // Current code calls res.json(); mock it throwing SyntaxError as real fetch would
        json: () =>
          Promise.reject(
            new SyntaxError(
              `Unexpected token '<', "<?xml vers"... is not valid JSON`
            )
          ),
        // After the fix, code will call res.text() instead
        text: async () => xmlBody,
      })
    );

    let caught: unknown;
    try {
      await fetchRoutingGraph(...nextBbox());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    // Must NOT surface the raw JSON parse message to the user
    expect((caught as Error).message).not.toMatch(/Unexpected token/i);
    expect((caught as Error).message).not.toMatch(/is not valid JSON/i);
    // Must be human-readable
    expect((caught as Error).message.length).toBeGreaterThan(20);
  });
});

// ── out body geom — inline geometry parsing ───────────────────────────────────

describe("fetchRoutingGraph — out body geom inline geometry", () => {
  it("builds the routing graph from way.geometry coordinates (no separate node elements)", async () => {
    // out body geom format: ways include a `geometry` array with {lat,lon} per node ref.
    // There are NO separate node elements in the response — coordinates come inline.
    const way = {
      type: "way",
      id: 1001,
      nodes: [10, 11],
      tags: { highway: "footway" },
      geometry: [
        { lat: 43.7701, lon: 11.2558 },
        { lat: 43.7702, lon: 11.2559 },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ elements: [way] }),
      })
    );

    const graph = await fetchRoutingGraph(...nextBbox());

    // Both node IDs must be present and have correct coordinates
    expect(graph.nodes.has(10)).toBe(true);
    expect(graph.nodes.has(11)).toBe(true);
    expect(graph.nodes.get(10)?.lat).toBeCloseTo(43.7701);
    expect(graph.nodes.get(10)?.lon).toBeCloseTo(11.2558);
    expect(graph.nodes.get(11)?.lat).toBeCloseTo(43.7702);
    expect(graph.nodes.get(11)?.lon).toBeCloseTo(11.2559);

    // The edge must exist in both directions
    const edgesFrom10 = graph.adj.get(10);
    expect(edgesFrom10).toBeDefined();
    expect(edgesFrom10!.some((e) => e.toId === 11)).toBe(true);
  });
});

// ── closed pedestrian way filter ──────────────────────────────────────────────

describe("fetchRoutingGraph — closed pedestrian way filter", () => {
  it("excludes closed highway=pedestrian ways (plaza area polygons) from the routing graph", async () => {
    // Closed way: first node ID === last node ID → this is an area polygon (e.g., Piazza della Signoria).
    // These ways form ring polygons that are not walkable paths; their mass expansion via `>` was
    // causing Overpass timeouts. Client-side filter must discard them.
    const closedPedestrianWay = {
      type: "way",
      id: 2001,
      nodes: [20, 21, 22, 20], // closed ring
      tags: { highway: "pedestrian" },
      geometry: [
        { lat: 43.7700, lon: 11.2550 },
        { lat: 43.7701, lon: 11.2551 },
        { lat: 43.7702, lon: 11.2552 },
        { lat: 43.7700, lon: 11.2550 }, // same as first
      ],
    };

    // An open footway that SHOULD be included
    const openFootway = {
      type: "way",
      id: 2002,
      nodes: [30, 31],
      tags: { highway: "footway" },
      geometry: [
        { lat: 43.7710, lon: 11.2560 },
        { lat: 43.7711, lon: 11.2561 },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({ elements: [closedPedestrianWay, openFootway] }),
      })
    );

    const graph = await fetchRoutingGraph(...nextBbox());

    // Closed pedestrian ring must NOT appear in the graph
    expect(graph.nodes.has(20)).toBe(false);
    expect(graph.nodes.has(21)).toBe(false);
    expect(graph.nodes.has(22)).toBe(false);

    // Open footway MUST appear
    expect(graph.nodes.has(30)).toBe(true);
    expect(graph.nodes.has(31)).toBe(true);
  });
});

// ── area=yes filter ───────────────────────────────────────────────────────────

describe("fetchRoutingGraph — Overpass query shape", () => {
  it('excludes area=yes ways from the query sent to Overpass', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ elements: [] }),
      text: async () => JSON.stringify({ elements: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // Will throw "No walkable roads found" — that's fine, fetch was still called
    await fetchRoutingGraph(...nextBbox()).catch(() => {});

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const query = decodeURIComponent(
      (init.body as string).replace(/^data=/, "")
    );
    // The query must filter out area polygons
    expect(query).toContain('"area"!');
  });
});
