import { describe, it, expect } from "vitest";
import { plateIn, displayPlate, mapLabel } from "./plate";

describe("plateIn", () => {
  it("reads a plate that is the whole name", () => {
    expect(plateIn("KCS 969P")).toBe("KCS 969P");
    expect(plateIn("KHMA 826T")).toBe("KHMA 826T");
  });

  it("finds the plate inside a longer provider name", () => {
    expect(plateIn("CPO - Menengai - KCC 386Z - FMB140")).toBe("KCC 386Z");
    expect(plateIn("SEM 9685", "WKS - Naitiri - SEM 9685(KHMA 324X)-18L/H")).toBe("KHMA 324X");
    expect(plateIn("WKS - Naitiri - KCS 649Gl")).toBe("KCS 649G");
    expect(plateIn("KCS969P")).toBe("KCS 969P");
  });

  it("leaves names with no plate alone", () => {
    expect(plateIn("MUFINDI: 012", "MUFINDI: 012")).toBeNull();
    expect(plateIn("CAT 214B")).toBeNull();
    expect(plateIn("LOGYARD - Menengai - JCB 1 H00052413")).toBeNull();
    expect(plateIn("XKCS 969P")).toBeNull();
    expect(plateIn(null, undefined)).toBeNull();
  });
});

describe("mapLabel", () => {
  const unit = (name, id = name) => ({ id, name, regPlate: plateIn(id, name) });
  it("shows only the licence number, for road vehicles and tractors", () => {
    expect(mapLabel(unit("Faw Prime Mover CA 4181 KDL 712E"), "sukari")).toBe("KDL 712E");
    expect(mapLabel(unit("Toyota Double Cab GUN125R-DJFLXJ KDM 341M"), "sukari")).toBe("KDM 341M");
    expect(mapLabel(unit("Mahindra 9200 4WD KTCC 787D"), "sukari")).toBe("KTCC 787D");
    expect(mapLabel(unit("WKS - Kabras KTCB358X"), "kabras")).toBe("KTCB 358X");
    expect(mapLabel(unit("FG - Menengai - KCC 385Z"), "menengai")).toBe("KCC 385Z");
    expect(mapLabel(unit("125F Bell 38 KHMA 858U"), "sukari")).toBe("KHMA 858U");
  });
  it("falls back to the id where there is no plate", () => {
    expect(mapLabel(unit("LOGYARD - Menengai - JCB 1 H00052413"), "menengai")).toBe("LOGYARD - Menengai - JCB 1 H00052413");
  });
  it("shows the id at Kasulu", () => {
    expect(mapLabel(unit("MUFINDI: EX 11"), "kasulu")).toBe("MUFINDI: EX 11");
    expect(mapLabel({ id: "MUFINDI - LMV 13", name: "MUFINDI - LMV 13 KDA 123A", regPlate: "KDA 123A" }, "kasulu")).toBe("MUFINDI - LMV 13");
  });
});

describe("displayPlate", () => {
  it("prints the plate where there is one, else the id", () => {
    expect(displayPlate({ id: "CPO - Menengai - KCC 386Z - FMB140", regPlate: "KCC 386Z" })).toBe("KCC 386Z");
    expect(displayPlate({ id: "MUFINDI: 012", regPlate: null })).toBe("MUFINDI: 012");
  });
});
