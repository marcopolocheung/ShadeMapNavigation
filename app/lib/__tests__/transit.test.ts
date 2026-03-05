import { describe, it, expect } from "vitest";
import { inferMode } from "../transit";

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

import { afterEach, vi } from "vitest";
import { fetchTransitStops } from "../transit";

afterEach(() => vi.unstubAllGlobals());

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
    expect(stops[0].mode).toBe("bus");
    expect(stops[0].name).toBe("Marienplatz");
  });

  it("parses a subway_entrance node as subway", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ elements: [
        { type: "node", id: 2, lat: 48.2, lon: 11.6, tags: { railway: "subway_entrance", name: "U-Bahn" } },
      ]}),
    }));
    const stops = await fetchTransitStops(...nextBbox());
    expect(stops[0].mode).toBe("subway");
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

  it("returns [] on HTTP error (non-fatal)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }));
    expect(await fetchTransitStops(...nextBbox())).toEqual([]);
  });

  it("returns [] when Overpass returns XML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => '<?xml version="1.0"?><osm/>',
    }));
    expect(await fetchTransitStops(...nextBbox())).toEqual([]);
  });

  it("returns [] on network failure (non-fatal)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network error")));
    expect(await fetchTransitStops(...nextBbox())).toEqual([]);
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
});
