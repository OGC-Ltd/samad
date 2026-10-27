import { describe, it, expect } from "vitest";
import { fixAgeMs, fixAgeLabel, fixRecencyTier, LIVE_WITHIN_MS } from "./fixRecency";
import { DARK_AFTER_MS } from "./vehicleMap";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const agedBy = (ms) => ({ capturedAtMs: NOW - ms });

describe("fixAgeMs", () => {
  it("is null when the unit carries no timestamp", () => {
    expect(fixAgeMs({}, NOW)).toBeNull();
    expect(fixAgeMs({ capturedAt: "not a date" }, NOW)).toBeNull();
  });
  it("reads the ISO field when the numeric one is absent", () => {
    expect(fixAgeMs({ capturedAt: "2026-09-09T11:30:00Z" }, NOW)).toBe(30 * 60_000);
  });
  it("clamps a future fix to zero, that is a clock disagreement, not a fresh fix", () => {
    expect(fixAgeMs(agedBy(-60_000), NOW)).toBe(0);
  });
});

describe("fixRecencyTier", () => {
  it("is live inside the 15-minute window", () => {
    expect(fixRecencyTier(agedBy(0), NOW)).toBe("live");
    expect(fixRecencyTier(agedBy(LIVE_WITHIN_MS - 1), NOW)).toBe("live");
  });
  it("is delayed from there to the dark line", () => {
    expect(fixRecencyTier(agedBy(LIVE_WITHIN_MS), NOW)).toBe("delayed");
    expect(fixRecencyTier(agedBy(DARK_AFTER_MS - 1), NOW)).toBe("delayed");
  });
  it("is dark at the line the map already uses", () => {
    expect(fixRecencyTier(agedBy(DARK_AFTER_MS), NOW)).toBe("dark");
  });
  it("is unknown with no timestamp, not dark, which would be a claim", () => {
    expect(fixRecencyTier({}, NOW)).toBe("unknown");
  });
});

describe("fixAgeLabel", () => {
  it("says now under a minute", () => {
    expect(fixAgeLabel(agedBy(0), NOW)).toBe("now");
    expect(fixAgeLabel(agedBy(59_000), NOW)).toBe("now");
  });
  it("rounds DOWN, so it never overstates the wait", () => {
    expect(fixAgeLabel(agedBy(119_000), NOW)).toBe("1m");
    expect(fixAgeLabel(agedBy(59 * 60_000 + 59_000), NOW)).toBe("59m");
  });
  it("steps to hours, then days, then years", () => {
    expect(fixAgeLabel(agedBy(60 * 60_000), NOW)).toBe("1h");
    expect(fixAgeLabel(agedBy(47 * 3_600_000), NOW)).toBe("47h");
    expect(fixAgeLabel(agedBy(48 * 3_600_000), NOW)).toBe("2d");
    expect(fixAgeLabel(agedBy(400 * 86_400_000), NOW)).toBe("1y");
  });
  it("is an em dash with nothing to measure", () => {
    expect(fixAgeLabel({}, NOW)).toBe("-");
  });
});
