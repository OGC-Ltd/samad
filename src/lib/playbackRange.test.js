import { describe, it, expect } from "vitest";
import { addDays, daysBetween, parseSpan, spanKey, daysOf, mergeDays, MAX_RANGE_DAYS } from "./playbackRange";

describe("spans", () => {
  it("reads one day and a range", () => {
    expect(parseSpan("2026-09-24")).toEqual({ from: "2026-09-24", to: "2026-09-24" });
    expect(parseSpan("2026-09-22..2026-09-24")).toEqual({ from: "2026-09-22", to: "2026-09-24" });
    expect(parseSpan("nonsense")).toBeNull();
  });

  it("writes one day as a day, and orders a range", () => {
    expect(spanKey("2026-09-24", "2026-09-24")).toBe("2026-09-24");
    expect(spanKey("2026-09-24", "2026-09-22")).toBe("2026-09-22..2026-09-24");
  });

  it("caps a range at a month and at today", () => {
    expect(spanKey("2026-08-01", "2026-09-30")).toBe(`2026-08-01..${addDays("2026-08-01", MAX_RANGE_DAYS - 1)}`);
    expect(spanKey("2026-09-23", "2026-09-30", "2026-09-25")).toBe("2026-09-23..2026-09-25");
  });

  it("lists the days, across a month end", () => {
    expect(daysOf("2026-09-29..2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(daysBetween("2026-09-29", "2026-10-02")).toBe(4);
  });
});

describe("mergeDays", () => {
  const H = 3_600_000;
  const day = (name, pts, extra = {}) => ({
    day: name, from: pts[0]?.t ?? 0, to: 0, fixes: pts.length, points: pts, rawPoints: pts.length,
    distanceM: 1000, events: [{ t: pts[0]?.t ?? 0, kind: "stop" }], truncated: false, ...extra,
  });

  it("joins the days in order and adds up their figures", () => {
    const m = mergeDays([
      day("2026-09-23", [{ t: 1 * H }, { t: 2 * H }]),
      day("2026-09-24", [{ t: 25 * H }, { t: 26 * H }], { truncated: true }),
    ]);
    expect(m.points.map((p) => p.t)).toEqual([1 * H, 2 * H, 25 * H, 26 * H]);
    expect(m.events).toHaveLength(2);
    expect(m.fixes).toBe(4);
    expect(m.distanceM).toBe(2000);
    expect(m.truncated).toBe(true);
    expect(m).toMatchObject({ day: "2026-09-23", toDay: "2026-09-24", firstAt: 1 * H, lastAt: 26 * H });
  });

  it("breaks the line at midnight only when the unit was silent across it", () => {
    const quiet = mergeDays([day("a", [{ t: 0 }, { t: 23 * H }]), day("b", [{ t: 30 * H }])]);
    expect(quiet.points[2].gapBefore).toBe(true);
    const driving = mergeDays([day("a", [{ t: 0 }, { t: 24 * H - 30_000 }]), day("b", [{ t: 24 * H }])]);
    expect(driving.points[2].gapBefore).toBeUndefined();
  });

  it("skips days that came back empty", () => {
    const one = day("2026-09-24", [{ t: 1 }]);
    expect(mergeDays([null, one])).toBe(one);
    expect(mergeDays([null])).toBeNull();
  });
});
