import { describe, it, expect } from "vitest";
import { pathLengthM, formatDistance, plainPoint } from "./measure";

describe("pathLengthM", () => {
  it("is zero for no leg", () => {
    expect(pathLengthM([])).toBe(0);
    expect(pathLengthM([{ lat: 0, lng: 0 }])).toBe(0);
  });

  it("sums legs: one degree of latitude is ~111.2 km", () => {
    const m = pathLengthM([{ lat: 0, lng: 34 }, { lat: 0.5, lng: 34 }, { lat: 1, lng: 34 }]);
    expect(m / 1000).toBeCloseTo(111.19, 1);
  });

  it("takes the map's lat()/lng() points too", () => {
    const p = (lat, lng) => ({ lat: () => lat, lng: () => lng });
    expect(pathLengthM([p(0, 34), p(1, 34)])).toBeCloseTo(pathLengthM([{ lat: 0, lng: 34 }, { lat: 1, lng: 34 }]), 6);
    expect(plainPoint(p(1, 2))).toEqual({ lat: 1, lng: 2 });
  });
});

describe("formatDistance", () => {
  it.each([
    [0, "0 m"], [NaN, "0 m"], [12.4, "12 m"], [999.4, "999 m"],
    [1240, "1.24 km"], [38_640, "38.6 km"], [412_300, "412 km"],
  ])("%s → %s", (m, s) => expect(formatDistance(m)).toBe(s));
});
