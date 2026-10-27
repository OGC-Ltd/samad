/**
 * "Stopped in transit" filled on load and then emptied seconds later.
 *
 * Nothing moved. The snapshot and the live stream disagree about
 * `movement.exact`, and the merge took the live answer unconditionally.
 *
 * Measured on Mufindi, 61 vehicles compared between /vehicles/snapshot and the
 * live stream: 49 arrive with `exact: true` and a real stop time, then arrive
 * again with `exact: false` and a `since` of minutes ago. None went the other
 * way. `strandedStop` requires `exact === true`, so the list went 28 → 0 on the
 * first frame after load.
 *
 * `exact: false` means "I did not see the transition". It is an absence of
 * evidence, and it must not overwrite evidence.
 */

import { describe, it, expect } from "vitest";
import { applyLiveUpdate, mapSnapshotVehicle, strandedStop } from "./vehicleMap";

/** The real pair, from the measurement: MUFINDI: BH 03. */
const SNAPSHOT_MOVEMENT = { exact: true,  moving: false, since: "2026-08-25T15:34:28.000Z", state: "resting" };
const LIVE_MOVEMENT     = { exact: false, moving: false, since: "2026-09-21T03:42:50.000Z", state: "resting" };

/** A vehicle as the snapshot gives it, stopped long enough to be flagged. */
function snapshotVehicle(movement = SNAPSHOT_MOVEMENT) {
  return mapSnapshotVehicle({
    vehicleId: "v1", name: "MUFINDI: BH 03", plate: "BH 03",
    lat: -8.5, lng: 35.3, speedKmh: 0, engineOn: false,
    connectionOnline: true, capturedAt: new Date().toISOString(),
    movement, zones: { inside: [] },
  });
}

describe("a live frame that saw nothing", () => {
  it("does not overwrite a stop the server actually witnessed", () => {
    const merged = applyLiveUpdate(snapshotVehicle(), {
      vehicleId: "v1", speedKmh: 0, capturedAt: new Date().toISOString(), movement: LIVE_MOVEMENT,
    });
    expect(merged.movement.exact).toBe(true);
    expect(merged.movement.since).toBe(SNAPSHOT_MOVEMENT.since);
  });

  it("keeps the unit on the stranded list across that frame", () => {
    // The symptom itself, end to end: flagged from the snapshot, still flagged
    // after the frame that used to clear it.
    const now = Date.now();
    const before = snapshotVehicle();
    expect(strandedStop(before, now)).not.toBeNull();

    const after = applyLiveUpdate(before, {
      vehicleId: "v1", speedKmh: 0, capturedAt: new Date().toISOString(), movement: LIVE_MOVEMENT,
    });
    expect(strandedStop(after, now)).not.toBeNull();
  });

  it("still takes the state the frame reports", () => {
    // It knows what the machine is doing NOW; it just cannot date the stop.
    const merged = applyLiveUpdate(snapshotVehicle(), {
      vehicleId: "v1", speedKmh: 0, capturedAt: new Date().toISOString(),
      movement: { ...LIVE_MOVEMENT, state: "idling" },
    });
    expect(merged.movement.state).toBe("idling");
    expect(merged.movement.exact).toBe(true);
  });
});

describe("a live frame that did see the transition", () => {
  it("wins outright, so a genuine new stop replaces an old one", () => {
    const fresh = { exact: true, moving: false, since: "2026-09-21T06:00:00.000Z", state: "resting" };
    const merged = applyLiveUpdate(snapshotVehicle(), {
      vehicleId: "v1", speedKmh: 0, capturedAt: new Date().toISOString(), movement: fresh,
    });
    expect(merged.movement.since).toBe(fresh.since);
  });

  it("lets a unit that started moving leave the list", () => {
    // The opposite failure would be worse than the one being fixed: a machine
    // that drove away must not stay flagged as standing still.
    const moving = { exact: true, moving: true, since: new Date().toISOString(), state: "moving" };
    const merged = applyLiveUpdate(snapshotVehicle(), {
      vehicleId: "v1", speedKmh: 40, engineOn: true,
      capturedAt: new Date().toISOString(), movement: moving,
    });
    expect(merged.movement.state).toBe("moving");
    expect(strandedStop(merged, Date.now())).toBeNull();
  });
});

describe("the cases with nothing to choose between", () => {
  it("keeps what it has when the frame carries no movement at all", () => {
    const merged = applyLiveUpdate(snapshotVehicle(), {
      vehicleId: "v1", speedKmh: 0, capturedAt: new Date().toISOString(),
    });
    expect(merged.movement).toEqual(SNAPSHOT_MOVEMENT);
  });

  it("takes the frame's record when we hold nothing", () => {
    const merged = applyLiveUpdate(snapshotVehicle(null), {
      vehicleId: "v1", speedKmh: 0, capturedAt: new Date().toISOString(), movement: LIVE_MOVEMENT,
    });
    expect(merged.movement).toEqual(LIVE_MOVEMENT);
  });

  it("takes the frame's record when ours was inexact too", () => {
    // Two absences of evidence: the newer one is no worse, and keeping the
    // older would freeze a stale `since` forever.
    const weak = { ...SNAPSHOT_MOVEMENT, exact: false };
    const merged = applyLiveUpdate(snapshotVehicle(weak), {
      vehicleId: "v1", speedKmh: 0, capturedAt: new Date().toISOString(), movement: LIVE_MOVEMENT,
    });
    expect(merged.movement.since).toBe(LIVE_MOVEMENT.since);
  });
});
