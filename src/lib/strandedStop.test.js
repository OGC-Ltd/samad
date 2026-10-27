/* Units that were in transit and have stopped where nobody expected them to.
 *
 * The thing worth pinning here is what the predicate REFUSES to flag, because
 * that is the whole design. On a 597-unit fleet the great majority of machines
 * are parked in a yard and have been since before the server booted, and a
 * "stationary for ten minutes" rule that took them at face value would produce
 * a list of five hundred rows nobody could use. Three rungs exist purely to
 * keep them out — offline, stale fix, and movement.exact — and each has a test
 * below named after the case it exists for.
 *
 * The second is that the clock is a PARAMETER. This is the only predicate in
 * vehicleMap whose answer changes with no new telemetry, so it must never read
 * Date.now() itself; the last test pins that by running under a system clock
 * set years away from the nowMs it is handed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { strandedStop, isStrandedStop, STRANDED_STOP_MS } from "./vehicleMap";

const NOW = Date.parse("2026-09-07T09:00:00Z");
const agoMs = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

/**
 * A unit that stopped `stoppedMinsAgo` minutes ago, reporting normally.
 * Overrides are shallow-merged so each test names only what it is about.
 */
const unit = (stoppedMinsAgo, over = {}) => ({
  id: "KDE 581S",
  online: true,
  engine: "off",
  speed: 0,
  capturedAtMs: NOW - 30_000,
  movement: { state: "resting", moving: false, since: agoMs(stoppedMinsAgo * MIN), exact: true },
  zones: { inside: [], breach: false, known: true },
  ...over,
});

afterEach(() => { vi.useRealTimers(); });

describe("strandedStop, what it refuses to flag", () => {
  it("does not flag a unit that has simply gone dark", () => {
    // A lost tracker is a different story with a different action. Folding the
    // two together buries the handful of stranded machines under every unit
    // whose box has gone quiet.
    expect(strandedStop(unit(240, { online: false }), NOW)).toBeNull();
  });

  it("does not flag a unit whose last fix is older than the stale bound", () => {
    // `online` is the provider's verdict and can lag its own data.
    expect(strandedStop(unit(240, { capturedAtMs: NOW - 45 * MIN }), NOW)).toBeNull();
  });

  it("does not flag a unit we never saw start moving", () => {
    // exact:false means the server was already watching a stopped unit when it
    // started — there is no evidence this machine was ever in transit. This is
    // the rung that keeps the yard off the list.
    const yardMachine = unit(360, { movement: { state: "resting", moving: false, since: agoMs(360 * MIN), exact: false } });
    expect(strandedStop(yardMachine, NOW)).toBeNull();
  });

  it("does not flag a unit that is still moving", () => {
    const rolling = unit(240, {
      engine: "on",
      speed: 42,
      movement: { state: "moving", moving: true, since: agoMs(240 * MIN), exact: true },
    });
    expect(strandedStop(rolling, NOW)).toBeNull();
  });

  it("does not flag a stop that has not yet reached the threshold", () => {
    expect(strandedStop(unit(9), NOW)).toBeNull();
  });

  it("does not flag a unit with no movement data at all", () => {
    expect(strandedStop(unit(30, { movement: null }), NOW)).toBeNull();
  });

  it("does not flag on an unparseable stop time", () => {
    const noSince = unit(30, { movement: { state: "resting", moving: false, since: null, exact: true } });
    expect(strandedStop(noSince, NOW)).toBeNull();
  });
});

describe("strandedStop, what it flags", () => {
  it("flags a unit stopped for longer than the threshold", () => {
    const why = strandedStop(unit(11), NOW);
    expect(why).not.toBeNull();
    expect(why.forMs).toBe(11 * MIN);
    expect(why.state).toBe("resting");
    // No containment test supplied, so containment was not decided.
    expect(why.zonesKnown).toBe(false);
  });

  it("flags at the threshold exactly", () => {
    expect(strandedStop(unit(10), NOW)?.forMs).toBe(STRANDED_STOP_MS);
  });

  it("flags a unit idling, engine on, going nowhere is the case with an action", () => {
    const idling = unit(20, {
      engine: "on",
      movement: { state: "idling", moving: false, since: agoMs(20 * MIN), exact: true },
    });
    expect(strandedStop(idling, NOW)?.state).toBe("idling");
  });

  it("flags a unit whose containment could not be evaluated, and says so", () => {
    // Absence of evaluation is not evidence of safety. The list is something a
    // person reads, so a false positive costs a glance where a false negative
    // costs a machine nobody looked for. `zonesKnown: false` is what lets the
    // row say "location unverified" instead of implying we checked.
    expect(strandedStop(unit(20), NOW)?.zonesKnown).toBe(false);                       // no test supplied
    expect(strandedStop(unit(20), NOW, { insideZone: () => null })?.zonesKnown).toBe(false);
  });

  it("says containment WAS decided when the test could answer", () => {
    expect(strandedStop(unit(20), NOW, { insideZone: () => false })?.zonesKnown).toBe(true);
  });

  it("takes its threshold from the caller", () => {
    expect(strandedStop(unit(4), NOW, { minStopMs: 3 * MIN })).not.toBeNull();
    expect(strandedStop(unit(4), NOW)).toBeNull();
  });
});

describe("strandedStop, the zone rung", () => {
  it("does not flag a unit standing inside a known geofence", () => {
    // The whole point: a machine parked in a workshop, a yard or a weighbridge
    // is somewhere the estate knows about, whether that fence came from Wialon
    // or was drawn in our own system.
    expect(strandedStop(unit(45), NOW, { insideZone: () => true })).toBeNull();
  });

  it("flags a unit standing outside every known geofence", () => {
    expect(strandedStop(unit(45), NOW, { insideZone: () => false })).not.toBeNull();
  });

  it("is the LAST rung, a cheaper failure never pays for the geometry", () => {
    // 597 units against 107 fences on every 30-second tick is the difference
    // between this being free and being felt. Only candidates that survive
    // every other rung should reach the point-in-polygon.
    let calls = 0;
    const insideZone = () => { calls += 1; return false; };
    strandedStop(unit(45, { online: false }), NOW, { insideZone });        // offline
    strandedStop(unit(45, { capturedAtMs: NOW - 45 * MIN }), NOW, { insideZone });  // stale
    strandedStop(unit(4), NOW, { insideZone });                            // under threshold
    expect(calls).toBe(0);
    strandedStop(unit(45), NOW, { insideZone });
    expect(calls).toBe(1);
  });

  it("is handed the whole vehicle, so the test can use the server's verdict", () => {
    const v = unit(45);
    let seen = null;
    strandedStop(v, NOW, { insideZone: (x) => { seen = x; return false; } });
    expect(seen).toBe(v);
  });
});

describe("strandedStop, the clock is a parameter", () => {
  it("ignores the system clock entirely", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    // Date.now() is now years past every timestamp in the fixture. If the
    // predicate read it, this stop would measure in years and flag; it reads
    // the nowMs it was handed instead.
    expect(strandedStop(unit(9), NOW)).toBeNull();
    expect(strandedStop(unit(11), NOW)?.forMs).toBe(11 * MIN);
  });

  it("is pure, same inputs, same answer", () => {
    const v = unit(11);
    expect(strandedStop(v, NOW)).toEqual(strandedStop(v, NOW));
  });
});

describe("isStrandedStop", () => {
  it("is the verdict alone", () => {
    expect(isStrandedStop(unit(11), NOW)).toBe(true);
    expect(isStrandedStop(unit(9), NOW)).toBe(false);
    expect(isStrandedStop(unit(11, { online: false }), NOW)).toBe(false);
  });
});
