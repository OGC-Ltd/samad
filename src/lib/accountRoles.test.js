import { describe, it, expect } from "vitest";
import { uniqueRoles, roleNames } from "./accountRoles";

/** Four organisations, the same role in each — the reported case. */
const sysAdminEverywhere = (slugPerOrg) => ({
  platformRoles: [{ slug: "platform-admin", name: "Platform Administrator" }],
  organisations: ["Sukari", "Menengai", "Kabras", "West Sugar"].map((name, i) => ({
    id: `org-${i}`,
    name,
    // Per-org Role rows. `slugPerOrg` makes each one spell its slug
    // differently, which is what defeated the original slug-keyed version.
    roles: [{ slug: slugPerOrg ? `system-admin-${i}` : "system-admin", name: "System Administrator" }],
  })),
});

describe("uniqueRoles", () => {
  it("reports one role for the same role held in four organisations", () => {
    // The exact complaint: [Platform Administrator, System Administrator,
    // System Administrator] was wrong; two entries is right.
    const held = uniqueRoles(sysAdminEverywhere(false));
    expect(held.map((r) => r.name)).toEqual([
      "Platform Administrator",
      "System Administrator",
    ]);
    expect(held).toHaveLength(2);
  });

  it("still merges when each organisation spells the slug differently", () => {
    // Why the key is the name: a Role row is per-organisation, so four sites
    // are four rows and their slugs need not match. Slug-keying merged none.
    const held = uniqueRoles(sysAdminEverywhere(true));
    expect(held.map((r) => r.name)).toEqual([
      "Platform Administrator",
      "System Administrator",
    ]);
  });

  it("ignores case and surrounding space when deciding sameness", () => {
    const held = uniqueRoles({
      platformRoles: [],
      organisations: [
        { name: "A", roles: [{ slug: "ops", name: "Fleet Operator" }] },
        { name: "B", roles: [{ slug: "ops", name: "  fleet operator " }] },
      ],
    });
    expect(held).toHaveLength(1);
    // The first spelling seen is the one shown — not the normalised key.
    expect(held[0].name).toBe("Fleet Operator");
  });

  it("keeps every organisation a role is held in", () => {
    const [, sysAdmin] = uniqueRoles(sysAdminEverywhere(false));
    expect(sysAdmin.orgs).toEqual(["Sukari", "Menengai", "Kabras", "West Sugar"]);
  });

  it("lets a platform role outrank an identically named org role", () => {
    // Applying everywhere is a strictly bigger claim than holding it at one
    // site, so the chip must not end up captioned with a subset of orgs.
    const held = uniqueRoles({
      platformRoles: [{ slug: "sysadmin", name: "System Administrator" }],
      organisations: [{ name: "Sukari", roles: [{ slug: "sysadmin", name: "System Administrator" }] }],
    });
    expect(held).toHaveLength(1);
    expect(held[0].platform).toBe(true);
  });

  it("does not list one organisation twice for a doubly granted role", () => {
    const held = uniqueRoles({
      platformRoles: [],
      organisations: [{
        name: "Sukari",
        roles: [
          { slug: "sysadmin", name: "System Administrator" },
          { slug: "sys-admin", name: "System Administrator" },
        ],
      }],
    });
    expect(held).toHaveLength(1);
    expect(held[0].orgs).toEqual(["Sukari"]);
  });

  it("survives the shapes a missing endpoint returns", () => {
    expect(uniqueRoles(undefined)).toEqual([]);
    expect(uniqueRoles({})).toEqual([]);
    expect(uniqueRoles({ platformRoles: [], organisations: [{ name: "A" }] })).toEqual([]);
    // A nameless role is not a chip anybody can read, so it is not one.
    expect(uniqueRoles({ organisations: [{ name: "A", roles: [{ slug: "x", name: "" }] }] })).toEqual([]);
  });
});

describe("roleNames", () => {
  it("de-duplicates the bio line the same way", () => {
    expect(roleNames([
      { name: "System Administrator" },
      { name: "System Administrator" },
      { name: "Fleet Operator" },
    ])).toBe("System Administrator, Fleet Operator");
  });

  it("is empty for nothing at all", () => {
    expect(roleNames([])).toBe("");
    expect(roleNames(undefined)).toBe("");
  });
});
