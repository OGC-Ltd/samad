// The run that prompted these: Naitiri gate → Raiply, 49.9 km of straight line,
// a Menengai truck signed out by West Kenya Sugar's sales office. Every figure
// below is that route unless it says otherwise, so a test failing here names a
// real journey rather than an abstraction.

import { describe, it, expect } from "vitest";
import { liveTrip, tripEta, fmtDuration, roundTripKm, haversineM,
         legLabel, awaitingSignIn, hasDelivered } from "./tripProgress";

const NAITIRI = { lat: 0.78129, lng: 34.87781 };
const RAIPLY  = { lat: 0.53120, lng: 35.25001 };

/** A trip shaped as the server sends it, on the real route. */
const run = (over = {}) => ({
  yardLat: NAITIRI.lat, yardLng: NAITIRI.lng, yardName: "Naitiri",
  destinationLat: RAIPLY.lat, destinationLng: RAIPLY.lng, destination: "RaiPly",
  destinationSpreadM: 400,
  legM: Math.round(haversineM(NAITIRI, RAIPLY)),
  arrivedAt: null,
  ...over,
});

describe("the route itself", () => {
  it("is the ~50 km the operator describes", () => {
    expect(Math.round(haversineM(NAITIRI, RAIPLY) / 100) / 10).toBeCloseTo(49.9, 1);
  });

  it("makes a round trip of twice that", () => {
    expect(roundTripKm(run())).toBeCloseTo(99.7, 1);
  });
});

describe("liveTrip on the Naitiri run", () => {
  it("reads at-yard at the gate, so an unclosed run does not look outbound", () => {
    // This is the bug the origin fix exists for. With no yard the leg fell
    // through to 'outbound' and the server's day filter kept the stale row
    // forever, declaring 29 t on a parked truck.
    const t = liveTrip(run(), NAITIRI.lat, NAITIRI.lng);
    expect(t.leg).toBe("at-yard");
    expect(t.percent).toBe(0);
  });

  it("reads outbound with the gate behind it", () => {
    const t = liveTrip(run(), 0.70, 34.99);
    expect(t.leg).toBe("outbound");
    expect(t.percent).toBeGreaterThan(0);
    expect(t.percent).toBeLessThan(50);
  });

  it("reads at-destination inside Raiply and pins the bar at half", () => {
    const t = liveTrip(run(), RAIPLY.lat, RAIPLY.lng);
    expect(t.leg).toBe("at-destination");
    expect(t.percent).toBe(50);
  });

  it("reads returning once it has been there, even back in the outbound corridor", () => {
    const t = liveTrip(run({ arrivedAt: "2026-09-15T06:00:00Z" }), 0.70, 34.99);
    expect(t.leg).toBe("returning");
    expect(t.percent).toBeGreaterThan(50);
  });

  it("leaves a no-fix run alone however convincing the coordinates are", () => {
    const t = liveTrip(run({ leg: "no-fix" }), RAIPLY.lat, RAIPLY.lng);
    expect(t.leg).toBe("no-fix");
  });

  it("still names the leg when the destination could not be placed", () => {
    const t = liveTrip(
      run({ destinationLat: null, destinationLng: null, legM: null }),
      0.70, 34.99,
    );
    expect(t.leg).toBe("outbound");
    expect(t.percent).toBeNull();      // no denominator, so no number
  });
});

describe("tripEta", () => {
  const AT = Date.UTC(2026, 8, 15, 6, 0, 0);

  it("counts down to the destination while outbound", () => {
    const t = liveTrip(run(), 0.70, 34.99);
    const eta = tripEta(t, 60, AT);
    expect(eta.towards).toBe("destination");
    expect(eta.remainingKm).toBeCloseTo(t.toDestinationM / 1000, 1);
    expect(eta.minutes).toBe(Math.round((t.toDestinationM / 1000) / 60 * 60));
    expect(eta.etaMs).toBe(AT + eta.minutes * 60_000);
  });

  it("counts down to the YARD while returning, the driver is going home", () => {
    const t = liveTrip(run({ arrivedAt: "2026-09-15T06:00:00Z" }), 0.70, 34.99);
    const eta = tripEta(t, 60, AT);
    expect(eta.towards).toBe("yard");
    expect(eta.remainingKm).toBeCloseTo(t.fromYardM / 1000, 1);
  });

  it("halves the wait when the truck doubles its speed", () => {
    const t = liveTrip(run(), 0.70, 34.99);
    expect(tripEta(t, 80, AT).minutes).toBe(Math.round(tripEta(t, 40, AT).minutes / 2));
  });

  it("gives a distance and no clock below the moving floor", () => {
    // 3 km/h is a parked truck's GPS scatter, not a truck doing 3 km/h. At that
    // speed the arithmetic says sixteen hours, and sixteen hours would be
    // rendered in exactly the same type as a real answer.
    const t = liveTrip(run(), 0.70, 34.99);
    const eta = tripEta(t, 3, AT);
    expect(eta.moving).toBe(false);
    expect(eta.minutes).toBeNull();
    expect(eta.etaMs).toBeNull();
    expect(eta.remainingKm).toBeGreaterThan(0);
  });

  it("treats a missing speed as stopped rather than as instant arrival", () => {
    const t = liveTrip(run(), 0.70, 34.99);
    expect(tripEta(t, null, AT).minutes).toBeNull();
    expect(tripEta(t, undefined, AT).minutes).toBeNull();
  });

  it("has nothing to count down at either end of the run", () => {
    expect(tripEta(liveTrip(run(), RAIPLY.lat, RAIPLY.lng), 60, AT)).toBeNull();
    const home = liveTrip(run({ arrivedAt: "2026-09-15T06:00:00Z" }), NAITIRI.lat, NAITIRI.lng);
    expect(home.leg).toBe("back");
    expect(tripEta(home, 60, AT)).toBeNull();
  });

  it("returns null without geometry rather than a zero countdown", () => {
    const t = liveTrip(
      run({ destinationLat: null, destinationLng: null, legM: null }),
      0.70, 34.99,
    );
    expect(tripEta(t, 60, AT)).toBeNull();
    expect(tripEta(null, 60, AT)).toBeNull();
  });

  it("counts down to the destination from inside the yard, not to the yard", () => {
    // 'at-yard' is the first moment of a run, not an arrival.
    const eta = tripEta(liveTrip(run(), NAITIRI.lat, NAITIRI.lng), 20, AT);
    expect(eta.towards).toBe("destination");
    expect(eta.remainingKm).toBeCloseTo(49.9, 0);
  });
});

describe("fmtDuration", () => {
  it("reads as a duration past the hour instead of counting minutes", () => {
    expect(fmtDuration(48)).toBe("48 m");
    expect(fmtDuration(72)).toBe("1 h 12 m");
    expect(fmtDuration(120)).toBe("2 h");
  });

  it("does not render a zero hour", () => {
    expect(fmtDuration(59)).toBe("59 m");
    expect(fmtDuration(60)).toBe("1 h");
  });

  it("says the small number in words rather than as 0 m", () => {
    expect(fmtDuration(0)).toBe("under a minute");
  });

  it("is absent, not zero, without a figure", () => {
    expect(fmtDuration(null)).toBeNull();
    expect(fmtDuration(undefined)).toBeNull();
    expect(fmtDuration(NaN)).toBeNull();
  });
});

describe("a trip is completed by the sign-in, not by arriving", () => {
  // A completed run never reaches any of this: the guard signs the unit in, the
  // provider records a return, `actual_return_at` is set and the row leaves the
  // open set. So everything below is about a truck that is HOME and whose run
  // is still open — the state that needs acting on, and the one the card used
  // to tick off as done.
  const home = (over = {}) => liveTrip(
    run({ arrivedAt: "2026-09-15T06:00:00Z", departureIsSignOut: true, ...over }),
    NAITIRI.lat, NAITIRI.lng,
  );

  it("reaches the gate and stays open", () => {
    expect(home().leg).toBe("back");
    expect(awaitingSignIn(home())).toBe(true);
  });

  it("says the signature is what is outstanding", () => {
    expect(legLabel(home())).toBe("Back, awaiting sign-in");
  });

  it("does not claim a sign-in on a lifecycle no guard closes", () => {
    // A cane dispatch is closed by the provider recording a return, which is
    // not a person at a gate. Claiming otherwise would put words in the
    // operator's mouth about a process we do not observe.
    const cane = home({ departureIsSignOut: false });
    expect(awaitingSignIn(cane)).toBe(false);
    expect(legLabel(cane)).toBe("Back at the yard");
  });

  it("is not awaiting anything until it is actually home", () => {
    const enroute = liveTrip(
      run({ arrivedAt: "2026-09-15T06:00:00Z", departureIsSignOut: true }),
      0.70, 34.99,
    );
    expect(enroute.leg).toBe("returning");
    expect(awaitingSignIn(enroute)).toBe(false);
    expect(legLabel(enroute)).toBe("Returning");
  });

  it("cannot be reached by a truck that never left", () => {
    // 'back' requires `arrived`, which is what stops the three stale Naitiri
    // rows — parked at their own gate, never having gone anywhere — from being
    // presented as runs waiting to be signed in.
    const neverLeft = liveTrip(run({ departureIsSignOut: true }), NAITIRI.lat, NAITIRI.lng);
    expect(neverLeft.leg).toBe("at-yard");
    expect(awaitingSignIn(neverLeft)).toBe(false);
  });

  it("has no countdown left to run", () => {
    expect(tripEta(home(), 60)).toBeNull();
  });

  it("answers nothing for no trip at all", () => {
    expect(awaitingSignIn(null)).toBe(false);
    expect(legLabel(null)).toBeNull();
  });
});

describe("the bed empties when Raiply is BEHIND it, not on arrival", () => {
  // Three different events, hours apart on this route: the truck arrives, the
  // bags come off, and much later a guard signs the run in. The run is CLOSED
  // by the guard; the sugar comes off somewhere in between, and the only
  // evidence of it this system has is the unit leaving the zone it went in to.
  const at = (lat, lng, over = {}) => liveTrip(run({ departureIsSignOut: true, ...over }), lat, lng);

  it("is still loaded in the yard it is leaving", () => {
    expect(hasDelivered(at(NAITIRI.lat, NAITIRI.lng))).toBe(false);
  });

  it("is still loaded the whole way there", () => {
    expect(hasDelivered(at(0.70, 34.99))).toBe(false);
  });

  /*
   * The rule the operator asked for, and the one a naive reading gets wrong.
   *
   * A truck that has just rolled through the Raiply gate is standing in the
   * yard with 29 t of sugar on the bed waiting its turn at the bay. Emptying
   * it here wrote the load off at the moment the wheels crossed the line, and
   * put "Empty" on the card of a unit nobody had touched yet.
   */
  it("is STILL LOADED standing inside Raiply, arriving is not offloading", () => {
    const t = at(RAIPLY.lat, RAIPLY.lng);
    expect(t.leg).toBe("at-destination");
    expect(hasDelivered(t)).toBe(false);
  });

  it("empties once it has gone in and come back out again", () => {
    // `arrivedAt` is the server's record of a fix INSIDE the radius, so this
    // is a unit that was demonstrably in the zone and is now outside it.
    const out = at(RAIPLY.lat + 0.05, RAIPLY.lng, { arrivedAt: "2026-09-15T06:00:00Z" });
    expect(out.leg).toBe("returning");
    expect(hasDelivered(out)).toBe(true);
  });

  /*
   * The load-bearing negative. Leaving is only evidence of an offload for a
   * unit that went IN — otherwise every truck that drove past Raiply on the
   * way somewhere else would have its sugar written off in transit.
   */
  it("does not empty a truck that never entered the zone", () => {
    const past = at(RAIPLY.lat + 0.05, RAIPLY.lng);   // no arrivedAt
    expect(past.leg).toBe("outbound");
    expect(hasDelivered(past)).toBe(false);
  });

  it("stays empty all the way home", () => {
    const back = at(0.70, 34.99, { arrivedAt: "2026-09-15T06:00:00Z" });
    expect(back.leg).toBe("returning");
    expect(hasDelivered(back)).toBe(true);
  });

  it("stays empty at the gate while the sign-in is outstanding", () => {
    const home = at(NAITIRI.lat, NAITIRI.lng, { arrivedAt: "2026-09-15T06:00:00Z" });
    expect(home.leg).toBe("back");
    expect(awaitingSignIn(home)).toBe(true);   // the run is open …
    expect(hasDelivered(home)).toBe(true);     // … and the bed is not
  });

  /*
   * A unit that tips and then parks inside the perimeter overnight reads as
   * laden until it pulls out. Pinned rather than merely tolerated: it is the
   * accepted cost of using the exit as the evidence, and somebody meeting it
   * on the dashboard should find the trade-off written down rather than
   * conclude the rule is broken.
   */
  it("holds a unit parked inside the zone as laden until it pulls out", () => {
    const parked = at(RAIPLY.lat, RAIPLY.lng, { arrivedAt: "2026-09-15T06:00:00Z" });
    expect(parked.leg).toBe("at-destination");
    expect(hasDelivered(parked)).toBe(false);
  });

  it("does not empty a truck that has merely gone quiet", () => {
    // No fix since sign-out is not evidence of a delivery. As far as anything
    // here knows the sugar is still on the bed, and saying otherwise would
    // quietly write 29 t off the fleet's stock on a silent tracker.
    expect(hasDelivered(at(RAIPLY.lat, RAIPLY.lng, { leg: "no-fix" }))).toBe(false);
  });

  it("answers nothing for no run", () => {
    expect(hasDelivered(null)).toBe(false);
    expect(hasDelivered(undefined)).toBe(false);
  });
});
