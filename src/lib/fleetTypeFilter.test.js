/* The Fleets funnel's grouping and predicate.
 *
 * The thing worth pinning here is the one that decided the design: the two
 * fleets name their machines in completely different ways, and a filter that
 * only understood one of them would be useless on the other. Kasulu/Mufindi
 * carry an equipment code in the name ("MUFINDI: OPTIM - CM 01"); Sukari's id
 * is a bare plate ("KHMA 858U") with the machine only in the descriptive name
 * ("BOMAG COMPACTOR BW213PD-40"). Grouping on spriteKind is what lets one
 * funnel serve both, so these tests use fixtures in BOTH shapes.
 *
 * The second is that the rows must SUM to the fleet. A funnel whose parts
 * disagree with the whole is the same bug the Analytics filter had — a donut
 * claiming 218 machines above a list of 32 — and it is why fleetType can never
 * return null.
 */

import { describe, it, expect } from "vitest";
import { fleetTypeOptions, matchesTypeFilter, fleetType, fleetTypeLabel } from "./vehicleMap";

/** Mufindi's shape: the equipment code lives in `id`. */
const coded = (id) => ({ id, name: id });
/** Sukari's shape: `id` is a plate, the machine is in `name`. */
const plated = (id, name, vehicleType) => ({ id, name, vehicleType });

describe("fleetType", () => {
  it("reads the equipment code out of a coded name", () => {
    expect(fleetType(coded("MUFINDI: EX 07"))).toBe("ex");
    expect(fleetType(coded("MUFINDI: OPTIM - CM 01"))).toBe("comp");
  });

  it("reads the machine out of a descriptive name when the id is a bare plate", () => {
    expect(fleetType(plated("KHMA 858U", "BOMAG COMPACTOR BW213PD-40"))).toBe("comp");
    expect(fleetType(plated("KBH 123A", "Faw Prime mover CA4181"))).toBe("truck");
  });

  it("draws generators and motorbikes as themselves", () => {
    expect(fleetType(coded("MUFINDI - DG 13"))).toBe("gen");
    expect(fleetType(plated("KHMA 900A", "Perkins Generator 100kVA"))).toBe("gen");
    expect(fleetType(plated("KMFA 123B", "Honda Motorbike"))).toBe("mc");
    expect(fleetType(plated("KMFA 124B", "Boxer", "MOTORCYCLE"))).toBe("mc");
    expect(fleetType(plated("KMGJ 333W", "West Sugar-Bike-KMGJ 333W"))).toBe("mc");
    expect(fleetType(plated("KMFU 927U", "Menengai - KMFU 927U"))).toBe("mc");
    expect(fleetType(plated("KMHA 326X", "WKS - Naitiri - SAME 9358 (KMHA 326X)"))).toBe("mtr");
    expect(fleetType(plated("KDA 123A", "Menengai - KDA 123A"))).toBe("truck");
    expect(fleetTypeLabel("gen")).toBe("Generator");
    expect(fleetTypeLabel("mc")).toBe("Motorbike");
  });

  it("never returns null, an unrecognisable unit is still offered as a truck", () => {
    expect(fleetType(plated("MUFINDI: 013", "MUFINDI: 013"))).toBe("truck");
    expect(fleetType({})).toBe("truck");
  });
});

describe("fleetTypeOptions", () => {
  const FLEET = [
    coded("MUFINDI: EX 01"), coded("MUFINDI: EX 02"), coded("MUFINDI: EX 03"),
    coded("MUFINDI: DZ 01"),
    plated("KHMA 858U", "BOMAG COMPACTOR BW213PD-40"),
    plated("KBH 123A", "Faw Prime mover CA4181"),
    plated("KBH 124A", "Mahindra 575 DI"),
  ];

  it("is the organisation's own machines, biggest first", () => {
    expect(fleetTypeOptions(FLEET).map((o) => [o.kind, o.count]))
      .toEqual([["ex", 3], ["comp", 1], ["dz", 1], ["mtr", 1], ["truck", 1]]);
  });

  it("labels each row in prose", () => {
    expect(fleetTypeOptions(FLEET)[0]).toMatchObject({ kind: "ex", label: "Excavator" });
  });

  it("rows sum to the fleet, so the funnel can never disagree with ALL UNITS", () => {
    expect(fleetTypeOptions(FLEET).reduce((n, o) => n + o.count, 0)).toBe(FLEET.length);
  });

  it("offers nothing for an empty fleet rather than throwing", () => {
    expect(fleetTypeOptions([])).toEqual([]);
    expect(fleetTypeOptions(undefined)).toEqual([]);
  });
});

describe("matchesTypeFilter", () => {
  const excavator = coded("MUFINDI: EX 01");
  const tractor = plated("KBH 124A", "Mahindra 575 DI");

  it("passes everything when nothing is ticked, an empty selection is 'no filter'", () => {
    for (const empty of [[], new Set(), null, undefined]) {
      expect(matchesTypeFilter(excavator, empty)).toBe(true);
      expect(matchesTypeFilter(tractor, empty)).toBe(true);
    }
  });

  it("keeps only the ticked types", () => {
    expect(matchesTypeFilter(excavator, ["ex"])).toBe(true);
    expect(matchesTypeFilter(tractor, ["ex"])).toBe(false);
  });

  it("accepts a Set as well as an array, since the menu holds one of each", () => {
    expect(matchesTypeFilter(excavator, new Set(["ex", "dz"]))).toBe(true);
    expect(matchesTypeFilter(tractor, new Set(["ex", "dz"]))).toBe(false);
  });

  it("selecting every present type keeps the whole fleet", () => {
    const fleet = [excavator, tractor];
    const all = fleetTypeOptions(fleet).map((o) => o.kind);
    expect(fleet.filter((v) => matchesTypeFilter(v, all))).toHaveLength(2);
  });
});

describe("fleetTypeLabel", () => {
  it("names the kinds the map draws", () => {
    expect(fleetTypeLabel("mtr")).toBe("Tractor");
    expect(fleetTypeLabel("lmv")).toBe("Light Vehicle");
  });

  it("returns an unknown kind unchanged rather than inventing a name", () => {
    expect(fleetTypeLabel("zzz")).toBe("zzz");
  });
});
