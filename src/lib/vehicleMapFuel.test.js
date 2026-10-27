/**
 * CRITICAL said 14 while the fuel alerts said 1 (27 Sep evening).
 *
 * The server still sent FUEL RATE and FUEL DOWN findings as a unit's open
 * incident; every one of them turned the unit red, counted it CRITICAL and put
 * "Fuel Theft Alert" on its card, while the alerts list, which is theft-only,
 * left them out. A unit carries an incident only when it is a theft case.
 */

import { describe, it, expect } from "vitest";
import { mapSnapshotVehicle, matchesFilter } from "./vehicleMap";

const row = (fuelIncident) => mapSnapshotVehicle({
  vehicleId: "v1", plate: "KTCC 206P", lat: -0.5, lng: 34.5,
  speedKmh: 14, engineOn: true, connectionOnline: true,
  capturedAt: new Date().toISOString(), movement: { state: "moving" },
  zones: { inside: [] }, fuelIncident,
});

describe("the open fuel incident on a unit", () => {
  it("makes a possible theft red and critical", () => {
    const v = row({ id: "inc-1", mayUseTheftWording: true, confidence: 0.85 });
    expect(v.status).toBe("theft");
    expect(v.fuelIncident.id).toBe("inc-1");
    expect(matchesFilter(v, "critical")).toBe(true);
  });

  it("drops a FUEL DOWN finding, which belongs in the daily summary", () => {
    const v = row({ id: "inc-2", mayUseTheftWording: false, cause: "UNEXPLAINED_BURN", reason: "drop-exceeds-distance" });
    expect(v.fuelIncident).toBeNull();
    expect(v.status).not.toBe("theft");
    expect(matchesFilter(v, "critical")).toBe(false);
  });

  it("drops one that does not say either way", () => {
    expect(row({ id: "inc-3" }).fuelIncident).toBeNull();
  });
});
