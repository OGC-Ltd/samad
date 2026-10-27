/**
 * The first-time tour (operator, 2026-10-09: "guide a first time user on how
 * they can use the application"), drawn by driver.js in components/shared/
 * ProductTour. This file holds what the tour SAYS and to whom, so that can be
 * tested without a browser.
 *
 * ## Steps point at `data-tour` marks, not at classes
 *
 * Each step names the `data-tour` value of the control it is about — set on
 * that control in AppHeader, SidePanel, MapToolRail, App, MobileHeader and
 * MobileTabBar. The classes on those controls are styling and change with
 * every restyle; the mark is there for the tour alone and says so.
 *
 * ## One list for every screen size and every account
 *
 * A step may name several marks — the desktop control and the phone one — and
 * takes the first that is actually on screen when the tour starts. A step
 * whose control is not on screen is dropped: the sidebar's status cards on a
 * tablet, where the sidebar is an icon rail; the map tools for an account that
 * cannot open the map. Permissions are tested as well as presence, so a step
 * never describes a screen the account cannot open even where its control is
 * drawn disabled.
 *
 * ## Seen once, per person, on any machine
 *
 * The account keeps the tour version the person has been shown (fleet-server
 * users.tour_seen_version, on /auth/me as `user.tourSeenVersion`, written by
 * POST /account/tour), so a person who has had it on one machine does not get
 * it on the next (operator, 2026-10-09: "what if we have over 10 machines").
 * The browser keeps its own record too, for a server that cannot answer and
 * for the moment between opening the tour and the account hearing of it. Both
 * are written when the tour first opens, not when it closes (claimFirstRun).
 * Bump TOUR_VERSION when the app changes enough that everybody should see it
 * again.
 *
 * Copy follows the app's empty-state rule: Title Case titles, no em dashes.
 */

export const TOUR_VERSION = 1;

const keyFor = (userId) => `ft-tour:v${TOUR_VERSION}:${userId ?? "anon"}`;

/** Has this person been shown this version of the tour in this browser? */
export function tourSeen(userId) {
  try { return localStorage.getItem(keyFor(userId)) != null; } catch { return false; }
}

export function markTourSeen(userId) {
  try { localStorage.setItem(keyFor(userId), String(Date.now())); } catch { /* storage off: shown again next time */ }
}

/** Has the account been shown this version? `accountVersion` is
 *  user.tourSeenVersion from /auth/me: null for never, undefined from a
 *  server that does not keep it. */
const seenOnAccount = (accountVersion) => (accountVersion ?? 0) >= TOUR_VERSION;

/** Neither the account nor this browser has had this version of the tour. */
export function tourDue(userId, accountVersion) {
  return !seenOnAccount(accountVersion) && !tourSeen(userId);
}

/**
 * Should the tour open by itself for this person? True once, and recorded in
 * this browser at that moment rather than when the tour closes: driver.js
 * reports only a close by ✕, Esc or Done, so a tour left by reloading,
 * closing the tab or signing out was never recorded and came back at every
 * sign-in (operator, 2026-10-09). The caller tells the account. The account
 * menu has it for anyone who wants it again.
 */
export function claimFirstRun(userId, accountVersion) {
  if (!tourDue(userId, accountVersion)) return false;
  markTourSeen(userId);
  return true;
}

/**
 * This browser has seen it and the account has not heard: seen before the
 * account kept it, or the save failed. The account should be told, or every
 * other machine shows it again. Never for a server that does not keep it.
 */
export function accountBehind(userId, accountVersion) {
  return accountVersion !== undefined && !seenOnAccount(accountVersion) && tourSeen(userId);
}

// ── replay ────────────────────────────────────────────────────────────────
// The account menu asks; ProductTour, mounted once in the app shell, listens.

const bus = new EventTarget();
export function requestTour() { bus.dispatchEvent(new Event("tour")); }
export function onTourRequest(cb) {
  bus.addEventListener("tour", cb);
  return () => bus.removeEventListener("tour", cb);
}

// ── items already covered ─────────────────────────────────────────────────
//
// A tour never explains the same thing twice (operator, 2026-10-13: "driver.js
// should never repeat an already covered item ... on page b if it has item q
// it should not be covered again, only new items"). Every step carries a KEY:
// its page and mark for a part that belongs to one page, and one shared key
// for a control several pages draw the same way (the pager, the unit picker,
// the period, Run, the table toolbar, the Guide). A step is recorded as
// covered when it is SHOWN, so a tour closed at its second step leaves the
// rest for the next page that has them. Kept per person in this browser.
// Guide, which a person presses to see a page again, shows it all.

const coveredKey = (userId) => `ft-tour-covered:v${TOUR_VERSION}:${userId ?? "anon"}`;
export function coveredItems(userId) {
  try { return new Set(JSON.parse(localStorage.getItem(coveredKey(userId)) ?? "[]")); } catch { return new Set(); }
}
export function markCovered(userId, key) {
  if (!key) return;
  try {
    const all = coveredItems(userId);
    if (all.has(key)) return;
    all.add(key);
    localStorage.setItem(coveredKey(userId), JSON.stringify([...all]));
  } catch { /* storage off: may be shown again */ }
}

/** Controls drawn the same way on several pages: one key wherever they are. */
const SHARED_KEY = {
  "page-pager": "pager",
  "page-unit": "unit-picker",
  "page-range": "period",
  "page-run": "run",
};

// ── what the tour says ────────────────────────────────────────────────────

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const list = (rows) => `<ul class="ft-tour__list">${rows.map((r) => `<li>${r}</li>`).join("")}</ul>`;

/** One line per screen in the sidebar, for the screens step. */
export const SCREEN_LINES = {
  fleet:        "<b>Live Map</b>: every unit, where it is now",
  alerts:       "<b>Alerts</b>: fuel and overspeeding alerts from all your organisations, escalated or de-escalated in one place",
  drivers:      "<b>Drivers</b>: each driver's trips, tonnes, distance and incidents",
  analytics:    "<b>Analytics</b>: fuel use and cost, daily activity and sugar haulage over the days you pick",
  maintenance:  "<b>Maintenance</b>: probe health, fuel events, speeding, faults and repairs",
  weighbridges: "<b>Weighbridges</b>: every ticket each scale weighed, and the day across all of them",
};

/**
 * The tour for this account, as driver.js steps.
 *
 *   can        permission test, as usePermissions gives it
 *   firstName  for the welcome; may be empty
 *   orgName    the organisation on screen
 *   multiOrg   whether the account can switch organisation
 *   visible    (mark) → the Element carrying data-tour=mark if it is on
 *              screen, else null. Injected so this can be tested without a DOM.
 */
export function buildTourSteps({ can = () => true, firstName = "", orgName = "", multiOrg = false, visible = () => null, covered = new Set() } = {}) {
  const first = (...marks) => {
    for (const m of marks) { const el = visible(m); if (el) return el; }
    return null;
  };
  const map = can("map:read");
  const steps = [];
  const add = (key, element, popover, when = true) => {
    if (!when) return;
    if (element === null) return;          // a step about a control that is not on screen
    if (covered.has(key)) return;          // already explained, on this tour or a page's
    steps.push(element === undefined ? { key, popover } : { key, element, popover });
  };

  add("app:welcome", undefined, {
    title: firstName ? `Welcome, ${esc(firstName)}` : "Welcome to Samad Resources",
    description:
      "A one-minute look at where things are. Use the buttons or your arrow keys, "
      + "and close it whenever you like: it is always in your account menu, top right.",
  });

  add("app:org", first("org", "m-org"), {
    title: multiOrg ? "Your Organisations" : "Your Organisation",
    description: multiOrg
      ? `You are looking at <b>${esc(orgName) || "one organisation"}</b>. Switch here, and the map, the lists and every report follow.`
      : `Everything you see belongs to <b>${esc(orgName) || "your organisation"}</b>.`,
    side: "bottom", align: "start",
  });

  add("app:status", first("status"), {
    title: "The Fleet at a Glance",
    description:
      "How many units are online, offline or idling, and how many carry a warning or a critical alert. "
      + "Click a card to show only those units on the map; click it again to show them all.",
    side: "right", align: "start",
  }, map);

  // A screen naming several grants opens on any one of them (NAV_ITEMS).
  const may = (p) => (Array.isArray(p) ? p.some((one) => can(one)) : can(p));
  const screens = Object.keys(SCREEN_LINES).filter((k) => may(PERMISSION_OF[k]));
  add("app:nav", first("nav", "m-tabs"), {
    title: "The Screens",
    description: screens.length
      ? `Move between the parts of the app here.${list(screens.map((k) => SCREEN_LINES[k]))}`
      : "Move between the parts of the app here.",
    side: "right", align: "start",
  });

  const reports = [
    can("logbook:read")      && "<b>Logbook</b>: how one unit was used over a period, with a PDF and a workbook",
    can("fuel_audit:read")   && "<b>Fuel Audit</b>: fuel alerts found to be a faulty probe, and their repairs",
    can("fuel_filling:read") && "<b>Fuel Report</b>: one unit's fuel over a period, fillings and drains included",
  ].filter(Boolean);
  add("app:fleets", first("fleets"), {
    title: "Fleets and Reports",
    description: "Choose which machine types and units the map is about."
      + (reports.length ? ` The unit reports are here too:${list(reports)}` : ""),
    side: "right", align: "start",
  }, map);

  add("app:search", first("map-search", "m-search"), {
    title: "Find Anything",
    description: "Search for a plate, a driver, a place or a road. A unit that belongs to another of your organisations is found too.",
    side: "right", align: "start",
  }, map);

  const tools = [
    "<b>Maps</b>: OpenStreetMap or satellite, and layers such as site plans and weighbridges",
    "<b>Measure</b> a distance, or show a unit's <b>Route covered</b>",
    "<b>Geofences</b> on or off",
    visible("map-halted") && "<b>Halted</b>: units that stopped mid-journey",
    visible("map-fuel")   && "<b>Fuel alerts</b>: open fuel theft alerts",
  ].filter(Boolean);
  add("app:map-tools", first("map-tools"), {
    title: "Map Tools",
    description: `${list(tools)}The arrow at the bottom shows every tool's name.`,
    side: "right", align: "center",
  }, map);

  add("app:map", first("map"), {
    title: "Open a Unit",
    description:
      "Click any unit on the map to open its panel: where it is, its fuel, today's trips, its driver and its alerts. "
      + "Numbered circles are groups of units; zoom in or click one to spread them out.",
  }, map);

  add("app:notifications", first("alerts", "m-alerts"), {
    title: "Notifications",
    description: "The fleet's events as they happen: arrivals, departures, fuel and alerts. The number is what is new since you last looked.",
    side: "bottom", align: "end",
  }, map);

  add("manual", first("account", "m-account"), {
    title: "Your Account",
    description: "Your profile and password are here, and so is the <b>Guide</b>, whenever you want this again.",
    side: "bottom", align: "end",
  });

  return steps;
}

// ── page tours ────────────────────────────────────────────────────────────
//
// A short tour of each page, besides the map's (operator, 2026-10-13: "now we
// can have the driver.js run on different pages"). It runs the first time a
// person opens that page, once per page in this browser, and again whenever
// they press Guide there. Steps point at `data-tour` marks as the map tour's
// do: the shared ones (page-toolbar on TableToolbar, page-pager on
// TablePager, page-unit on UnitPicker) and each page's own (page-kpis,
// page-table…), and a step whose part is not on screen is dropped.

/** Which pages have a tour of their own (SidePanel NAV_ITEMS keys). */
export const PAGE_TOURS = {
  alerts: {
    title: "Alerts",
    intro: "Fuel and overspeeding alerts from all your organisations, in one list, the newest report first.",
    steps: [
      ["alerts-stats", "Where Things Stand", "How many alerts are open, escalated or de-escalated for the day you pick. The chart shows every alert ever received, fuel in amber and speed in blue."],
      ["page-toolbar", "Read and Unread", "How many alerts match and how many you have not read. <b>Mark all read</b> clears your unread dots. Search a plate and pick the day just below."],
      ["page-table", "Decide", "Open a row for its details. Tick several to escalate or de-escalate them together. A dot marks one you have not read; <b>Probe reported</b> marks a unit already waiting on a fuel probe repair."],
      ["page-pager", "More Alerts", "Older alerts are on the next pages."],
    ],
  },
  drivers: {
    title: "Drivers",
    intro: "Each driver's trips, tonnes, distance and incidents.",
    steps: [
      ["page-filters", "Rank and Search", "Rank the drivers with the chips, or search by name, ID or licence."],
      ["page-table", "The Drivers", "Each driver's trips, tonnes, distance and incidents, in the order you picked."],
      ["page-pager", "More Drivers", "The rest of the list is on the next pages."],
    ],
  },
  // Every section of the page (operator, 2026-10-13: "driver.js should cover
  // every section in the analytics page"). Which appear depends on the fleet:
  // a plant fleet has the fuel rates row, a haulage fleet the dispatches, the
  // haulage row and the sugar units, Kasulu the fuel standard. A section not
  // on screen is skipped, so each fleet gets the tour of its own page.
  analytics: {
    title: "Analytics",
    intro: "Fuel use and cost, daily activity and haulage over the days you pick, section by section.",
    steps: [
      ["page-filters", "Pick the Days and Units", "Every figure and chart below follows the days, fleets and units you choose here."],
      ["an-summary", "Summary", "Distance covered over those days, the average a day and a trip, and how many trips were completed."],
      ["page-kpis", "The Headline Figures", "Trips, distance and trips a day. The arrow compares the latest half of the days picked with the half before it."],
      ["an-today", "Today on the Ground", "What the fleet is doing today, since midnight Nairobi time, in the blocks that follow."],
      ["an-mix", "Fleet Composition", "The fleet by machine type: tractors, trucks, company vehicles and the rest."],
      ["an-coverage", "Fleet Coverage", "How many units are reporting now, how many are tracked but quiet, and how many have no tracker.",
        // A plant fleet's block is "Operational today", and counts other things
        { says: /Operational today/, title: "Operational Today", description: "How many machines are working today, and how many are stationary, parked or offline." }],
      ["an-sensors", "Probes and Sensors", "How many units have a working fuel probe, and what is wrong with the rest: tracker silent, probe dead or silent, uncalibrated."],
      ["an-early", "Tractors Dispatched Early", "Tractors sent out before 06:00 today."],
      ["an-trucks", "Trucks Dispatched", "Trucks sent out today."],
      ["an-hours", "Hours Run Today", "How many units have run today, their average hours, and how many fall in each band of hours."],
      ["an-fuelrow", "Fuel Rates", "Fuel per unit of work each day, and fuel per operating hour machine by machine."],
      ["an-haulrow", "Fuel per Distance and Output", "Litres per kilometre each day, measured from the tank, beside what left the gate: the weighbridges' tonnes, or sugar hauled."],
      ["an-hauls", "Units Ferrying Sugar", "Each unit that carried sugar: out and back, duration, destination, tonnes and distance."],
      ["an-standard", "Fuel Against Standard", "Each machine's burn against its standard rate from the FactorySuite register, the worst first."],
      ["an-fuelcost", "Fuel Consumption and Cost", "Fuel put in, what it cost, what drained and suspected theft, day by day."],
      ["an-daily", "Daily Activity", "Which days each unit was active, as a calendar of the period."],
    ],
  },
  // Every section of each page below (operator, 2026-10-13: "do the same for
  // maintenance, weighbridge page, logbook page, audit and report").
  maintenance: {
    title: "Maintenance",
    intro: "The Sensor Monitor: every unit's tracker, fuel probe, speed and faults, and the repairs under way.",
    steps: [
      ["page-kpis", "Units Monitored", "How many units have a tracker, how many sent a reading in the last hour, and how many hold a live connection now."],
      ["page-filters", "Search and Filter", "Search a registration, and narrow by activity or day. On a phone the filters fold behind the Filters button."],
      ["page-tabs", "Five Views", "<b>Probes</b>: each unit's fuel probe health, and where a repair is filed. <b>Fuel FSL</b>: the day's fuel events. <b>Speed</b>: overspeeding cases. <b>Malfunction</b>: fault episodes. <b>Repairs</b>: open repair jobs, signed off once the fix has held."],
      ["page-toolbar", "Counts and Export", "What the table holds. Refresh it, or save it as a CSV.", { key: "toolbar" }],
      [".sp4-table-scroll", "The Table", "One row a unit or case. Click a row for its detail: on Fuel FSL, the day's fuel trace."],
      ["page-pager", "More Rows", "The rest are on the next pages."],
    ],
  },
  weighbridges: {
    title: "Weighbridges",
    intro: "Every ticket each scale weighed, and the day across all of them.",
    steps: [
      ["wb-views", "Tickets or Analytics", "<b>Tickets</b>: one row per token. <b>Analytics</b>: the day across every bridge, its flow, the road and the activity."],
      ["page-kpis", "The Figures", "Weighments, unique vehicles and the heaviest load for the dates picked."],
      ["wb-filters", "Search and Dates", "Search a token, vehicle or driver, and pick the ticket dates."],
      ["page-tabs", "One Scale or All", "Pick a weighbridge, or see them all together."],
      ["page-toolbar", "Tickets and Tonnes", "How many tickets and tonnes are shown. Reload them, or save them as a CSV.", { key: "toolbar" }],
      ["page-table", "Tickets", "One row a ticket, from its two weighings. Open one for its detail."],
      ["page-pager", "More Tickets", "Earlier tickets are on the next pages."],
      ["wb-sites", "Each Weighbridge", "Each scale's day: what it weighed and what is still to come."],
      ["wb-road", "Vehicles on the Road to the Mill", "Units on their way in, and which of them are loaded."],
      ["wb-late", "Out Longer Than a Run Takes", "Units gone longer than a round trip should take."],
      ["wb-feed", "Live Activity", "Each weighing and movement as it happens."],
    ],
  },
  audit: {
    title: "Fuel Audit",
    intro: "Fuel alerts found to be a faulty probe, and where each probe repair stands.",
    steps: [
      ["page-kpis", "Where Repairs Stand", "Probes waiting for repair, open cases, failed repairs and probes repaired."],
      ["page-toolbar", "False Alerts", "How many units, and the litres of alerts that turned out to be the probe. Reload to read them again."],
      ["page-table", "Each Probe", "One row a unit. Open it for its fuel cases and its repair, and to sign the repair off."],
      ["page-pager", "More Units", "The rest are on the next pages."],
    ],
  },
  fuelReport: {
    title: "Fuel Report",
    intro: "The fleet's fuel against its standard, and any one unit's fuel over a period.",
    steps: [
      ["page-modes", "Two Views", "<b>Performance</b> reviews the whole fleet; <b>Vehicle analytics</b> is one unit's report."],
      ["fpr-kpis", "The Fleet's Fuel", "Fuel put in over the period, a typical month, this month's pace against the months before, and the litres above standard."],
      ["fpr-period", "The Period", "Pick a number of months, or the first and last day."],
      ["fpr-perday", "Litres Put In per Day", "How much fuel went in each day, month by month."],
      ["fpr-share", "Share of All Fuel", "Which kinds of machine take the fuel."],
      ["fpr-above", "Litres Above Standard", "Fuel put in beyond what each kind of machine should burn."],
      ["fpr-refills", "Refill Records", "The refills the review is built from."],
      ["fpr-attention", "Units Needing Attention", "The units furthest over their standard, the worst first."],
      ["fpr-benchmark", "Benchmark Performers", "The units at or under their standard, to hold the rest to."],
      ["fpr-todo", "What to Do", "What to act on first, and the litres a month it would save."],
      ["fpr-each", "How Each Unit Compares", "Every unit against its standard, kind by kind."],
      ["page-unit", "Choose a Unit", "Type a plate or a machine name."],
      ["page-range", "The Period", "Pick the first and last day."],
      ["page-run", "Run", "Reads the unit's fuel for that period."],
      ["page-kpis", "The Figures", "The unit's fuel for the period at a glance."],
      ["page-tabs", "Four Views", "<b>Graph & map</b>: fuel level, speed and mileage with the route. <b>Statistics & events</b>: the figures and each filling and drain. <b>Trips</b> and <b>Parkings</b>: one row each."],
      ["page-toolbar", "Counts and Export", "What the table holds, and saving it as a CSV.", { key: "toolbar" }],
      [".frp-root .sp4-table-scroll", "The Rows", "One row a trip, parking or event, in time order."],
    ],
  },
  usageReview: {
    title: "Logbook",
    intro: "How one unit was used over a period: drive hours, distance, fuel and where it spent its time.",
    steps: [
      ["page-unit", "Choose a Unit", "Type a plate or a machine name."],
      ["page-range", "The Period", "Up to 92 days. A review built before shows by itself as soon as the unit and period match."],
      ["logbook-kmpl", "Kilometres per Litre", "The rate for the fuel estimate. Leave it empty to use the unit's own."],
      ["page-run", "Build", "Reads the unit's history and builds the review. A long period takes up to a minute."],
      ["page-kpis", "The Figures", "Drive time, distance and fuel for the period."],
      ["logbook-bar", "The Review", "The unit and period on show. A day or place you pick shows here; click it to clear it."],
      ["logbook-downloads", "Excel and PDF", "The workbook with every row behind the review, and a short PDF report. The arrow reads the history again."],
      ["logbook-map", "The Map", "Each day's route, or the movement web between places. Click a place to pick it."],
      ["logbook-days", "Distance per Day", "How far the unit went each day. Click a day to pick it, and the hours below follow it."],
      ["logbook-places", "Where It Spent Its Time", "Each place by hours spent, with its activity, area and stops. Click one to pick it."],
      ["logbook-hours", "Driving by Hour", "When in the day the unit drove."],
      ["logbook-detail", "Day and Place Detail", "The drives and stops for the day or place you picked. Play a day on the map from here."],
    ],
  },
};

/** Has this person been shown the tour of `page` in this browser? */
const pageKey = (page, userId) => `ft-tour-page:v${TOUR_VERSION}:${page}:${userId ?? "anon"}`;
export function pageTourSeen(page, userId) {
  try { return localStorage.getItem(pageKey(page, userId)) != null; } catch { return true; }
}
export function markPageTourSeen(page, userId) {
  try { localStorage.setItem(pageKey(page, userId), String(Date.now())); } catch { /* storage off */ }
}

/**
 * The tour of one page, as driver.js steps, or [] for a page without one.
 * Its parts are looked up as the map tour's are (`visible`), and the last step
 * points at the account menu, where Guide runs it again.
 */
export function buildPageTourSteps(page, { visible = () => null, covered = new Set() } = {}) {
  const t = PAGE_TOURS[page];
  if (!t) return [];
  const steps = [{ key: `${page}:intro`, popover: { title: t.title, description: `${t.intro} A quick look at this page; close it whenever you like.` } }];
  // A step may carry a second wording for when its block says something else
  // (`says`, tested against the block's text): one section, two fleets. It may
  // also name the shared `key` it is covered under (see SHARED_KEY).
  for (const [mark, title, description, opt] of t.steps) {
    const key = opt?.key ?? SHARED_KEY[mark] ?? `${page}:${mark}`;
    if (covered.has(key)) continue;
    const el = visible(mark);
    if (!el) continue;
    const other = opt?.says && opt.says.test(el.textContent ?? "");
    steps.push({ key, element: el, popover: { title: other ? opt.title : title, description: other ? opt.description : description, side: "bottom", align: "start" } });
  }
  const account = visible("account") ?? visible("m-account");
  if (account && !covered.has("manual")) {
    steps.push({ key: "manual", element: account, popover: {
      title: "The Guide",
      description: "Press <b>Guide</b> in your account menu on any page for a tour of that page.",
      side: "bottom", align: "end",
    } });
  }
  return steps;
}

/** Whether a page's tour has anything left to say besides its introduction. */
export const hasNewItems = (steps) => steps.some((x) => !x.key?.endsWith(":intro"));

/** The permission each sidebar screen asks for (SidePanel NAV_ITEMS). */
export const PERMISSION_OF = {
  fleet: "map:read",
  alerts: ["alerts:read", "fuel_theft:read", "analytics:read"],
  drivers: "driver:read",
  analytics: "analytics:read",
  maintenance: "sensor:read",
  weighbridges: "weighbridge:read",
};

/**
 * The element marked `data-tour=mark` if it is actually on screen: in the
 * document, laid out, not hidden, and with a size. A tablet's folded sidebar
 * and a phone's hidden desktop header are in the DOM but not on screen.
 */
export function visibleMark(mark, doc = typeof document === "undefined" ? null : document) {
  if (!doc) return null;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = doc.defaultView?.getComputedStyle(el);
    return !(cs && (cs.visibility === "hidden" || cs.display === "none"));
  };
  // A mark starting "." is a shared class instead: the Sensor Monitor's five
  // tabs each draw their own table, all `.sp4-table-scroll`.
  const query = mark.startsWith(".") ? mark : `[data-tour="${mark}"]`;
  for (const el of doc.querySelectorAll(query)) {
    if (el.closest(".app-tab-panel--hidden, [inert]")) continue;
    if (shown(el)) return el;
    // A wrapper laid out as `display: contents` (Analytics' headline figures
    // on a phone) has no box to highlight: its first child that has one
    // stands for it.
    if (doc.defaultView?.getComputedStyle(el).display === "contents") {
      const child = [...el.children].find(shown);
      if (child) return child;
    }
  }
  return null;
}
