import { describe, it, expect } from "vitest";
import { createFrameStore } from "./positionDelta";

describe("createFrameStore", () => {
  it("rebuilds the full frame from a delta on top of the replayed one", () => {
    const s = createFrameStore();
    s.full({ vehicleId: "v1", plate: "KXX 1", lat: 1, lng: 1, cargoWeightKg: 900, movement: { s: "moving" } });
    const f = s.apply({ vehicleId: "v1", lat: 2, movement: { s: "resting" }, $del: ["cargoWeightKg"] });
    expect(f).toEqual({ vehicleId: "v1", plate: "KXX 1", lat: 2, lng: 1, movement: { s: "resting" } });
    expect("cargoWeightKg" in f).toBe(false);
    // …and the next delta builds on the rebuilt frame.
    expect(s.apply({ vehicleId: "v1", lng: 5 })).toMatchObject({ lat: 2, lng: 5, plate: "KXX 1" });
  });

  it("a vehicle with no base takes the delta as its whole frame", () => {
    const s = createFrameStore();
    expect(s.apply({ vehicleId: "new", plate: "KNEW", lat: 3 })).toEqual({ vehicleId: "new", plate: "KNEW", lat: 3 });
  });

  it("a fresh full frame (reconnect replay) replaces the base", () => {
    const s = createFrameStore();
    s.full({ vehicleId: "v1", lat: 1, extra: true });
    s.full({ vehicleId: "v1", lat: 7 });
    expect(s.apply({ vehicleId: "v1", lng: 2 })).toEqual({ vehicleId: "v1", lat: 7, lng: 2 });
  });

  it("does not mutate a frame it already returned", () => {
    const s = createFrameStore();
    const a = s.full({ vehicleId: "v1", lat: 1 });
    s.apply({ vehicleId: "v1", lat: 2 });
    expect(a.lat).toBe(1);
  });
});
