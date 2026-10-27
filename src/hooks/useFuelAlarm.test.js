import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
const { noteFuelCount, hushFuelAlarm, isFuelAlarmRinging: ringing, resetFuelAlarm } = await import("./useFuelAlarm");

describe("the fuel alarm", () => {
  beforeEach(() => resetFuelAlarm());

  it("rings when the unread fuel count rises, not on the first count ever seen", () => {
    noteFuelCount("u1", 3);
    expect(ringing()).toBe(false);
    noteFuelCount("u1", 3);
    expect(ringing()).toBe(false);
    noteFuelCount("u1", 4);
    expect(ringing()).toBe(true);
  });

  it("stays rung until the Alerts page hushes it", () => {
    noteFuelCount("u1", 1);
    noteFuelCount("u1", 2);
    noteFuelCount("u1", 2);
    expect(ringing()).toBe(true);
    hushFuelAlarm();
    expect(ringing()).toBe(false);
  });

  it("measures the next theft from a count lowered by reading", () => {
    noteFuelCount("u1", 5);
    noteFuelCount("u1", 1); // four read
    expect(ringing()).toBe(false);
    noteFuelCount("u1", 2);
    expect(ringing()).toBe(true);
  });

  it("keeps each account's mark apart", () => {
    noteFuelCount("u1", 5);
    noteFuelCount("u2", 1);
    expect(ringing()).toBe(false);
  });

  it("ignores counts that have not arrived", () => {
    noteFuelCount("u1", undefined);
    noteFuelCount(undefined, 3);
    noteFuelCount("u1", 2);
    expect(ringing()).toBe(false);
  });
});
