import { describe, it, expect } from "vitest";
import { groupOrganisations } from "./groupDisplay";

describe("groupOrganisations", () => {
  it("lists each group organisation once, with a logo and its groups", () => {
    const orgs = groupOrganisations([
      { id: "g1", name: "Night haulage", organisation: { name: "Kilimo Transporters", logoUrl: null } },
      { id: "g2", name: "Day haulage", organisation: { name: "kilimo transporters ", logoUrl: "/logo/g2" } },
      { id: "g3", name: "Office", organisation: null },
      { id: "g4", name: "Lake", organisation: { name: "Lakeside Haulage", logoUrl: null } },
    ]);
    expect(orgs.map((o) => o.name)).toEqual(["Kilimo Transporters", "Lakeside Haulage"]);
    expect(orgs[0]).toMatchObject({ logoUrl: "/logo/g2", groupIds: ["g1", "g2"], groupNames: ["Night haulage", "Day haulage"] });
  });

  it("is empty without groups", () => {
    expect(groupOrganisations(undefined)).toEqual([]);
  });
});
