import { describe, it, expect } from "vitest";
import { inferMode, rankThresholdForZoom, fetchTransitStops, getStopsFromCache, tileKey, tilesForBbox, clearTileCache, modeFromRouteType } from "../transit";

describe("inferMode", () => {
  it("returns 'subway' for subway=yes", () => expect(inferMode({ subway: "yes" })).toBe("subway"));
  it("returns 'subway' for railway=subway_entrance", () => expect(inferMode({ railway: "subway_entrance" })).toBe("subway"));
  it("returns 'subway' for station=subway", () => expect(inferMode({ station: "subway" })).toBe("subway"));
  it("returns 'tram' for railway=tram_stop", () => expect(inferMode({ railway: "tram_stop" })).toBe("tram"));
  it("returns 'rail' for railway=station", () => expect(inferMode({ railway: "station" })).toBe("rail"));
  it("returns 'rail' for railway=halt", () => expect(inferMode({ railway: "halt" })).toBe("rail"));
  it("returns 'ferry' for ferry=yes", () => expect(inferMode({ ferry: "yes" })).toBe("ferry"));
  it("returns 'ferry' for amenity=ferry_terminal", () => expect(inferMode({ amenity: "ferry_terminal" })).toBe("ferry"));
  it("returns 'bus' for highway=bus_stop", () => expect(inferMode({ highway: "bus_stop" })).toBe("bus"));
  it("returns 'bus' for empty tags", () => expect(inferMode({})).toBe("bus"));
  it("subway beats railway=station", () => expect(inferMode({ subway: "yes", railway: "station" })).toBe("subway"));
  it("tram beats highway=bus_stop", () => expect(inferMode({ railway: "tram_stop", highway: "bus_stop" })).toBe("tram"));
});

describe("rankThresholdForZoom", () => {
  it("zoom 9 → 80 (subway+rail only)", () => expect(rankThresholdForZoom(9)).toBe(80));
  it("zoom 11 → 80", () => expect(rankThresholdForZoom(11)).toBe(80));
  it("zoom 12 → 65 (adds tram+ferry)", () => expect(rankThresholdForZoom(12)).toBe(65));
  it("zoom 13 → 65", () => expect(rankThresholdForZoom(13)).toBe(65));
  it("zoom 14 → 45 (adds bus)", () => expect(rankThresholdForZoom(14)).toBe(45));
  it("zoom 15 → 45", () => expect(rankThresholdForZoom(15)).toBe(45));
  it("zoom 16 → 20", () => expect(rankThresholdForZoom(16)).toBe(20));
  it("zoom 17 → 20", () => expect(rankThresholdForZoom(17)).toBe(20));
  it("zoom 18 → 0 (all stops)", () => expect(rankThresholdForZoom(18)).toBe(0));
});

import { afterEach, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  clearTileCache();
});

let _bbox = 0;
function nextBbox(): [number, number, number, number] {
  _bbox++;
  const b = _bbox * 10;
  return [b, b, b + 0.01, b + 0.01];
}

describe("fetchTransitStops", () => {
  it("parses a bus_stop node", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ stops: [
        { id: 1, stop_name: "Marienplatz", geometry: { coordinates: [11.5, 48.1] },
          location_type: 0, route_stops: [{ route: { route_type: 3 } }] },
      ], meta: {} }),
    }));
    const stops = await fetchTransitStops(...nextBbox());
    expect(stops).toHaveLength(1);
    expect(stops![0].mode).toBe("bus");
    expect(stops![0].name).toBe("Marienplatz");
    expect(stops![0].rankScore).toBe(50);
  });

  it("parses a subway stop (route_type 1)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ stops: [
        { id: 2, stop_name: "U-Bahn", geometry: { coordinates: [11.6, 48.2] },
          location_type: 0, route_stops: [{ route: { route_type: 1 } }] },
      ], meta: {} }),
    }));
    const stops = await fetchTransitStops(...nextBbox());
    expect(stops![0].mode).toBe("subway");
    expect(stops![0].rankScore).toBe(90);
  });

  it("deduplicates nodes that appear twice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ stops: [
        { id: 3, stop_name: "Stop", geometry: { coordinates: [11.7, 48.3] },
          location_type: 0, route_stops: [{ route: { route_type: 3 } }] },
        { id: 3, stop_name: "Stop", geometry: { coordinates: [11.7, 48.3] },
          location_type: 0, route_stops: [{ route: { route_type: 3 } }] },
      ], meta: {} }),
    }));
    const stops = await fetchTransitStops(...nextBbox());
    expect(stops).toHaveLength(1);
  });

  it("returns error string on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    expect(typeof await fetchTransitStops(...nextBbox())).toBe("string");
  });

  it("returns error string on HTTP 429 rate-limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    expect(typeof await fetchTransitStops(...nextBbox())).toBe("string");
  });

  it("returns error string on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network error")));
    expect(typeof await fetchTransitStops(...nextBbox())).toBe("string");
  });

  it("caches result and does not re-fetch for same tile area", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ stops: [], meta: {} }) });
    vi.stubGlobal("fetch", fn);
    const [s, w, n, e] = nextBbox(); // e.g. [70, 70, 70.01, 70.01]
    await fetchTransitStops(s, w, n, e);
    const countAfterFirst = fn.mock.calls.length; // 1 (single endpoint, not three)
    // Sub-bbox is in the same tile → should hit cache, no new fetches
    await fetchTransitStops(s + 0.001, w + 0.001, n - 0.001, e - 0.001);
    expect(fn.mock.calls.length).toBe(countAfterFirst);
  });

  it("URL includes apikey, include_route_stops, per_page", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ stops: [], meta: {} }) });
    vi.stubGlobal("fetch", fn);
    await fetchTransitStops(...nextBbox());
    const url: string = fn.mock.calls[0][0];
    expect(url).toContain("apikey=");
    expect(url).toContain("include_route_stops=true");
    expect(url).toContain("per_page=200");
  });

  it("zoom 10 → only subway+rail stops returned (rankScore ≥ 80)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ stops: [
        { id: 100, stop_name: "Metro",    geometry: { coordinates: [1, 1] }, location_type: 0, route_stops: [{ route: { route_type: 1 } }] }, // subway
        { id: 101, stop_name: "Train",    geometry: { coordinates: [1, 1] }, location_type: 0, route_stops: [{ route: { route_type: 2 } }] }, // rail
        { id: 102, stop_name: "Bus Stop", geometry: { coordinates: [1, 1] }, location_type: 0, route_stops: [{ route: { route_type: 3 } }] }, // bus
        { id: 103, stop_name: "Tram",     geometry: { coordinates: [1, 1] }, location_type: 0, route_stops: [{ route: { route_type: 0 } }] }, // tram
      ], meta: {} }),
    }));
    const stops = await fetchTransitStops(...nextBbox(), 10, 30);
    expect(stops).not.toBeNull();
    expect(stops!.every(s => s.rankScore >= 80)).toBe(true);
    expect(stops!.some(s => s.mode === "bus")).toBe(false);
    expect(stops!.some(s => s.mode === "tram")).toBe(false);
  });

  it("limit cap: 40 stops → sliced to 30 (default limit)", async () => {
    const stops = Array.from({ length: 40 }, (_, i) => ({
      id: 200 + i, stop_name: "Stop", geometry: { coordinates: [1, 1] },
      location_type: 0, route_stops: [{ route: { route_type: 3 } }],
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ stops, meta: {} }),
    }));
    const result = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(30);
  });

  it("limit=5 with 10 stops → returns 5", async () => {
    const stops = Array.from({ length: 10 }, (_, i) => ({
      id: 300 + i, stop_name: "Stop", geometry: { coordinates: [1, 1] },
      location_type: 0, route_stops: [{ route: { route_type: 3 } }],
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ stops, meta: {} }),
    }));
    const result = await fetchTransitStops(...nextBbox(), 14, 5);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(5);
  });

  it("zoom < 9 → returns empty array without fetching", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const stops = await fetchTransitStops(...nextBbox(), 8, 30);
    expect(stops).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("tile cache and in-flight deduplication", () => {
  it("second fetchTransitStops for the same tile area does not re-fetch", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ stops: [
        { id: 700, stop_name: "Stop A", geometry: { coordinates: [11.3, 48.1] },
          location_type: 0, route_stops: [{ route: { route_type: 3 } }] },
      ], meta: {} }) });
    vi.stubGlobal("fetch", fn);
    const b: [number, number, number, number] = [48.10, 11.30, 48.12, 11.32]; // fits in tile lat48.10_lon11.30
    await fetchTransitStops(...b, 14, 30);
    const countAfterFirst = fn.mock.calls.length; // 1 (single endpoint)
    await fetchTransitStops(...b, 14, 30); // same tile → cache hit
    expect(fn.mock.calls.length).toBe(countAfterFirst); // no new fetches
  });

  it("concurrent fetchTransitStops for the same tile only fires one set of requests", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ stops: [], meta: {} }) });
    vi.stubGlobal("fetch", fn);
    const b: [number, number, number, number] = [48.10, 11.30, 48.12, 11.32];
    await Promise.all([
      fetchTransitStops(...b, 14, 30),
      fetchTransitStops(...b, 14, 30),
    ]);
    const totalAfterBoth = fn.mock.calls.length;
    // Third call should hit cache
    await fetchTransitStops(...b, 14, 30);
    expect(fn.mock.calls.length).toBe(totalAfterBoth);
  });
});

describe("fetchTransitland (tested via fetchTransitStops)", () => {
  it("sends bbox in lon_min,lat_min,lon_max,lat_max order", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ stops: [], meta: {} }) });
    vi.stubGlobal("fetch", fn);
    await fetchTransitStops(48.10, 11.30, 48.12, 11.32, 14, 30);
    const url: string = fn.mock.calls[0][0];
    const decoded = decodeURIComponent(url);
    // bbox must be w,s,e,n = lon_min,lat_min,lon_max,lat_max
    // tile snap: s=48.10, w=11.30, e=11.35, n=48.15
    const bboxMatch = decoded.match(/bbox=([^&]+)/);
    expect(bboxMatch).not.toBeNull();
    const [bw, bs, be, bn] = bboxMatch![1].split(",").map(Number);
    expect(bw).toBeCloseTo(11.30);
    expect(bs).toBeCloseTo(48.10);
    expect(be).toBeCloseTo(11.35);
    expect(bn).toBeCloseTo(48.15);
  });

  it("includes include_route_stops=true in URL", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ stops: [], meta: {} }) });
    vi.stubGlobal("fetch", fn);
    await fetchTransitStops(...nextBbox(), 14, 30);
    expect(fn.mock.calls[0][0]).toContain("include_route_stops=true");
  });

  it("returns error string when endpoint returns HTTP 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401,
      json: async () => ({}) }));
    expect(typeof await fetchTransitStops(...nextBbox(), 14, 30)).toBe("string");
  });

  it("returns error string on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    expect(typeof await fetchTransitStops(...nextBbox(), 14, 30)).toBe("string");
  });
});

describe("getStopsFromCache", () => {
  it("returns empty array when no tiles cached", () => {
    const stops = getStopsFromCache(2.0, 2.0, 2.1, 2.1);
    expect(stops).toEqual([]);
  });

  it("returns stops synchronously after a completed fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ stops: [
        { id: 800, stop_name: "SyncStop", geometry: { coordinates: [11.31, 48.11] },
          location_type: 0, route_stops: [{ route: { route_type: 3 } }] },
      ], meta: {} }) }));
    const b: [number, number, number, number] = [48.10, 11.30, 48.12, 11.32];
    await fetchTransitStops(...b, 14, 30);
    const cached = getStopsFromCache(...b, 14, 30);
    expect(cached.length).toBeGreaterThan(0);
    expect(cached[0].name).toBe("SyncStop");
  });

  it("applies zoom rank threshold when reading from cache", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ stops: [
        { id: 801, stop_name: "BusStop", geometry: { coordinates: [11.31, 48.11] },
          location_type: 0, route_stops: [{ route: { route_type: 3 } }] },
        { id: 802, stop_name: "Metro",   geometry: { coordinates: [11.31, 48.11] },
          location_type: 0, route_stops: [{ route: { route_type: 1 } }] },
      ], meta: {} }) }));
    const b: [number, number, number, number] = [48.10, 11.30, 48.12, 11.32];
    await fetchTransitStops(...b, 14, 30);
    // zoom=11 → threshold 80 → only subway (90) survives
    const cached = getStopsFromCache(...b, 11, 30);
    expect(cached.every(s => s.rankScore >= 80)).toBe(true);
    expect(cached.some(s => s.mode === "bus")).toBe(false);
  });
});

describe("fetchTransitStops tile-based", () => {
  it("merges stops from two tiles, deduplicating by id", async () => {
    // bbox spanning two lat tiles: 48.20–48.30 crosses the 48.25 boundary
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ stops: [
        { id: 900, stop_name: "StopX", geometry: { coordinates: [11.31, 48.22] },
          location_type: 0, route_stops: [{ route: { route_type: 3 } }] },
      ], meta: {} }) }));
    const stops = await fetchTransitStops(48.20, 11.30, 48.30, 11.32, 14, 30);
    expect(stops).not.toBeNull();
    // StopX appears in one tile; the same stop should appear only once even if both tiles return it
    const ids = stops!.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns empty array (not null) for zoom < 9", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const result = await fetchTransitStops(0, 0, 1, 1, 8, 30);
    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("modeFromRouteType", () => {
  it("0 → tram",    () => expect(modeFromRouteType(0)).toBe("tram"));
  it("1 → subway",  () => expect(modeFromRouteType(1)).toBe("subway"));
  it("2 → rail",    () => expect(modeFromRouteType(2)).toBe("rail"));
  it("3 → bus",     () => expect(modeFromRouteType(3)).toBe("bus"));
  it("4 → ferry",   () => expect(modeFromRouteType(4)).toBe("ferry"));
  it("5 → tram",    () => expect(modeFromRouteType(5)).toBe("tram"));   // cable car
  it("6 → tram",    () => expect(modeFromRouteType(6)).toBe("tram"));   // gondola
  it("7 → rail",    () => expect(modeFromRouteType(7)).toBe("rail"));   // funicular
  it("11 → bus",    () => expect(modeFromRouteType(11)).toBe("bus"));   // trolleybus
  it("12 → subway", () => expect(modeFromRouteType(12)).toBe("subway")); // monorail
  it("99 → bus",    () => expect(modeFromRouteType(99)).toBe("bus"));   // unknown
});

describe("tileKey", () => {
  it("formats latFloor and lonFloor to 2 decimal places", () => {
    expect(tileKey(48, 11.25)).toBe("lat48.00_lon11.25");
  });
  it("floors lat 48.12 → tile lat48.00", () => {
    // tilesForBbox does the flooring; tileKey just formats
    expect(tileKey(48.0, 11.0)).toBe("lat48.00_lon11.00");
  });
  it("handles negative lat", () => {
    expect(tileKey(-34.0, 151.0)).toBe("lat-34.00_lon151.00");
  });
});

describe("tilesForBbox", () => {
  it("returns one tile when bbox fits entirely within one 0.05° cell", () => {
    const tiles = tilesForBbox(48.10, 11.30, 48.12, 11.32);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].key).toBe("lat48.10_lon11.30");
  });
  it("tile object has correct south/west/north/east covering the full 0.05° square", () => {
    const [t] = tilesForBbox(48.10, 11.30, 48.12, 11.32);
    expect(t.s).toBeCloseTo(48.10);
    expect(t.w).toBeCloseTo(11.30);
    expect(t.n).toBeCloseTo(48.15);
    expect(t.e).toBeCloseTo(11.35);
  });
  it("returns two tiles when bbox crosses a longitude tile boundary", () => {
    // 11.20–11.30 spans tile at lon11.20 and tile at lon11.25
    const tiles = tilesForBbox(48.10, 11.20, 48.12, 11.30);
    expect(tiles).toHaveLength(2);
    const keys = tiles.map(t => t.key);
    expect(keys).toContain("lat48.10_lon11.20");
    expect(keys).toContain("lat48.10_lon11.25");
  });
  it("returns four tiles when bbox crosses both lat and lon boundaries", () => {
    const tiles = tilesForBbox(48.20, 11.20, 48.30, 11.30);
    expect(tiles).toHaveLength(4);
  });
});
