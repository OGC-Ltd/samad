import { describe, it, expect } from "vitest";
import {
  alertPager, bulkPlan, bulkWords, canTake, choiceWords, companyForOrgCode, alertTrend, countWhere, trendUnit, daysBounds, daysWords, decisionWords,
  duration, figureOf, fleetDay, fleetMidnight, headline, kindOf, periodDays, periodFrom, reportedLate, statusOf, unitQueues,
} from "./alertsView";

describe("alertPager", () => {
  it("reads the whole from the counts while there are more pages", () => {
    expect(alertPager({ page: 0, rows: 15, hasNext: true, listed: 40 }))
      .toEqual({ page: 0, pageCount: 3, total: 40, from: 1, to: 15 });
    expect(alertPager({ page: 1, rows: 15, hasNext: true, listed: 40 })).toMatchObject({ from: 16, to: 30, pageCount: 3 });
  });

  it("lets the rows win when the counts lag", () => {
    // The last page holds 7: that is the whole, whatever the counts said.
    expect(alertPager({ page: 2, rows: 7, hasNext: false, listed: 40 }))
      .toEqual({ page: 2, pageCount: 3, total: 37, from: 31, to: 37 });
    // More after this page: never drawn as the last one.
    expect(alertPager({ page: 2, rows: 15, hasNext: true, listed: 30 })).toMatchObject({ pageCount: 4, total: 46 });
    expect(alertPager({ page: 0, rows: 15, hasNext: true, listed: null })).toMatchObject({ pageCount: 2, total: 16 });
  });

  it("is one page, and no pager, when everything fits", () => {
    expect(alertPager({ page: 0, rows: 4, hasNext: false, listed: 4 })).toMatchObject({ pageCount: 1, total: 4 });
  });
});

describe("periods", () => {
  it("opens at midnight on the fleet's clock, not the browser's", () => {
    // 01:30 in Nairobi on 12 Oct is 22:30 UTC on the 11th.
    const now = Date.parse("2026-10-11T22:30:00Z");
    expect(new Date(fleetMidnight(now)).toISOString()).toBe("2026-10-11T21:00:00.000Z");
    expect(periodFrom("today", now)).toBe("2026-10-11T21:00:00.000Z");
    // Seven days is today and the six before it.
    expect(periodFrom("7d", now)).toBe("2026-10-05T21:00:00.000Z");
  });
});

describe("countWhere", () => {
  const counts = [
    { orgId: "a", kind: "fuel", status: "open", n: 2 },
    { orgId: "a", kind: "speeding", status: "open", n: 5 },
    { orgId: "b", kind: "speeding", status: "escalated", n: 1 },
  ];

  it("sums what the other filters let through", () => {
    expect(countWhere(counts, { status: "open" })).toBe(7);
    expect(countWhere(counts, { orgs: ["b"] })).toBe(1);
    expect(countWhere(counts, { kind: "speeding", status: "open" })).toBe(5);
    expect(countWhere(counts, { orgs: ["a"], kind: "fuel" })).toBe(2);
  });

  it("splits read from unread", () => {
    const marked = [{ orgId: "a", kind: "fuel", status: "open", read: true, n: 3 }, { orgId: "a", kind: "fuel", status: "open", read: false, n: 4 }];
    expect(countWhere(marked, { read: "unread" })).toBe(4);
    expect(countWhere(marked, { read: "read" })).toBe(3);
    expect(countWhere(marked, {})).toBe(7);
  });

  it("has nothing to say before the counts arrive", () => {
    expect(countWhere(null, {})).toBeNull();
  });
});

describe("an alert's decision in words", () => {
  it("names the escalation's reason, and a de-escalation by its kind", () => {
    expect(statusOf({ kind: "fuel", status: "escalated", decision: { reason: "probe_fault" } }))
      .toEqual({ label: "Escalated", tone: "inc", meaning: "faulty fuel probe" });
    expect(statusOf({ kind: "speeding", status: "deescalated", decision: {} }).meaning).toBe("not an overspeed");
    expect(decisionWords("fuel", { outcome: "ESCALATED", reason: "theft" })).toBe("Escalated as confirmed theft");
    expect(decisionWords("speeding", { outcome: "DEESCALATED" })).toBe("De-escalated as not an overspeed");
  });

  it("says why an open fuel alert is off the map", () => {
    expect(statusOf({ kind: "fuel", status: "open", cleared: "unit" }).meaning).toMatch(/another alert on this unit/);
    expect(statusOf({ kind: "fuel", status: "open", cleared: null, fuel: { live: true } }).meaning).toBe("on the map now");
  });

  it("words each decision for the button that makes it", () => {
    expect(choiceWords("fuel", { outcome: "ESCALATED", reason: "probe_fault" }).confirm).toBe("Escalate as faulty fuel probe");
    expect(choiceWords("fuel", { outcome: "DEESCALATED", reason: null }).label).toBe("Not a theft");
    expect(choiceWords("speeding", { outcome: "ESCALATED", reason: null }).confirm).toBe("Escalate as a confirmed overspeed");
  });
});

describe("figures", () => {
  it("states what happened in one figure", () => {
    expect(headline({ kind: "fuel", fuel: { litres: 23.44 } })).toEqual({ figure: "23.4 L", words: "lost" });
    expect(headline({ kind: "speeding", speeding: { peakKmh: 104.4, limitKmh: 80 } })).toEqual({ figure: "104 km/h", words: "in 80 km/h" });
  });

  it("reads a duration the way a person would say it", () => {
    expect(duration(45)).toBe("45 s");
    expect(duration(190)).toBe("3 min");
    expect(duration(3900)).toBe("1 h 05 min");
  });

  it("finds the dashboard's company for an organisation code", () => {
    expect(companyForOrgCode("SAMAD")).toBe("samad");
    expect(companyForOrgCode("nowhere")).toBeNull();
  });
});

describe("the days asked for", () => {
  // 01:30 in Nairobi on 12 Oct.
  const now = Date.parse("2026-10-11T22:30:00Z");

  it("reads days on the fleet's clock", () => {
    expect(fleetDay(now)).toBe("2026-10-12");
    expect(periodDays("7d", now)).toEqual({ fromDay: "2026-10-06", toDay: "2026-10-12" });
    expect(periodDays("today", now)).toEqual({ fromDay: "2026-10-12", toDay: "2026-10-12" });
  });

  it("asks from midnight to the last moment of the last day, and leaves an open end to the server", () => {
    expect(daysBounds({ fromDay: "2026-10-03", toDay: "2026-10-05" }, now))
      .toEqual({ from: "2026-10-02T21:00:00.000Z", to: "2026-10-05T20:59:59.999Z" });
    expect(daysBounds({ fromDay: "2026-10-06", toDay: "2026-10-12" }, now))
      .toEqual({ from: "2026-10-05T21:00:00.000Z", to: null });
  });

  it("words a span", () => {
    expect(daysWords({ fromDay: "2026-10-03", toDay: "2026-10-12" })).toBe("3 Oct – 12 Oct");
    expect(daysWords({ fromDay: "2026-10-03", toDay: "2026-10-03" })).toBe("3 Oct");
  });
});

describe("deciding many at once", () => {
  const fuel = (id, over = {}) => ({
    kind: "fuel", id, orgId: "a", vehicleId: "v1", plate: "KDA 1", at: "2026-10-10T08:00:00Z",
    choices: [
      { outcome: "ESCALATED", reason: "theft" }, { outcome: "ESCALATED", reason: "probe_fault" }, { outcome: "DEESCALATED", reason: null },
    ],
    ...over,
  });
  const speed = (id, over = {}) => ({
    kind: "speeding", id, orgId: "b", vehicleId: "v9", plate: "KDB 9", at: "2026-10-10T08:00:00Z",
    choices: [{ outcome: "ESCALATED", reason: null }, { outcome: "DEESCALATED", reason: null }],
    ...over,
  });
  const keyOf = (a) => `${a.kind}:${a.id}`;

  it("knows which decisions an alert can still take", () => {
    const theft = fuel("f", { choices: [{ outcome: "ESCALATED", reason: "probe_fault" }, { outcome: "DEESCALATED", reason: null }] });
    expect(canTake(theft, "ESCALATED", "theft")).toBe(false);
    expect(canTake(theft, "ESCALATED", "probe_fault")).toBe(true);
    expect(canTake(speed("s"), "ESCALATED")).toBe(true);
  });

  it("escalates some and de-escalates others in one batch, and says why the rest cannot", () => {
    const already = fuel("f2", {
      status: "escalated", decision: { outcome: "ESCALATED", reason: "theft" },
      choices: [{ outcome: "ESCALATED", reason: "probe_fault" }, { outcome: "DEESCALATED", reason: null }],
    });
    const probe = fuel("f3", { status: "escalated", decision: { outcome: "ESCALATED", reason: "probe_fault" }, choices: [] });
    const alerts = [fuel("f1"), already, probe, speed("s1"), speed("s2")];
    const picks = { "fuel:f1": "ESCALATED", "fuel:f2": "ESCALATED", "fuel:f3": "DEESCALATED", "speeding:s1": "DEESCALATED", "speeding:s2": null };
    const { run, skip } = bulkPlan(alerts, picks, "theft", keyOf);
    expect(run.map((s) => [s.alert.id, s.outcome, s.reason])).toEqual([["f1", "ESCALATED", "theft"], ["s1", "DEESCALATED", null]]);
    expect(skip.map((s) => [s.alert.id, s.why])).toEqual([
      ["f2", "Already escalated as confirmed theft."],
      ["f3", "Escalated as a faulty fuel probe: it closes in Fuel Audit."],
    ]);
    // As a faulty probe, the one already escalated as a theft can go too.
    expect(bulkPlan(alerts, picks, "probe_fault", keyOf).run.map((s) => s.alert.id)).toEqual(["f1", "f2", "s1"]);
  });

  it("queues each unit's alerts oldest first, units side by side", () => {
    const steps = [
      { alert: fuel("late", { at: "2026-10-10T09:00:00Z" }) },
      { alert: speed("s") },
      { alert: fuel("early", { at: "2026-10-10T07:00:00Z" }) },
    ];
    expect(unitQueues(steps).map((q) => q.map((s) => s.alert.id))).toEqual([["early", "late"], ["s"]]);
  });

  it("sums a batch up in one line", () => {
    expect(bulkWords([
      { ok: true, outcome: "ESCALATED" }, { ok: true, outcome: "ESCALATED" }, { ok: true, outcome: "DEESCALATED" }, { ok: false },
    ])).toBe("2 escalated, 1 de-escalated, 1 failed");
    expect(bulkWords([])).toBe("Nothing decided");
  });
});

describe("alerts over time", () => {
  const NOW = Date.parse("2026-10-13T09:00:00Z");
  const history = [
    { orgId: "a", kind: "fuel", day: "2026-10-11", n: 2 },
    { orgId: "a", kind: "speeding", day: "2026-10-11", n: 1 },
    { orgId: "b", kind: "speeding", day: "2026-10-13", n: 4 },
  ];

  it("counts camera alarms on their own line", () => {
    const withCamera = [...history, { orgId: "b", kind: "camera", day: "2026-10-13", n: 7 }];
    expect(alertTrend(withCamera, {}, NOW).points.at(-1)).toEqual(
      { start: "2026-10-13", words: "13 Oct", fuel: 0, speeding: 4, camera: 7 });
  });

  it("runs from the first alert to today, empty days at 0, both kinds apart", () => {
    expect(alertTrend(history, {}, NOW)).toEqual({
      unit: "day",
      points: [
        { start: "2026-10-11", words: "11 Oct", fuel: 2, speeding: 1, camera: 0 },
        { start: "2026-10-12", words: "12 Oct", fuel: 0, speeding: 0, camera: 0 },
        { start: "2026-10-13", words: "13 Oct", fuel: 0, speeding: 4, camera: 0 },
      ],
    });
  });

  it("follows the organisation filter", () => {
    expect(alertTrend(history, { orgs: ["b"] }, NOW).points).toEqual([
      { start: "2026-10-13", words: "13 Oct", fuel: 0, speeding: 4, camera: 0 },
    ]);
  });

  it("groups a long history by week, then by month", () => {
    expect(trendUnit("2026-08-01", "2026-10-13")).toBe("week");
    expect(trendUnit("2024-01-01", "2026-10-13")).toBe("month");
    const weeks = alertTrend([{ orgId: "a", kind: "fuel", day: "2026-08-05", n: 3 }, { orgId: "a", kind: "fuel", day: "2026-08-09", n: 1 }], {}, NOW);
    expect(weeks.unit).toBe("week");
    expect(weeks.points[0]).toEqual({ start: "2026-08-03", words: "Week of 3 Aug", fuel: 4, speeding: 0, camera: 0 });
    expect(weeks.points.at(-1).start).toBe("2026-10-12");
    const months = alertTrend([{ orgId: "a", kind: "speeding", day: "2024-06-30", n: 2 }], {}, NOW);
    expect(months.points.slice(0, 2).map((p) => [p.words, p.speeding])).toEqual([["Jun 2024", 2], ["Jul 2024", 0]]);
  });

  it("waits for the history", () => {
    expect(alertTrend(null)).toBeNull();
    expect(alertTrend([], {}, NOW).points).toHaveLength(1);
  });
});

describe("reportedLate", () => {
  it("names when an alert was reported, when that was well after it began", () => {
    expect(reportedLate({ at: "2026-10-12T18:00:00Z", arrivedAt: "2026-10-13T01:30:00Z" })).toBe("reported 13 Oct 04:30");
    expect(reportedLate({ at: "2026-10-13T01:00:00Z", arrivedAt: "2026-10-13T01:30:00Z" })).toBe("reported 04:30");
  });

  it("says nothing when it was reported within minutes, or the time is missing", () => {
    expect(reportedLate({ at: "2026-10-13T01:00:00Z", arrivedAt: "2026-10-13T01:05:00Z" })).toBeNull();
    expect(reportedLate({ at: "2026-10-13T01:00:00Z" })).toBeNull();
  });
});

describe("camera alarms", () => {
  const alarm = (over = {}) => ({
    kind: "camera", status: "open", decision: null, cleared: null,
    camera: { label: "No Seatbelt", severity: "critical", speedKmh: 60, clips: { roadFacing: null, driverFacing: "x.mp4" } },
    ...over,
  });

  it("names the alarm and the speed it happened at", () => {
    expect(headline(alarm())).toEqual({ figure: "No Seatbelt", words: "at 60 km/h" });
    expect(headline(alarm({ camera: { label: "Phone Use", speedKmh: null } }))).toEqual({ figure: "Phone Use", words: "" });
  });

  it("has no number for the bar", () => {
    expect(figureOf(alarm())).toBeNull();
    expect(figureOf({ kind: "speeding", speeding: { overByKmh: 12 } })).toBe(12);
  });

  it("is confirmed or a false alarm", () => {
    expect(statusOf(alarm({ status: "escalated" })).meaning).toBe("confirmed alarm");
    expect(statusOf(alarm({ status: "deescalated" })).meaning).toBe("a false alarm");
    expect(decisionWords("camera", { outcome: "ESCALATED" })).toBe("Escalated as a confirmed alarm");
    expect(decisionWords("camera", { outcome: "DEESCALATED" })).toBe("De-escalated as a false alarm");
    expect(choiceWords("camera", { outcome: "DEESCALATED" }).label).toBe("False alarm");
    expect(kindOf("camera")).toMatchObject({ tag: "Camera", icon: "ti-video", title: "Camera alarm" });
  });
});
