/**
 * A deleted fuel alert is removed from the UI for good (operator, 2026-09-30):
 * the feed items about the case it opens are hidden, while the Fuel Audit's
 * own items (probe fault and repair) and everything else still show.
 */

import { describe, it, expect } from "vitest";
import { isDeletedCaseItem } from "./fuelFollowUps";

describe("isDeletedCaseItem", () => {
  it("hides a deleted alert's case items, live or read back from history", () => {
    expect(isDeletedCaseItem({ alertType: "FUEL_FOLLOWUP_OPENED" })).toBe(true);
    expect(isDeletedCaseItem({ alertType: "FUEL_FOLLOWUP_ASSIGNED" })).toBe(true);
    expect(isDeletedCaseItem({ id: "fu-abc-opened" })).toBe(true);
    expect(isDeletedCaseItem({ id: "fu-abc-declined-1727700000000" })).toBe(true);
  });

  it("keeps the Fuel Audit's items", () => {
    expect(isDeletedCaseItem({ alertType: "FUEL_FOLLOWUP_PROBE_FAULT" })).toBe(false);
    expect(isDeletedCaseItem({ id: "fu-abc-repair_raised" })).toBe(false);
    expect(isDeletedCaseItem({ id: "fu-abc-probe_fixed" })).toBe(false);
  });

  it("keeps everything that is not a case item", () => {
    expect(isDeletedCaseItem({ id: "n-1", alertType: "FUEL_THEFT", text: "Fuel drop" })).toBe(false);
    expect(isDeletedCaseItem({ id: "fuel-opened" })).toBe(false);
    expect(isDeletedCaseItem(null)).toBe(false);
  });
});
