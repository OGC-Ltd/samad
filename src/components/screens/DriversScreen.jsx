// Desktop Drivers tab — real driver analytics from the fleet-server DB
// (/analytics/drivers). A four-cell strip reads the whole roster — drivers,
// tonnes and mileage trends, incident summary; the full-width grid compares
// the drivers, and a row opens one driver's figures in the side panel. Design mirrors the Analytics and
// Maintenance pages (cards, KPI tiles, ranked bars, Inter, --color-* tokens).

import { useState, useEffect, useId, useRef, useCallback, useMemo } from "react";
import "./DriversScreen.scss";
import { getDriversOverview } from "../../api/drivers";
import { useAppSelector, useCompanies } from "../../context/AppContext";
import { pendingDriver, clearPendingDriver, driverNameMatches } from "../../lib/driverHandoff";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { useApiData } from "../../hooks/useApiData";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { createReport, addSectionTitle, addSummaryCards, addTable, downloadReport } from "../../utils/pdfReport";
import DownloadReportButton from "../shared/DownloadReportButton";
import { downloadOrgReportPdf } from "../../api/reports";
import ErrorBoundary from "../shared/ErrorBoundary";
import LoadError from "../shared/LoadError";
import TabEmptyState from "../shared/TabEmptyState";
import { DriversIcon } from "../footer/NavIcons";
import { claimSidePanel, onSidePanelClaim } from "../../lib/sidePanels";
import { carriesCargo } from "../../lib/vehicleMap";

// Report-only. The on-screen charts take their colour from --tone-tonnes /
// --tone-mileage on .drivers-page; jsPDF cannot resolve a CSS variable, so the
// PDF summary cards still need a literal.
const TONNES_COLOR = "#22c55e";
const MILEAGE_COLOR = "#06b6d4";

const fmt = (n, d = 0) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

const initialsOf = (name = "") =>
  name.split(" ").map((w) => w[0]).filter(Boolean).join("").slice(0, 2).toUpperCase() || "–";

// Rating → performance tier (drives the avatar ring + pill colour), mirroring the
// dash ManagerCard's status pill. A driver who hasn't earned any rating yet
// (score still at its 0 default) reads as "NEW", not a judgment call. Below
// "FAIR" (rating < 3) never shows a pill — the UI intentionally hides any
// "Needs Work" style label for low performers.
// `color` is for the PDF, which cannot resolve a CSS variable; on screen the
// tier is a TONE name and its colour lives in DriversScreen.scss, per theme.
const ratingTier = (r = 0) => {
  if (r === 0) return { label: "NEW", color: "#94a3b8", tone: "new" };
  if (r >= 4.5) return { label: "EXCELLENT", color: "#22c55e", tone: "good" };
  if (r >= 4) return { label: "GOOD", color: "#22c55e", tone: "good" };
  if (r >= 3) return { label: "FAIR", color: "#f59e0b", tone: "fair" };
  return { label: "", color: "#94a3b8", tone: "new" };
};

/**
 * A person's name, drawn as a name.
 *
 * The registry is synced from RaiFactorySuite and typed by hand for the orgs
 * the sync does not cover, so the same roster carries "JOSEPH OTIENO", "joseph
 * otieno" and "Joseph Otieno" — three spellings of one person, and a column of
 * them reads as three different kinds of record rather than one list.
 *
 * Case is REPAIRED, not forced. A word that already mixes cases is left exactly
 * as it was typed, because that is the only case a human chose on purpose —
 * "McOmbaka" and "DeSouza" survive, where a blanket `text-transform:
 * capitalize` would have kept "JOSEPH" shouting and a blanket lowercase-then-
 * capitalise would have flattened them. Hyphens and apostrophes are word
 * boundaries: "achieng'-odhiambo" is two names, not one.
 *
 * The stored value is untouched — this is a rendering, so search, sort and
 * every export still see what the server sent.
 */
const titleCase = (name = "") =>
  String(name).replace(/[^\s'’-]+/g, (w) =>
    (/[a-z]/.test(w) && /[A-Z]/.test(w))
      ? w
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

const fmtDay = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The window a driver's figures actually cover.
 *
 * The roster is pulled over a fixed 90-day window, so "the period" as a page
 * fact is the same sentence on every row and worth no column. What differs per
 * driver is when they were ACTIVE inside it — `byDay` is only the days that
 * carry a trip — and that is the fact the grid was missing: a driver with 12
 * trips over three days and one with 12 over three months read identically.
 *
 * Taken from `details[id].byDay`, which the overview already returns in the
 * same payload as the roster, so this costs no request. Nothing is invented:
 * a driver with no activity gets no window and the cell says so.
 */
const activeWindow = (detail) => {
  const byDay = detail?.byDay ?? [];
  if (byDay.length === 0) return null;
  const from = byDay[0].day, to = byDay.at(-1).day;
  return { from, to, days: byDay.length, label: from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}` };
};

// Roster table shows the top drivers a page at a time; the rest paginate.
const ROSTER_PAGE_SIZE = 6;

// Full driver datagrid (search + metric filter + sort + pages), mirroring
// the Maintenance grid. The metric chips rank the grid by one of the numbers.
//
// PAGES, Prev / Next — the Sensor Monitor's pager (operator, 2026-10-03).
// The rank number on each row carries the position across pages, so page two
// still reads as 16th to 30th rather than as a fresh list.
//
// The step is smaller on a phone because a row IS bigger there: the table
// becomes a stack of cards, each about 133px tall, so 15 of those is a
// ~2,000px page. The query is the same 700px the stylesheet switches on (see
// DriversScreen.scss) — the step and the row shape have to change at the same
// width, or a tablet gets table rows counted out for cards.
const GRID_CARDS_QUERY = "(max-width: 700px)";
const GRID_STEP = 15;
const GRID_STEP_PHONE = 10;
// Columns that are a count the roster can be RANKED on. Sorting by one of these
// numbers the rows (1 = best by that measure, whichever way the sort runs) and
// draws a bar in that column against the roster's largest value — the gap
// between first and fifth is what a ranking is for, and a column of bare
// figures makes the reader do that subtraction row by row.
const RANKED_KEYS = new Set(["rating", "trips", "tonnes", "mileageKm", "fuelTheftCases", "overspeedingCases"]);
const BAR_KEYS = new Set(["rating", "trips", "tonnes", "mileageKm"]);
const GRID_METRICS = [
  { key: "tonnes", label: "Tonnes" },
  { key: "mileageKm", label: "Mileage" },
  { key: "trips", label: "Trips" },
  { key: "rating", label: "Rating" },
];

// Driver employment status (UserStatus enum) → label + tone for the grid badge.
/* The status badge carries a TONE NAME, not a hex.
 *
 * These were three literals handed to the cell as an inline `--tone`, which
 * made the badge the one thing in the grid the theme could not reach: #22c55e
 * measures 2.3:1 on the light page and #f59e0b 2.1:1, both far under the 4.5
 * an 11px label needs, and no stylesheet could correct them because the value
 * arrived after the cascade. The name goes to a class and the colour lives in
 * DriversScreen.scss, per theme, like every other colour on this page. */
const DRIVER_STATUS = {
  ACTIVE: { label: "Active", tone: "active" },
  SUSPENDED: { label: "Suspended", tone: "suspended" },
  TERMINATED: { label: "Terminated", tone: "terminated" },
};
const statusMeta = (s) => DRIVER_STATUS[s] || { label: s || "-", tone: "unknown" };

/**
 * The whole roster in one reading, for the strip at the top of the page
 * (operator, 2026-10-13: the strip covers all the drivers; one driver's
 * figures live in the side panel). Everything is summed from the overview the
 * page already holds — the roster rows for the window's totals, each driver's
 * `byDay` for the daily series — so it costs no request and agrees with the
 * grid below it to the unit.
 */
function fleetOf(drivers, details, liveVehicles) {
  const days = new Map();
  let drove = 0;
  for (const d of drivers) {
    const byDay = details?.[d.id]?.byDay ?? [];
    if (byDay.length) drove += 1;
    for (const x of byDay) {
      const cur = days.get(x.day) ?? { day: x.day, tonnes: 0, mileageKm: 0 };
      cur.tonnes += Number(x.tonnes) || 0;
      cur.mileageKm += Number(x.mileageKm) || 0;
      days.set(x.day, cur);
    }
  }
  const byDay = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const sum = (k) => drivers.reduce((n, d) => n + (Number(d[k]) || 0), 0);
  const involved = (k) => drivers.filter((d) => Number(d[k]) > 0).length;
  // On the road: a roster driver named on a unit whose engine is running now,
  // matched the way the panel matches a driver to their unit.
  const live = new Set(liveVehicles.filter((v) => v.driver && v.engine === "on").map((v) => v.driver));
  const rated = drivers.filter((d) => Number(d.rating) > 0);
  const mix = { good: 0, fair: 0, low: 0, new: 0 };
  for (const d of drivers) {
    const r = Number(d.rating) || 0;
    mix[r === 0 ? "new" : r >= 4 ? "good" : r >= 3 ? "fair" : "low"] += 1;
  }
  return {
    count: drivers.length,
    active: drivers.filter((d) => d.status === "ACTIVE").length,
    onRoad: drivers.filter((d) => live.has(d.fullName)).length,
    drove,
    avgRating: rated.length ? rated.reduce((n, d) => n + Number(d.rating), 0) / rated.length : null,
    mix,
    byDay,
    totals: {
      trips: sum("trips"), tonnes: sum("tonnes"), mileageKm: sum("mileageKm"),
      fuelTheftCases: sum("fuelTheftCases"), overspeedingCases: sum("overspeedingCases"),
    },
    involved: { theft: involved("fuelTheftCases"), speed: involved("overspeedingCases") },
  };
}

// Trend delta over a daily series — this half vs the previous half. Mirrors the
// stat cards on the Analytics page so the driver trend charts read as siblings.
function periodDelta(values) {
  if (values.length < 2) return null;
  const half = Math.max(1, Math.floor(values.length / 2));
  const cur = values.slice(-half);
  const prev = values.slice(-2 * half, -half);
  const total = (arr) => arr.reduce((s, x) => s + x, 0);
  const c = total(cur), p = total(prev);
  if (p <= 0) return c > 0 ? 100 : 0;
  return Math.round(((c - p) / p) * 100);
}

export default function DriversScreen() {
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const { activeCompany } = useCompanies();

  // Live fleet (shared SSE stream) — powers the selected driver's realtime
  // gauges/radar. Same list the map renders, no extra request.
  const { vehicles: liveVehicles } = useFleetLiveShared();

  // One batched request: roster + EVERY driver's analytics (kept warm on the
  // server). Selecting a driver is then a pure in-memory lookup — instant,
  // no per-selection fetch — and the localStorage cache repaints the whole
  // page on revisit without waiting on the network.
  const { data: overview, loading, error, retry } = useApiData(
    () => getDriversOverview({ companyId: activeCompanyId }),
    [activeCompanyId],
    { cacheKey: `ft-drivers-ov:${activeCompanyId}` }
  );
  const drivers = useMemo(() => overview?.drivers ?? [], [overview]);

  const [selectedId, setSelectedId] = useState(null);
  // The driver panel: opened by picking a row (operator, 2026-10-13: "when we
  // click the driver a sidebar should be populated with the details of the
  // driver and all the stats"). The first-row default selection does not open it.
  const [panelOpen, setPanelOpen] = useState(false);
  const openDriver = (id) => { setSelectedId(id); setPanelOpen(true); };
  const closeDriver = useCallback(() => setPanelOpen(false), []);
  const [leaderView, setLeaderView] = useState("top"); // "top" | "bottom" 6 by tonnes

  // Default to the first driver in the table; keep a valid selection on refresh.
  useEffect(() => {
    const list = overview?.drivers ?? [];
    if (list.length === 0) { setSelectedId(null); return; }
    // Opened from a vehicle's driver link → select that driver once.
    const wanted = pendingDriver();
    if (wanted) {
      const hit = list.find((d) => driverNameMatches(d.fullName, wanted));
      clearPendingDriver();
      // Asked for by name, so the panel opens: it is the point of the jump.
      if (hit) { setSelectedId(hit.id); setPanelOpen(true); return; }
    }
    setSelectedId((prev) => (prev && list.some((d) => d.id === prev) ? prev : list[0].id));
  }, [overview]);

  const detail = (selectedId && overview?.details?.[selectedId]) || null;

  // The selected driver's vehicle in the live fleet — matched by driver name
  // (the telemetry stream carries the assigned driver on every vehicle).
  const selectedName = detail?.driver?.fullName
    ?? drivers.find((d) => d.id === selectedId)?.fullName;
  const liveVehicle = selectedName
    ? liveVehicles.find((v) => v.driver === selectedName) ?? null
    : null;

  // Leaderboard shows the top or bottom 6 drivers by tonnes ferried — the list
  // arrives already sorted by tonnes, highest first.
  const leaderDrivers =
    leaderView === "bottom" ? drivers.slice(-ROSTER_PAGE_SIZE) : drivers.slice(0, ROSTER_PAGE_SIZE);

  // The strip reads the whole roster, not the selected driver.
  const fleet = useMemo(
    () => fleetOf(drivers, overview?.details, liveVehicles),
    [drivers, overview?.details, liveVehicles],
  );
  // Sub caption for the trend stat charts — the delta pill's "this half vs
  // previous half" framing, matching the Analytics page.
  const dayCount = fleet.byDay.length;
  const dHalf = Math.max(1, Math.floor(dayCount / 2));
  const fleetSub = dayCount > 1 ? `last ${dHalf}d vs previous ${dHalf}d, all drivers` : dayCount ? "single day" : "";

  // ── PDF reports (utils/pdfReport.js — same builder as the Warehouse tab) ──
  const accent = activeCompany?.accentColor || "#22c55e";

  // Whole roster — server-rendered template report (kind 'drivers'), same
  // 90-day window the on-screen roster uses (api/drivers getDriversOverview).
  const handleAllDriversReport = () =>
    downloadOrgReportPdf({
      companyId: activeCompanyId,
      kind: "drivers",
      days: 90,
      filename: `${activeCompany?.short || "Fleet"}-Drivers-Report.pdf`,
    });

  // Selected driver: the performance statement + daily activity, from the same
  // /analytics/drivers/:id payload the profile cards render.
  //
  // This is where the statement lives now. The card that used to print it
  // beside the grid is gone — it was the third copy of figures the grid and
  // the Summary card above already carry — but it held two things they do not:
  // hours on road, and the heaviest load with its date and route. Both are
  // still in this PDF, which is the artefact a statement should be anyway.
  const handleDriverReport = () => {
    if (!detail?.driver) return;
    const { driver, totals, byDay = [] } = detail;
    const period = byDay.length ? `${fmtDay(byDay[0].day)} – ${fmtDay(byDay.at(-1).day)}` : "no activity";
    const doc = createReport({
      companyName: activeCompany?.name || "Fleet",
      reportTitle: "Driver Report",
      subtitle:    `${titleCase(driver.fullName)}${driver.employeeId ? ` · #${driver.employeeId}` : ""} · ${period}`,
      accentColor: accent,
    });
    addSummaryCards(doc, [
      { value: fmt(totals.trips),                label: "Trips",                  color: "#3b82f6" },
      { value: fmt(byDay.length),                label: "Days driven",            color: TONNES_COLOR },
      { value: `${fmt(totals.mileageKm)} km`,    label: "Mileage",                color: MILEAGE_COLOR },
      { value: fmt(totals.overspeedingCases),    label: "Overspeeding",           color: "#ef4444" },
    ]);
    addSectionTitle(doc, "Performance Statement");
    addTable(doc, {
      accentColor: accent,
      head: ["Metric", "Value"],
      body: [
        ["Truck",              driver.vehicle ?? "-"],
        ["Trailer",            driver.trailer || "-"],
        ["Trips completed",    fmt(totals.trips)],
        ["Days driven",        fmt(byDay.length)],
        ["Distance covered",   `${fmt(totals.mileageKm)} km`],
        ["Overspeeding cases", fmt(totals.overspeedingCases)],
      ],
    });
    if (byDay.length > 0) {
      addSectionTitle(doc, "Daily Activity");
      addTable(doc, {
        accentColor: accent,
        head: ["Date", "Trips", "Mileage (km)"],
        body: byDay.map((d) => [fmtDay(d.day), fmt(d.trips), fmt(d.mileageKm)]),
      });
    }
    downloadReport(doc, `${activeCompany?.short || "Fleet"}-Driver-Report-${titleCase(driver.fullName).replace(/\s+/g, "")}.pdf`);
  };

  const isEmpty = !loading && drivers.length === 0;

  return (
    <div className="drivers-page">
      <div className="drivers-page__inner">
        {/* The empty state already names the page — no header needed then. */}
        {!isEmpty && (
          <div className="dr-head">
            <div>
              <h1 className="dr-title">Driver Analytics</h1>
              <div className="dr-subtitle">
                {loading ? "Loading…" : `${fmt(drivers.length)} driver${drivers.length === 1 ? "" : "s"} · ${activeCompany?.name || "Fleet"}`}
              </div>
            </div>
            {/* The two PDF buttons used to sit here, beside the page title.
                They are on the TABLE now — see AllDriversSection — because
                that is what they export and it is where Sensor Monitor keeps
                its own: an export control at the top of a page claims the
                page, and a reader looking at a roster should not have to
                travel back up to a header to take it away. */}
          </div>
        )}

        {error ? (
          <LoadError label="Drivers" onRetry={retry} fullSection />
        ) : !loading && drivers.length === 0 ? (
          <TabEmptyState
            icon={<DriversIcon size={44} />}
            title="Drivers"
            hint="No drivers yet. Driver profiles and analytics will appear here once the live integration is connected."
          />
        ) : (
          <ErrorBoundary label="Drivers">
            <div className="dr-layout">
              {/* The whole roster in one strip (operator, 2026-10-13): who is on
                  it, what they hauled, how far, and what went wrong. One
                  driver's figures are in the panel a row opens. */}
              <section className="dr-strip" aria-label="All drivers">
                <FleetCard fleet={fleet} loading={loading} />
                <TrendStat
                  title="Tonnes ferried"
                  series={fleet.byDay}
                  valueKey="tonnes"
                  value={loading ? "-" : fmt(fleet.totals.tonnes, 1)}
                  unit="t"
                  tone="tonnes"
                  type="bar"
                  sub={fleetSub}
                  loading={loading}
                />
                <TrendStat
                  title="Mileage covered"
                  series={fleet.byDay}
                  valueKey="mileageKm"
                  value={loading ? "-" : fmt(fleet.totals.mileageKm)}
                  unit="km"
                  tone="mileage"
                  type="line"
                  sub={fleetSub}
                  loading={loading}
                />
                <FleetSummary fleet={fleet} loading={loading} />
              </section>
            </div>

            {/* All drivers — the datagrid, full width, in the Maintenance
                tab's grid grammar. It used to be a master-detail pair with a
                Performance statement card beside it at 38%; that card restated
                the selected driver's trips, tonnes, mileage, incidents and
                rating, all of which are columns in the grid it sat next to and
                most of which are also in the Summary card above. The grid gets
                the whole row now, which is the width eight columns needed. */}
            <AllDriversSection
              drivers={drivers}
              details={overview?.details}
              selectedId={selectedId}
              onSelect={openDriver}
              selectedName={selectedName}
              onDriverReport={detail?.driver ? handleDriverReport : null}
              onAllDriversReport={handleAllDriversReport}
            />
          </ErrorBoundary>
        )}
      </div>
      {panelOpen && detail?.driver && (
        <DriverPanel
          detail={detail}
          row={drivers.find((d) => d.id === selectedId)}
          liveVehicle={liveVehicle}
          onReport={handleDriverReport}
          onClose={closeDriver}
        />
      )}
    </div>
  );
}

// How many cases each list shows before "Show all".
const PANEL_CASES = 6;

/**
 * The driver panel: everything the overview holds on one driver, down the
 * right of the page. Who they are and what they are driving now, the window's
 * figures and what they come to per trip, the heaviest load, the two daily
 * charts, and every fuel and overspeeding case behind the counts. All of it is
 * already in the overview payload, so opening it costs no request.
 */
function DriverPanel({ detail, row, liveVehicle, onReport, onClose }) {
  const { driver, totals, heaviestLoad, byDay = [], incidents } = detail;
  const tier = ratingTier(driver.rating);
  const st = statusMeta(row?.status ?? driver.status);
  const w = activeWindow(detail);
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // A new driver starts at the top of the panel, not where the last one was left.
  useEffect(() => { ref.current?.scrollTo?.({ top: 0 }); }, [driver.id]);
  // One side panel at a time (lib/sidePanels): this closes the notifications
  // feed, and the feed opening closes this.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    claimSidePanel("driver");
    return onSidePanelClaim("driver", () => closeRef.current?.());
  }, []);

  const per = (n, d) => (d > 0 ? n / d : null);
  const dash = (v, dec, unit) => (v == null ? "-" : `${fmt(v, dec)}${unit}`);
  const windowDays = totals.windowDays ?? 90;
  // Samad's trucks carry no weighed loads and no fuel probes: trips and days
  // driven stand where new-ui shows tonnes, and there is no fuel-theft list.
  const headline = [
    { label: "Trips", value: fmt(totals.trips) },
    { label: "Days driven", value: fmt(byDay.length) },
    { label: "Mileage", value: fmt(totals.mileageKm), unit: "km" },
  ];
  const rates = [
    { label: "Trips per active day", value: dash(per(totals.trips, w?.days ?? 0), 1, "") },
    { label: "Km per trip", value: dash(per(totals.mileageKm, totals.trips), 0, " km") },
    { label: "Km per active day", value: dash(per(totals.mileageKm, w?.days ?? 0), 0, " km") },
  ];
  const overspeeds = incidents?.overspeeds ?? [];
  const daysSub = `${fmt(byDay.length)} active day${byDay.length === 1 ? "" : "s"}`;

  return (
    <aside className="dr-panel" role="dialog" aria-label={`${titleCase(driver.fullName)}, driver details`}>
      <header className="dr-panel__head">
        <span className="dr-panel__title">Driver</span>
        <button type="button" className="dr-panel__x" onClick={onClose} aria-label="Close driver details">×</button>
      </header>

      <div className="dr-panel__body" ref={ref}>
        <DriverIdCard driver={driver} tier={tier} st={st} row={row} w={w} liveVehicle={liveVehicle} />

        <section className="dr-panel__sec">
          <h3 className="dr-panel__h">Last {fmt(windowDays)} Days</h3>
          <dl className="dr-window__lead">
            {headline.map((x) => (
              <div key={x.label}>
                <dt>{x.label}</dt>
                <dd>{x.value}{x.unit && <span className="dr-window__unit"> {x.unit}</span>}</dd>
              </div>
            ))}
          </dl>
          <ActivityStrip byDay={byDay} days={windowDays} />
          <dl className="dr-window__rates">
            {rates.map((x) => (
              <div key={x.label}><dt>{x.label}</dt><dd>{x.value}</dd></div>
            ))}
            {heaviestLoad && (
              <div className="dr-window__heavy">
                <dt>Heaviest load</dt>
                <dd>
                  {fmt(heaviestLoad.tonnes, 1)} t
                  <span className="dr-window__heavyon">
                    {fmtDay(heaviestLoad.date)}{heaviestLoad.route ? ` · ${heaviestLoad.route}` : ""}
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </section>

        {byDay.length > 0 && (
          <section className="dr-panel__sec dr-panel__charts">
            <TrendStat title="Trips per day" series={byDay} valueKey="trips" unit="" tone="tonnes" type="bar"
                       value={fmt(totals.trips)} sub={daysSub} />
            <TrendStat title="Mileage per day" series={byDay} valueKey="mileageKm" unit="km" tone="mileage" type="line"
                       value={fmt(totals.mileageKm)} sub={daysSub} />
          </section>
        )}

        <SpeedCases overspeeds={overspeeds} trips={totals.overspeedingCases} />
      </div>

      <footer className="dr-panel__foot">
        <DownloadReportButton onGenerate={onReport} permission="driver:export" label="Driver PDF" />
      </footer>
    </aside>
  );
}

/** The day an incident happened, as a block: day number over month, the time
 *  under it. Read down a list, the blocks are the timeline. */
function DayBlock({ iso }) {
  const d = new Date(iso);
  return (
    <span className="dr-dayblock" aria-hidden="true">
      <span className="dr-dayblock__d">{d.getDate()}</span>
      <span className="dr-dayblock__m">{d.toLocaleDateString("en-GB", { month: "short" })}</span>
    </span>
  );
}
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const ymd = (d) => d.toISOString().slice(0, 10);

/**
 * The window as a row of days, one tick each, filled where the driver had a
 * trip. "41 of 90" says how many; the strip says whether they were steady
 * or all at the start, which the count cannot.
 */
function ActivityStrip({ byDay, days }) {
  const on = new Set(byDay.map((x) => x.day));
  const today = new Date();
  const cells = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1 - i)));
    return ymd(d);
  });
  const active = cells.filter((c) => on.has(c)).length;
  return (
    <div className="dr-activity">
      <div className="dr-activity__head">
        <span>Active days</span>
        <b>{fmt(active)} <span>of {fmt(days)}</span></b>
      </div>
      <div className="dr-activity__strip" role="img"
           aria-label={`Active on ${active} of the last ${days} days`}
           style={{ "--n": days }}>
        {cells.map((c) => (
          <span key={c} className={`dr-activity__day${on.has(c) ? " dr-activity__day--on" : ""}`} title={fmtDay(c)} />
        ))}
      </div>
      <div className="dr-activity__ends" aria-hidden="true">
        <span>{fmtDay(cells[0])}</span><span>Today</span>
      </div>
    </div>
  );
}

/** Show the first PANEL_CASES, then all. */
function useFold(items) {
  const [all, setAll] = useState(false);
  return {
    shown: all ? items : items.slice(0, PANEL_CASES),
    more: items.length > PANEL_CASES ? (
      <button type="button" className="dr-panel__more" onClick={() => setAll((v) => !v)}>
        {all ? "Show fewer" : `Show all ${fmt(items.length)}`}
      </button>
    ) : null,
  };
}

/**
 * Overspeeding: the alerts on their trips, a row per day and unit with each
 * alert's time as a chip. The count in the head is TRIPS with an overspeed,
 * which is what the roster ranks on; the note says how many alerts that was.
 */
function SpeedCases({ overspeeds, trips }) {
  const groups = [];
  const byKey = new Map();
  for (const o of overspeeds) {
    const key = `${new Date(o.at).toDateString()}|${o.plate ?? ""}|${o.route ?? ""}`;
    let g = byKey.get(key);
    if (!g) { g = { key, at: o.at, plate: o.plate, route: o.route, times: [] }; byKey.set(key, g); groups.push(g); }
    g.times.push(o.at);
  }
  const { shown, more } = useFold(groups);
  return (
    <section className="dr-panel__sec dr-cases-sec dr-cases-sec--speed">
      <h3 className="dr-panel__h">
        Overspeeding
        <span className={`dr-panel__count${trips ? " dr-panel__count--speed" : ""}`}>{fmt(trips)}</span>
      </h3>
      {overspeeds.length === 0 ? (
        <p className="dr-panel__note">No overspeeding on their trips.</p>
      ) : (
        <>
          <p className="dr-panel__note">
            <b>{fmt(overspeeds.length)} alert{overspeeds.length === 1 ? "" : "s"}</b> on {fmt(trips)} trip{trips === 1 ? "" : "s"}
          </p>
          <ul className="dr-cases">
            {shown.map((g) => (
              <li key={g.key} className="dr-case dr-case--on">
                <DayBlock iso={g.at} />
                <span className="dr-case__body">
                  <span className="dr-case__line">
                    <span className="dr-case__plate">{g.plate ?? "Unit"}</span>
                    {g.route && <span className="dr-case__route">{g.route}</span>}
                  </span>
                  <span className="dr-case__times">
                    {g.times.slice().sort().map((t, i) => <span key={i} className="dr-case__chip">{fmtTime(t)}</span>)}
                  </span>
                </span>
                <span className="dr-case__n">{fmt(g.times.length)}×</span>
              </li>
            ))}
          </ul>
          {more}
        </>
      )}
    </section>
  );
}

const MIX = [
  { key: "good", label: "4+" },
  { key: "fair", label: "3 to 4" },
  { key: "low", label: "Under 3" },
  { key: "new", label: "Unrated" },
];

/**
 * The roster cell: how many drivers, how many are driving now and drove at
 * all in the window, and how the ratings fall — a stacked bar rather than one
 * average, because an average of 3.4 hides whether that is everyone at 3.4 or
 * half the roster at 5 and half unrated.
 */
function FleetCard({ fleet, loading }) {
  if (loading && !fleet.count) {
    return (
      <div className="dr-cell dr-fleet">
        <div className="dr-cell__empty" aria-busy="true">Loading drivers…</div>
      </div>
    );
  }
  const facts = [
    { label: "Driving now", value: fmt(fleet.onRoad), live: fleet.onRoad > 0 },
    { label: "Drove in 90 days", value: fmt(fleet.drove) },
    { label: "Average rating", value: fleet.avgRating == null ? "-" : `${fmt(fleet.avgRating, 1)} / 5` },
  ];
  return (
    <div className="dr-cell dr-fleet">
      <div className="dr-statchart__head">
        <span className="dr-statchart__label">Drivers</span>
      </div>
      <div className="dr-summary__lead">
        <span className="dr-summary__figure">{fmt(fleet.count)}</span>
        <span className="dr-summary__caption">on the roster,<br />{fmt(fleet.active)} active</span>
      </div>
      <dl className="dr-fleet__facts">
        {facts.map((f) => (
          <div key={f.label} className={`dr-fleet__fact${f.live ? " dr-fleet__fact--live" : ""}`}>
            <dt>{f.live && <span className="dr-live__dot" aria-hidden="true" />}{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      <div className="dr-fleet__mix">
        <span className="dr-fleet__mixlabel">Ratings</span>
        <span className="dr-fleet__bar" role="img"
              aria-label={MIX.map((m) => `${fleet.mix[m.key]} ${m.label}`).join(", ")}>
          {MIX.map((m) => fleet.mix[m.key] > 0 && (
            <span key={m.key} className={`dr-fleet__seg dr-fleet__seg--${m.key}`}
                  style={{ flexGrow: fleet.mix[m.key] }}
                  title={`${m.label}: ${fmt(fleet.mix[m.key])} driver${fleet.mix[m.key] === 1 ? "" : "s"}`} />
          ))}
        </span>
        <ul className="dr-fleet__legend">
          {MIX.map((m) => (
            <li key={m.key} className={`dr-fleet__key dr-fleet__key--${m.key}`}>
              <span className="dr-fleet__swatch" aria-hidden="true" />{m.label}<b>{fmt(fleet.mix[m.key])}</b>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * The driver's ID card, at the top of the panel (operator, 2026-10-13: "we
 * need the driver id card back, with the gauges for speed, fuel, load, temp
 * and oil, and the radar"). Who they are, then their unit right now off the
 * shared live stream: five ring gauges, each with its figure and unit, and the
 * radar beside them giving the same five as one shape. The radar is the
 * glance; the rings are the reading, which is why both are here.
 *
 * Engine off, or no unit of theirs in this fleet: the rings empty, the
 * figures read "—", the radar greys, and the state line says which it is.
 */
function DriverIdCard({ driver, tier, st, row, w, liveVehicle }) {
  const v        = liveVehicle;
  const engineOn = v?.engine === "on";
  // Samad's partner sends speed but no fuel, load, temperature or oil: those
  // read "-" (null), never a made-up 0.
  const speed    = v?.speed ?? 0;
  const fuel     = v?.fuelLevel ?? null;
  const loadPct  = v?.maxPayload > 0 ? Math.min(100, Math.round(((v?.weight ?? 0) / v.maxPayload) * 100)) : null;
  const temp     = v?.engineTemp ?? null;
  const oil      = v?.oilLevel ?? null;

  const gauges = [
    { key: "speed", label: "Speed", unit: "km/h", value: speed,   max: 120,
      tone: speed > (v?.speedLimit ?? 80) ? "crit" : "ok" },
    { key: "fuel",  label: "Fuel",  unit: "%",    value: fuel,    max: 100,
      tone: fuel < 15 ? "crit" : fuel < 40 ? "warn" : "ok" },
    { key: "load",  label: "Load",  unit: "%",    value: loadPct, max: 100,
      tone: loadPct > 95 ? "crit" : loadPct > 80 ? "warn" : "info" },
    { key: "temp",  label: "Temp",  unit: "°C",   value: temp,    max: 120,
      tone: temp > 105 ? "crit" : temp > 95 ? "warn" : "info" },
    { key: "oil",   label: "Oil",   unit: "%",    value: oil,     max: 100,
      tone: oil < 20 ? "crit" : oil < 40 ? "warn" : "ok" },
  // A generator or motorbike has no load to gauge; the radar takes any count.
  ].filter((g) => g.key !== "load" || !v || carriesCargo(v));
  const liveState = !v ? "No vehicle on record" : engineOn ? "Live" : "Engine off";

  return (
    <section className={`dr-idcard${engineOn ? " dr-idcard--on" : ""}`} aria-label="Driver ID card">
      <div className="dr-idcard__who">
        <span className={`dr-profile__avatar dr-idcard__avatar dr-tier--${tier.tone}`}>{initialsOf(driver.fullName)}</span>
        <div className="dr-panel__ident">
          <div className="dr-profile__namerow">
            <span className="dr-panel__name">{titleCase(driver.fullName)}</span>
            {tier.label && <span className={`dr-profile__pill dr-tier--${tier.tone}`}>{tier.label}</span>}
          </div>
          <div className="dr-profile__meta">
            {driver.employeeId ? `#${driver.employeeId}` : "Driver"}
            {driver.licenceNumber ? ` · Lic ${driver.licenceNumber}` : ""}
            {driver.idNumber ? ` · ID ${driver.idNumber}` : ""}
            {driver.phone ? <> · <a href={`tel:${driver.phone}`}>{driver.phone}</a></> : ""}
          </div>
          <StarRating value={driver.rating} />
        </div>
      </div>

      <dl className="dr-idcard__facts">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`dr-grid__badge dr-grid__badge--${st.tone}`}>
              <span className="dr-grid__dot" aria-hidden="true" />{st.label}
            </span>
          </dd>
        </div>
        <div>
          <dt>{row?.vehicleFrom === "assignment" ? "Assigned to" : "Truck"}</dt>
          <dd>{row?.vehicle ?? "-"}</dd>
        </div>
        <div>
          <dt>Trailer</dt>
          <dd>{driver.trailer || row?.trailer || "-"}</dd>
        </div>
        <div>
          <dt>Active</dt>
          <dd>{w ? w.label : "No activity"}</dd>
        </div>
      </dl>

      <div className="dr-idcard__live">
        <div className="dr-live__head">
          <span className="dr-live__state">
            <span className="dr-live__dot" aria-hidden="true" />
            {liveState}
          </span>
          {v && <span className="dr-live__unit">{v.id}</span>}
        </div>
        <div className="dr-idcard__instruments">
          <DriverRadar gauges={gauges} off={!engineOn} />
          <ul className="dr-gauges">
            {gauges.map((g) => <DriverGauge key={g.key} g={g} off={!engineOn} />)}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** One ring: the share of its scale filled, the figure in the middle, the
 *  label and unit under it. Colour only where the reading has a threshold. */
function DriverGauge({ g, off }) {
  const r = 18, c = 22;
  const circ = 2 * Math.PI * r;
  const none = off || g.value == null;
  const share = none ? 0 : Math.max(0, Math.min(g.value / g.max, 1));
  return (
    <li className={`dr-gauge dr-meter--${none ? "off" : g.tone}`}>
      <span className="dr-gauge__ring">
        <svg className="dr-gauge__svg" viewBox="0 0 44 44" aria-hidden="true">
          <circle className="dr-gauge__track" cx={c} cy={c} r={r} />
          <circle
            className="dr-gauge__fill" cx={c} cy={c} r={r}
            strokeDasharray={`${circ * share} ${circ}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        </svg>
        <span className="dr-gauge__val">{none ? "-" : Math.round(g.value)}</span>
      </span>
      <span className="dr-gauge__lbl">{g.label}<span className="dr-meter__unit">{g.unit}</span></span>
    </li>
  );
}

/** The same five readings as one shape, each spoke its share of its own scale. */
function DriverRadar({ gauges, off }) {
  const n = gauges.length;
  const CX = 50, CY = 46, R = 30;
  const step = (2 * Math.PI) / n;
  const pt = (i, rr) => [CX + rr * Math.cos(-Math.PI / 2 + i * step), CY + rr * Math.sin(-Math.PI / 2 + i * step)];
  const poly = (rr) => gauges.map((_, i) => pt(i, typeof rr === "function" ? rr(i) : rr))
    .map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + "Z";
  const vals = gauges.map((g) => (off ? 0 : Math.max(0, Math.min(g.value / g.max, 1))));
  const label = off ? "No live readings" :
    gauges.map((g) => (g.value == null ? `${g.label} not reported` : `${g.label} ${Math.round(g.value)} ${g.unit}`)).join(", ");
  return (
    <svg className={`dr-radar${off ? " dr-radar--off" : ""}`} viewBox="0 0 100 92" role="img" aria-label={label}>
      {[0.33, 0.66, 1].map((lvl) => <path key={lvl} className="dr-radar__grid" d={poly(R * lvl)} />)}
      {gauges.map((g, i) => {
        const p = pt(i, R);
        return <line key={g.key} className="dr-radar__grid" x1={CX} y1={CY} x2={p[0]} y2={p[1]} />;
      })}
      <path className="dr-radar__shape" d={poly((i) => R * Math.max(vals[i], 0.03))} />
      {gauges.map((g, i) => {
        const p = pt(i, R * Math.max(vals[i], 0.03));
        return <circle key={g.key} className="dr-radar__pt" cx={p[0]} cy={p[1]} r="2" />;
      })}
      {gauges.map((g, i) => {
        const p = pt(i, R + 10);
        return <text key={g.key} className="dr-radar__axis" x={p[0]} y={p[1]} textAnchor="middle" dominantBaseline="middle">{g.label}</text>;
      })}
    </svg>
  );
}

function StarRating({ value }) {
  const v = Number(value ?? 0);
  return (
    <div className="dr-rating" aria-label={`Rating ${fmt(v, 1)} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} className={"dr-rating__star" + (i <= Math.round(v) ? " dr-rating__star--on" : "")}
             width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
        </svg>
      ))}
      <span className="dr-rating__num">{fmt(v, 1)}/5</span>
    </div>
  );
}

// Summary — the roster's trips, and its fuel-theft and overspeeding cases with
// how many drivers they fall on: ten cases on one driver and ten across ten
// are different problems.
function FleetSummary({ fleet, loading }) {
  if (loading && !fleet.count) {
    return (
      <div className="dr-cell dr-summary">
        <div className="dr-cell__empty" aria-busy="true">Loading…</div>
      </div>
    );
  }
  const { totals, involved } = fleet;
  const incidents = [
    { name: "Fuel theft", n: totals.fuelTheftCases, who: involved.theft, tone: "theft" },
    { name: "Overspeeding", n: totals.overspeedingCases, who: involved.speed, tone: "speed" },
  ];
  const clean = incidents.every((i) => !i.n);

  return (
    <div className="dr-cell dr-summary">
      <div className="dr-statchart__head">
        <span className="dr-statchart__label">Summary</span>
        {clean && <span className="dr-summary__clean">Clean</span>}
      </div>

      <div className="dr-summary__lead">
        <span className="dr-summary__figure">{fmt(totals.trips)}</span>
        <span className="dr-summary__caption">trips completed<br />by all drivers</span>
      </div>

      <div className="dr-summary__incidents">
        {incidents.map((i) => (
          <div
            key={i.name}
            className={`dr-summary__incident${i.n ? ` dr-summary__incident--${i.tone}` : ""}`}
          >
            <span className="dr-summary__dot" aria-hidden="true" />
            <span className="dr-summary__name">
              {i.name}
              {i.n > 0 && <span className="dr-summary__who"> · {fmt(i.who)} driver{i.who === 1 ? "" : "s"}</span>}
            </span>
            <span className="dr-summary__count">{fmt(i.n)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// "All drivers" section — mirrors the Maintenance page's vehicle datagrid: a
// full-width filter row (metric chips + word search) above the edge-to-edge
// grid card — sticky header, sortable, paginated — which takes the whole row.
function AllDriversSection({
  drivers, details, selectedId, onSelect,
  selectedName, onDriverReport, onAllDriversReport,
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState("mileageKm");
  const [sortDir, setSortDir] = useState("desc");
  const cardView = useMediaQuery(GRID_CARDS_QUERY);
  const step = cardView ? GRID_STEP_PHONE : GRID_STEP;
  const [page, setPage] = useState(0);

  const q = query.trim().toLowerCase();
  const filtered = drivers.filter((d) =>
    !q ||
    d.fullName.toLowerCase().includes(q) ||
    String(d.employeeId ?? "").toLowerCase().includes(q) ||
    String(d.licenceNumber ?? "").toLowerCase().includes(q) ||
    String(d.idNumber ?? "").includes(q) ||
    String(d.phone ?? "").includes(q) ||
    String(d.vehicle ?? "").toLowerCase().includes(q)
  );

  const windowFor = (id) => activeWindow(details?.[id]);

  // Bars measure against the WHOLE roster, not the filtered rows: a search
  // that leaves three drivers must not stretch the smallest of them to full
  // width. Rating is out of 5 whatever anybody scored.
  const ranked = RANKED_KEYS.has(sortKey);
  const barMax = sortKey === "rating" ? 5 : Math.max(1, ...drivers.map((d) => d[sortKey] ?? 0));

  const sorted = [...filtered].sort((a, b) => {
    let cmp;
    if (sortKey === "driver") cmp = a.fullName.localeCompare(b.fullName);
    else if (sortKey === "status") cmp = String(a.status ?? "").localeCompare(String(b.status ?? ""));
    // By the LAST active day, not by the length of the window: the question a
    // reader asks of this column is "who has been driving lately". ISO days
    // compare correctly as strings, and a driver with no activity sorts to the
    // bottom of a descending sort rather than to the top of it.
    // `vehicle` IS the plate — a string, the way the filter above it and the
    // cell that renders it both read it. This reached for `.plate`, a shape it
    // has not had since the roster started sending the registration itself, so
    // every row resolved to undefined, every comparison returned 0, and the
    // column kept whatever order it was already in. A dead sort looks exactly
    // like a sort on a column whose values happen to be tied.
    // By PLATE, not by whether the posting is open: sorting a column of
    // registrations on a hidden boolean puts two units of the same fleet
    // number in different halves of the list for a reason nothing on screen
    // explains. Rows with no vehicle sort last either way.
    else if (sortKey === "vehicle") cmp = String(a.vehicle ?? "\uffff").localeCompare(String(b.vehicle ?? "\uffff"));
    else if (sortKey === "period") cmp = String(windowFor(a.id)?.to ?? "").localeCompare(String(windowFor(b.id)?.to ?? ""));
    else cmp = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
    return sortDir === "asc" ? cmp : -cmp;
  });

  // Pages of one step each, Prev / Next — the Sensor Monitor's pager, so the
  // two tables on either side of the Fuel report page the same way. The page
  // is clamped rather than trusted: a search that leaves 9 drivers, or a phone
  // rotated into a smaller step, would otherwise point past the last page.
  const pageCount = Math.max(1, Math.ceil(sorted.length / step));
  const at = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(at * step, at * step + step);

  // Re-ranking or searching goes back to page one: what the reader asked for
  // is the TOP of the new order, not whatever slice of it page four now holds.
  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "driver" ? "asc" : "desc"); }
    setPage(0);
  };
  // Metric chips rank the grid by that number, highest first.
  const rankBy = (key) => { setSortKey(key); setSortDir("desc"); setPage(0); };
  const update = (fn) => { fn(); setPage(0); };

  return (
    <>
      {/* Filters — chips + search, full width above the row (like maint-filters). */}
      <div data-tour="page-filters" className="dr-filters">
        {/* `display: contents` at every width above 768px, so the chips still
            lay out as direct children of the wrapping flex row and the desktop
            bar is unchanged. Below 768 the wrapper becomes a real box and takes
            one horizontally-scrolling line — see DriversScreen.scss. */}
        {/* One control with four positions rather than four loose chips: the
            grid is ranked by exactly one measure at a time, and a segmented
            switch says so where a row of pills reads as filters that stack. */}
        <div className="dr-filters__chips" role="group" aria-label="Rank drivers by">
          <span className="dr-rankby__label" aria-hidden="true">Rank by</span>
          <span className="dr-seg">
            {GRID_METRICS.map((m) => (
              <GridChip key={m.key} active={sortKey === m.key} onClick={() => rankBy(m.key)} label={m.label} />
            ))}
          </span>
        </div>
        {/* The glyph is drawn, not imported — the page carries no icon set, and
            it is the same two elements the Sensor Monitor bar and the User
            accounts roster draw, so the three search fields cannot fall out of
            step with each other. */}
        <div className="dr-searchwrap">
          <svg className="dr-searchwrap__icon" width="13" height="13" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            className="dr-search"
            value={query}
            onChange={(e) => update(() => setQuery(e.target.value))}
            placeholder="Search driver, ID or licence…"
          />
        </div>
        {/* The two exports, inline with the search that precedes them: this row
            is the table's toolbar, and a control that acts on the table belongs
            in it. They used to sit beside the page title, four cards above the
            grid they export.

            The titles say what each one covers, because neither follows this
            row's search box or chips — one is the selected driver's statement,
            the other the whole registry. */}
        <div className="dr-filters__tools">
          {onDriverReport && selectedName && (
            <DownloadReportButton
              onGenerate={onDriverReport}
              permission="driver:export"
              label={`${titleCase(selectedName).split(" ")[0]} PDF`}
            />
          )}
          <DownloadReportButton
            onGenerate={onAllDriversReport}
            permission="driver:export"
            label="All Drivers PDF"
          />
        </div>
      </div>

      <div data-tour="page-table" className="dr-grid-card">
        <div className="dr-grid-scroll">
          <table className="dr-grid">
            <thead>
              <tr>
                <GridTh label="Driver" k="driver" sortKey={sortKey} dir={sortDir} onClick={toggleSort} />
                {/* The unit they were last in, beside the person who drove it. */}
                <GridTh label="Vehicle" k="vehicle" sortKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <GridTh label="Status" k="status" sortKey={sortKey} dir={sortDir} onClick={toggleSort} />
                {/* The window the row's figures cover. It sits with the WORDS,
                    before the measurements, because it qualifies all six of
                    them — the same place Sensor Monitor puts the day its fuel
                    columns are counted over. */}
                <GridTh label="Period" k="period" sortKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <GridTh label="Rating" k="rating" sortKey={sortKey} dir={sortDir} onClick={toggleSort} num />
                <GridTh label="Trips" k="trips" sortKey={sortKey} dir={sortDir} onClick={toggleSort} num />
                <GridTh label="Tonnes" k="tonnes" sortKey={sortKey} dir={sortDir} onClick={toggleSort} num />
                <GridTh label="Mileage" k="mileageKm" sortKey={sortKey} dir={sortDir} onClick={toggleSort} num />
                <GridTh label="Fuel theft" k="fuelTheftCases" sortKey={sortKey} dir={sortDir} onClick={toggleSort} num />
                <GridTh label="Overspeed" k="overspeedingCases" sortKey={sortKey} dir={sortDir} onClick={toggleSort} num />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((d, i) => {
                const st = statusMeta(d.status);
                // Position by the measure, best first, whichever way it sorts.
                const pos = at * step + i;
                const rank = sortDir === "desc" ? pos + 1 : sorted.length - pos;
                // The row IS the control — this is a master-detail grid and
                // picking a driver is the point of it. It was mouse-only: no
                // tabindex, no key handler, no selected state announced.
                return (
                  <tr
                    key={d.id}
                    className={d.id === selectedId ? "dr-grid__row--selected" : ""}
                    onClick={() => onSelect(d.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(d.id); }
                    }}
                    tabIndex={0}
                    aria-selected={d.id === selectedId}
                  >
                    <td className="dr-drivercell">
                      <span className="dr-driver">
                        <span className="dr-rank" aria-label={ranked ? `Rank ${rank}` : undefined}>
                          {ranked ? rank : ""}
                        </span>
                        {/* Neutral, not per-driver. An identity hash paints a
                            colour that means nothing, and the eye reads it as
                            a status — next to the status badge and the two
                            incident columns, which DO carry colour, that is
                            six hues competing in one row. The initials are
                            the identifier; grey lets them be. This is the one
                            thing the User accounts row does that this row
                            does not: that table spends no other colour, so a
                            hue per person costs it nothing. */}
                        <span className="dr-avatar">
                          {initialsOf(d.fullName)}
                        </span>
                        {/* Name over identifier, which is the roster's stack.
                            The employee number and the licence were already
                            SEARCHABLE from the box above this grid and were
                            nowhere on screen — so a search by staff number
                            returned a row that could not be checked against
                            the number typed. The second line is also what
                            separates two drivers with one name, which a
                            registry synced from three sources has. */}
                        <span className="dr-driver__ident">
                          <span className="dr-driver__name">{titleCase(d.fullName)}</span>
                          {(d.employeeId || d.licenceNumber) && (
                            <span className="dr-driver__sub"
                                  /* The column is capped, and on a tablet the
                                     cap is 108px — a licence clipped mid-code
                                     is recoverable from a pointer rather than
                                     from the detail panel. */
                                  title={[
                                    d.employeeId ? `#${d.employeeId}` : null,
                                    d.licenceNumber ? `Licence ${d.licenceNumber}` : null,
                                  ].filter(Boolean).join(" · ")}>
                              {d.employeeId ? `#${d.employeeId}` : ""}
                              {d.employeeId && d.licenceNumber ? " · " : ""}
                              {d.licenceNumber ? `Lic ${d.licenceNumber}` : ""}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    <VehicleCell plate={d.vehicle} from={d.vehicleFrom} />
                    <td>
                      {/* The dot is kept INSIDE the badge rather than replaced
                          by it: a wash carries its meaning in its fill, which
                          is the part a red-green reader cannot use, and this
                          row already asks the eye to separate an amber column
                          from a red one. */}
                      <span className={`dr-grid__badge dr-grid__badge--${st.tone}`}>
                        <span className="dr-grid__dot" aria-hidden="true" />
                        {st.label}
                      </span>
                    </td>
                    <PeriodCell w={windowFor(d.id)} />
                    {/* `data-label` is what lets a row become a card under
                        768px: with no table head above it, each figure has to
                        carry the column name it came from. Inert on a desk,
                        where the head is still doing that job. */}
                    <MetricCell label="Rating" k="rating" value={d.rating} decimals={1} sortKey={sortKey} max={barMax}
                                prefix={<span className="dr-star" aria-hidden="true">★</span>} />
                    <MetricCell label="Trips" k="trips" value={d.trips} sortKey={sortKey} max={barMax} />
                    <MetricCell label="Tonnes" k="tonnes" value={d.tonnes} decimals={1} sortKey={sortKey} max={barMax} />
                    <MetricCell label="Mileage" k="mileageKm" value={d.mileageKm} sortKey={sortKey} max={barMax} />
                    {/* Incidents carry a DOT as well as a colour. Red-on-amber
                        is exactly the pair a red-green dichromat cannot
                        separate, and these two columns sit side by side. The
                        marker says "there is something here" without asking
                        the reader to name the hue. */}
                    <IncidentCell n={d.fuelTheftCases} tone="theft" label="Fuel theft" />
                    <IncidentCell n={d.overspeedingCases} tone="speed" label="Overspeed" />
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={10} className="dr-grid__empty">No drivers match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {/* Prev · where you are · Next, centred under the last row. The
            buttons stay in place and grey out at either end rather than
            vanishing, so the pair never shifts under a pointer that is
            clicking through pages. */}
        {pageCount > 1 && (
          <nav className="dr-pager" aria-label="Driver pages">
            <button
              type="button"
              className="dr-pager__btn"
              onClick={() => setPage(Math.max(0, at - 1))}
              disabled={at === 0}
            >
              ← Prev
            </button>
            <span className="dr-pager__info" aria-live="polite">
              Page {at + 1} of {pageCount}
              <span className="dr-pager__range">
                {" · "}{fmt(at * step + 1)}–{fmt(at * step + pageRows.length)} of {fmt(sorted.length)}
              </span>
            </span>
            <button
              type="button"
              className="dr-pager__btn"
              onClick={() => setPage(Math.min(pageCount - 1, at + 1))}
              disabled={at >= pageCount - 1}
            >
              Next →
            </button>
          </nav>
        )}
      </div>
    </>
  );
}


function GridChip({ label, active, onClick }) {
  return (
    <button
      type="button"
      className={`dr-chip${active ? " dr-chip--active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * A figure, and — in the column the grid is ranked by — a bar under it.
 *
 * Only the ranked column draws one. Bars in all four would be four rankings at
 * once, which is a chart nobody asked for; one bar says which column the order
 * comes from and how far apart the rows are on it.
 */
function MetricCell({ label, k, value, decimals = 0, sortKey, max, prefix = null }) {
  const barred = BAR_KEYS.has(k) && sortKey === k;
  return (
    <td className={"dr-num" + (barred ? " dr-num--ranked" : "")} data-label={label}>
      <span className="dr-metric">
        <span className="dr-metric__num">{prefix}{prefix ? " " : ""}{fmt(value, decimals)}</span>
        {barred && (
          <span className="dr-metric__track" aria-hidden="true">
            <span className="dr-metric__fill" style={{ "--share": Math.max(0, Math.min((value ?? 0) / max, 1)) }} />
          </span>
        )}
      </span>
    </td>
  );
}

function GridTh({ label, k, sortKey, dir, onClick, num }) {
  const active = sortKey === k;
  return (
    <th
      className={num ? "dr-num" : undefined}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {/* A real button, not a th with onClick. Sorting is this grid's second
          interaction after selection, and it was reachable only by mouse.
          aria-sort goes on the header cell, where a screen reader looks for it. */}
      <button type="button" className="dr-grid__sort" onClick={() => onClick(k)}
              title={`Sort by ${label.toLowerCase()}`}>
        <span>{label}</span>
        {/* Drawn in CSS rather than ▲/▼: those sit on a different baseline in
            every fallback font and drift against the label. */}
        <span className={"dr-caret" + (active ? ` dr-caret--${dir}` : "")} aria-hidden="true" />
      </button>
    </th>
  );
}

/**
 * The unit this driver is on.
 *
 * The registration from their most recent trip — the truck they actually got
 * into — and where the roster holds no trip for them, the unit they are
 * POSTED to, which the server hands over as `vehicleFrom: 'assignment'`. A
 * driver who has not driven inside the history the payload covers is not a
 * driver on no lorry, and a column of em-dashes down the night shift is worse
 * than the weaker fact, so the weaker fact is shown and marked: dimmer, with
 * the distinction in the title rather than in a second line of type.
 *
 * An em-dash is left for the case where the data genuinely has no answer —
 * neither a trip nor a posting, or a server that predates the field. That is
 * a roster gap to be filled by attaching a vehicle to the driver, not by this
 * page inventing a plate for them.
 */
function VehicleCell({ plate, from }) {
  if (!plate) {
    return (
      <td className="dr-veh dr-veh--none" data-label="Vehicle" title="No trip on record and no vehicle assigned">
        -
      </td>
    );
  }
  const posted = from === "assignment";
  return (
    <td
      className={`dr-veh${posted ? " dr-veh--posted" : ""}`}
      data-label="Vehicle"
      title={posted ? "Assigned to this unit, no trip on record yet" : "Last unit driven"}
    >
      {plate}
    </td>
  );
}

/**
 * The active window, or an honest blank.
 *
 * The count of active days rides in the title rather than in the cell: two
 * dates already tell the reader where the row sits in the quarter, and a third
 * figure in the same cell would be the only column here carrying two numbers.
 */
function PeriodCell({ w }) {
  if (!w) return <td className="dr-when dr-when--none" data-label="Period">No activity</td>;
  return (
    <td className="dr-when" data-label="Period" title={`${w.days} active day${w.days === 1 ? "" : "s"} in the last 90`}>
      {w.label}
    </td>
  );
}

/** A count that is zero, or a count that wants attention. */
function IncidentCell({ n, tone, label }) {
  if (!n) return <td className="dr-num dr-num--zero" data-label={label}>0</td>;
  return (
    <td className={`dr-num dr-incident dr-incident--${tone}`} data-label={label}>
      <span className="dr-incident__dot" aria-hidden="true" />
      {fmt(n)}
    </td>
  );
}


// Selected-driver trend as a stat chart - muted title + trend delta pill, big
// total value, a sub caption, and a daily chart underneath.
//
// The card's own headline IS the chart's readout. Moving the cursor over the
// line rewrites the value and the caption in place rather than floating a
// tooltip over the plot: the number is already set in the size the card wants
// it read at, the caption row already exists, and nothing moves when the
// pointer does. A tooltip would have been a second, smaller copy of both.
function TrendStat({ title, series, valueKey, unit, value, tone, type, sub, loading }) {
  const deltaPct = periodDelta(series.map((s) => s[valueKey]));
  const up = (deltaPct ?? 0) >= 0;
  const [cursor, setCursor] = useState(null);

  const at = cursor != null && series[cursor] ? series[cursor] : null;
  const decimals = unit === "t" ? 1 : 0;

  return (
    <div className={`dr-cell dr-statchart dr-statchart--${tone}`}>
      <div className="dr-statchart__head">
        <span className="dr-statchart__label">{title}</span>
        {deltaPct != null && (
          <span className={`dr-statchart__delta ${up ? "up" : "down"}`}>
            {up ? "▲" : "▼"} {Math.abs(deltaPct)}%
          </span>
        )}
      </div>
      <div className={"dr-statchart__value" + (at ? " dr-statchart__value--reading" : "")}>
        {at ? fmt(at[valueKey], decimals) : value}
        {unit && <span className="dr-statchart__unit"> {unit}</span>}
      </div>
      <div className="dr-statchart__sub">{at ? `${fmtDay(at.day)} · one day` : sub}</div>
      {type === "line" ? (
        <TrendLine
          series={series} valueKey={valueKey} unit={unit} title={title}
          decimals={decimals} loading={loading} cursor={cursor} onCursor={setCursor}
        />
      ) : (
        <TrendMini series={series} valueKey={valueKey} unit={unit} loading={loading} />
      )}
    </div>
  );
}

/* Monotone cubic interpolation (Fritsch-Carlson).
 *
 * Not Catmull-Rom, which is the usual reach for "make the line smooth": it
 * overshoots between points, and on a series that touches zero - which an idle
 * day does, most weeks - the overshoot dips the curve and its area fill BELOW
 * the baseline. A distance chart that draws negative kilometres is worse than
 * a jagged one. Monotone cubic is smooth and cannot overshoot: between two
 * samples the curve stays between their two values. */
function smoothPath(pts) {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;

  const dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  // Tangents: zero at every local extremum (that is what kills the overshoot),
  // a weighted harmonic mean of the neighbouring slopes everywhere else.
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  m[n - 1] = slope[n - 2];

  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + m[i] * h}` +
         ` ${pts[i + 1][0] - h},${pts[i + 1][1] - m[i + 1] * h}` +
         ` ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

/* The plot's aspect ratio IS the card's height, because the SVG scales
 * uniformly (height:auto) — so this ratio is what has to agree with Analytics,
 * not a pixel height. .an-kpi__spark measures 115px inside a 324px card at
 * 1440; 264/84 lands the same plot at 116px there and 97px on a phone. At the
 * 96 it was, the chart came out 130px and made every card in the row 14px
 * taller than the KPI tiles it sits under on the next tab. */
/* The plot is PAD_T..H-PAD_B, and only the bottom band has changed: 84/15
   became 73/4, so `base` is still 69 and every point, bar and crosshair lands
   exactly where it did. What went is the 11 units under the baseline that
   existed to seat two date ticks, which is ~11px of card height at this
   chart's width — on a four-up row of equal-height cards, off all four.
   4 rather than 0 because a marker sitting on the baseline has r=3.2. */
const CHART = { W: 264, H: 73, PAD_X: 7, PAD_T: 10, PAD_B: 4 };

// Per-day mileage as a smooth, readable line.
function TrendLine({ series, valueKey, unit, title, decimals, loading, cursor, onCursor }) {
  // useId, not a module counter: a duplicated gradient id would make the second
  // chart's fill resolve to the first one's stops.
  const gid = useId();

  if (loading) return <div className="dr-chart__empty" aria-busy="true">Loading…</div>;
  if (!series || series.length === 0) return <div className="dr-chart__empty">No activity in window</div>;
  // A series of nothing but zeros draws a flat line pinned to the axis inside a
  // full-height plot — a 110px box holding one horizontal rule. Say it instead.
  if (series.every((s) => !s[valueKey])) return <div className="dr-chart__empty">Nothing recorded in this window</div>;

  const { W, H, PAD_X, PAD_T, PAD_B } = CHART;
  const n = series.length;
  const step = n > 1 ? (W - PAD_X * 2) / (n - 1) : 0;
  const max = Math.max(1, ...series.map((s) => s[valueKey]));
  const base = H - PAD_B;
  const xOf = (i) => (n > 1 ? PAD_X + i * step : W / 2);
  const yOf = (v) => PAD_T + (1 - v / max) * (base - PAD_T);

  const pts = series.map((s, i) => [xOf(i), yOf(s[valueKey])]);
  const line = smoothPath(pts);
  const area = n > 1 ? `${line} L${xOf(n - 1)},${base} L${xOf(0)},${base} Z` : "";

  const clamp = (i) => Math.max(0, Math.min(n - 1, i));
  const pick = (e) => {
    if (n < 2) return onCursor(0);
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width) return undefined;
    // Client px -> viewBox units. The SVG scales uniformly, so one ratio does it.
    const vx = ((e.clientX - box.left) / box.width) * W;
    return onCursor(clamp(Math.round((vx - PAD_X) / step)));
  };
  const onKeyDown = (e) => {
    const move = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n }[e.key];
    if (move === undefined) {
      if (e.key === "Escape") onCursor(null);
      return;
    }
    e.preventDefault();
    onCursor(clamp((cursor ?? n - 1) + move));
  };

  const read = cursor != null && series[cursor];

  return (
    /* Focusable and arrow-driven, not hover-only. This is the one chart on the
       page carrying a per-day number, and a pointer was the only way to get at
       it. role=img with a label so a screen reader is told the shape rather
       than handed thirty unlabelled path nodes. */
    <svg
      className={"dr-spark" + (read ? " dr-spark--reading" : "")}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      tabIndex={0}
      /* The window's dates live here now rather than under the plot. They were
         two 7.5px ticks that never changed while the cursor moved and cost the
         card the band they sat in; the day a reader actually wants is the one
         under the pointer, and that is written into the caption above in the
         size the card sets its numbers. Nothing is lost to a screen reader. */
      aria-label={`${title} by day, ${fmtDay(series[0].day)} to ${fmtDay(series.at(-1).day)}. ${n} day${n === 1 ? "" : "s"}, highest ${fmt(max, decimals)} ${unit}. Arrow keys read each day.`}
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={() => onCursor(null)}
      onFocus={() => onCursor((c) => (c == null ? n - 1 : c))}
      onBlur={() => onCursor(null)}
      onKeyDown={onKeyDown}
    >
      <defs>
        <linearGradient id={`dr-fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="dr-spark__stop-a" />
          <stop offset="100%" className="dr-spark__stop-b" />
        </linearGradient>
      </defs>

      <line className="dr-spark__base" x1={PAD_X} y1={base} x2={W - PAD_X} y2={base} />
      {area && <path className="dr-spark__area" d={area} fill={`url(#dr-fill-${gid})`} />}
      {/* non-scaling-stroke so the line is the same weight at every card width -
          the SVG is laid out fluid and would otherwise thin out on a phone. */}
      <path className="dr-spark__line" d={line} vectorEffect="non-scaling-stroke" />
      {n === 1 && <circle className="dr-spark__marker" cx={xOf(0)} cy={pts[0][1]} r="3" />}

      {read && (
        <g className="dr-spark__cursor">
          <line
            className="dr-spark__crosshair" vectorEffect="non-scaling-stroke"
            x1={pts[cursor][0]} y1={PAD_T - 5} x2={pts[cursor][0]} y2={base}
          />
          <circle className="dr-spark__marker" cx={pts[cursor][0]} cy={pts[cursor][1]} r="3.2" />
        </g>
      )}
    </svg>
  );
}

// Per-day tonnes as bars. A bar carries its own hit target and its <title>
// answers "which day", which is why this one needed no cursor of its own — and
// why the date ticks came off it too.
function TrendMini({ series, valueKey, unit, loading }) {
  if (loading) return <div className="dr-chart__empty" aria-busy="true">Loading…</div>;
  if (!series || series.length === 0) return <div className="dr-chart__empty">No activity in window</div>;
  // Every bar zero-height is an empty box, not a chart. Same call as TrendLine.
  if (series.every((s) => !s[valueKey])) return <div className="dr-chart__empty">Nothing recorded in this window</div>;
  const { W, H, PAD_X, PAD_T, PAD_B } = CHART;
  const n = series.length;
  const stepX = (W - PAD_X * 2) / n;
  const base = H - PAD_B;
  const max = Math.max(1, ...series.map((s) => s[valueKey]));

  return (
    <svg className="dr-spark" viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label={`${fmt(n)} days of tonnage, ${fmtDay(series[0].day)} to ${fmtDay(series.at(-1).day)}, highest ${fmt(max, 1)} ${unit}. Each bar names its own day.`}>
      <line className="dr-spark__base" x1={PAD_X} y1={base} x2={W - PAD_X} y2={base} />
      {series.map((s, i) => {
        const bh = (s[valueKey] / max) * (base - PAD_T);
        return (
          <rect
            key={i} className="dr-spark__bar"
            x={PAD_X + i * stepX + 0.5} y={base - bh}
            width={Math.max(1, stepX - 1.5)} height={bh} rx="1.5"
          >
            <title>{fmtDay(s.day)}: {fmt(s[valueKey], unit === "t" ? 1 : 0)} {unit}</title>
          </rect>
        );
      })}
    </svg>
  );
}