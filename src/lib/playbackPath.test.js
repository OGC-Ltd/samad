/**
 * The playback cursor lands between fixes on almost every frame, so these pin
 * the two things that go wrong there: a bearing that wraps the long way round,
 * and a position slid across a stretch the unit never reported from.
 */

import { describe, it, expect } from "vitest";
import { indexAt, lerpHeading, gapsOf, sampleAt, travelledTo, syncReveal, minuteMarks, zonesAt } from "./playbackPath";

const p = (t, lat, lng, extra = {}) => ({ t, lat, lng, hdg: 0, spd: 10, eng: true, ...extra });

describe("lerpHeading", () => {
  it("takes the short arc across north", () => {
    // The bug this exists to prevent: 350 -> 10 is a 20 degree turn to the
    // RIGHT. A naive (a + (b - a) * f) sweeps 340 degrees left instead, and the
    // marker visibly spins on every northward turn.
    expect(lerpHeading(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(lerpHeading(10, 350, 0.5)).toBeCloseTo(0, 6);
  });

  it("never returns a bearing outside 0-360", () => {
    for (const [a, b] of [[350, 10], [10, 350], [0, 180], [180, 0], [359, 1]]) {
      for (const f of [0, 0.25, 0.5, 0.75, 1]) {
        const h = lerpHeading(a, b, f);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(360);
      }
    }
  });

  it("interpolates the ordinary case linearly", () => {
    expect(lerpHeading(90, 180, 0.5)).toBeCloseTo(135, 6);
  });

  it("survives a missing bearing at either end", () => {
    expect(lerpHeading(null, 90, 0.5)).toBe(90);
    expect(lerpHeading(90, null, 0.5)).toBe(90);
  });
});

describe("indexAt", () => {
  const pts = [p(100, 0, 0), p(200, 0, 0), p(300, 0, 0)];

  it("finds the last fix at or before the instant", () => {
    expect(indexAt(pts, 99)).toBe(-1);
    expect(indexAt(pts, 100)).toBe(0);
    expect(indexAt(pts, 250)).toBe(1);
    expect(indexAt(pts, 300)).toBe(2);
    expect(indexAt(pts, 9999)).toBe(2);
  });
});

describe("sampleAt", () => {
  it("interpolates position half way between two fixes", () => {
    const pts = [p(0, 0, 0), p(1000, 10, 20)];
    const s = sampleAt(pts, 500);
    expect(s.lat).toBeCloseTo(5, 9);
    expect(s.lng).toBeCloseTo(10, 9);
    expect(s.f).toBeCloseTo(0.5, 9);
  });

  /**
   * Speed and ignition are STATES the unit reported, not continuous quantities.
   * Blending 0 and 40 would put 20 km/h on the readout for an instant the
   * machine was doing neither, so both step from the fix being travelled FROM.
   */
  it("steps speed and ignition rather than blending them", () => {
    const pts = [p(0, 0, 0, { spd: 0, eng: false }), p(1000, 1, 1, { spd: 40, eng: true })];
    const s = sampleAt(pts, 500);
    expect(s.spd).toBe(0);
    expect(s.eng).toBe(false);
  });

  it("holds position through a silence instead of sliding across it", () => {
    // 5 km apart with no fixes in between. Interpolating would walk the marker
    // steadily across country the unit was never recorded on.
    const pts = [p(0, 0, 0), p(60_000, 0.05, 0, { gapBefore: true })];
    const s = sampleAt(pts, 30_000);
    expect(s.inGap).toBe(true);
    expect(s.lat).toBe(0);
    expect(s.lng).toBe(0);
  });

  it("clamps before the first fix and after the last", () => {
    const pts = [p(1000, 1, 1), p(2000, 2, 2)];
    expect(sampleAt(pts, 0).lat).toBe(1);
    expect(sampleAt(pts, 99_999).lat).toBe(2);
  });

  it("returns null for an empty track", () => {
    expect(sampleAt([], 0)).toBeNull();
  });

  it("does not divide by zero on two fixes sharing a timestamp", () => {
    // The unique index is (device_id, captured_at), so two rows for the SAME
    // vehicle can share an instant if it reports through two devices.
    const pts = [p(1000, 1, 1), p(1000, 2, 2)];
    const s = sampleAt(pts, 1000);
    expect(Number.isFinite(s.lat)).toBe(true);
  });
});

describe("gapsOf / travelledTo", () => {
  it("reports each silence with its span", () => {
    const pts = [p(0, 0, 0), p(1000, 1, 1), p(60_000, 2, 2, { gapBefore: true })];
    expect(gapsOf(pts)).toEqual([{ from: 1000, to: 60_000, index: 2 }]);
  });

  it("breaks the travelled path on a gap rather than joining across it", () => {
    const pts = [p(0, 0, 0), p(1000, 1, 1), p(60_000, 2, 2, { gapBefore: true }), p(61_000, 3, 3)];
    const runs = travelledTo(pts, 61_000);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toHaveLength(2);
  });

  it("grows the current run up to the cursor", () => {
    const pts = [p(0, 0, 0), p(1000, 10, 0)];
    const runs = travelledTo(pts, 500);
    expect(runs).toHaveLength(1);
    // The two passed fixes are not both behind the cursor — only the first is —
    // so the run is that fix plus the interpolated head.
    expect(runs[0]).toHaveLength(2);
    expect(runs[0][1].lat).toBeCloseTo(5, 9);
  });

  it("draws nothing before the first fix", () => {
    const pts = [p(1000, 1, 1), p(2000, 2, 2)];
    expect(travelledTo(pts, 0)).toEqual([]);
  });
});

describe("syncReveal", () => {
  const entry = (t) => ({ t, shown: false, id: t });
  const run = (entries, t) => {
    const calls = [];
    const changed = syncReveal(entries, t, (e, due) => calls.push([e.id, due]));
    return { calls, changed };
  };

  it("reveals only what has happened by now", () => {
    const es = [entry(10), entry(20), entry(30)];
    const { calls } = run(es, 20);
    expect(calls).toEqual([[10, true], [20, true]]);
    expect(es.map((e) => e.shown)).toEqual([true, true, false]);
  });

  it("fires only on the frame an entry crosses the cursor", () => {
    // The performance property. setMap is expensive; the comparison is not.
    const es = [entry(10), entry(20), entry(30)];
    run(es, 25);
    const second = run(es, 26);
    expect(second.changed).toBe(0);
    expect(second.calls).toEqual([]);
  });

  it("un-reveals when the cursor is scrubbed back before an entry", () => {
    // Rewinding is how you re-watch something. Without this, one pass leaves
    // the whole day's pins on screen for good.
    const es = [entry(10), entry(20), entry(30)];
    run(es, 30);
    const back = run(es, 15);
    expect(back.calls).toEqual([[20, false], [30, false]]);
    expect(es.map((e) => e.shown)).toEqual([true, false, false]);
  });

  it("treats an entry exactly at the cursor as reached", () => {
    const es = [entry(20)];
    expect(run(es, 20).calls).toEqual([[20, true]]);
  });

  it("shows nothing at the very start of the day", () => {
    const es = [entry(10), entry(20)];
    expect(run(es, 5).changed).toBe(0);
    expect(es.every((e) => !e.shown)).toBe(true);
  });
});

describe("minuteMarks", () => {
  // ~0.001 deg of latitude is ~111 m, comfortably past the 12 m move floor.
  const moving = (n, startMs = 0) =>
    Array.from({ length: n }, (_, i) => ({
      t: startMs + i * 30_000, lat: i * 0.001, lng: 0, spd: 40, hdg: 90, eng: true,
    }));

  it("lands marks on the whole minute, not on the first fix's offset", () => {
    const pts = moving(10, 15_000);          // fixes at :15, :45, 1:15 …
    const ts = minuteMarks(pts).map((m) => m.t);
    expect(ts.every((t) => t % 60_000 === 0)).toBe(true);
    expect(ts[0]).toBe(60_000);
  });

  it("carries the speed and heading at that minute", () => {
    const m = minuteMarks(moving(10))[0];
    expect(m.spd).toBe(40);
    expect(m.hdg).toBe(90);
    expect(m.eng).toBe(true);
  });

  it("does not stack sixty marks on a unit that never moved", () => {
    // An hour parked on one spot. Sixty marks there is one answer drawn sixty
    // times, and it buries the track.
    const parked = Array.from({ length: 120 }, (_, i) => ({
      t: i * 30_000, lat: 0.5, lng: 0.5, spd: 0, hdg: null, eng: false,
    }));
    expect(minuteMarks(parked).length).toBeLessThanOrEqual(1);
  });

  it("skips the minutes inside a silence but keeps the one reporting resumed on", () => {
    // sampleAt holds the last position across a gap, so a mark at minute 3 of
    // a ten-minute silence would claim a place for a time we only know the
    // clock of. Minute 10 is different: that IS a fix, at a real position.
    const pts = [
      { t: 0,         lat: 0,     lng: 0, spd: 10, hdg: 0, eng: true },
      { t: 600_000,   lat: 0.05,  lng: 0, spd: 10, hdg: 0, eng: true, gapBefore: true },
    ];
    const ts = minuteMarks(pts).map((m) => m.t);
    expect(ts).toEqual([600_000]);
  });

  it("returns nothing for an empty track", () => {
    expect(minuteMarks([])).toEqual([]);
    expect(minuteMarks(null)).toEqual([]);
  });
});

describe("zonesAt", () => {
  const square = (name, x0, y0, x1, y1) => ({
    properties: { name },
    geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
  });

  it("names every fence the point falls inside", () => {
    const fs = [square("Yard", 0, 0, 10, 10), square("Wider", -5, -5, 20, 20), square("Elsewhere", 50, 50, 60, 60)];
    expect(zonesAt({ lat: 5, lng: 5 }, fs)).toEqual(["Yard", "Wider"]);
  });

  it("treats a hole as outside", () => {
    // A yard with an excluded building in the middle of it.
    const donut = {
      properties: { name: "Donut" },
      geometry: { type: "Polygon", coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
      ] },
    };
    expect(zonesAt({ lat: 5, lng: 5 }, [donut])).toEqual([]);
    expect(zonesAt({ lat: 2, lng: 2 }, [donut])).toEqual(["Donut"]);
  });

  it("handles MultiPolygon and ignores featureless input", () => {
    const mp = { properties: { name: "Split" }, geometry: { type: "MultiPolygon", coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[8, 8], [9, 8], [9, 9], [8, 9], [8, 8]]],
    ] } };
    expect(zonesAt({ lat: 8.5, lng: 8.5 }, [mp])).toEqual(["Split"]);
    expect(zonesAt({ lat: 5, lng: 5 }, [mp])).toEqual([]);
    expect(zonesAt({ lat: 0, lng: 0 }, null)).toEqual([]);
  });
});
