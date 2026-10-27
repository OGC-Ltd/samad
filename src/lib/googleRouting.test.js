import { describe, it, expect } from "vitest";
import { toTrafficRoute } from "./googleRouting";
import { delayCause } from "./tomtomTraffic";

const answer = {
  enabled: true,
  origin: { lat: -0.82, lng: 34.38, fixAt: "2026-10-15T06:00:00.000Z" },
  destination: { lat: -0.91, lng: 34.61, name: "NYAONDO", source: "custom" },
  route: { path: [[-0.82, 34.38], [-0.91, 34.61]], distanceM: 31_200, durationS: 2_700, staticDurationS: 2_400 },
  etaAt: "2026-10-15T06:45:00.000Z",
  computedAt: "2026-10-15T06:00:00.000Z",
  arrived: false,
  reason: null,
};

describe("toTrafficRoute", () => {
  it("reads the server answer in the TomTom route shape", () => {
    const r = toTrafficRoute(answer);
    expect(r.lengthM).toBe(31_200);
    expect(r.travelS).toBe(2_700);
    expect(r.noTrafficS).toBe(2_400);
    expect(r.delayS).toBe(300);
    expect(r.arrivalMs).toBe(Date.parse("2026-10-15T06:45:00.000Z"));
    expect(r.points).toEqual([{ lat: -0.82, lng: 34.38 }, { lat: -0.91, lng: 34.61 }]);
    expect(r.jams).toBeNull();
    expect(r.source).toBe("Google");
  });
  it("turns a refusal into an error the card can show", () => {
    expect(() => toTrafficRoute({ enabled: false })).toThrow(/switched off/);
    expect(() => toTrafficRoute({ ...answer, route: null, reason: "At the destination." })).toThrow("At the destination.");
  });
});

describe("delayCause without traffic sections", () => {
  const r = toTrafficRoute(answer);
  it("states the route-wide delay for a moving unit", () => {
    expect(delayCause(r, 40)).toEqual({ kind: "traffic-ahead", text: "Traffic on the route · +5 m" });
  });
  it("says nothing about a stopped unit, since it cannot know why", () => {
    expect(delayCause(r, 0)).toBeNull();
  });
});
