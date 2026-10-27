import { describe, it, expect, vi, beforeEach } from "vitest";
import { PAGE_TOURS, accountBehind, buildPageTourSteps, buildTourSteps, claimFirstRun, coveredItems, esc, hasNewItems, markCovered, markPageTourSeen, pageTourSeen, tourDue, tourSeen } from "./productTour";

const store = new Map();
vi.stubGlobal("localStorage", {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
});

// Stand-in elements: the test cares which steps survive, not what they point at.
const on = (...marks) => (m) => (marks.includes(m) ? { mark: m } : null);
const titles = (steps) => steps.map((s) => s.popover.title);
const DESKTOP = on("org", "status", "nav", "fleets", "map-search", "map-tools", "map", "alerts", "account");

describe("buildTourSteps", () => {
  it("walks a full-access desktop account through every part of the app", () => {
    expect(titles(buildTourSteps({ firstName: "Silas", orgName: "Sukari", visible: DESKTOP }))).toEqual([
      "Welcome, Silas", "Your Organisation", "The Fleet at a Glance", "The Screens", "Fleets and Reports",
      "Find Anything", "Map Tools", "Open a Unit", "Notifications", "Your Account",
    ]);
  });

  // An account without the map sees nothing about it, even where the sidebar
  // still draws those controls disabled.
  it("leaves out the map for an account that cannot open it", () => {
    const can = (p) => p !== "map:read";
    const t = titles(buildTourSteps({ can, visible: DESKTOP }));
    expect(t).toEqual(["Welcome to Samad Resources", "Your Organisation", "The Screens", "Your Account"]);
  });

  it("drops a step whose control is not on screen (a tablet's folded sidebar)", () => {
    const t = titles(buildTourSteps({ visible: on("org", "nav", "map-search", "map-tools", "map", "alerts", "account") }));
    expect(t).not.toContain("The Fleet at a Glance");
    expect(t).not.toContain("Fleets and Reports");
    expect(t).toContain("The Screens");
  });

  it("takes the phone's controls where the desktop's are not on screen", () => {
    const steps = buildTourSteps({ visible: on("m-org", "m-tabs", "m-search", "map", "m-alerts", "m-account") });
    expect(titles(steps)).toEqual([
      "Welcome to Samad Resources", "Your Organisation", "The Screens", "Find Anything", "Open a Unit", "Notifications", "Your Account",
    ]);
    expect(steps[1].element).toEqual({ mark: "m-org" });
  });

  it("lists only the screens and reports this account may open", () => {
    const can = (p) => ["map:read", "weighbridge:read", "telemetry:read", "logbook:read"].includes(p);
    const steps = buildTourSteps({ can, visible: DESKTOP });
    const screens = steps.find((s) => s.popover.title === "The Screens").popover.description;
    expect(screens).toContain("Live Map");
    expect(screens).toContain("Weighbridges");
    expect(screens).not.toContain("Analytics");
    const reports = steps.find((s) => s.popover.title === "Fleets and Reports").popover.description;
    expect(reports).toContain("Logbook");
    expect(reports).not.toContain("Fuel Audit");
  });

  it("includes Alerts for roles with the dedicated alerts permission", () => {
    const can = (p) => p === "alerts:read";
    const steps = buildTourSteps({ can, visible: DESKTOP });
    const screens = steps.find((s) => s.popover.title === "The Screens").popover.description;
    expect(screens).toContain("Alerts");
    expect(screens).not.toContain("Analytics");
  });

  it("names Halted and Fuel alerts only when the rail draws them", () => {
    const tools = (vis) => buildTourSteps({ visible: vis }).find((s) => s.popover.title === "Map Tools").popover.description;
    expect(tools(DESKTOP)).not.toContain("Halted");
    expect(tools(on("map-tools", "map-halted", "map-fuel"))).toContain("Halted");
  });

  it("says how to switch organisation only to an account that can", () => {
    const one = buildTourSteps({ orgName: "Sukari", visible: DESKTOP })[1].popover;
    const many = buildTourSteps({ orgName: "Sukari", multiOrg: true, visible: DESKTOP })[1].popover;
    expect(one.title).toBe("Your Organisation");
    expect(many.title).toBe("Your Organisations");
    expect(many.description).toContain("Switch here");
  });

  it("escapes names that reach the popover as HTML", () => {
    expect(esc('<img src=x onerror="1">')).toBe("&lt;img src=x onerror=&quot;1&quot;&gt;");
    expect(buildTourSteps({ firstName: "<b>", visible: DESKTOP })[0].popover.title).toBe("Welcome, &lt;b&gt;");
  });
});

// Operator, 2026-10-09: the tour came back at every sign-in (recorded only when
// closed by ✕, Esc or Done), and then on every other machine (recorded only in
// the browser).
describe("claimFirstRun", () => {
  beforeEach(() => store.clear());

  it("opens the tour once, and records it as it opens", () => {
    expect(claimFirstRun("u1", null)).toBe(true);
    // Never closed (a reload, a sign-out): still seen at the next sign-in.
    expect(tourSeen("u1")).toBe(true);
    expect(claimFirstRun("u1", null)).toBe(false);
  });

  it("is per person", () => {
    claimFirstRun("u1", null);
    expect(claimFirstRun("u2", null)).toBe(true);
  });

  it("does not open on a new machine once the account has had it", () => {
    expect(tourDue("u1", 1)).toBe(false);
    expect(claimFirstRun("u1", 1)).toBe(false);
  });

  it("opens again for everybody when the tour version is bumped past the account's", () => {
    expect(tourDue("u1", 0)).toBe(true);
  });

  it("falls back to this browser's record on a server that does not keep it", () => {
    expect(claimFirstRun("u1", undefined)).toBe(true);
    expect(claimFirstRun("u1", undefined)).toBe(false);
  });
});

describe("accountBehind", () => {
  beforeEach(() => store.clear());

  it("asks to tell the account about a tour this browser has seen and it has not", () => {
    claimFirstRun("u1", null);
    expect(accountBehind("u1", null)).toBe(true);
    expect(accountBehind("u1", 1)).toBe(false);
  });

  it("has nothing to tell before this browser has seen it, or a server that does not keep it", () => {
    expect(accountBehind("u1", null)).toBe(false);
    claimFirstRun("u1", undefined);
    expect(accountBehind("u1", undefined)).toBe(false);
  });
});

describe("page tours", () => {
  const on = (...marks) => (m) => (marks.includes(m) ? { mark: m } : null);

  it("walks the parts of the page that are on screen, then points at the Guide", () => {
    const steps = buildPageTourSteps("alerts", { visible: on("alerts-stats", "page-table", "account") });
    expect(steps.map((x) => x.popover.title)).toEqual(["Alerts", "Where Things Stand", "Decide", "The Guide"]);
    expect(steps[0].element).toBeUndefined();
    expect(steps[1].element).toEqual({ mark: "alerts-stats" });
  });

  it("words a section by what it shows, where two fleets show different things", () => {
    const block = (text) => (m) => (m === "an-coverage" ? { textContent: text } : null);
    const title = (text) => buildPageTourSteps("analytics", { visible: block(text) })[1].popover.title;
    expect(title("Fleet coverage 594 FLEET Reporting now 154")).toBe("Fleet Coverage");
    expect(title("Operational today 22 WORKING")).toBe("Operational Today");
  });

  it("has nothing for a page without a tour", () => {
    expect(buildPageTourSteps("fleet", { visible: on("account") })).toEqual([]);
  });

  it("keeps every page's copy free of em dashes, and titles in Title Case", () => {
    for (const t of Object.values(PAGE_TOURS)) {
      for (const [, title, text, alt] of t.steps) {
        if (alt?.description) expect(alt.description).not.toMatch(/—/);
        expect(text).not.toMatch(/—/);
        expect(title.split(" ").filter((w) => !["a", "and", "or", "the", "of", "at", "on", "per", "to", "by"].includes(w)).every((w) => /^[A-Z]/.test(w))).toBe(true);
      }
    }
  });

  it("never covers an item twice: a control another page explained is skipped", () => {
    const vis = on("page-unit", "page-range", "page-run", "page-kpis", "logbook-map", "account");
    const first = buildPageTourSteps("fuelReport", { visible: vis });
    expect(first.map((x) => x.key)).toEqual(["fuelReport:intro", "unit-picker", "period", "run", "fuelReport:page-kpis", "manual"]);
    // Shown on the Fuel Report; the Logbook then has only its own parts left.
    const covered = new Set(first.map((x) => x.key));
    const next = buildPageTourSteps("usageReview", { visible: vis, covered });
    expect(next.map((x) => x.key)).toEqual(["usageReview:intro", "usageReview:page-kpis", "usageReview:logbook-map"]);
  });

  it("has nothing new to show once every part is covered", () => {
    const vis = on("page-pager", "account");
    const covered = new Set(["pager", "manual"]);
    expect(hasNewItems(buildPageTourSteps("drivers", { visible: vis, covered }))).toBe(false);
    expect(hasNewItems(buildPageTourSteps("drivers", { visible: vis }))).toBe(true);
  });

  it("skips the app tour's Guide step once a page tour has covered it", () => {
    const t = buildTourSteps({ visible: DESKTOP, covered: new Set(["manual"]) }).map((x) => x.popover.title);
    expect(t).not.toContain("Your Account");
  });

  it("records covered items per person", () => {
    store.clear();
    markCovered("u1", "pager");
    expect(coveredItems("u1").has("pager")).toBe(true);
    expect(coveredItems("u2").has("pager")).toBe(false);
  });

  it("remembers each page apart, per person", () => {
    store.clear();
    markPageTourSeen("alerts", "u1");
    expect(pageTourSeen("alerts", "u1")).toBe(true);
    expect(pageTourSeen("drivers", "u1")).toBe(false);
    expect(pageTourSeen("alerts", "u2")).toBe(false);
  });
});
