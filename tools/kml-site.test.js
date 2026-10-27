/* Turning the operations survey into a map layer.
 *
 * The camera-suffix rule shipped broken once — built with a plain template
 * literal, where the escapes collapse and the pattern matches nothing — and the
 * script reported success while every "(2 G6B, 1 B, 1 LPR)" went onto the map.
 * These assert on the OUTPUT, which is the only thing that would have caught it.
 */

import { describe, it, expect } from "vitest";
import {
  cleanName, parseKml, dedupe, categoryFor, metresToRing, outsideRing,
  isPlaceholderName, ringAreaM2,
} from "./kml-site.lib.mjs";

describe("cleanName", () => {
  it("strips a single camera count", () => {
    expect(cleanName("Fuel Pump (1 LPR)")).toBe("Fuel Pump");
  });

  it("strips a list of them", () => {
    expect(cleanName("Weighbridge (2 G6B, 1 B, 1 LPR)")).toBe("Weighbridge");
    expect(cleanName("Shamberere (1 PTZ, 2 G6B, 1 D)")).toBe("Shamberere");
  });

  /* No space between the digit and the code — "(3B)", "(1D)". The obvious
   * `\b`-anchored pattern silently fails on exactly these. */
  it("strips a count with no space before the code", () => {
    expect(cleanName("Admin (3B)")).toBe("Admin");
    expect(cleanName("Main Gate Tractor (1 LPR, 1D)")).toBe("Main Gate Tractor");
  });

  /* The suffix has to be ENTIRELY counts, or a looser rule eats real names.
   * "Mufindi Paper Mills Ltd (Kasulu)" is an organisation in this very app. */
  it("leaves a real parenthetical alone", () => {
    for (const n of [
      "Mufindi Paper Mills Ltd (Kasulu)",
      "Kabras Sugar Factory (West Kenya)",
      "Gate (north)",
    ]) expect(cleanName(n)).toBe(n);
  });

  it("leaves a name with no parenthetical alone", () => {
    expect(cleanName("Scrap Yard")).toBe("Scrap Yard");
  });
});

describe("parseKml", () => {
  const kml = `
    <Placemark><name>Scrap Yard</name><Point><coordinates>34.8385,0.3778,0</coordinates></Point></Placemark>
    <Placemark><name><![CDATA[Weighbridge (2 G6B, 1 B, 1 LPR)]]></name>
      <Point><coordinates>34.8351,0.3772,0</coordinates></Point></Placemark>
    <Placemark><name>Kabras</name><Polygon><outerBoundaryIs><LinearRing>
      <coordinates>34.83,0.376 34.84,0.376 34.84,0.384 34.83,0.376</coordinates>
    </LinearRing></outerBoundaryIs></Polygon></Placemark>
    <Placemark><Point><coordinates>34.837,0.377,0</coordinates></Point></Placemark>
  `;

  it("reads points and polygons", () => {
    const out = parseKml(kml);
    expect(out.map((f) => f.kind)).toEqual(["point", "point", "area"]);
  });

  /* A marker with no name is a pin dropped while drawing. It would render as an
   * anonymous dot an operator cannot act on. The survey carries seven. */
  it("drops unnamed placemarks", () => {
    expect(parseKml(kml)).toHaveLength(3);
  });

  it("unwraps CDATA and cleans the name, keeping the original", () => {
    const wb = parseKml(kml)[1];
    expect(wb.name).toBe("Weighbridge");
    expect(wb.rawName).toBe("Weighbridge (2 G6B, 1 B, 1 LPR)");
  });

  it("reads coordinates as [lng, lat], dropping altitude", () => {
    expect(parseKml(kml)[0].geometry.coordinates).toEqual([34.8385, 0.3778]);
  });

  it("ignores a placemark with no coordinates", () => {
    expect(parseKml("<Placemark><name>Empty</name></Placemark>")).toEqual([]);
  });
});

describe("dedupe", () => {
  /* The survey records four places twice — once as a place, once as a camera
   * position, 0-5 m apart. Stripping the suffix is what reveals them as one. */
  it("merges pins that differ only by their camera suffix", () => {
    const out = dedupe([
      { name: "Safety Office", rawName: "Safety Office", kind: "point" },
      { name: "Safety Office", rawName: "Safety Office (1B)", kind: "point" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rawName).toBe("Safety Office");
    expect(out[0].aliases).toEqual(["Safety Office (1B)"]);
  });

  it("keeps a point and an area of the same name apart", () => {
    const out = dedupe([
      { name: "Distillery", rawName: "Distillery", kind: "point" },
      { name: "Distillery", rawName: "Distillery", kind: "area" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("is case-insensitive about the name", () => {
    expect(dedupe([
      { name: "Garage", rawName: "Garage", kind: "point" },
      { name: "garage", rawName: "garage", kind: "point" },
    ])).toHaveLength(1);
  });
});

describe("categoryFor", () => {
  it("reads the gate out of a compound name", () => {
    // Longest-first ordering: this is a gate, not the distillery.
    expect(categoryFor("Distillery Main Gate")).toBe("gate");
    expect(categoryFor("Distillery")).toBe("process");
  });

  it("classifies the site's own vocabulary", () => {
    expect(categoryFor("Scrap Yard")).toBe("yard");
    expect(categoryFor("Unhinged Trailler Yard")).toBe("yard");   // survey's spelling
    expect(categoryFor("Vehicle Parking")).toBe("parking");
    expect(categoryFor("Garage")).toBe("workshop");
    expect(categoryFor("Project Workshop")).toBe("workshop");
    expect(categoryFor("Inner Square")).toBe("storage");
    expect(categoryFor("Chemical Storage")).toBe("storage");
    expect(categoryFor("Weighbridge")).toBe("weighing");
  });

  it("falls back rather than throwing on something new", () => {
    expect(categoryFor("Something Nobody Listed")).toBe("facility");
  });
});

/* A square roughly 1 km on a side at Sukari's latitude, for the fence tests. */
const RING = [
  [34.380, -0.825], [34.390, -0.825], [34.390, -0.815], [34.380, -0.815],
];

describe("the fuel station is its own category", () => {
  it("reads a fuel station as a pump, not as a facility", () => {
    expect(categoryFor("Fuel Station")).toBe("fuel");
    expect(categoryFor("Diesel Depot")).toBe("fuel");
  });

  it("still reads a fuel STORE as the pump rather than as a store", () => {
    expect(categoryFor("Fuel Store")).toBe("fuel");
  });

  it("leaves a gate a gate even when it is the fuel bay's own", () => {
    expect(categoryFor("Fuel Bay Gate")).toBe("gate");
  });
});

describe("outside the fence means outside, not on it", () => {
  it("measures to the nearest EDGE, not to the nearest vertex", () => {
    // Mid-way along the southern edge, 1 m below it. A vertex-only measure
    // would report ~550 m, which is how this check used to be got wrong.
    expect(metresToRing([34.385, -0.825009], RING)).toBeLessThan(2);
  });

  it("does not flag a gate drawn ON the perimeter", () => {
    // Sukari's Main Gate is 7.5 m off the fence line and ray casting puts it
    // outside. It is the site's own front gate.
    expect(outsideRing([[34.385, -0.8250607]], RING)).toBe(false);
  });

  it("still flags something genuinely beyond the fence", () => {
    // Kabras' distillery gates are hundreds of metres out, inside another
    // fence. That is the case the flag exists for.
    expect(outsideRing([[34.385, -0.8280]], RING)).toBe(true);
  });

  it("flags a polygon with any vertex well outside", () => {
    expect(outsideRing([[34.385, -0.820], [34.385, -0.8280]], RING)).toBe(true);
  });
});

describe("the vocabulary the second and third surveys needed", () => {
  it("reads WB as the weighbridge a mill means by it", () => {
    expect(categoryFor("Commerical WB")).toBe("weighing");
    expect(categoryFor("Cane WB")).toBe("weighing");
  });

  it("does not find a WB inside another word", () => {
    expect(categoryFor("Webridge Office")).not.toBe("weighing");
  });

  it("does not mistake WH for WB", () => {
    // "Main Entrance WH" is a warehouse, and it is read as the entrance it is.
    expect(categoryFor("Main Entrance WH")).toBe("gate");
  });

  it("reads an entrance as a gate", () => {
    expect(categoryFor("Factory Entrance")).toBe("gate");
  });

  it("reads every piece of a scrap yard as the yard, not just the named one", () => {
    for (const n of ["Scrap yard", "Scrap CNTR", "Scrap LS"]) {
      expect(categoryFor(n)).toBe("yard");
    }
  });

  it("reads the bagasse houses however the survey spells them", () => {
    for (const n of ["Bagasee HSE LS", "Bagasse House", "Bagase RS"]) {
      expect(categoryFor(n)).toBe("storage");
    }
  });

  it("reads a river as water rather than as a site", () => {
    expect(categoryFor("MOLO RIVER 2")).toBe("water");
  });

  it("strips a camera count written with codes this survey uses", () => {
    // G6 (not just G6B) and Bullet, in Nzoia's and Menengai's exports.
    expect(cleanName("Scrap yard (1 G6)")).toBe("Scrap yard");
    expect(cleanName("Main Gate (1PTZ, 1lpr, 1Bullet)")).toBe("Main Gate");
  });

  it("still leaves a real parenthetical alone", () => {
    expect(cleanName("Mufindi Paper Mills Ltd (Kasulu)")).toBe("Mufindi Paper Mills Ltd (Kasulu)");
  });
});

describe("what Google Earth named for the surveyor", () => {
  it("treats an Untitled label as no label", () => {
    expect(isPlaceholderName("Untitled polygon")).toBe(true);
    expect(isPlaceholderName("Untitled placemark")).toBe(true);
    expect(isPlaceholderName("  untitled Image Overlay ")).toBe(true);
  });

  it("leaves a real name alone", () => {
    expect(isPlaceholderName("Big Farm")).toBe(false);
    expect(isPlaceholderName("Untitledness Yard")).toBe(false);
  });

  it("drops an Untitled placemark from the parse", () => {
    const kml = `<Placemark><name>Untitled polygon</name>
      <Point><coordinates>35.9,-0.22,0</coordinates></Point></Placemark>
      <Placemark><name>Big Farm</name>
      <Point><coordinates>35.9,-0.22,0</coordinates></Point></Placemark>`;
    expect(parseKml(kml).map((f) => f.name)).toEqual(["Big Farm"]);
  });
});

describe("the site fence is the biggest polygon by area", () => {
  it("measures a ring in square metres", () => {
    // A 0.01 x 0.01 degree box at the equator is close to 1.24 km2.
    const box = [[35.0, 0.0], [35.01, 0.0], [35.01, 0.01], [35.0, 0.01]];
    expect(ringAreaM2(box) / 1e6).toBeGreaterThan(1.2);
    expect(ringAreaM2(box) / 1e6).toBeLessThan(1.3);
  });

  it("prefers a large ring over one with more vertices", () => {
    // Menengai's Big Farm has 10 vertices; the river outlines have 9 each and
    // are a fiftieth of the size. Vertex count is not the question.
    const big   = [[35.0, 0.0], [35.05, 0.0], [35.05, 0.05], [35.0, 0.05]];
    const fussy = [[35.0, 0.0], [35.001, 0.0], [35.002, 0.0005], [35.002, 0.001],
                   [35.001, 0.0015], [35.0, 0.001]];
    expect(ringAreaM2(big)).toBeGreaterThan(ringAreaM2(fussy));
    expect(fussy.length).toBeGreaterThan(big.length);
  });
});
