/* Every map-visibility axis, composed in one place.
 *
 * The contract worth pinning: the markers, the camera and the overlay's status
 * chips must all answer "is this vehicle showing?" the same way. They live in
 * three files that cannot see each other, and when each composed the axes
 * itself they drifted — which is how a chip reading ONLINE 412 ends up above a
 * map holding three units. So the last test here is the important one:
 * matchesMapFilters with no extra axes must be EXACTLY matchesFilter, or the
 * counts start disagreeing with the map again.
 */

import { describe, it, expect } from "vitest";
import { matchesMapFilters, matchesFilter } from "./vehicleMap";

/** Sukari's shape: id is a plate, the machine is in the descriptive name. */
const excavator = { id: "KDE 581S", name: "CAT EXCAVATOR 320D", online: true, engine: "on", speed: 0 };
const truck     = { id: "KBH 123A", name: "Faw Prime mover CA4181", online: true, engine: "on", speed: 44 };
const offline   = { id: "KCD 118P", name: "Faw Prime mover CA4181", online: false, engine: "off", speed: 0 };

describe("matchesMapFilters, the tracked selection", () => {
  it("passes everything when the selection is empty", () => {
    // An empty selection is the absence of a narrowing, not "hide everything" —
    // the same rule matchesTypeFilter states for an empty type list.
    expect(matchesMapFilters(truck, { trackedSet: new Set() })).toBe(true);
    expect(matchesMapFilters(truck, {})).toBe(true);
    expect(matchesMapFilters(truck, { trackedSet: null })).toBe(true);
  });

  it("hides everything outside the selection", () => {
    const tracked = new Set(["KBH 123A"]);
    expect(matchesMapFilters(truck, { trackedSet: tracked })).toBe(true);
    expect(matchesMapFilters(excavator, { trackedSet: tracked })).toBe(false);
  });

  it("keeps a tracked unit whatever the type filter says", () => {
    // Operator, 2026-10-15: a sidebar click must not take tracked units off
    // the map. A tracked excavator survives a trucks-only funnel.
    const tracked = new Set(["KDE 581S"]);
    expect(matchesMapFilters(excavator, { trackedSet: tracked, fleetTypes: ["ex"] })).toBe(true);
    expect(matchesMapFilters(excavator, { trackedSet: tracked, fleetTypes: ["truck"] })).toBe(true);
  });

  it("keeps a tracked unit whatever the status filter says", () => {
    const tracked = new Set(["KCD 118P"]);
    expect(matchesMapFilters(offline, { trackedSet: tracked, filterKey: "offline" })).toBe(true);
    expect(matchesMapFilters(offline, { trackedSet: tracked, filterKey: "ok" })).toBe(true);
  });

  it("draws the filter's matches alongside the tracked units", () => {
    const tracked = new Set(["KCD 118P"]);
    // No filter: the tracked units alone.
    expect(matchesMapFilters(truck, { trackedSet: tracked })).toBe(false);
    // A filter set: its matches join them, its non-matches stay hidden.
    expect(matchesMapFilters(truck, { trackedSet: tracked, filterKey: "ok" })).toBe(true);
    expect(matchesMapFilters(truck, { trackedSet: tracked, fleetTypes: ["truck"] })).toBe(true);
    expect(matchesMapFilters(excavator, { trackedSet: tracked, fleetTypes: ["truck"] })).toBe(false);
    expect(matchesMapFilters(truck, { trackedSet: tracked, inTransitOnly: true })).toBe(true);
    expect(matchesMapFilters(excavator, { trackedSet: tracked, inTransitOnly: true })).toBe(false);
  });
});

describe("matchesMapFilters, the in-transit lens", () => {
  it("keeps only units that are actually moving", () => {
    expect(matchesMapFilters(truck, { inTransitOnly: true })).toBe(true);
    expect(matchesMapFilters(excavator, { inTransitOnly: true })).toBe(false);   // engine on, stationary
    expect(matchesMapFilters(offline, { inTransitOnly: true })).toBe(false);
  });

  it("does nothing when it is off", () => {
    expect(matchesMapFilters(excavator, { inTransitOnly: false })).toBe(true);
  });

  it("composes with the other two axes", () => {
    expect(matchesMapFilters(truck, { inTransitOnly: true, fleetTypes: ["truck"] })).toBe(true);
    expect(matchesMapFilters(excavator, { inTransitOnly: true, fleetTypes: ["truck", "ex"] })).toBe(false);
    // Tracked units are exempt from the lens like every other filter.
    const watched = new Set(["KDE 581S"]);
    expect(matchesMapFilters(excavator, { trackedSet: watched, inTransitOnly: true, fleetTypes: ["truck"] })).toBe(true);
  });
});

describe("matchesMapFilters, the chip-count contract", () => {
  it("is exactly matchesFilter when no other axis is set", () => {
    // This is what keeps MapOverlay's numbers equal to what clicking them
    // shows. If the composer is ever a STRICTER superset for a bare filterKey,
    // the counts drift from the map and the chips start lying.
    for (const v of [truck, excavator, offline]) {
      for (const key of ["all", "ok", "offline", "transit", "idling", "parked", "warning", "critical"]) {
        expect(matchesMapFilters(v, { filterKey: key })).toBe(matchesFilter(v, key));
      }
    }
  });

  it("defaults filterKey to 'all'", () => {
    expect(matchesMapFilters(offline, {})).toBe(true);
  });
});
