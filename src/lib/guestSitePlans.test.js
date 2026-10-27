import { describe, it, expect } from "vitest";
import {
  perimeterOf, bboxOf, occupantsIn, nextGuestState, sameGuestList, LEAVE_GRACE_MS,
} from "./guestSitePlans";

const NOW = Date.parse("2026-09-15T09:00:00Z");
const MIN = 60_000;

// A square of the right SIZE in the right part of the world — a hectare or
// so, at Migori's longitude and just below the equator — so that a latitude
// sign error or a swapped lng/lat shows up here as a unit that is suddenly
// nowhere near the fence. Not any one site's ring: it was traced off Oyani's
// before that survey was re-cut, and nothing in these tests wants it to track
// a real file. A fixture that follows a survey is a fixture that breaks every
// time a surveyor walks the fence again.
const RING = [
  [34.5938, -1.0408], [34.5951, -1.0408], [34.5951, -1.0400], [34.5938, -1.0400], [34.5938, -1.0408],
];
const PLAN = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { name: "Gate", category: "gate" },
      geometry: { type: "Point", coordinates: [34.5939, -1.0404] } },
    { type: "Feature", properties: { name: "Oyani", category: "perimeter" },
      geometry: { type: "Polygon", coordinates: [RING] } },
  ],
};
const RIVER = {
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { name: "Molo", category: "water" },
    geometry: { type: "Polygon", coordinates: [RING] } }],
};

const unit = (id, lat, lng, ageMs = MIN) => ({ id, lat, lng, capturedAtMs: NOW - ageMs });

describe("perimeterOf", () => {
  it("finds the fence among the places inside it", () => {
    expect(perimeterOf(PLAN).properties.name).toBe("Oyani");
  });

  it("returns null for a survey with no fence", () => {
    // --no-fence: a river's biggest outline is water, not a boundary.
    expect(perimeterOf(RIVER)).toBe(null);
    expect(perimeterOf(null)).toBe(null);
  });
});

describe("occupantsIn", () => {
  it("names the units inside the fence and no others", () => {
    const fleet = [unit("IN 1", -1.0404, 34.5944), unit("OUT 1", -1.0404, 34.6100)];
    expect(occupantsIn(fleet, perimeterOf(PLAN), NOW)).toEqual(["IN 1"]);
  });

  it("contains nothing when the survey has no fence", () => {
    expect(occupantsIn([unit("IN 1", -1.0404, 34.5944)], perimeterOf(RIVER), NOW)).toEqual([]);
  });

  it("ignores a unit with no position", () => {
    expect(occupantsIn([{ id: "NO FIX", capturedAtMs: NOW }], perimeterOf(PLAN), NOW)).toEqual([]);
  });

  it("ignores a DARK unit, whose position is a memory", () => {
    // The case the grace window cannot cover: a lorry that reported from this
    // yard last week and has been silent since must not pin the layer open.
    const stale = unit("SILENT", -1.0404, 34.5944, 26 * 3_600_000);
    expect(occupantsIn([stale], perimeterOf(PLAN), NOW)).toEqual([]);
    expect(occupantsIn([{ ...stale, capturedAtMs: undefined }], perimeterOf(PLAN), NOW)).toEqual([]);
  });
});

describe("bboxOf", () => {
  it("boxes the ring", () => {
    expect(bboxOf(perimeterOf(PLAN))).toEqual({
      minLat: -1.0408, maxLat: -1.04, minLng: 34.5938, maxLng: 34.5951,
    });
  });

  it("has nothing to box for a point or a missing feature", () => {
    expect(bboxOf(null)).toBe(null);
    expect(bboxOf(PLAN.features[0])).toBe(null);   // the gate, a Point
  });

  it("is a REJECT and never an answer", () => {
    // The box is the rectangle around the ring; the ray cast still decides.
    // A version that trusted the box would call every lorry on the road
    // beside an L-shaped yard "inside" it.
    const L = {
      type: "Feature", properties: { category: "perimeter" },
      geometry: { type: "Polygon", coordinates: [[
        [0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0],
      ]] },
    };
    const corner = unit("CORNER", 1.5, 1.5);   // in the box, out of the L
    expect(occupantsIn([corner], L, NOW)).toEqual([]);
    expect(occupantsIn([corner], L, NOW, bboxOf(L))).toEqual([]);
  });

  it("gives the same answer with the box as without it", () => {
    const per = perimeterOf(PLAN);
    const box = bboxOf(per);
    const fleet = [
      unit("IN 1", -1.0404, 34.5944),
      unit("OUT FAR", 0.7872, 34.8814),     // Naitiri, 200 km north
      unit("OUT NEAR", -1.0409, 34.5944),   // just below the fence
    ];
    expect(occupantsIn(fleet, per, NOW, box)).toEqual(occupantsIn(fleet, per, NOW));
    expect(occupantsIn(fleet, per, NOW, box)).toEqual(["IN 1"]);
  });
});

describe("nextGuestState", () => {
  it("opens a visit and keeps its start time across sweeps", () => {
    const first  = nextGuestState({}, { oyani: ["KCP 131P"] }, NOW);
    const second = nextGuestState(first, { oyani: ["KCP 131P", "KDE 319Q"] }, NOW + 5 * MIN);
    expect(second.oyani.since).toBe(NOW);            // the visit, not this sweep
    expect(second.oyani.lastSeen).toBe(NOW + 5 * MIN);
    expect(second.oyani.occupants).toHaveLength(2);
  });

  it("holds the survey through the grace window, then drops it", () => {
    const visit = nextGuestState({}, { oyani: ["KCP 131P"] }, NOW);
    const blip  = nextGuestState(visit, { oyani: [] }, NOW + LEAVE_GRACE_MS - MIN);
    expect(Object.keys(blip)).toEqual(["oyani"]);
    const gone  = nextGuestState(blip, { oyani: [] }, NOW + LEAVE_GRACE_MS + MIN);
    expect(gone).toEqual({});
  });

  it("re-arms the window when the unit is seen again", () => {
    // A lorry on the fence line flicking in and out must not restart the
    // layer; it must simply never leave.
    let st = nextGuestState({}, { oyani: ["KCP 131P"] }, NOW);
    for (let i = 1; i <= 10; i++) {
      st = nextGuestState(st, { oyani: i % 2 ? [] : ["KCP 131P"] }, NOW + i * MIN);
    }
    expect(st.oyani.since).toBe(NOW);
  });

  it("offers nothing for a yard that was never occupied", () => {
    expect(nextGuestState({}, { oyani: [] }, NOW)).toEqual({});
    expect(nextGuestState(undefined, undefined, NOW)).toEqual({});
  });
});

describe("sameGuestList", () => {
  it("is true for a sweep that changed nothing", () => {
    const a = nextGuestState({}, { oyani: ["A"] }, NOW);
    const b = nextGuestState(a, { oyani: ["A"] }, NOW + MIN);
    expect(sameGuestList(a, b)).toBe(true);
  });

  it("is false when a yard is added, emptied further, or filled further", () => {
    const one = nextGuestState({}, { oyani: ["A"] }, NOW);
    expect(sameGuestList(one, nextGuestState(one, { oyani: ["A"], raiply: ["B"] }, NOW))).toBe(false);
    expect(sameGuestList(one, nextGuestState(one, { oyani: ["A", "B"] }, NOW))).toBe(false);
  });
});
