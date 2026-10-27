import { describe, it, expect } from "vitest";
import { fleetDayOf, fleetDayBounds, dayBreakdown, dayAssessment, engineBasisLabel, eventLabel, hoursLabel, isTheftEvent, unexplainedMatters } from "./fuelDay";

describe("fleet days", () => {
  it("puts 01:23 EAT on its own Kenyan day, not the UTC one before", () => {
    expect(fleetDayOf("2026-09-24T22:23:06.000Z")).toBe("2026-09-25");
    expect(fleetDayBounds("2026-09-25")).toEqual({
      from: "2026-09-24T21:00:00.000Z", to: "2026-09-25T21:00:00.000Z",
    });
  });
});

// MUFINDI - DZ 20 on 2026-09-25, as served.
const tank = {
  initialMl: 298222, currentMl: 240000, engineBurnMl: 54978,
  engineSeconds: 7879, engineRateLPerHour: 25.12, distanceM: 675,
};
const drops = [
  { id: "d4", beganAt: "2026-09-24T22:23:06Z", stolenMl: 34930, verdict: "DRAIN", drainCause: "UNEXPLAINED_BURN", recoveredMl: 34201 },
  { id: "d2", beganAt: "2026-09-24T21:43:00Z", stolenMl: 26750, verdict: "REDISTRIBUTION", recoveredMl: 49398 },
  { id: "d1", beganAt: "2026-09-24T21:28:00Z", stolenMl: 23330, verdict: "DRAIN", drainCause: "HIGH_BURN", recoveredMl: 0 },
];

describe("dayBreakdown", () => {
  it("balances the tank: opening + refuelled − closing is what was used", () => {
    const b = dayBreakdown({ tank, drops });
    expect(b.opening).toBeCloseTo(298.222, 3);
    expect(b.closing).toBe(240);
    expect(b.used).toBeCloseTo(58.222, 3);
    expect(b.engine).toBeCloseTo(54.978, 3);
    expect(b.unexplained).toBeCloseTo(3.244, 3);
    expect(b.engineHours).toBeCloseTo(2.19, 2);
    expect(b.distanceKm).toBeCloseTo(0.675, 3);
  });

  it("counts a refuel only when the fuel arrived", () => {
    const fillings = [
      { id: "f1", filledAt: "2026-09-25T05:00:00Z", filledMl: 100000, verdict: "REFILL" },
      { id: "f2", filledAt: "2026-09-25T06:00:00Z", filledMl: 40000, verdict: "REDISTRIBUTION" },
    ];
    const b = dayBreakdown({ tank, fillings });
    expect(b.refuelled).toBe(100);
    expect(b.refuelCount).toBe(1);
    expect(b.used).toBeCloseTo(158.222, 3);
    // Both are still listed: the reported-but-not-arrived one is an event too.
    expect(b.events.map((e) => e.id)).toEqual(["f1", "f2"]);
  });

  it("lists the events in time order, refuels and drops together", () => {
    const b = dayBreakdown({ tank, drops, fillings: [{ id: "f", filledAt: "2026-09-24T21:35:00Z", filledMl: 1000, verdict: "REFILL" }] });
    expect(b.events.map((e) => e.id)).toEqual(["d1", "f", "d2", "d4"]);
  });

  it("leaves a figure blank rather than guessing an end", () => {
    const b = dayBreakdown({ tank: { ...tank, currentMl: null } });
    expect(b.used).toBeNull();
    expect(b.unexplained).toBeNull();
    expect(dayBreakdown({ tank: null }).opening).toBeNull();
  });
});

describe("eventLabel", () => {
  it("says what the level did, and theft only as a possible theft", () => {
    expect(eventLabel({ type: "drop", verdict: "REDISTRIBUTION" })).toBe("Level dipped and came back");
    expect(eventLabel({ type: "drop", verdict: "DRAIN", cause: "HIGH_BURN" })).toBe("Burn above normal");
    expect(eventLabel({ type: "drop", verdict: "DRAIN", cause: "UNEXPLAINED_BURN" })).not.toMatch(/theft/i);
    expect(eventLabel({ type: "drop", verdict: "DRAIN", cause: "SIPHON" })).toBe("Possible theft");
    expect(eventLabel({ type: "refuel", verdict: "REFILL" })).toBe("Refuelled");
  });
});

describe("isTheftEvent, the only event the window highlights", () => {
  it("is a drop that stayed down and was called a possible theft", () => {
    expect(isTheftEvent({ type: "drop", verdict: "DRAIN", cause: "SIPHON" })).toBe(true);
    expect(isTheftEvent({ type: "drop", verdict: "DRAIN", cause: "UNEXPLAINED_BURN" })).toBe(false);
    expect(isTheftEvent({ type: "drop", verdict: "REDISTRIBUTION", cause: "SIPHON" })).toBe(false);
    expect(isTheftEvent({ type: "refuel", verdict: "REFILL" })).toBe(false);
  });
});

describe("unexplainedMatters", () => {
  it("ignores a few litres of disagreement and flags a real gap", () => {
    expect(unexplainedMatters({ unexplained: 3.2, engine: 55 })).toBe(false);
    expect(unexplainedMatters({ unexplained: 12, engine: 55 })).toBe(true);
    expect(unexplainedMatters({ unexplained: 8, engine: 120 })).toBe(false);
  });
});

describe("dayAssessment, the day read for the case, not left as 'not explained'", () => {
  // MUFINDI - CTR 07, 27 Sep 2026: parked all day, engine never on, 21.3 L
  // drawn off at 08:11 (680.8 L → 659.6 L), the day opening at 691.7 L.
  const THEFT = { id: "ctr07", type: "drop", at: "2026-09-27T05:11:00Z", litres: 21.3, verdict: "DRAIN", cause: "SIPHON" };
  const ctr07 = {
    opening: 691.7, refuelled: 0, refuelCount: 0, closing: 659.6, used: 32.1,
    engine: 0, engineHours: 0, engineRate: 3.4, unexplained: 32.1, distanceKm: null, events: [THEFT],
  };
  const incident = {
    id: "ctr07", beganAt: "2026-09-27T05:11:00Z", tankBeforeMl: 680_800, tankAfterMl: 659_600, mayUseTheftWording: true,
  };

  it("says nothing burned it, what the theft took, and where the rest went", () => {
    expect(dayAssessment(ctr07, incident, true)).toEqual([
      "The engine did not run today, so none of the 32.1 L the tank lost was burned.",
      "21.3 L of it is this possible theft at 08:11 (680.8 L → 659.6 L).",
      "The other 10.8 L went before 08:11, with no event of its own: the tank read 691.7 L at the start of the day and 680.8 L when the theft began, a fall too gradual to be reported on its own.",
      "Nothing has gone since.",
    ]);
  });

  it("says when the rest went after the case instead", () => {
    const later = { ...ctr07, opening: 680.8, closing: 648.8, used: 32.0 };
    expect(dayAssessment(later, incident, false)[2])
      .toBe("The other 10.7 L went after 08:11, with no event of its own: 659.6 L then, 648.8 L at the end of the day.");
  });

  it("clears a working day the engine accounts for (EX 10, 27 Sep)", () => {
    const ex10 = {
      opening: 172.0, refuelled: 192.8, refuelCount: 1, closing: 265.7, used: 99.1,
      engine: 145.1, engineHours: 12 + 59 / 60, engineRate: 11.2, events: [
        { id: "r", type: "refuel", at: "2026-09-27T02:58:00Z", litres: 192.8, verdict: "REFILL" },
        { id: "b", type: "drop", at: "2026-09-27T05:52:00Z", litres: 11.2, verdict: "DRAIN", cause: "UNEXPLAINED_BURN" },
      ],
    };
    expect(dayAssessment(ex10, null, true)).toEqual([
      "The engine ran 12 h 59 min at its usual 11.2 L/h, which burns 145.1 L, enough to cover all of the 99.1 L the tank lost.",
      "That is 46.0 L under its usual rate for those hours, so nothing is missing.",
    ]);
  });

  it("says so when the tank's loss matches the engine hours", () => {
    const fine = { opening: 200, refuelled: 0, closing: 150, used: 50, engine: 48, engineHours: 4, engineRate: 12, events: [] };
    expect(dayAssessment(fine)).toEqual([
      "The engine ran 4 h 00 min at its usual 12.0 L/h, which burns 48.0 L of the 50.0 L the tank lost.",
      "The rest matches the engine hours: nothing is missing.",
    ]);
  });

  it("says nothing without a tank ledger, and admits a day with no engine record", () => {
    expect(dayAssessment({ used: null, events: [] })).toEqual([]);
    expect(dayAssessment({ used: 20, engine: null, engineHours: null, events: [] })[0])
      .toBe("There is no engine-hour record for that day, so the 20.0 L the tank lost cannot be set against a burn.");
    expect(hoursLabel(0.5)).toBe("30 min");
  });
});

describe("the register's standard rate", () => {
  const day = (tank) => dayBreakdown({ tank: { initialMl: 160_000, currentMl: 120_000, ...tank } });

  it("names an hourly register rate as the standard one", () => {
    const b = day({ engineSeconds: 3600, engineBurnMl: 14_000, engineRateLPerHour: 14, engineRateBasis: "register" });
    expect(engineBasisLabel(b)).toBe("1 h 00 min at 14.0 L/h");
    expect(dayAssessment(b)[0]).toBe("The engine ran 1 h 00 min at its standard 14.0 L/h, which burns 14.0 L of the 40.0 L the tank lost.");
  });

  it("states a road vehicle's expectation as distance at km/L", () => {
    const b = day({
      engineSeconds: 7200, distanceM: 38_000, engineBurnMl: 14_615,
      engineRateLPerHour: null, engineRateKmPerL: 2.6, engineRateBasis: "register",
    });
    expect(engineBasisLabel(b)).toBe("38.0 km at 2.6 km/L");
    expect(dayAssessment(b)[0]).toBe("It covered 38.0 km at its standard 2.6 km/L, which burns 14.6 L of the 40.0 L the tank lost.");
  });

  it("keeps 'usual' for a derived rate", () => {
    const b = day({ engineSeconds: 3600, engineBurnMl: 9_100, engineRateLPerHour: 9.1, engineRateBasis: "vehicle" });
    expect(dayAssessment(b)[0]).toContain("at its usual 9.1 L/h");
  });
});
