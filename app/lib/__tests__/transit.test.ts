import { describe, it, expect } from "vitest";
import { inferMode, rankThresholdForZoom, fetchTransitStops, getStopsFromCache, tileKey, tilesForBbox, clearTileCache } from "../transit";

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
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 1, lat: 48.1, lon: 11.5, tags: { highway: "bus_stop", name: "Marienplatz" } },
      ]}),
    }));
    const stops = await fetchTransitStops(...nextBbox());
    expect(stops).toHaveLength(1);
    expect(stops![0].mode).toBe("bus");
    expect(stops![0].name).toBe("Marienplatz");
    expect(stops![0].rankScore).toBe(50);
  });

  it("parses a subway_entrance node as subway", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 2, lat: 48.2, lon: 11.6, tags: { railway: "subway_entrance", name: "U-Bahn" } },
      ]}),
    }));
    const stops = await fetchTransitStops(...nextBbox());
    expect(stops![0].mode).toBe("subway");
    expect(stops![0].rankScore).toBe(90);
  });

  it("deduplicates nodes that appear twice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 3, lat: 48.3, lon: 11.7, tags: { highway: "bus_stop" } },
        { type: "node", id: 3, lat: 48.3, lon: 11.7, tags: { public_transport: "stop_position" } },
      ]}),
    }));
    const stops = await fetchTransitStops(...nextBbox());
    expect(stops).toHaveLength(1);
  });

  it("returns null on HTTP error (caller should keep previous stops)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }));
    expect(await fetchTransitStops(...nextBbox())).toBeNull();
  });

  it("returns null when Overpass returns XML (rate-limited)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => '<?xml version="1.0"?><osm/>',
    }));
    expect(await fetchTransitStops(...nextBbox())).toBeNull();
  });

  it("returns null on network failure (caller should keep previous stops)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network error")));
    expect(await fetchTransitStops(...nextBbox())).toBeNull();
  });

  it("caches result and does not re-fetch for a sub-bbox", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) });
    vi.stubGlobal("fetch", fn);
    const [s, w, n, e] = nextBbox();
    await fetchTransitStops(s, w, n, e);
    await fetchTransitStops(s + 0.001, w + 0.001, n - 0.001, e - 0.001);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("query includes bus_stop, railway, public_transport, ferry_terminal", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) });
    vi.stubGlobal("fetch", fn);
    await fetchTransitStops(...nextBbox());
    const body = decodeURIComponent((fn.mock.calls[0][1] as RequestInit).body as string).replace(/^data=/, "");
    expect(body).toContain("bus_stop");
    expect(body).toContain("railway");
    expect(body).toContain("public_transport");
    expect(body).toContain("ferry_terminal");
  });

  it("zoom 10 → only subway+rail stops returned (rankScore ≥ 80)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 100, lat: 1, lon: 1, tags: { railway: "subway_entrance", name: "Metro" } },
        { type: "node", id: 101, lat: 1, lon: 1, tags: { railway: "station", name: "Train Stn" } },
        { type: "node", id: 102, lat: 1, lon: 1, tags: { highway: "bus_stop", name: "Bus Stop" } },
        { type: "node", id: 103, lat: 1, lon: 1, tags: { railway: "tram_stop", name: "Tram" } },
      ]}),
    }));
    const stops = await fetchTransitStops(...nextBbox(), 10, 30);
    expect(stops).not.toBeNull();
    expect(stops!.every(s => s.rankScore >= 80)).toBe(true);
    expect(stops!.some(s => s.mode === "bus")).toBe(false);
    expect(stops!.some(s => s.mode === "tram")).toBe(false);
  });

  it("limit cap: 40 stops from Overpass → sliced to 30 (default limit)", async () => {
    const elements = Array.from({ length: 40 }, (_, i) => ({
      type: "node", id: 200 + i, lat: 1, lon: 1, tags: { highway: "bus_stop" },
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ elements }),
    }));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).not.toBeNull();
    expect(stops!.length).toBe(30);
  });

  it("limit=5 with 10 stops → returns 5", async () => {
    const elements = Array.from({ length: 10 }, (_, i) => ({
      type: "node", id: 300 + i, lat: 1, lon: 1, tags: { highway: "bus_stop" },
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ elements }),
    }));
    const stops = await fetchTransitStops(...nextBbox(), 14, 5);
    expect(stops).not.toBeNull();
    expect(stops!.length).toBe(5);
  });

  it("zoom < 9 → returns empty array without fetching", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const stops = await fetchTransitStops(...nextBbox(), 8, 30);
    expect(stops).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("raceOverpass (tested via fetchTransitStops)", () => {
  it("succeeds when the primary endpoint fails but a fallback responds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("overpass-api.de")) return Promise.reject(new Error("Network error"));
      return Promise.resolve({ ok: true, status: 200,
        text: async () => JSON.stringify({ elements: [] }) });
    }));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).not.toBeNull();
  });

  it("returns null when all three endpoints fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).toBeNull();
  });

  it("returns null when all endpoints return HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).toBeNull();
  });

  it("returns null when all endpoints return XML (rate-limited)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => '<?xml version="1.0"?><osm/>',
    }));
    const stops = await fetchTransitStops(...nextBbox(), 14, 30);
    expect(stops).toBeNull();
  });
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
  it("returns one tile when bbox fits entirely within one 0.25° cell", () => {
    const tiles = tilesForBbox(48.10, 11.30, 48.12, 11.32);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].key).toBe("lat48.00_lon11.25");
  });
  it("tile object has correct south/west/north/east covering the full 0.25° square", () => {
    const [t] = tilesForBbox(48.10, 11.30, 48.12, 11.32);
    expect(t.s).toBeCloseTo(48.00);
    expect(t.w).toBeCloseTo(11.25);
    expect(t.n).toBeCloseTo(48.25);
    expect(t.e).toBeCloseTo(11.50);
  });
  it("returns two tiles when bbox crosses a longitude tile boundary", () => {
    // 11.20–11.30 spans tile at lon11.00 and tile at lon11.25
    const tiles = tilesForBbox(48.10, 11.20, 48.12, 11.30);
    expect(tiles).toHaveLength(2);
    const keys = tiles.map(t => t.key);
    expect(keys).toContain("lat48.00_lon11.00");
    expect(keys).toContain("lat48.00_lon11.25");
  });
  it("returns four tiles when bbox crosses both lat and lon boundaries", () => {
    const tiles = tilesForBbox(48.20, 11.20, 48.30, 11.30);
    expect(tiles).toHaveLength(4);
  });
});
