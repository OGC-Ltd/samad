// The grader, tested where it can be: `accessIn` is the pure half of
// usePermissions, and it is what decides whether an organisation has any
// screen in it at all.
//
// This exists because of a real blank page. A membership can carry trip and
// vehicle permissions and none of the five NAV_TABS ones, and the shell used
// to render that as an empty document — header, footer, nothing between, no
// text saying why. The wildcard is the only reason a platform admin never saw
// it, which is also why the wildcard needs a test of its own: it is the thing
// that hides the bug from whoever is most likely to be looking.

import { describe, it, expect } from "vitest";
import { accessIn, canInOrg } from "./usePermissions";

/** The shape /auth/me returns, trimmed to what the grader reads. */
const org = (code, permissions) => ({ id: `id-${code}`, code, permissions, vehicleIds: null });

// The five permissions the footer nav gates its tabs on. Kept as literals
// rather than imported from FooterNav, which pulls in CSS and icons.
const SCREENS = ["map:read", "driver:read", "sensor:read", "analytics:read", "weighbridge:read"];

const ORGS = [
  // Taken from this deployment: a membership with plenty of permissions and
  // not one screen among them.
  org("SUKARI", ["vehicle:delete", "vehicle:export", "trip:read", "trip:create", "fuel_theft:read"]),
  org("MENENGAI", ["vehicle:read", "map:read", "driver:read", "sensor:read", "analytics:read", "weighbridge:read"]),
  org("KASULU", ["platform:admin", "trip:read"]),
];

describe("accessIn", () => {
  it("answers for an organisation that is not the one on screen", () => {
    expect(accessIn(ORGS, "menengai").can("map:read")).toBe(true);
    expect(accessIn(ORGS, "sukari").can("map:read")).toBe(false);
  });

  it("maps a company id to its org code", () => {
    // `westsugar` -> WESTSUGAR is the table; anything unlisted upper-cases.
    expect(accessIn([org("WESTSUGAR", ["map:read"])], "westsugar").can("map:read")).toBe(true);
    expect(accessIn([org("OTHER", ["map:read"])], "other").can("map:read")).toBe(true);
  });

  it("honours the platform:admin wildcard the server honours", () => {
    expect(accessIn(ORGS, "kasulu").can("map:read")).toBe(true);
    expect(accessIn(ORGS, "kasulu").can("anything:at:all")).toBe(true);
  });

  it("reports the organisation that opens NO screen", () => {
    // The blank page, stated as the condition that produced it.
    expect(SCREENS.some(accessIn(ORGS, "sukari").can)).toBe(false);
    expect(SCREENS.some(accessIn(ORGS, "menengai").can)).toBe(true);
  });

  it("grants nothing for an organisation the account is not in", () => {
    // Null and "no permissions" must land in the same place — a membership
    // that is absent cannot be more permissive than one that is empty.
    const absent = accessIn(ORGS, "nowhere");
    expect(absent.org).toBe(null);
    expect(SCREENS.some(absent.can)).toBe(false);
    expect(SCREENS.some(accessIn(undefined, "sukari").can)).toBe(false);
  });
});


/**
 * Grading by organisation ID rather than by the company on screen.
 *
 * This is what lets one administrator edit and delete across every
 * organisation they were added to WITHOUT switching company first. The server
 * has always allowed it — middleware/authorize.ts takes the organisation from
 * the request path and says outright that the caller's home org "says nothing
 * about the request in front of us" — but the roster graded every row against
 * the active company, so the only way to reach another tenant's people was to
 * become that tenant.
 *
 * The rule these pin: reach is per organisation, in BOTH directions. Holding
 * user:delete at A must not draw a Delete button on a row from B, and lacking
 * it at B must not hide one on a row from A.
 */
describe("canInOrg", () => {
  it("grades a permission held in that organisation", () => {
    expect(canInOrg(ORGS, "id-MENENGAI", "map:read")).toBe(true);
  });

  it("refuses a permission held only in ANOTHER organisation", () => {
    // The whole bug in one assertion: map:read at MENENGAI is not map:read
    // at SUKARI, however the header happens to be set.
    expect(canInOrg(ORGS, "id-SUKARI", "map:read")).toBe(false);
  });

  it("honours the wildcard, so a platform administrator grades true", () => {
    expect(canInOrg(ORGS, "id-KASULU", "user:delete")).toBe(true);
  });

  it("refuses an organisation the account does not hold at all", () => {
    // Not "unknown, so allow". An org missing from /me is one this account
    // was never added to, and the server would refuse the write anyway.
    expect(canInOrg(ORGS, "id-NOWHERE", "user:read")).toBe(false);
  });

  it("refuses when no organisation is named", () => {
    // A row with no scopeOrgId is a row whose actions have no address. It must
    // not fall back to the active company, which is how a delete would be sent
    // to the wrong tenant.
    expect(canInOrg(ORGS, null, "user:read")).toBe(false);
    expect(canInOrg(ORGS, undefined, "user:read")).toBe(false);
  });

  it("survives an empty or missing org list", () => {
    expect(canInOrg([], "id-MENENGAI", "map:read")).toBe(false);
    expect(canInOrg(undefined, "id-MENENGAI", "map:read")).toBe(false);
  });

  it("treats an organisation with no permissions as no access, not as all", () => {
    expect(canInOrg([org("EMPTY", [])], "id-EMPTY", "user:read")).toBe(false);
  });

  /**
   * The cross-org administrator, stated as the requirement rather than as
   * code: added as System Administrator at two companies, they administer
   * both — and nothing else.
   */
  it("lets one administrator reach every organisation they were added to, and no others", () => {
    const admin = [
      org("A", ["user:read", "user:update", "user:delete", "user:assign_role"]),
      org("B", ["user:read", "user:update", "user:delete", "user:assign_role"]),
      org("C", ["vehicle:read"]),
    ];
    expect(canInOrg(admin, "id-A", "user:delete")).toBe(true);
    expect(canInOrg(admin, "id-B", "user:delete")).toBe(true);
    // Added to C, but not as an administrator there.
    expect(canInOrg(admin, "id-C", "user:delete")).toBe(false);
    // Never added to D at all.
    expect(canInOrg(admin, "id-D", "user:delete")).toBe(false);
  });
});
