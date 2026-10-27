/**
 * The day a person picks is the day on their own clock. Just after midnight in
 * Nairobi (UTC+3) UTC is still on yesterday, and the UTC day made today's
 * date read as "tomorrow" on the quick picks.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../services/api", () => ({ apiFetch: vi.fn(async () => ({ data: { id: "ri1" } })) }));

import { localDayISO, estimateState, setRepairStage, REPAIRS_CHANGED } from "./repairs";

describe("localDayISO", () => {
  it("is the viewer's calendar day, with an offset in days", () => {
    const d = new Date(2026, 9, 1, 0, 30); // 1 Oct 00:30 local
    expect(localDayISO(0, d.getTime())).toBe("2026-10-01");
    expect(localDayISO(1, d.getTime())).toBe("2026-10-02");
    expect(localDayISO(7, d.getTime())).toBe("2026-10-08");
  });

  it("crosses a month end", () => {
    expect(localDayISO(1, new Date(2026, 8, 30, 23, 50).getTime())).toBe("2026-10-01");
  });
});

describe("the fix-date badge", () => {
  it("reads today's fix date as today just after midnight, not tomorrow", () => {
    const justAfterMidnight = new Date(2026, 9, 1, 0, 30).getTime(); // 1 Oct 00:30 local
    const job = { expectedResolutionAt: "2026-10-01T00:00:00.000Z", resolvedAt: null };
    expect(estimateState(job, justAfterMidnight).text).toBe("2026-10-01 · today");
    const tomorrow = { expectedResolutionAt: "2026-10-02T00:00:00.000Z", resolvedAt: null };
    expect(estimateState(tomorrow, justAfterMidnight).text).toBe("2026-10-02 · tomorrow");
  });
});

describe("Repairs and Audit stay in step", () => {
  it("announces every write so both views re-read", async () => {
    // The suite runs without a DOM; an EventTarget is all the event needs.
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const heard = vi.fn();
    target.addEventListener(REPAIRS_CHANGED, heard);
    await setRepairStage({ orgId: "o1", itemId: "ri1", stage: "fixing" });
    vi.unstubAllGlobals();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
