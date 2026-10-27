import { describe, it, expect } from "vitest";
import { cumulativeM, distanceAt, stopsOf, legsOf, legProgress, km } from "./playbackLegs";

// 0.01 degrees of latitude is ~1,112 m, whatever the longitude. Times are in
// minutes, so a 0.01 step in a minute is ~67 km/h.
const MIN = 60_000;
const p = (m, lat, extra = {}) => ({ t: m * MIN, lat, lng: 35, spd: 0, ...extra });
const STEP = 1112;

// Drives 2 steps (0-2 min), stands still (2-22), drives 3 steps (22-25).
// Every fix reports speed 0, like the units whose speed line is dead: legs
// must come from where the unit went, not from what it said its speed was.
const day = [
  p(0, 0), p(1, 0.01), p(2, 0.02),
  p(12, 0.02), p(22, 0.02),
  p(23, 0.03), p(24, 0.04), p(25, 0.05),
];

describe("cumulativeM / distanceAt", () => {
  it("measures along the track and interpolates between fixes", () => {
    const cum = cumulativeM(day);
    expect(cum[2]).toBeCloseTo(2 * STEP, -1);
    expect(distanceAt(day, cum, 0.5 * MIN)).toBeCloseTo(STEP / 2, -1);
    expect(distanceAt(day, cum, 999 * MIN)).toBe(cum[day.length - 1]);
    expect(distanceAt(day, cum, -5)).toBe(0);
  });

  it("counts nothing across a reporting silence", () => {
    const gappy = [p(0, 0), p(1, 0.01), p(20, 0.5, { gapBefore: true }), p(21, 0.51)];
    const cum = cumulativeM(gappy);
    expect(cum[3]).toBeCloseTo(2 * STEP, -1);
    expect(distanceAt(gappy, cum, 10 * MIN)).toBe(cum[1]);
  });
});

describe("stopsOf", () => {
  it("finds standing still by position, whatever the speed column says", () => {
    expect(stopsOf(day)).toEqual([{ from: 2 * MIN, to: 22 * MIN }]);
  });

  it("ignores a pause shorter than three minutes", () => {
    const brief = [p(0, 0), p(1, 0.01), p(3, 0.01), p(4, 0.02)];
    expect(stopsOf(brief)).toEqual([]);
  });

  it("counts a silence the unit came back from in the same place as a stop", () => {
    const parked = [p(0, 0), p(1, 0.01), p(60, 0.01, { gapBefore: true }), p(61, 0.02)];
    expect(stopsOf(parked)).toEqual([{ from: 1 * MIN, to: 60 * MIN }]);
  });
});

describe("legsOf", () => {
  it("splits the day at the stops, and the legs add up to the trip", () => {
    const legs = legsOf(day);
    expect(legs.map((l) => [l.from / MIN, l.to / MIN])).toEqual([[0, 2], [22, 25]]);
    expect(legs[0].distanceM).toBeCloseTo(2 * STEP, -1);
    expect(legs[1].distanceM).toBeCloseTo(3 * STEP, -1);
    const cum = cumulativeM(day);
    expect(legs[0].distanceM + legs[1].distanceM).toBeCloseTo(cum[day.length - 1], 6);
  });

  it("is one leg when the unit never stopped", () => {
    expect(legsOf([p(0, 0), p(1, 0.01), p(2, 0.02)])).toHaveLength(1);
  });

  it("does not number a yard shuffle between two stops as a leg", () => {
    const yard = [p(0, 0), p(10, 0), p(11, 0.001), p(21, 0.001), p(22, 0.02)];
    const legs = legsOf(yard);
    expect(legs).toHaveLength(1);
    expect(legs[0].from).toBe(21 * MIN);
  });
});

describe("legProgress", () => {
  const legs = legsOf(day);
  const cum = cumulativeM(day);

  it("reports the leg being driven and the trip so far", () => {
    const g = legProgress(day, cum, legs, 23.5 * MIN);
    expect(g.index).toBe(1);
    expect(g.count).toBe(2);
    expect(g.stopped).toBe(false);
    expect(g.legDoneM).toBeCloseTo(1.5 * STEP, -1);
    expect(g.doneM).toBeCloseTo(3.5 * STEP, -1);
    expect(g.tripM).toBeCloseTo(5 * STEP, -1);
  });

  it("keeps naming the finished leg while stopped", () => {
    const g = legProgress(day, cum, legs, 10 * MIN);
    expect(g).toMatchObject({ index: 0, stopped: true });
    expect(g.legDoneM).toBe(legs[0].distanceM);
  });

  it("has no leg before the first one starts", () => {
    const late = [p(0, 0), p(10, 0), p(11, 0.01)];
    const g = legProgress(late, cumulativeM(late), legsOf(late), 5 * MIN);
    expect(g.leg).toBeNull();
  });
});

it("prints kilometres to one decimal", () => {
  expect(km(12345)).toBe("12.3");
});
