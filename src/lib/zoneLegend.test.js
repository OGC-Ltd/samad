/* The map key, and the promise it makes.
 *
 * A key is a reading of the map in front of you. The old one was a constant
 * listing twelve land uses and was shown to every organisation, so Sukari —
 * which carries three zones — was handed a key naming Nursery, Rain-fed,
 * Wetland and Haulage road, none of which are anywhere on its map. What is
 * pinned here is that the key can only name what is drawn.
 */

import { describe, it, expect } from "vitest";
import { legendFor, zoneColor, ZONE_STYLE, ZONE_LEGEND } from "./zoneLegend";

const labels = (cats) => legendFor(cats).map((r) => r.label);
const keys   = (cats) => legendFor(cats).map((r) => r.key);

describe("legendFor", () => {
  it("names only the categories the organisation actually has", () => {
    // West Kenya's six geofences are three factory and three unclassified.
    expect(labels(["factory", "other"])).toEqual(["Factory", "Other"]);
  });

  it("does not invent the rest of the catalogue", () => {
    const out = labels(["factory", "other"]);
    for (const absent of ["Nursery", "Rain-fed", "Wetland", "Haulage road", "Farm block"]) {
      expect(out).not.toContain(absent);
    }
  });

  it("is empty when nothing is drawn", () => {
    expect(legendFor([])).toEqual([]);
  });

  /* Keep-outs and gates lead. They are the only entries describing somewhere a
   * machine should not be, and a key that buries them under nine land uses is a
   * key read too late. */
  it("puts the things a machine must avoid first", () => {
    expect(keys(["farm", "road", "restricted", "gate"]))
      .toEqual(["restricted", "gate", "farm", "road"]);
  });

  it("orders by the catalogue, not by the order it was handed", () => {
    expect(keys(["road", "nursery", "farm"])).toEqual(["farm", "nursery", "road"]);
  });

  it("carries each category's own colour", () => {
    expect(legendFor(["restricted"])[0].color).toBe(ZONE_STYLE.restricted.color);
  });

  /* The backend derives a category from the zone's name, so it can start
   * emitting one this list has never seen. Appending it grey is a visible
   * prompt; dropping it would draw a colour with no key entry at all. */
  it("keeps an unranked category rather than dropping it", () => {
    const out = keys(["farm", "quarry"]);
    expect(out).toContain("quarry");
    expect(out.indexOf("quarry")).toBeGreaterThan(out.indexOf("farm"));
    expect(legendFor(["quarry"])[0].color).toBe(ZONE_STYLE.other.color);
  });

  it("sorts several unranked categories predictably", () => {
    expect(keys(["zeta", "alpha"])).toEqual(["alpha", "zeta"]);
  });

  /* The works-site vocabulary exists because "Farm block" describes nothing on
   * a mill site. Every category the ranking names must have a style, or it
   * would rank into the key and then draw as undefined. */
  it("gives every ranked category a style", () => {
    for (const key of ZONE_LEGEND) expect(ZONE_STYLE[key], key).toBeDefined();
  });

  it("carries the site vocabulary a mill needs", () => {
    expect(labels(["yard", "parking", "workshop", "weighing", "gate"]))
      .toEqual(["Gate", "Yard", "Vehicle park", "Workshop", "Weighbridge"]);
  });
});

/* The site fence was white for satellite imagery, and white on OpenStreetMap's
 * pale land drew nothing at all (operator, 2026-10-09). */
describe("zoneColor", () => {
  it("draws the site perimeter orange on OpenStreetMap, white on satellite", () => {
    expect(zoneColor("perimeter", "osm")).toBe("#ea580c");
    expect(zoneColor("perimeter", "google")).toBe(ZONE_STYLE.perimeter.color);
  });

  it("leaves categories without an OSM colour alone on either base", () => {
    expect(zoneColor("farm", "osm")).toBe(ZONE_STYLE.farm.color);
    expect(zoneColor("farm", "google")).toBe(ZONE_STYLE.farm.color);
    expect(zoneColor("quarry", "osm")).toBe(ZONE_STYLE.other.color);
  });

  it("keys the swatch to the map in front of you", () => {
    expect(legendFor(["perimeter"], "osm")[0].color).toBe("#ea580c");
    expect(legendFor(["perimeter"], "google")[0].color).toBe(ZONE_STYLE.perimeter.color);
  });
});
