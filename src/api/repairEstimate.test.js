/**
 * The technician's estimate of when a unit comes back, and the one question it
 * exists to answer: has this job gone quiet?
 *
 * A list of open repairs sorted by when they were filed tells nobody anything
 * — the count is on the tab. What somebody arrives at the Repairs tab to find
 * out is which part was expected last Tuesday and has not turned up, and only
 * this date can say. Everything below is a variation on getting that answer
 * right, or refusing to give one.
 *
 * ## Every case here is UTC, on purpose
 *
 * The column is a Postgres DATE and arrives as an instant at midnight UTC.
 * Reading it with the browser's calendar puts a reader west of UTC a day
 * behind, and a date field that reports the previous day for some of its
 * readers is worse than no date at all. `now` is injected throughout so these
 * assertions do not quietly change meaning tomorrow.
 */

import { describe, it, expect } from "vitest";
import {
  dayOf, utcTodayISO, daysUntil, estimateState, escalationOf, escalationPhrase,
} from "./repairs";

/** A fixed "now" well inside a month, so ±N never crosses a year boundary. */
const NOW = Date.parse("2026-09-16T11:30:00.000Z");

/** The stored shape: midnight UTC on a given day. */
const stored = (day) => `${day}T00:00:00.000Z`;

describe("reading the day without asking the browser", () => {
  it("takes the day straight out of the ISO text", () => {
    expect(dayOf(stored("2026-09-25"))).toBe("2026-09-25");
  });

  /*
   * The load-bearing one. Midnight UTC on the 25th is the 24th at 21:00 in New
   * York, so anything routed through `new Date(...).getDate()` reports the
   * 24th there. Nothing in here may consult a local calendar.
   */
  it("does not shift the day for a reader west of UTC", () => {
    // Whatever timezone this suite happens to run in, the answer is the same.
    expect(dayOf("2026-09-25T00:00:00.000Z")).toBe("2026-09-25");
    expect(dayOf("2026-01-01T00:00:00.000Z")).toBe("2026-01-01");
  });

  it("answers nothing for nothing, rather than inventing a date", () => {
    expect(dayOf(null)).toBeNull();
    expect(dayOf(undefined)).toBeNull();
    expect(dayOf("")).toBeNull();
    expect(dayOf("next Tuesday")).toBeNull();
  });

  it("reports today in the same frame the stored day is in", () => {
    expect(utcTodayISO(NOW)).toBe("2026-09-16");
  });
});

describe("how many days off it is", () => {
  it("counts forward", () => {
    expect(daysUntil(stored("2026-09-25"), NOW)).toBe(9);
  });

  it("counts backward once it has passed", () => {
    expect(daysUntil(stored("2026-09-10"), NOW)).toBe(-6);
  });

  it("is zero on the day itself, regardless of the hour", () => {
    // 11:30 UTC on the 16th against midnight UTC on the 16th is still today.
    expect(daysUntil(stored("2026-09-16"), NOW)).toBe(0);
  });

  it("has nothing to say about a job with no date", () => {
    expect(daysUntil(null, NOW)).toBeNull();
  });
});

describe("what the Repairs tab prints", () => {
  const open = (day) => ({ expectedResolutionAt: day ? stored(day) : null, resolvedAt: null });

  it("says nothing at all for a job that never named a date", () => {
    const e = estimateState(open(null), NOW);
    expect(e.text).toBe("-");
    expect(e.overdue).toBe(false);
  });

  it("counts down while there is still time", () => {
    const e = estimateState(open("2026-09-25"), NOW);
    expect(e.text).toBe("2026-09-25 · in 9 days");
    expect(e.overdue).toBe(false);
    expect(e.tone).toBe("ok");
  });

  it("warns on the day and the day before, which is when somebody should ring", () => {
    expect(estimateState(open("2026-09-16"), NOW).text).toBe("2026-09-16 · today");
    expect(estimateState(open("2026-09-17"), NOW).text).toBe("2026-09-17 · tomorrow");
    expect(estimateState(open("2026-09-16"), NOW).tone).toBe("warn");
    // Neither is overdue: a part due today has all day to arrive.
    expect(estimateState(open("2026-09-16"), NOW).overdue).toBe(false);
  });

  it("says how far over it has run, because that is the number that gets it chased", () => {
    const e = estimateState(open("2026-09-10"), NOW);
    expect(e.text).toBe("2026-09-10 · 6 days over");
    expect(e.overdue).toBe(true);
    expect(e.tone).toBe("inc");
  });

  it("gets the singular right one day over", () => {
    expect(estimateState(open("2026-09-15"), NOW).text).toBe("2026-09-15 · 1 day over");
  });

  /*
   * The one that stops the tab crying wolf. A signed-off job's estimate is
   * history — the part arrived, somebody closed it — and painting it red
   * afterwards flags work that is finished, which is how a colour people are
   * meant to act on stops being one.
   */
  it("never calls a job overdue after it has been signed off", () => {
    const closed = {
      expectedResolutionAt: stored("2026-09-10"),
      resolvedAt: "2026-09-12T08:00:00.000Z",
    };
    const e = estimateState(closed, NOW);
    expect(e.overdue).toBe(false);
    expect(e.tone).toBe("none");
    // The date is still shown — it is the record of what was expected.
    expect(e.text).toBe("2026-09-10");
  });

  it("survives a row that is missing entirely", () => {
    expect(estimateState(null, NOW).text).toBe("-");
    expect(estimateState(undefined, NOW).overdue).toBe(false);
  });
});

/* ── The escalation the server's sweep records ─────────────────────────────
   It lands on the job's TRAIL rather than in the stage column — escalating a
   job does not stop the repair — which means this screen only shows it if
   something reads for it. These pin the reading, because an escalation nobody
   can see on the board is the exact failure the sweep exists to prevent. */
describe("escalationOf", () => {
  const stage = (at) => ({ stage: "spare_outsourced", at, by: "u1" });
  const esc = (level, reason, days, at) =>
    ({ kind: "escalation", level, reason, days, at });

  it("is null for a job that has never been raised", () => {
    expect(escalationOf({ stageHistory: [stage("2026-09-10T08:00:00Z")] })).toBeNull();
    expect(escalationOf({ stageHistory: [] })).toBeNull();
    expect(escalationOf({})).toBeNull();
  });

  it("survives a trail that is not a list", () => {
    expect(escalationOf({ stageHistory: null })).toBeNull();
    expect(escalationOf({ stageHistory: "corrupted" })).toBeNull();
  });

  it("reports the LATEST escalation, not the first", () => {
    const item = { stageHistory: [
      esc(1, "stalled", 3, "2026-09-12T05:05:00Z"),
      stage("2026-09-13T09:00:00Z"),
      esc(2, "overdue", 6, "2026-09-15T05:05:00Z"),
    ] };
    const e = escalationOf(item);
    expect(e.level).toBe(2);
    expect(e.reason).toBe("overdue");
    expect(e.days).toBe(6);
    expect(e.at).toBe("2026-09-15T05:05:00Z");
  });

  it("falls back rather than rendering NaN when the entry is half-written", () => {
    const e = escalationOf({ stageHistory: [{ kind: "escalation" }] });
    expect(e.level).toBe(1);
    expect(e.days).toBe(0);
    expect(e.reason).toBe("stalled");
  });

  it("says why, in the same words the server used", () => {
    expect(escalationPhrase(escalationOf({ stageHistory: [esc(1, "overdue", 3, "x")] })))
      .toBe("3 days past the expected date");
    expect(escalationPhrase(escalationOf({ stageHistory: [esc(1, "stalled", 1, "x")] })))
      .toBe("no movement for 1 day");
    expect(escalationPhrase(null)).toBe("");
  });
});
