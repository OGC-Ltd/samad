/*
 * Road Safety Compliance (operator, 2026-11-23; compliance-page-spec.md and
 * its mockup): the client's Road Safety Standard, measured from what the
 * system already has. Only requirements the system can measure are here; the
 * server works out each one for the period (server/compliance.go), this page
 * shows them: the summary cards, the table grouped by category, and a side
 * panel for one requirement (how it is measured, the period's breaches by day
 * and by unit, its last four weeks, and a way to the alerts behind it).
 *
 * ComplianceScreen reads; ComplianceView draws, from props alone, so the
 * page can be tested from a stubbed response (ComplianceScreen.test.jsx).
 */

import { useEffect, useMemo, useState } from "react";
import { askMenuRoom } from "../../lib/menuRoom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useAppActions } from "../../context/AppContext";
import { fetchCompliance, downloadCompliancePdf } from "../../api/compliance";
import { requestAlertsView } from "../../lib/alertsRequest";
import {
  CATEGORIES, PERIODS, filterRows, mostBreaches, okMeans, periodRange, pillWords, plainSum, summarise, tone, unitsNamed, unitsTitle,
} from "../../lib/compliance";
import FilterBar from "../body/FilterBar";
import EmptyNote from "../shared/EmptyNote";
import DetailSidebar, { DetailSidebarIdent, DetailSidebarSection } from "../shared/DetailSidebar";
import "./ComplianceScreen.scss";

const isHours = (ref) => ref.startsWith("5.1.4");

function Chip({ on, onClick, children, n, title }) {
  return (
    <button type="button" className={"sp4-filter-chip" + (on ? " sp4-filter-chip--on" : "")}
            aria-pressed={on} onClick={onClick} title={title}>
      {children}
      {n != null && <span className="sys-chip-n">{n}</span>}
    </button>
  );
}

/** The ring of the overall figure. */
function Ring({ value }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const v = typeof value === "number" ? value : 0;
  return (
    <svg className={`cmp-ring cmp-tone--${tone(value)}`} width="84" height="84" viewBox="0 0 84 84" aria-hidden="true">
      <circle className="cmp-ring__track" cx="42" cy="42" r={r} />
      <circle className="cmp-ring__value" cx="42" cy="42" r={r} strokeDasharray={`${(c * v) / 100} ${c}`} transform="rotate(-90 42 42)" />
    </svg>
  );
}

function Pill({ row }) {
  const t = row.monitored ? tone(row.compliance) : "none";
  return (
    <div className="cmp-comp">
      <span className={`cmp-pill cmp-tone--${t}`}>{pillWords(row)}</span>
      {typeof row.compliance === "number" && (
        <span className={`cmp-bar cmp-tone--${t}`} aria-hidden="true"><span style={{ width: `${row.compliance}%` }} /></span>
      )}
    </div>
  );
}

/** The period's breaches by day: a small bar per fleet day. */
function DayBars({ days }) {
  const max = Math.max(1, ...days.map((d) => d.n));
  const short = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return (
    <div className="cmp-days" role="img" aria-label={days.map((d) => `${d.day}: ${d.n}`).join(", ")}>
      {days.map((d) => (
        <div key={d.day} className="cmp-days__col" title={`${d.day}: ${d.n}`}>
          <span className={"cmp-days__bar" + (d.n ? "" : " cmp-days__bar--zero")} style={{ height: `${Math.max(4, (d.n / max) * 100)}%` }} />
          {days.length <= 7 && <span className="cmp-days__label">{short(d.day)}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * When an incident was: a moment, a day, or the stretch that was checked
 * ("Sun 22 Nov, 09:32 → Mon 23 Nov, 09:32"; a week of days ends on its last
 * day, until being exclusive).
 */
const itemWhen = (it) => {
  const fmt = (ms) => new Date(ms).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Nairobi",
    ...(it.wholeDay ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
  if (!it.until) return fmt(Date.parse(it.at));
  return `${fmt(Date.parse(it.at))} → ${fmt(Date.parse(it.until) - (it.wholeDay ? 86_400_000 : 0))}`;
};

/**
 * The units in breach; a unit with incidents opens to list them (operator,
 * 2026-11-23): when, what happened, the driver if not the unit's usual one,
 * the speed and a map link for a dashcam alarm.
 */
export function UnitList({ row, initialOpen = "" }) {
  const [open, setOpen] = useState(initialOpen);
  const count = (u) => (row.unitWord === "not reporting" ? "not reporting" : row.unitWord ? `${u.n} ${row.unitWord}` : u.n);
  return (
    <ul className="cmp-units cmp-units--open">
      {row.byUnit.map((u) => {
        const name = <span>{u.plate}{u.driver ? ` · ${u.driver}` : ""}</span>;
        if (!u.items?.length) return <li key={u.vehicleId}><div className="cmp-urow">{name}<b>{count(u)}</b></div></li>;
        const isOpen = open === u.vehicleId;
        return (
          <li key={u.vehicleId}>
            <button type="button" className="cmp-urow cmp-urow--btn" aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? "" : u.vehicleId)}>
              <i className={`ti ti-chevron-${isOpen ? "down" : "right"}`} aria-hidden="true" />
              {name}<b>{count(u)}</b>
            </button>
            {isOpen && (
              <ol className="cmp-items">
                {u.items.map((it, i) => (
                  <li key={`${it.at}-${i}`}>
                    <span className="cmp-items__when">{itemWhen(it)}</span>
                    <span className="cmp-items__what">
                      {it.what}
                      {it.speed != null && ` · ${Math.round(it.speed)} km/h`}
                      {it.driver && it.driver !== u.driver && ` · ${it.driver}`}
                      {it.lat != null && it.lon != null && (
                        <> · <a href={`https://www.google.com/maps?q=${it.lat},${it.lon}`} target="_blank" rel="noreferrer">Map</a></>
                      )}
                    </span>
                  </li>
                ))}
                {u.items.length < u.n && <li className="cmp-muted">Latest {u.items.length} of {u.n} shown.</li>}
              </ol>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RowPanel({ row, period, monitoredSince, onClose, onOpenAlerts }) {
  const sum = plainSum(row, period.noun);
  const since = monitoredSince && isHours(row.ref)
    ? new Date(monitoredSince).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Nairobi" })
    : null;
  return (
    <DetailSidebar className="cmp-panel" title="Requirement" label={row.requirement} itemKey={row.ref} onClose={onClose}
      footer={row.alerts && (
        <button type="button" className="sp4-ghost-btn" onClick={() => onOpenAlerts(row)}>
          Open in Alerts <i className="ti ti-arrow-right" aria-hidden="true" />
        </button>
      )}>
      <DetailSidebarIdent kind={<span className="cmp-panel-kind">{row.category}</span>} name={row.requirement}>
        <Pill row={row} />
      </DetailSidebarIdent>
      <DetailSidebarSection title="What it means">
        <p className="cmp-plain">
          <b>{sum.text}</b>
          {sum.pct != null && <> → <b>{sum.pct}%</b></>}
        </p>
        {okMeans(row) && <p className="cmp-plain-ok">OK means: {okMeans(row)}</p>}
        {since && <p className="cmp-muted cmp-plain-since">Driver hours tracked since {since}.</p>}
      </DetailSidebarSection>
      <DetailSidebarSection title={period.label}>
        <div className="cmp-panel-figure">
          <b>{row.monitored ? row.breaches : "—"}</b>
          <span>{row.result}</span>
        </div>
        {row.byDay?.length > 0 && row.monitored && <DayBars days={row.byDay} />}
      </DetailSidebarSection>
      <DetailSidebarSection title={unitsTitle(row)}>
        {row.byUnit?.length ? <UnitList key={row.ref} row={row} />
          : <p className="cmp-muted">{row.monitored ? "No unit in breach." : "Not monitored in this period."}</p>}
      </DetailSidebarSection>
      {row.weeks?.length > 0 && (
        <DetailSidebarSection title="Last 4 weeks" aside={<span className="cmp-aside">Compliance rate</span>}>
          <ul className="cmp-units cmp-weeks">
            {[...row.weeks].reverse().map((w) => (
              <li key={w.from}><span>{w.label}</span><b>{typeof w.compliance === "number" ? `${w.compliance}%` : "Not monitored"}</b></li>
            ))}
          </ul>
        </DetailSidebarSection>
      )}
    </DetailSidebar>
  );
}

/**
 * The page from its data alone.
 * @param {object} p
 * @param {{ rows: object[], units: number, monitoredSince: string|null }|null} p.data
 * @param {string} p.periodKey
 */
export function ComplianceView({ data, periodKey, loading = false, error = null, onRetry, onPeriod, onExport, exporting = false, onOpenAlerts, initialTab = CATEGORIES[0] }) {
  const [q, setQ] = useState("");
  // One category at a time, as tabs (operator, 2026-11-23: "switching tabs
  // operational requirements and vehicle requirements", not folding groups).
  const [tab, setTab] = useState(initialTab);
  const [breaches, setBreaches] = useState(false);
  const [unit, setUnit] = useState("");
  const [open, setOpen] = useState(null);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const sum = useMemo(() => summarise(rows), [rows]);
  const shown = useMemo(() => filterRows(rows, { q, category: tab, breaches, unit }), [rows, q, tab, breaches, unit]);
  const units = useMemo(() => unitsNamed(rows, data?.vehicles), [rows, data]);
  const period = PERIODS.find((p) => p.key === periodKey) ?? PERIODS[0];
  const openRow = open && rows.find((r) => r.ref === open);
  const activeCount = breaches + (unit !== "");
  const inTab = rows.filter((r) => r.category === tab);

  // The panel sits beside the table, not over it (operator, 2026-11-23): the
  // page makes room on its right, and the left menu folds while it is open.
  const panelOpen = Boolean(openRow);
  useEffect(() => {
    if (!panelOpen) return undefined;
    askMenuRoom(true);
    return () => askMenuRoom(false);
  }, [panelOpen]);

  return (
    <div className={"sp4-root sys-root cmp-root" + (panelOpen ? " cmp-root--panel" : "")}>
      <header className="cmp-head">
        <div>
          <h1 className="cmp-title">Safety Compliance</h1>
        </div>
        <div className="cmp-head__acts">
          <div className="cmp-seg" role="radiogroup" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.key} type="button" role="radio" aria-checked={p.key === periodKey}
                      className={"cmp-seg__btn" + (p.key === periodKey ? " cmp-seg__btn--on" : "")} onClick={() => onPeriod?.(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
          <button type="button" className="sp4-ghost-btn" onClick={onExport} disabled={!rows.length || exporting}>
            <i className="ti ti-file-type-pdf" aria-hidden="true" /> {exporting ? "Making the PDF…" : "Export PDF"}
          </button>
        </div>
      </header>

      {error && !rows.length ? (
        <EmptyNote icon="ti-alert-triangle" tone="error" title="Compliance Could Not Be Loaded" action={onRetry && { label: "Try again", onClick: onRetry }}>
          {String(error.message ?? error)}
        </EmptyNote>
      ) : loading && !rows.length ? (
        <EmptyNote icon="ti-loader-2" tone="busy" title="Measuring the Requirements">
          Positions, dashcam alarms and driver hours for {period.noun}.
        </EmptyNote>
      ) : (
        <>
          <section className={"cmp-cards" + (loading ? " cmp-stale" : "")} aria-label="Summary">
            <div className="cmp-card cmp-card--ring">
              <Ring value={sum.overall} />
              <div>
                <b className="cmp-big" data-testid="overall">{sum.overall == null ? "—" : `${sum.overall}%`}</b>
                <span className="cmp-label">Compliance {period.noun}</span>
              </div>
            </div>
            <div className="cmp-card"><span className="cmp-label"><i className="cmp-dot cmp-tone--met" />Fully met</span><b className="cmp-big" data-testid="met">{sum.met}</b></div>
            <div className="cmp-card"><span className="cmp-label"><i className="cmp-dot cmp-tone--amber" />With breaches</span><b className="cmp-big" data-testid="with">{sum.withBreaches}</b></div>
            <div className="cmp-card"><span className="cmp-label"><i className="cmp-dot cmp-dot--accent" />Units monitored</span><b className="cmp-big" data-testid="units">{data?.units ?? 0}</b></div>
            <div className="cmp-card cmp-card--cats">
              <span className="cmp-label cmp-label--caps">By category</span>
              {CATEGORIES.map((c) => (
                <div key={c} className="cmp-cat">
                  <span>{c}</span>
                  <span className={`cmp-bar cmp-tone--${tone(sum.categories[c])}`} aria-hidden="true"><span style={{ width: `${sum.categories[c] ?? 0}%` }} /></span>
                  <b>{sum.categories[c] == null ? "—" : `${sum.categories[c]}%`}</b>
                </div>
              ))}
            </div>
          </section>

          <FilterBar
            label="Filters"
            activeCount={activeCount}
            peek={(
              <div className="sp4-search-wrap cmp-search">
                <i className="ti ti-search sp4-search-icon" aria-hidden="true" />
                <input className="sp4-search" type="text" placeholder="Search requirement…" aria-label="Search requirement"
                       value={q} onChange={(e) => setQ(e.target.value)} />
                {q && <button type="button" className="sp4-search-clear" aria-label="Clear search" onClick={() => setQ("")}>✕</button>}
              </div>
            )}
          >
            <div className="sp4-filter-group">
              <Chip on={breaches} onClick={() => setBreaches((b) => !b)} n={inTab.filter((r) => typeof r.compliance === "number" && r.compliance < 100).length}>With breaches</Chip>
            </div>
            <label className="sp4-filter-group cmp-unit">
              <span className="sp4-filter-label">Unit</span>
              <select className="sp4-select" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit">
                <option value="">All</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.plate}</option>)}
              </select>
            </label>
          </FilterBar>

          <div className="cmp-tabs" role="tablist" aria-label="Category">
            {CATEGORIES.map((c) => (
              <button key={c} type="button" role="tab" id={`cmp-tab-${c}`} aria-selected={tab === c} aria-controls="cmp-tabpanel"
                      className={"cmp-tab" + (tab === c ? " cmp-tab--on" : "")} onClick={() => setTab(c)}>
                {c} requirements
                <span className="cmp-tab__n">{rows.filter((r) => r.category === c).length}</span>
                <span className={`cmp-tab__pct cmp-tone--${tone(sum.categories[c])}`}>{sum.categories[c] == null ? "—" : `${sum.categories[c]}%`}</span>
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            unit && !q && rows.filter((r) => r.category === tab).every((r) => !(r.byUnit ?? []).some((u) => u.vehicleId === unit)) ? (
              <EmptyNote icon="ti-circle-check" title={`${units.find((u) => u.id === unit)?.plate ?? "This unit"} had no breaches ${period.noun}`}>
                Nothing against it in the {tab.toLowerCase()} requirements.
              </EmptyNote>
            ) : (
              <EmptyNote icon="ti-filter-off" title="No Requirement Matches">Clear the search or a filter to see the others.</EmptyNote>
            )
          ) : (
            <div className={"cmp-table-wrap" + (loading ? " cmp-stale" : "")} id="cmp-tabpanel" role="tabpanel" aria-labelledby={`cmp-tab-${tab}`}>
              <table className="cmp-table">
                <thead>
                  <tr>
                    <th scope="col">Requirement</th>
                    <th scope="col">Result {period.noun}</th>
                    <th scope="col">Compliance</th>
                    <th scope="col">Most breaches</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.ref} className={"cmp-row" + (open === r.ref ? " cmp-row--open" : "")} tabIndex={0}
                        onClick={() => setOpen(r.ref)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(r.ref); } }}>
                      <td className="cmp-req">{r.requirement}</td>
                      <td className={r.monitored ? "" : "cmp-muted"}>{r.result}</td>
                      <td><Pill row={r} /></td>
                      <td className="cmp-most">{mostBreaches(r, unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {openRow && (
        <RowPanel row={openRow} period={period} monitoredSince={data?.monitoredSince} onClose={() => setOpen(null)}
                  onOpenAlerts={(row) => onOpenAlerts?.(row)} />
      )}
    </div>
  );
}

export default function ComplianceScreen() {
  const { setDesktopActiveTab } = useAppActions();
  const [periodKey, setPeriodKey] = useState("week");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  // The range is fixed when the period is picked, so a re-render does not move "now".
  const [range, setRange] = useState(() => periodRange("week"));

  const q = useQuery({
    queryKey: ["compliance", range.from, range.to],
    queryFn: ({ signal }) => fetchCompliance(range, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const pick = (key) => { setPeriodKey(key); setRange(periodRange(key)); };
  const exportPdf = async () => {
    setExporting(true);
    setExportError(null);
    try { await downloadCompliancePdf(range); } catch (e) { setExportError(e); } finally { setExporting(false); }
  };
  const openAlerts = (row) => {
    requestAlertsView(row.alerts);
    setDesktopActiveTab("alerts");
  };

  return (
    <>
      {exportError && (
        <div className="sp4-toast sp4-toast--crit" role="alert">
          <span className="sp4-toast-text">The PDF could not be made: {String(exportError.message ?? exportError)}</span>
          <button type="button" className="sp4-toast-x" aria-label="Dismiss" onClick={() => setExportError(null)}>×</button>
        </div>
      )}
      <ComplianceView
        data={q.data ?? null} periodKey={periodKey} range={range}
        loading={q.isFetching} error={q.error} onRetry={() => q.refetch()}
        onPeriod={pick} onExport={exportPdf} exporting={exporting} onOpenAlerts={openAlerts}
      />
    </>
  );
}
