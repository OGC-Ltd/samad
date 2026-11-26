import { describe, it, expect } from "vitest";
import {
  shapeOf, measure, problemsOf, notesOf, toPayload, draftOf, parsePoints, formatPoints,
  metresBetween, parentOf, fmtArea,
} from "./fenceShape";

// About 111 m a side near the equator (0.001°).
const sq = [
  { lat: 0, lng: 34 }, { lat: 0, lng: 34.001 }, { lat: 0.001, lng: 34.001 }, { lat: 0.001, lng: 34 },
];

describe("shapeOf / measure", () => {
  it("measures a polygon in hectares", () => {
    const { areaHa, perimeterM } = measure({ kind: "polygon", points: sq });
    expect(areaHa).toBeGreaterThan(1.2);
    expect(areaHa).toBeLessThan(1.3);
    expect(perimeterM).toBeGreaterThan(440);
    expect(perimeterM).toBeLessThan(450);
  });
  it("makes a rectangle from two opposite corners", () => {
    const r = measure({ kind: "rectangle", points: [sq[0], sq[2]] });
    expect(r.areaHa).toBeCloseTo(measure({ kind: "polygon", points: sq }).areaHa, 2);
  });
  it("makes a circle of the given radius", () => {
    const { areaHa } = measure({ kind: "circle", points: [sq[0]], radiusM: 100 });
    expect(areaHa).toBeGreaterThan(3.1);
    expect(areaHa).toBeLessThan(3.15);
  });
  it("buffers a corridor to its width and measures its centre-line", () => {
    const m = measure({ kind: "corridor", points: [sq[0], sq[1]], widthM: 20 });
    expect(m.lengthM).toBeGreaterThan(110);
    expect(m.lengthM).toBeLessThan(112);
    // 111 m × 20 m plus the round ends.
    expect(m.areaHa).toBeGreaterThan(0.22);
    expect(m.areaHa).toBeLessThan(0.26);
  });
  it("is null until there are enough points", () => {
    expect(shapeOf({ kind: "polygon", points: sq.slice(0, 2) })).toBeNull();
    expect(shapeOf({ kind: "circle", points: [sq[0]], radiusM: 0 })).toBeNull();
  });
  it("measures a radius from a drag", () => {
    expect(metresBetween(sq[0], sq[1])).toBeCloseTo(111.2, 0);
  });
});

describe("problemsOf", () => {
  it("passes a good polygon", () => {
    expect(problemsOf({ kind: "polygon", points: sq })).toEqual([]);
  });
  it("catches edges that cross", () => {
    const bow = [sq[0], sq[2], sq[1], sq[3]];
    expect(problemsOf({ kind: "polygon", points: bow })[0]).toMatch(/cross/);
  });
  it("asks for more corners", () => {
    expect(problemsOf({ kind: "polygon", points: sq.slice(0, 2) })[0]).toMatch(/at least 3/);
  });
  it("holds a circle and a corridor to the server's limits", () => {
    expect(problemsOf({ kind: "circle", points: [sq[0]], radiusM: 5 })[0]).toMatch(/at least 10 m/);
    expect(problemsOf({ kind: "corridor", points: [sq[0], sq[1]], widthM: 5000 })[0]).toMatch(/at most/);
  });
  it("refuses a slip of the mouse", () => {
    const tiny = [{ lat: 0, lng: 34 }, { lat: 0, lng: 34.00001 }, { lat: 0.00001, lng: 34.00001 }];
    expect(problemsOf({ kind: "polygon", points: tiny })[0]).toMatch(/smaller/);
  });
});

describe("existing fences", () => {
  const big = { type: "Feature", properties: { id: "a", name: "Sukari Industries" },
    geometry: { type: "Polygon", coordinates: [[[33.99, -0.01], [34.01, -0.01], [34.01, 0.01], [33.99, 0.01], [33.99, -0.01]]] } };
  const gate = { type: "Feature", properties: { id: "b", name: "Gate", radiusM: 50 },
    geometry: { type: "Point", coordinates: [34.0005, 0.0005] } };
  it("names the fence a shape sits inside, and what it overlaps", () => {
    const draft = { kind: "polygon", points: sq };
    expect(parentOf(shapeOf(draft), [big, gate]).properties.name).toBe("Sukari Industries");
    expect(notesOf(draft, [big, gate])).toEqual(["Sits inside Sukari Industries.", "Overlaps Gate."]);
  });
});

describe("toPayload / draftOf", () => {
  it("closes a polygon ring and sends [lng, lat]", () => {
    const b = toPayload({ kind: "polygon", points: sq }, { name: " Yard ", purpose: "yard", color: "#123456" });
    expect(b).toMatchObject({ type: "POLYGON", name: "Yard", purpose: "yard", color: "#123456", mode: "ALLOWLIST" });
    expect(b.polygonCoords[0]).toEqual([34, 0]);
    expect(b.polygonCoords.at(-1)).toEqual(b.polygonCoords[0]);
  });
  it("makes a keep-out a BLOCKLIST", () => {
    expect(toPayload({ kind: "circle", points: [sq[0]], radiusM: 80.4 }, { name: "x", purpose: "restricted" }))
      .toMatchObject({ type: "CIRCLE", mode: "BLOCKLIST", radiusM: 80, centerLat: 0, centerLng: 34 });
  });
  it("sends a corridor as a LINE with its width", () => {
    expect(toPayload({ kind: "corridor", points: [sq[0], sq[1]], widthM: 30 }, { name: "Road" }))
      .toMatchObject({ type: "LINE", widthM: 30, polygonCoords: [[34, 0], [34.001, 0]] });
  });
  it("reads a saved fence back as a draft", () => {
    const f = { geometry: { type: "Polygon", coordinates: [[[34, 0], [34.001, 0], [34.001, 0.001], [34, 0]]] }, properties: {} };
    expect(draftOf(f)).toEqual({ kind: "polygon", points: [{ lat: 0, lng: 34 }, { lat: 0, lng: 34.001 }, { lat: 0.001, lng: 34.001 }] });
    expect(draftOf({ geometry: { type: "Point", coordinates: [34, 0] }, properties: { radiusM: 70 } }))
      .toEqual({ kind: "circle", points: [{ lat: 0, lng: 34 }], radiusM: 70 });
  });
});

describe("parsePoints / formatPoints", () => {
  it("reads lat, lng lines and round-trips", () => {
    const { points, error } = parsePoints("-0.823400, 34.384490\n-0.8240 34.3850\n-0.8245,34.3840");
    expect(error).toBeNull();
    expect(points[0]).toEqual({ lat: -0.8234, lng: 34.38449 });
    expect(parsePoints(formatPoints(points)).points).toEqual(points);
  });
  it("turns a line round when the first number cannot be a latitude", () => {
    expect(parsePoints("115.86, -31.95").points[0]).toEqual({ lat: -31.95, lng: 115.86 });
  });
  it("reads pasted GeoJSON and drops the closing corner", () => {
    const { points } = parsePoints(JSON.stringify({ type: "Polygon", coordinates: [[[34, 0], [34.001, 0], [34.001, 0.001], [34, 0]]] }));
    expect(points).toHaveLength(3);
  });
  it("says which line is wrong", () => {
    expect(parsePoints("0.1, 34\nhello").error).toMatch(/Line 2/);
  });
});

describe("fmtArea", () => {
  it("uses m² under a hectare", () => {
    expect(fmtArea(0.5)).toBe("5,000 m²");
    expect(fmtArea(12.345)).toBe("12.35 ha");
  });
});
