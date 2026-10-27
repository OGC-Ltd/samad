import { describe, it, expect } from "vitest";
import { resolveWayBack, labelFor, crumbFor } from "./useWayBack";

/** The real sidebar order and permissions, copied rather than imported —
 *  see resolveWayBack's note on why the constant is a parameter. */
const NAV = [
  { key: "fleet",        label: "Live Map",     permission: "map:read"         },
  { key: "drivers",      label: "Drivers",      permission: "driver:read"      },
  { key: "analytics",    label: "Analytics",    permission: "analytics:read"   },
  { key: "maintenance",  label: "Maintenance",  permission: "sensor:read"      },
  { key: "weighbridges", label: "Weighbridges", permission: "weighbridge:read" },
];

const holding = (...slugs) => (p) => slugs.includes(p);

describe("resolveWayBack", () => {
  it("sends anyone who can open the map to the map", () => {
    const w = resolveWayBack(NAV, holding("map:read", "sensor:read"));
    expect(w.tab).toBe("fleet");
    expect(w.label).toBe("Back to the fleet");
    expect(w.crumb).toBe("Fleet");
  });

  it("names the first screen actually held when the map is not", () => {
    // The case the hard-coded "Back to the fleet" got wrong: this account has
    // no map:read, so naming the fleet promised a screen it cannot open.
    const w = resolveWayBack(NAV, holding("sensor:read"));
    expect(w.tab).toBe("maintenance");
    expect(w.label).toBe("Back to Maintenance");
    expect(w.crumb).toBe("Maintenance");
  });

  it("follows sidebar order, not permission order", () => {
    // Holding both, Drivers wins over Weighbridges because it comes first in
    // the nav — the same order App uses to correct a disallowed tab.
    expect(resolveWayBack(NAV, holding("weighbridge:read", "driver:read")).tab).toBe("drivers");
  });

  it("names nothing when the account holds no screen at all", () => {
    // A real state: a member of an organisation with no grants. App draws the
    // locked empty state with its own way out; promising one here would lie.
    const w = resolveWayBack(NAV, holding());
    expect(w.tab).toBeNull();
    expect(w.label).toBe("Back");
    expect(w.crumb).toBe("Back");
  });

  it("does not fall over on an empty nav", () => {
    expect(resolveWayBack([], holding("map:read")).tab).toBeNull();
    expect(resolveWayBack(undefined, holding("map:read")).tab).toBeNull();
  });
});

describe("the two voices", () => {
  it("keeps the operator's word for the map in both forms", () => {
    // "Live Map" is the nav item's name, not what anybody calls the screen.
    expect(labelFor({ key: "fleet", label: "Live Map" })).toBe("Back to the fleet");
    expect(crumbFor({ key: "fleet", label: "Live Map" })).toBe("Fleet");
  });

  it("uses the sidebar's own name for everything else", () => {
    expect(labelFor({ key: "maintenance", label: "Maintenance" })).toBe("Back to Maintenance");
    expect(crumbFor({ key: "maintenance", label: "Maintenance" })).toBe("Maintenance");
  });
});
