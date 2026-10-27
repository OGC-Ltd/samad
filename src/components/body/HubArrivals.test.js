import { describe, it, expect } from "vitest";
import { offeredClasses, offeredClass } from "./HubArrivals";

const keys = (list) => list.map(([k]) => k);

describe("offeredClasses", () => {
  it("lists trucks, cars, tractors and plant apart", () => {
    // Sukari 2026-10-20: FactorySuite's company vehicles split into cars, buses and machines.
    expect(keys(offeredClasses({ TRACTOR: 481, TRUCK: 75, CAR: 28, PLANT: 10, VEHICLE: 103 })))
      .toEqual(["TRUCK", "CAR", "TRACTOR", "PLANT"]);
    expect(keys(offeredClasses({ TRACTOR: 120, TRUCK: 60, CAR: 9, PLANT: 0, VEHICLE: 69 })))
      .toEqual(["TRUCK", "CAR", "TRACTOR"]);
  });
  it("always offers Trucks, and drops a class with no units", () => {
    expect(keys(offeredClasses({ TRACTOR: 0, TRUCK: 0, CAR: 0, PLANT: 0 }))).toEqual(["TRUCK"]);
    expect(keys(offeredClasses({ TRACTOR: 0, TRUCK: 4, CAR: 0, PLANT: 0 }))).toEqual(["TRUCK"]);
  });
  it("offers trucks, cars and tractors when the server sends no counts", () => {
    expect(keys(offeredClasses(undefined))).toEqual(["TRUCK", "CAR", "TRACTOR"]);
  });
});

describe("offeredClass", () => {
  it("falls back to Trucks when the remembered class is not on offer", () => {
    const menengai = offeredClasses({ TRACTOR: 120, TRUCK: 60, CAR: 9, PLANT: 0 });
    expect(offeredClass("PLANT", menengai)).toBe("TRUCK");
    expect(offeredClass("VEHICLE", menengai)).toBe("TRUCK");
    expect(offeredClass("CAR", menengai)).toBe("CAR");
    expect(offeredClass("TRACTOR", menengai)).toBe("TRACTOR");
  });
});
