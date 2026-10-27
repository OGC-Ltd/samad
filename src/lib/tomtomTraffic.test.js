import { describe, expect, it } from "vitest";
import { parseRoute, delayCause, travelModeFor } from "./tomtomTraffic";

// A straight 4-point road north from the equator, ~1.1 km between points,
// with a jam on the last two segments — TomTom's response shape, trimmed.
const pts = [0, 0.01, 0.02, 0.03].map((lat) => ({ latitude: lat, longitude: 36 }));
const response = (sections = []) => ({
  routes: [{
    summary: {
      lengthInMeters: 3336, travelTimeInSeconds: 600, trafficDelayInSeconds: 240,
      noTrafficTravelTimeInSeconds: 360, arrivalTime: "2026-10-04T08:10:00+03:00",
    },
    legs: [{ points: pts }],
    sections,
  }],
});
const jamFrom = (start) => ({
  sectionType: "TRAFFIC", startPointIndex: start, endPointIndex: 3,
  simpleCategory: "JAM", magnitudeOfDelay: 3, delayInSeconds: 240, effectiveSpeedInKmh: 8,
});

describe("parseRoute", () => {
  it("reduces the response to distance, times, points and jams", () => {
    const r = parseRoute(response([jamFrom(1), { sectionType: "TRAVEL_MODE", startPointIndex: 0, endPointIndex: 3 }]), 0);
    expect(r).toMatchObject({ lengthM: 3336, travelS: 600, noTrafficS: 360, delayS: 240 });
    expect(r.arrivalMs).toBe(Date.parse("2026-10-04T05:10:00Z"));
    expect(r.points).toHaveLength(4);
    expect(r.jams).toHaveLength(1);
    expect(r.jams[0]).toMatchObject({ label: "Queuing traffic", magnitude: 3, speedKmh: 8 });
    expect(r.jams[0].points).toHaveLength(3);
    expect(Math.round(r.jams[0].startM / 100)).toBe(11); // ~1.1 km along
  });

  it("throws when there is no route", () => {
    expect(() => parseRoute({ routes: [] })).toThrow(/No route/);
  });
});

describe("delayCause", () => {
  it("blames traffic only when the stopped unit is in the jam", () => {
    const r = parseRoute(response([jamFrom(0)]));
    expect(delayCause(r, 0).kind).toBe("traffic-here");
  });

  it("says a stop is not traffic when the road at the unit flows", () => {
    const r = parseRoute(response([jamFrom(1)]));   // jam starts 1.1 km ahead
    expect(delayCause(r, 2).kind).toBe("stopped-clear");
  });

  it("names a jam ahead and its delay for a moving unit", () => {
    const c = delayCause(parseRoute(response([jamFrom(1)])), 40);
    expect(c.kind).toBe("traffic-ahead");
    expect(c.text).toBe("Queuing traffic in 1.1 km · +4 m");
  });

  it("is clear with no traffic sections", () => {
    expect(delayCause(parseRoute(response()), 50).kind).toBe("clear");
  });
});

describe("travelModeFor", () => {
  it("routes light vehicles as cars and the rest as trucks", () => {
    expect(travelModeFor("SALOON")).toBe("car");
    expect(travelModeFor("PICKUP")).toBe("car");
    expect(travelModeFor("LORRY & TRAILER")).toBe("truck");
    expect(travelModeFor("TRACTOR")).toBe("truck");
    expect(travelModeFor("CANTER")).toBe("truck");
    expect(travelModeFor(undefined)).toBe("truck");
  });
});

import { trackJourney, expectedFor, sameSlotAhead, thinPath } from "./tomtomTraffic";

describe("trackJourney", () => {
  const T0 = Date.UTC(2026, 9, 4, 5, 0);
  // Parked 1 h, drives 10 fixes 1 min apart ~0.9 km each (54 km/h), stops
  // 5 min, goes silent 30 min, drives 2 more, then parks for an hour.
  const pts = [];
  let t = T0, lat = 0;
  const at = (dMin, dLat, extra = {}) => { t += dMin * 60_000; lat += dLat; pts.push({ t, lat, lng: 36, spd: dLat ? 54 : 0, ...extra }); };
  pts.push({ t, lat, lng: 36, spd: 0 });
  at(60, 0);
  for (let i = 0; i < 10; i++) at(1, 0.008);
  at(5, 0);
  at(30, 0.016, { gapBefore: true });
  at(1, 0.008); at(1, 0.008);
  at(60, 0);

  it("times only the stretch between the first and last moving fix", () => {
    const j = trackJourney(pts);
    expect(j.startMs).toBe(T0 + 60 * 60_000);
    expect(j.spanS / 60).toBe(10 + 5 + 30 + 2);
    expect(j.drivingS / 60).toBe(12);
    expect(j.stoppedS / 60).toBe(5);
    expect(j.silentS / 60).toBe(30);
    expect(Math.round(j.km)).toBe(12);   // 0.112° of latitude, silent leg included
  });

  it("is null for a unit that never moved", () => {
    expect(trackJourney([{ t: T0, lat: 0, lng: 36, spd: 0 }, { t: T0 + 6e5, lat: 0, lng: 36, spd: 0 }])).toBeNull();
  });
});

describe("expectedFor", () => {
  const j = { km: 40 };
  it("keeps TomTom's time when its route is the driven one", () => {
    expect(expectedFor(j, { lengthM: 42_000, expectedS: 3600 })).toMatchObject({ expectedS: 3600, matched: true });
  });
  it("scales to the distance driven when TomTom detours round off-network tracks", () => {
    const x = expectedFor(j, { lengthM: 80_000, expectedS: 7200 });
    expect(x.matched).toBe(false);
    expect(x.expectedS).toBe(3600);
  });
});

describe("sameSlotAhead / thinPath", () => {
  it("moves a past departure forward by whole weeks", () => {
    const now = Date.UTC(2026, 9, 4, 12);
    const past = Date.UTC(2026, 9, 4, 6);
    expect(sameSlotAhead(past, now)).toBe(past + 7 * 86_400_000);
  });
  it("thins to points 150 m apart, keeping both ends", () => {
    const path = Array.from({ length: 100 }, (_, i) => ({ lat: i * 0.0001, lng: 36 })); // ~11 m apart
    const out = thinPath(path);
    expect(out[0]).toBe(path[0]);
    expect(out[out.length - 1]).toBe(path[99]);
    expect(out.length).toBeLessThan(10);
  });
});

import { journeyLegs } from "./tomtomTraffic";

describe("journeyLegs", () => {
  // Out 4.4 km north and straight back, fixes every 30 s at ~53 km/h.
  const outAndBack = (stopMin) => {
    const pts = [];
    let t = 0;
    for (let i = 0; i <= 10; i++) { pts.push({ t, lat: i * 0.004, lng: 36, spd: 53 }); t += 30_000; }
    if (stopMin) { t += stopMin * 60_000; pts.push({ t, lat: 0.04, lng: 36, spd: 0 }); t += 30_000; }
    for (let i = 9; i >= 0; i--) { pts.push({ t, lat: i * 0.004, lng: 36, spd: 53 }); t += 30_000; }
    return { path: pts };
  };

  it("cuts a there-and-back drive at the turnaround", () => {
    const legs = journeyLegs(outAndBack(0));
    expect(legs).toHaveLength(2);
    expect(Math.round(legs[0].m / 100)).toBe(44);
    expect(Math.round(legs[1].m / 100)).toBe(44);
  });

  it("cuts at a stop at the far end", () => {
    expect(journeyLegs(outAndBack(5))).toHaveLength(2);
  });

  it("keeps a one-way drive whole", () => {
    const pts = Array.from({ length: 12 }, (_, i) => ({ t: i * 30_000, lat: i * 0.004, lng: 36 + i * 0.001, spd: 50 }));
    expect(journeyLegs({ path: pts })).toHaveLength(1);
  });
});
