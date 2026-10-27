/* Geofence containment, computed in the browser.
 *
 * The fixtures below are cut from Mufindi's real geometry, because the shapes
 * are the whole point: of its 107 fences, 29 are polygons, 67 are circles with
 * a 1 km radius and 11 are corridors. A containment test that handled only
 * polygons would call 46 units "not in any zone" while they stand in the middle
 * of a workshop, and those are exactly the units this rule must not flag.
 *
 * The other thing worth pinning is the THREE-state answer. `null` — no geometry
 * for this org — is not `false`. Three of the four live orgs have no geofences
 * at all, and reporting "not in a safe zone" about a fleet that has no zones
 * defined is an assertion nobody can support.
 */

import { describe, it, expect } from "vitest";
import { fenceContains, containingFences, insideAnyFence, zoneTestFor } from "./zoneContainment";

/** A square about 1.1 km on a side, near Mufindi. */
const square = {
  properties: { name: "FARM #215" },
  geometry: { type: "Polygon", coordinates: [[[30.50, -4.05], [30.51, -4.05], [30.51, -4.04], [30.50, -4.04], [30.50, -4.05]]] },
};

/** The same square with a hole punched through the middle of it. */
const withHole = {
  properties: { name: "Estate less the quarry" },
  geometry: { type: "Polygon", coordinates: [
    [[30.50, -4.05], [30.51, -4.05], [30.51, -4.04], [30.50, -4.04], [30.50, -4.05]],
    [[30.503, -4.047], [30.507, -4.047], [30.507, -4.043], [30.503, -4.043], [30.503, -4.047]],
  ] },
};

/** Mufindi's commonest shape: a point with a 1 km radius. */
const circle = {
  properties: { name: "Workshop A", radiusM: 1000 },
  geometry: { type: "Point", coordinates: [30.60, -4.10] },   // GeoJSON is lng, lat
};

/** A haulage corridor, 40 m wide. */
const corridor = {
  properties: { name: "Haul road 3", widthM: 40 },
  geometry: { type: "LineString", coordinates: [[30.70, -4.20], [30.72, -4.20]] },
};

describe("fenceContains, polygons", () => {
  it("finds a point inside the ring", () => {
    expect(fenceContains({ lat: -4.045, lng: 30.505 }, square)).toBe(true);
  });

  it("excludes a point outside the ring", () => {
    expect(fenceContains({ lat: -4.030, lng: 30.505 }, square)).toBe(false);
    expect(fenceContains({ lat: -4.045, lng: 30.490 }, square)).toBe(false);
  });

  it("treats a hole as outside", () => {
    // In the ring but in the hole → not inside. XOR across rings is what buys
    // this; a plain "any ring contains it" would say true.
    expect(fenceContains({ lat: -4.045, lng: 30.505 }, withHole)).toBe(false);
    // In the ring, clear of the hole → inside.
    expect(fenceContains({ lat: -4.041, lng: 30.505 }, withHole)).toBe(true);
  });

  it("handles a MultiPolygon", () => {
    const multi = { properties: { name: "Two blocks" }, geometry: {
      type: "MultiPolygon",
      coordinates: [square.geometry.coordinates, [[[31.00, -5.00], [31.01, -5.00], [31.01, -4.99], [31.00, -5.00]]]],
    } };
    expect(fenceContains({ lat: -4.045, lng: 30.505 }, multi)).toBe(true);
    expect(fenceContains({ lat: -4.995, lng: 31.008 }, multi)).toBe(true);
    expect(fenceContains({ lat: -4.000, lng: 30.000 }, multi)).toBe(false);
  });
});

describe("fenceContains, circles", () => {
  it("measures against the radius", () => {
    expect(fenceContains({ lat: -4.10, lng: 30.60 }, circle)).toBe(true);      // dead centre
    expect(fenceContains({ lat: -4.1050, lng: 30.60 }, circle)).toBe(true);    // ~555 m out
    expect(fenceContains({ lat: -4.1200, lng: 30.60 }, circle)).toBe(false);   // ~2.2 km out
  });

  it("is not inside a circle with no radius", () => {
    // A fence with no radius is a dropped pin, not an area. Treating it as one
    // would make containment a function of floating-point luck.
    const noRadius = { properties: { name: "Pin" }, geometry: circle.geometry };
    expect(fenceContains({ lat: -4.10, lng: 30.60 }, noRadius)).toBe(false);
  });
});

describe("fenceContains, corridors are NOT containment", () => {
  it("a unit standing on a haulage road is not inside anything", () => {
    // The headline rule. "Sukari to Rapogii road (Tarmac)" and
    // "Sukari-Factory to Ndiwa Marram Road" are fences, but a road is not a
    // place to be: a truck stopped on one for ten minutes must still flag.
    expect(fenceContains({ lat: -4.20, lng: 30.71 }, corridor)).toBe(false);    // dead on it
    expect(fenceContains({ lat: -4.20015, lng: 30.71 }, corridor)).toBe(false); // 17 m off
  });

  it("a corridor never suppresses a flag, whatever its width", () => {
    const wide = { properties: { name: "Wide haul road", widthM: 500 }, geometry: corridor.geometry };
    expect(insideAnyFence({ lat: -4.20, lng: 30.71 }, [wide])).toBe(false);
  });
});

describe("fenceContains, junk in, false out", () => {
  it("never throws on a malformed fence", () => {
    // One bad fence must not take the whole rule down with it.
    for (const bad of [null, {}, { geometry: null }, { geometry: { type: "Polygon" } },
                       { geometry: { type: "GeometryCollection", geometries: [] } }]) {
      expect(fenceContains({ lat: -4.045, lng: 30.505 }, bad)).toBe(false);
    }
  });

  it("is false for a point with no fix", () => {
    expect(fenceContains({ lat: null, lng: 30.505 }, square)).toBe(false);
    expect(fenceContains(null, square)).toBe(false);
  });
});

describe("containingFences / insideAnyFence", () => {
  const all = [square, circle, corridor];   // the corridor can never match

  it("names every fence containing the point", () => {
    // Overlap is normal — MUFINDI: 012 really is in four zones at once.
    expect(containingFences({ lat: -4.045, lng: 30.505 }, all)).toEqual(["FARM #215"]);
    expect(containingFences({ lat: -4.10, lng: 30.60 }, all)).toEqual(["Workshop A"]);
    expect(containingFences({ lat: 0, lng: 0 }, all)).toEqual([]);
  });

  it("short-circuits on the first hit", () => {
    expect(insideAnyFence({ lat: -4.10, lng: 30.60 }, all)).toBe(true);
    expect(insideAnyFence({ lat: 0, lng: 0 }, all)).toBe(false);
    expect(insideAnyFence({ lat: -4.10, lng: 30.60 }, [])).toBe(false);
  });
});

describe("zoneTestFor, the three states", () => {
  const fc = { type: "FeatureCollection", features: [square, circle, corridor] };

  it("true when the unit is inside a fence", () => {
    expect(zoneTestFor(fc)({ lat: -4.045, lng: 30.505 })).toBe(true);
  });

  it("false when the unit is outside every fence", () => {
    expect(zoneTestFor(fc)({ lat: -4.000, lng: 30.000 })).toBe(false);
  });

  it("NULL when the org has no geometry, not false", () => {
    // Sukari, West Kenya and Menengai are all in this state until their Wialon
    // zones are imported. "We never checked" must never reach an operator as
    // "it is not where it should be".
    expect(zoneTestFor({ type: "FeatureCollection", features: [] })({ lat: -4.045, lng: 30.505 })).toBeNull();
    expect(zoneTestFor(null)({ lat: -4.045, lng: 30.505 })).toBeNull();
  });

  it("NULL when the org has ONLY roads, they are not areas to be inside of", () => {
    // Geometry loaded, but none of it can contain anything. Answering "not in
    // any zone" here is the same false certainty as answering with no fences.
    const roadsOnly = { type: "FeatureCollection", features: [corridor] };
    expect(zoneTestFor(roadsOnly)({ lat: -4.20, lng: 30.71 })).toBeNull();
  });

  it("a unit on a road, in an org that HAS areas, is decided and outside", () => {
    // The two named Sukari roads, once their factory polygons are imported:
    // the answer is a definite "outside every zone", so the row flags without
    // the "location unverified" caveat.
    expect(zoneTestFor(fc)({ lat: -4.20, lng: 30.71 })).toBe(false);
  });

  it("NULL when the unit has no fix", () => {
    expect(zoneTestFor(fc)({ lat: null, lng: null })).toBeNull();
    expect(zoneTestFor(fc)({})).toBeNull();
  });

  it("honours the server's own verdict for AREAS", () => {
    // zones.inside is computed against per-vehicle ASSIGNMENT, which raw
    // geometry cannot see. When the server has an answer it outranks this one —
    // so the day its engine starts reporting, the rule improves by itself.
    const inDepot = { lat: -4.000, lng: 30.000, zones: { known: true, inside: [{ id: "z1", name: "Depot", area: true }] } };
    expect(zoneTestFor(fc)(inDepot)).toBe(true);
  });

  it("does NOT let the server's corridors suppress a flag", () => {
    // The server's `inside` covers every containing zone, corridors included.
    // A unit stopped on a haulage road must still flag, whichever side of the
    // wire decided it was there.
    const onRoad = { lat: -4.000, lng: 30.000, zones: { known: true, inside: [{ id: "r1", name: "Haul road 3", area: false }] } };
    expect(zoneTestFor(fc)(onRoad)).toBe(false);
  });

  it("ignores a server that predates the area field", () => {
    // A partial deploy must not reintroduce corridor suppression: with no
    // shape to read, fall through to the geometry we can see for ourselves.
    const legacy = { lat: -4.000, lng: 30.000, zones: { known: true, inside: [{ id: "z1", name: "Depot" }] } };
    expect(zoneTestFor(fc)(legacy)).toBe(false);   // decided by geometry: outside
  });
});
