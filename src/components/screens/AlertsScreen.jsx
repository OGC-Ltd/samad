/**
 * Alerts: fuel and overspeeding alerts from every organisation this account
 * holds, on one page, escalated and de-escalated there.
 *
 * Asked for 2026-10-12: "The fuel alerts and over speeding alerts we need to
 * have them on a centralized page that we can easily track, and manage —
 * escalate & de-escalate … it should list all organizations alerts and we can
 * filter so that it ease the pain of navigating from one organization to the
 * next." So the page does not follow the company in the header: it lists
 * every organisation the server says this account may read (through
 * alerts:read, or the existing fuel_theft:read / analytics:read grants), and
 * the Organisation chips narrow it.
 *
 * A fuel alert is what the map announces as a possible theft; unlike the map,
 * it stays here after 24 hours and after a decision, listed under it. An
 * overspeeding alert is one completed episode. Deciding one posts to its own
 * organisation's route, and only that organisation's administrators (or the
 * platform administrator) are offered the buttons: `canDecide` per
 * organisation, from the server.
 *
 * Built from the Fuel Audit's parts (SensorPanel's table, the Fuel report's
 * cards), so the fuel pages read alike.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "../body/SensorPanel.css";
import "./SystemScreen.css";
import "./FuelReportScreen.css";
import "./AuditScreen.css";
import "./AlertsScreen.css";
import { useAppActions, useAppSelector, useCompanies } from "../../context/AppContext";
import { usePermissions } from "../../hooks/usePermissions";
import { useApiData } from "../../hooks/useApiData";
import { decideAlert, fetchAlertHistory, fetchAlerts, markAlertsRead, markAllAlertsRead } from "../../api/alerts";
import { ALERT_SUMMARY_KEY } from "../../hooks/useAlertSummary";
import { hushFuelAlarm, useFuelAlarm } from "../../hooks/useFuelAlarm";
import { plateIn } from "../../lib/plate";
import { settleLimited } from "../../lib/settleLimited";
import {
  ALERT_KINDS, KINDS, OVER_BY, PERIODS, READS, STATUSES, alertPager, figureOf, kindOf, bulkPlan, bulkWords, choiceWords, companyForOrgCode, alertTrend, countWhere,
  daysBounds, daysWords, decisionWords, duration, fleetDay, headline, kmh, litres, periodDays,
  reportedLate, ruleWords, statusOf, unitQueues, when,
} from "../../lib/alertsView";
import { Card, Gauge } from "./FuelReportOverview";
import TableToolbar from "../body/TableToolbar";
import TablePager, { PAGE_STEP } from "../body/TablePager";
import FilterBar from "../body/FilterBar";
import EmptyNote from "../shared/EmptyNote";
import DetailSidebar, { DetailSidebarFacts, DetailSidebarIdent, DetailSidebarSection } from "../shared/DetailSidebar";
import { watchTableLabels } from "../../lib/tableLabels";

const POLL_MS = 60_000;
const rowKey = (a) => `${a.kind}:${a.id}`;
const NO_PICKS = new Map();

const EMPTY = {
  open: { icon: "ti-circle-check", title: "No Open Alerts", sub: "Every alert in this period has been escalated or de-escalated." },
  escalated: { icon: "ti-alert-triangle", title: "Nothing Escalated", sub: "No alert in this period has been escalated." },
  deescalated: { icon: "ti-circle-check", title: "Nothing De-escalated", sub: "No alert in this period has been de-escalated." },
  all: { icon: "ti-bell", title: "No Alerts", sub: "No alert in this period." },
};
const EMPTY_READ = {
  unread: { icon: "ti-mail-opened", title: "Nothing Unread", sub: "You have opened every alert these filters list." },
  read: { icon: "ti-mail", title: "Nothing Read Yet", sub: "Alerts you open, or mark read, are listed here." },
};

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The choices an alert takes after a decision, as the server would answer (alerts.rules). */
function choicesAfter(alert, outcome, reason) {
  if (alert.kind !== "fuel") return [{ outcome: outcome === "ESCALATED" ? "DEESCALATED" : "ESCALATED", reason: null }];
  if (reason === "probe_fault") return [];
  const all = [
    { outcome: "ESCALATED", reason: "theft" },
    { outcome: "ESCALATED", reason: "probe_fault" },
    { outcome: "DEESCALATED", reason: null },
  ];
  return all.filter((c) => !(c.outcome === outcome && c.reason === (outcome === "ESCALATED" ? reason : null)));
}

/** An alert as it stands after a decision made here, laid over its row until the server's next answer. */
function afterDecision(alert, choice, note, review) {
  const d = { outcome: choice.outcome, reason: choice.reason, note, by: review?.by ?? null, at: review?.at ?? new Date().toISOString() };
  return {
    ...alert,
    status: choice.outcome === "ESCALATED" ? "escalated" : "deescalated",
    decision: d,
    history: [...alert.history, d],
    choices: choicesAfter(alert, choice.outcome, choice.reason),
    cleared: null,
    ...(alert.kind === "fuel" ? { fuel: { ...alert.fuel, live: false } } : {}),
  };
}

/**
 * One end of the From / To pick: Sensor Monitor's day field. A typed year
 * passes through "0002", "0020"… on its way to "2026", so the day is taken
 * once it is whole, or when the field is left; the calendar's pick is whole
 * at once.
 */
function DayField({ label, value, max, onPick }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const whole = (v) => /^20\d\d-\d\d-\d\d$/.test(v);
  return (
    <input
      type="date"
      className="sp4-date-input"
      aria-label={label}
      value={draft}
      max={max}
      onChange={(e) => {
        setDraft(e.target.value);
        if (whole(e.target.value)) onPick(e.target.value);
      }}
      onBlur={() => {
        // Cleared: back to the default week (pickDay). Half a date: put back.
        if (draft !== value && (draft === "" || whole(draft))) onPick(draft);
        setDraft(value);
      }}
    />
  );
}

/** One figure as a gauge against the period's whole, like the Fuel Audit's cards. */
function StatCard({ title, n, of, color, note, loading }) {
  const shown = n == null ? "-" : n;
  const unit = of > 0 ? `of ${of} alert${of === 1 ? "" : "s"}` : loading ? "reading" : "no alerts";
  return (
    <Card title={title} note={note} className="aud-stat">
      <Gauge ratio={of > 0 && n != null ? n / of : 0} color={color} value={shown} unit={unit}
             ariaLabel={`${title}: ${shown} of ${of ?? 0} alerts.`} />
    </Card>
  );
}

const TREND_W = 240;
const TREND_H = 100;
const TREND_LINES = Object.entries(ALERT_KINDS).map(([key, k]) => ({ key, label: k.tag, cls: `alr-trend__line--${k.line}` }));

/** The kind's tag: its icon and word, as in the table. */
function KindTag({ kind }) {
  const k = kindOf(kind);
  return (
    <span className={`alr-kind alr-kind--${kind}`}>
      <i className={`ti ${k.icon}`} aria-hidden="true" />
      {k.tag}
    </span>
  );
}

const UNIT_WORDS = { day: "a day", week: "a week", month: "a month" };

/**
 * Every alert ever received, one line for fuel and one for overspeeding, a
 * day, week or month a point (alertsView alertTrend). Pointing at (or arrowing
 * along) the chart reads out that point; otherwise the key holds the totals.
 */
function TrendCard({ trend, loading, kinds }) {
  const [at, setAt] = useState(null);
  const series = trend?.points ?? null;
  const n = series?.length ?? 0;
  // Only the kinds the organisations on the page hold: a fleet with no fuel
  // data has no fuel line.
  const lines = TREND_LINES.filter((l) => !kinds || kinds.has(l.key));
  const top = Math.max(1, ...(series ?? []).flatMap((d) => lines.map((l) => d[l.key])));
  const xPct = (i) => (n < 2 ? 50 : (i / (n - 1)) * 100);
  // Room above the top line for its figure.
  const y = (v) => 16 + (1 - v / top) * (TREND_H - 20);
  const path = (k) => series.map((d, i) => `${i ? "L" : "M"}${((xPct(i) / 100) * TREND_W).toFixed(1)},${y(d[k]).toFixed(1)}`).join("");
  const sum = (k) => (series ?? []).reduce((t, d) => t + d[k], 0);
  const point = at != null && series?.[at] ? series[at] : null;

  const pointAt = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!n || r.width <= 0) return;
    setAt(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };
  const onKey = (e) => {
    if (!n || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    setAt((i) => Math.max(0, Math.min(n - 1, (i ?? n) + (e.key === "ArrowLeft" ? -1 : 1))));
  };
  const readout = point ? point.words : n ? `Since ${series[0].words.replace(/^Week of /, "")}` : "";

  return (
    <Card title="Alerts over time" className="aud-stat alr-trend">
      <ul className="alr-trend__key" aria-live="polite">
        {lines.map((l) => (
          <li key={l.key} className={l.cls}>
            <i aria-hidden="true" />{l.label}
            <b>{series ? (point ? point[l.key] : sum(l.key)) : "-"}</b>
          </li>
        ))}
        <li className="alr-trend__when">{series ? readout : loading ? "Reading…" : ""}</li>
      </ul>
      <div className="alr-trend__plot" tabIndex={n ? 0 : -1}
           role="img"
           aria-label={series
             ? `Alerts ${UNIT_WORDS[trend.unit]}, ${readout.toLowerCase()}: ${lines.map((l) => `${sum(l.key)} ${kindOf(l.key).noun}`).join(", ")}. Arrow keys read one point.`
             : "Alerts over time: reading."}
           onPointerMove={pointAt} onPointerDown={pointAt} onPointerLeave={() => setAt(null)}
           onKeyDown={onKey} onBlur={() => setAt(null)}>
        <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1="0" x2={TREND_W} y1={y(top * f)} y2={y(top * f)} className="alr-trend__grid" />
          ))}
          {n > 1 && lines.map((l) => (
            <path key={l.key} d={path(l.key)} className={`alr-trend__line ${l.cls}`} />
          ))}
          {point && (
            <line x1={(xPct(at) / 100) * TREND_W} x2={(xPct(at) / 100) * TREND_W} y1="0" y2={TREND_H}
                  className="alr-trend__cursor" />
          )}
        </svg>
        {/* Points in HTML, so they stay round however the chart stretches. */}
        {series && (n === 1 || point) && lines.map((l) => {
          const i = point ? at : 0;
          return (
            <span key={l.key} className={`alr-trend__dot ${l.cls}`}
                  style={{ left: `${xPct(i)}%`, top: `${(y(series[i][l.key]) / TREND_H) * 100}%` }} />
          );
        })}
        <span className="alr-trend__top">{top} {series ? UNIT_WORDS[trend.unit] : ""}</span>
      </div>
    </Card>
  );
}

function Chip({ on, onClick, children, n, title }) {
  return (
    <button type="button" className={"sp4-filter-chip" + (on ? " sp4-filter-chip--on" : "")}
            aria-pressed={on} onClick={onClick} title={title}>
      {children}
      {n != null && <span className="sys-chip-n">{n}</span>}
    </button>
  );
}

/**
 * Escalate or de-escalate one alert: ONE Escalate button with what it is
 * escalated as chosen under it (the operator's rule for fuel), a reason, and
 * a confirm button that says what will happen.
 */
function DecisionPanel({ alert, start, onDecided, onCancel, onToast }) {
  const escalations = alert.choices.filter((c) => c.outcome === "ESCALATED");
  const deescalation = alert.choices.find((c) => c.outcome === "DEESCALATED") ?? null;
  // De-escalate is picked when nothing else was asked for (operator,
  // 2026-10-20: "the deescalate button should be selected by default").
  const [outcome, setOutcome] = useState(
    start && alert.choices.some((c) => c.outcome === start) ? start
      : alert.choices.some((c) => c.outcome === "DEESCALATED") ? "DEESCALATED" : null);
  const [reason, setReason] = useState(escalations[0]?.reason ?? null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const noteRef = useRef(null);

  const choice = outcome === "ESCALATED"
    ? escalations.find((c) => c.reason === reason) ?? escalations[0]
    : outcome === "DEESCALATED" ? deescalation : null;
  const words = choice ? choiceWords(alert.kind, choice) : null;
  const ok = note.trim().length >= 3;

  useEffect(() => { if (outcome) noteRef.current?.focus(); }, [outcome]);

  const run = async () => {
    if (!choice || !ok || busy) return;
    setBusy(true);
    try {
      const review = await decideAlert(alert, choice.outcome, note.trim(), choice.reason);
      onDecided(alert, choice, note.trim(), review);
    } catch (err) {
      onToast({ tone: "crit", text: err?.message || "The decision could not be saved. Try again." });
      setBusy(false);
    }
  };

  return (
    <div className="alr-decide">
      <div className="alr-decide-row" role="group" aria-label="Decision">
        {escalations.length > 0 && (
          <button type="button" aria-pressed={outcome === "ESCALATED"}
                  className={"sp4-ghost-btn alr-pick alr-pick--esc" + (outcome === "ESCALATED" ? " is-on" : "")}
                  onClick={() => setOutcome("ESCALATED")} disabled={busy}>
            <i className="ti ti-arrow-big-up-line" aria-hidden="true" /> Escalate
          </button>
        )}
        {deescalation && (
          <button type="button" aria-pressed={outcome === "DEESCALATED"}
                  className={"sp4-ghost-btn alr-pick alr-pick--de" + (outcome === "DEESCALATED" ? " is-on" : "")}
                  onClick={() => setOutcome("DEESCALATED")} disabled={busy}>
            <i className="ti ti-arrow-big-down-line" aria-hidden="true" /> De-escalate
          </button>
        )}
      </div>

      {outcome === "ESCALATED" && escalations.length > 1 && (
        <div className="sp4-filter-group alr-as" role="radiogroup" aria-label="Escalate as">
          <span className="sp4-filter-label">As</span>
          {escalations.map((c) => (
            <button key={c.reason} type="button" role="radio" aria-checked={reason === c.reason}
                    className={"sp4-filter-chip" + (reason === c.reason ? " sp4-filter-chip--on" : "")}
                    onClick={() => setReason(c.reason)} disabled={busy}>
              {choiceWords(alert.kind, c).label}
            </button>
          ))}
        </div>
      )}

      {words && (
        <>
          <label className="sp4-field">
            <span className="sp4-label">Reason</span>
            <textarea ref={noteRef} className="sp4-textarea alr-note" rows={3} maxLength={2000} value={note}
                      disabled={busy} placeholder={words.placeholder} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p className="alr-hint">{words.hint}</p>
          <div className="aud-raise-foot">
            {!ok && <span className="sp4-repair-pending">Give a reason to continue</span>}
            <button type="button" className="sp4-ghost-btn" onClick={() => { setOutcome(null); onCancel?.(); }} disabled={busy}>
              Cancel
            </button>
            <button type="button" className={"sp4-submit-btn" + (choice.outcome === "ESCALATED" ? " alr-submit--esc" : "")}
                    onClick={run} disabled={!ok || busy}>
              {busy ? "Saving…" : words.confirm}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const BULK_REQUESTS = 3;
const FUEL_AS = ["theft", "probe_fault"];

/**
 * Escalate or de-escalate the selected alerts at once (operator, 2026-10-13:
 * "escalate or deescalate or both escalate and deescalate multiple"). Each
 * alert has its own pick, set at first from the button that opened the panel,
 * so one batch can escalate some and de-escalate others. One reason for each
 * side, as on a single alert, and one "as" for the fuel escalations.
 *
 * Sent a few units at a time, each unit's alerts one after another (see
 * lib/alertsView unitQueues). An alert that fails stays selected with why, so
 * the batch can be tried again; the rest are done.
 */
function BulkPanel({ alerts, start, failed, orgName, onRemove, onClose, onFinished }) {
  const offered = (a, outcome) => a.choices.some((c) => c.outcome === outcome);
  const [picks, setPicks] = useState({});
  const pickOf = (a) => {
    const k = rowKey(a);
    if (k in picks) return picks[k];
    return start && offered(a, start) ? start : null;
  };
  const [fuelReason, setFuelReason] = useState("theft");
  const [notes, setNotes] = useState({ ESCALATED: "", DEESCALATED: "" });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);

  const pickMap = Object.fromEntries(alerts.map((a) => [rowKey(a), pickOf(a)]));
  const { run, skip } = bulkPlan(alerts, pickMap, fuelReason, rowKey);
  const skipWhy = new Map(skip.map((s) => [rowKey(s.alert), s.why]));
  const esc = run.filter((s) => s.outcome === "ESCALATED");
  const de = run.filter((s) => s.outcome === "DEESCALATED");
  // A side shows while anything is picked for it, even if none of those can
  // take it as things stand: the fuel "as" lives there, and switching it is
  // how an alert already escalated as a theft goes on as a faulty probe.
  const pickedFor = (outcome) => alerts.filter((a) => pickOf(a) === outcome);
  const fuelEsc = pickedFor("ESCALATED").some((a) => a.kind === "fuel");
  const sides = ["ESCALATED", "DEESCALATED"].filter((o) => pickedFor(o).length > 0);
  const missing = [esc.length > 0 && "ESCALATED", de.length > 0 && "DEESCALATED"]
    .filter(Boolean).filter((o) => notes[o].trim().length < 3);
  const ok = run.length > 0 && missing.length === 0;

  const setPick = (a, outcome) => setPicks((p) => ({ ...p, [rowKey(a)]: pickOf(a) === outcome ? null : outcome }));

  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setSent(0);
    const done = [];
    await settleLimited(unitQueues(run), BULK_REQUESTS, async (queue) => {
      for (const step of queue) {
        const note = notes[step.outcome].trim();
        try {
          const review = await decideAlert(step.alert, step.outcome, note, step.reason);
          done.push({ ...step, note, review, ok: true });
        } catch (err) {
          done.push({ ...step, note, ok: false, error: err?.message || "The decision could not be saved." });
        }
        setSent(done.length);
      }
    });
    setBusy(false);
    onFinished(done);
  };

  /** One side's reason box: the words of the kinds it holds. */
  const side = (outcome, steps) => {
    const kinds = [...new Set(pickedFor(outcome).map((a) => a.kind))];
    const words = kinds.map((k) => choiceWords(k, { outcome, reason: k === "fuel" && outcome === "ESCALATED" ? fuelReason : null }));
    const placeholder = words.length === 1 ? words[0].placeholder
      : outcome === "ESCALATED" ? "Why are these escalated, and what happens next?" : "Why are none of these what they were flagged as?";
    return (
      <div className={`alr-bulk-side alr-bulk-side--${outcome === "ESCALATED" ? "esc" : "de"}`}>
        <h4 className="alr-bulk-side-t">
          <i className={`ti ${outcome === "ESCALATED" ? "ti-arrow-big-up-line" : "ti-arrow-big-down-line"}`} aria-hidden="true" />
          {outcome === "ESCALATED" ? "Escalate" : "De-escalate"} {steps.length}
          {pickedFor(outcome).length > steps.length && ` of ${pickedFor(outcome).length}`}
        </h4>
        {outcome === "ESCALATED" && fuelEsc && (
          <div className="sp4-filter-group alr-as" role="radiogroup" aria-label="Escalate the fuel alerts as">
            <span className="sp4-filter-label">Fuel as</span>
            {FUEL_AS.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={fuelReason === r}
                      className={"sp4-filter-chip" + (fuelReason === r ? " sp4-filter-chip--on" : "")}
                      onClick={() => setFuelReason(r)} disabled={busy}>
                {choiceWords("fuel", { outcome: "ESCALATED", reason: r }).label}
              </button>
            ))}
          </div>
        )}
        <label className="sp4-field">
          <span className="sp4-label">Reason{steps.length > 1 ? ", for all " + steps.length : ""}</span>
          <textarea className="sp4-textarea alr-note" rows={2} maxLength={2000} value={notes[outcome]} disabled={busy}
                    placeholder={placeholder} onChange={(e) => setNotes((n) => ({ ...n, [outcome]: e.target.value }))} />
        </label>
        {[...new Set(words.map((w) => w.hint))].map((h) => <p key={h} className="alr-hint">{h}</p>)}
      </div>
    );
  };

  const confirm = busy ? `Saving ${sent} of ${run.length}…`
    : esc.length && de.length ? `Escalate ${esc.length}, de-escalate ${de.length}`
    : esc.length ? `Escalate ${esc.length} alert${esc.length === 1 ? "" : "s"}`
    : de.length ? `De-escalate ${de.length} alert${de.length === 1 ? "" : "s"}`
    : "Nothing to decide";

  return (
    <section className="frv-card aud-card alr-bulk" aria-label="Decide the selected alerts">
      <div className="aud-card__head">
        <h3 className="frv-card__t">Decide {alerts.length} alert{alerts.length === 1 ? "" : "s"}</h3>
        <button type="button" className="sp4-ghost-btn" onClick={onClose} disabled={busy}>Close</button>
      </div>
      <p className="alr-hint">Pick Escalate or De-escalate for each alert; one left unpicked stays as it is.</p>

      <ul className="alr-bulk-list">
        {alerts.map((a) => {
          const k = rowKey(a);
          const pick = pickOf(a);
          const st = statusOf(a);
          const h = headline(a);
          const note = failed.get(k) ? `Not saved: ${failed.get(k)}` : skipWhy.get(k) ?? null;
          return (
            <li key={k} className={"alr-bulk-item" + (failed.has(k) ? " is-failed" : "") + (!pick ? " is-left" : "")}>
              <span className="alr-bulk-unit">
                <span className="sp4-reg" title={a.vehicleName || a.plate}>{plateIn(a.plate, a.vehicleName) ?? a.plate}</span>
                <span className="alr-org">{orgName(a)}</span>
              </span>
              <span className="alr-bulk-what">
                <KindTag kind={a.kind} />
                <span><b className="sys-num">{h.figure}</b> <span className="aud-unit">{h.words} · {when(a.at)}</span></span>
              </span>
              <span className={`sp4-pill sp4-pill--${st.tone}`} title={st.meaning}>{st.label}</span>
              <span className="alr-bulk-pick" role="group" aria-label={`Decision for ${a.plate}`}>
                <button type="button" aria-pressed={pick === "ESCALATED"} disabled={busy || !offered(a, "ESCALATED")}
                        className={"sp4-ghost-btn alr-pick alr-pick--esc" + (pick === "ESCALATED" ? " is-on" : "")}
                        onClick={() => setPick(a, "ESCALATED")}>Escalate</button>
                <button type="button" aria-pressed={pick === "DEESCALATED"} disabled={busy || !offered(a, "DEESCALATED")}
                        className={"sp4-ghost-btn alr-pick alr-pick--de" + (pick === "DEESCALATED" ? " is-on" : "")}
                        onClick={() => setPick(a, "DEESCALATED")}>De-escalate</button>
                <button type="button" className="sp4-ghost-btn alr-bulk-x" aria-label={`Take ${a.plate} out of the selection`}
                        title="Take out of the selection" onClick={() => onRemove(a)} disabled={busy}>
                  <i className="ti ti-x" aria-hidden="true" />
                </button>
              </span>
              {note && <span className={"alr-bulk-why" + (failed.has(k) ? " is-crit" : "")}>{note}</span>}
            </li>
          );
        })}
      </ul>

      {sides.length > 0 && (
        <div className="alr-bulk-sides">
          {sides.includes("ESCALATED") && side("ESCALATED", esc)}
          {sides.includes("DEESCALATED") && side("DEESCALATED", de)}
        </div>
      )}

      <div className="aud-raise-foot">
        {run.length > 0 && missing.length > 0 && (
          <span className="sp4-repair-pending">
            {missing.length === 2 ? "Give a reason for each side" : `Give a reason to ${missing[0] === "ESCALATED" ? "escalate" : "de-escalate"}`}
          </span>
        )}
        <button type="button" className="sp4-ghost-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className={"sp4-submit-btn" + (esc.length ? " alr-submit--esc" : "")} onClick={go} disabled={!ok || busy}>
          {confirm}
        </button>
      </div>
    </section>
  );
}

function Facts({ alert, org }) {
  const rows = [];
  if (alert.kind === "fuel") {
    const f = alert.fuel;
    rows.push(["Lost", litres(f.litres)]);
    if (f.tankBeforeL != null && f.tankAfterL != null) rows.push(["Tank", `${litres(f.tankBeforeL)} → ${litres(f.tankAfterL)}`]);
    rows.push(["Rule", ruleWords(f.rule)]);
    if (f.confidence != null) rows.push(["Confidence", `${Math.round(f.confidence * 100)}%`]);
    rows.push(["Began", when(alert.at)], ["Reported", when(f.detectedAt)]);
    if (f.location) rows.push(["Where", f.location]);
    if (f.driverName) rows.push(["Driver", f.driverName]);
    if (f.probeHold) rows.push(["Probe", "Reported for a fuel probe repair, not yet fixed"]);
  } else if (alert.kind === "camera") {
    const c = alert.camera;
    rows.push(["Alarm", c.label], ["Severity", c.severity === "critical" ? "Critical" : c.severity === "warning" ? "Warning" : "Information"]);
    if (c.speedKmh != null) rows.push(["Speed", kmh(c.speedKmh)]);
    rows.push(["When", when(alert.at)], ["Reported", when(alert.arrivedAt)]);
    if (c.lat != null && c.lng != null) rows.push(["Where", `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`]);
    rows.push(["Driver", c.driverName || "Not recorded"]);
  } else {
    const s = alert.speeding;
    rows.push(["Peak", kmh(s.peakKmh)], ["Limit", `${kmh(s.limitKmh)}${s.limitSource === "zone" ? " (zone)" : s.limitSource === "road" ? " (road)" : ""}`]);
    rows.push(["Over by", `${Math.round(s.overByKmh)} km/h`]);
    if (s.avgKmh != null) rows.push(["Average", kmh(s.avgKmh)]);
    rows.push(["Lasted", duration(s.durationSec)]);
    if (s.distanceM != null) rows.push(["Distance", `${(s.distanceM / 1000).toFixed(1)} km`]);
    rows.push(["From", when(alert.at)], ["To", when(s.endedAt)]);
    if (s.place) rows.push(["Where", s.place]);
    else if (s.lat != null && s.lng != null) rows.push(["Where", `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`]);
    rows.push(["Driver", s.driverName ?? "Not recorded"]);
    rows.push(["Evidence", `${s.frames} reading${s.frames === 1 ? "" : "s"} over the limit`]);
  }
  rows.push(["Organisation", org?.name ?? "-"]);
  return (
    <dl className="alr-facts">
      {rows.map(([k, v]) => (
        <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>
      ))}
    </dl>
  );
}

/**
 * The open alert, in the app's detail sidebar (shared/DetailSidebar: the
 * Drivers page's panel). Picking a row opens it under the header; another row
 * swaps the alert in place; × or Esc closes it. The table stays usable beside
 * it. Everything in it is already on the page's rows, so opening it costs no
 * request.
 */
function AlertPanel({ alert, org, start, canMap, onClose, onDecided, onToast, onShowOnMap, onOpenAudit }) {
  const k = rowKey(alert);
  const st = statusOf(alert);
  const h = headline(alert);
  const canDecide = org?.canDecide && alert.choices.length > 0;
  const why = !org?.canDecide
    ? `Only an administrator of ${org?.name ?? "this organisation"} can escalate or de-escalate this alert.`
    : alert.kind === "fuel" && alert.decision?.reason === "probe_fault"
      ? "Escalated as a faulty fuel probe: the case is in Fuel Audit and closes when its repair is signed off fixed."
      : "This alert was decided in its case and cannot be changed here.";
  const at = alert.speeding ?? alert.camera;
  const place = at?.lat != null && at?.lng != null
    ? `https://www.openstreetmap.org/?mlat=${at.lat}&mlon=${at.lng}#map=15/${at.lat}/${at.lng}`
    : null;
  const title = kindOf(alert.kind).title;
  const clips = alert.kind === "camera"
    ? [["Road", alert.camera.clips?.roadFacing], ["Driver", alert.camera.clips?.driverFacing]].filter(([, url]) => url)
    : [];

  return (
    <DetailSidebar
      title={title}
      label={`${title}, ${alert.plate}`}
      itemKey={k}
      onClose={onClose}
      footer={(canMap || place) ? (
        <>
          {place && (
            <a className="sp4-ghost-btn" href={place} target="_blank" rel="noreferrer noopener">
              <i className="ti ti-external-link" aria-hidden="true" /> Where it happened
            </a>
          )}
          {canMap && (
            <button type="button" className="sp4-ghost-btn" onClick={() => onShowOnMap(alert)}>
              <i className="ti ti-map-pin" aria-hidden="true" />
              {alert.kind === "fuel" && alert.fuel.live ? " Open on the map" : " Show unit on the map"}
            </button>
          )}
        </>
      ) : null}
    >
      <DetailSidebarIdent
        kind={<KindTag kind={alert.kind} />}
        name={plateIn(alert.plate, alert.vehicleName) ?? alert.plate}
        nameTitle={alert.vehicleName || alert.plate}
        sub={org?.name ?? "-"}
      >
        {alert.fuel?.probeHold && (
          <span className="alr-probe" title="This unit is already reported for a fuel probe repair">
            <i className="ti ti-tool" aria-hidden="true" />Probe reported
          </span>
        )}
      </DetailSidebarIdent>

      <DetailSidebarFacts facts={[
        { label: alert.kind === "fuel" ? "Lost" : alert.kind === "camera" ? "Alarm" : "Over by", value: h.figure },
        { label: "When", value: when(alert.at) },
        { label: "State", value: <span className={`sp4-pill sp4-pill--${st.tone}`} title={st.meaning}>{st.label}</span> },
      ]} />

      <DetailSidebarSection title="What Happened">
        <Facts alert={alert} org={org} />
      </DetailSidebarSection>

      {alert.kind === "camera" && (
        <DetailSidebarSection title="Recording">
          {clips.length > 0 ? (
            <div className="alr-clips">
              {clips.map(([label, url]) => (
                <figure key={label} className="alr-clip">
                  <video src={url} controls preload="none" playsInline />
                  <figcaption>
                    {label} camera · <a href={url} target="_blank" rel="noreferrer noopener">open the clip</a>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="dsb__note">No clip for this alarm.</p>
          )}
          {clips.length > 0 && (
            <p className="alr-hint">The camera uploads its clip after the alarm, so a new one can take a few minutes to play.</p>
          )}
        </DetailSidebarSection>
      )}

      <DetailSidebarSection title="Decision">
        {alert.history.length > 0 ? (
          <ol className="alr-history">
            {[...alert.history].reverse().map((d, i) => (
              <li key={`${d.at}-${i}`} className={i === 0 ? "is-current" : ""}>
                <span className="alr-history-what">{decisionWords(alert.kind, d)}</span>
                <span className="aud-unit"> · {d.by ?? "Someone"} · {when(d.at)}{i > 0 ? " · replaced" : ""}</span>
                {d.note && <p className="aud-case-note">{d.note}</p>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="dsb__note">Not decided yet{alert.cleared ? `: ${st.meaning}` : ""}.</p>
        )}
        {canDecide ? (
          <DecisionPanel key={`${k}:${start ?? ""}`} alert={alert} start={start} onDecided={onDecided} onToast={onToast} />
        ) : (
          <p className="alr-why">
            {why}
            {alert.kind === "fuel" && alert.decision?.reason === "probe_fault" && onOpenAudit && (
              <> <button type="button" className="aud-link" onClick={onOpenAudit}>Open Fuel Audit</button></>
            )}
          </p>
        )}
      </DetailSidebarSection>
    </DetailSidebar>
  );
}

export default function AlertsScreen() {
  const { companies } = useCompanies();
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const {
    setActiveCompanyId, setDesktopActiveTab, setSelectedVehicleId, setPendingFocusId, setMobileActiveTab, requestIncident,
  } = useAppActions();
  const { canIn, can } = usePermissions();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("open");
  const [orgs, setOrgs] = useState([]);
  // A chip's id, or "custom" for days picked in the From / To fields.
  const [period, setPeriod] = useState("7d");
  const [custom, setCustom] = useState(null);
  const [overBy, setOverBy] = useState(0);
  const [readF, setReadF] = useState("all");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [open, setOpen] = useState(null); // { key, start }
  const [toast, setToast] = useState(null);
  const [epoch, setEpoch] = useState(0);

  // Fleet days, first to last. A chip's run to today and Refresh moves them on
  // past a midnight; picked days stay put.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const days = useMemo(() => (period === "custom" && custom ? custom : periodDays(period)), [period, custom, epoch]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { from, to } = useMemo(() => daysBounds(days), [days, epoch]);
  const today = fleetDay();
  // One day, or back to the default week when the field is cleared.
  const pickDay = (day) => {
    setPeriod(day ? "custom" : "7d");
    setCustom(day ? { fromDay: day, toDay: day } : null);
  };
  const filters = useMemo(() => ({
    kind, status, orgs, from, to, q, minOverKmh: kind === "fuel" ? 0 : overBy, read: readF,
  }), [kind, status, orgs, from, to, q, overBy, readF]);
  const key = JSON.stringify(filters);

  // Pages of PAGE_STEP (15), turned with the app's one pager (TablePager,
  // operator 2026-10-12: "pagination should be consistent across all pages").
  // The server pages on a cursor, so the start of every page reached is kept:
  // Prev goes back to one, Next to the cursor the current page ended on. A new
  // filter starts again at page one.
  const [nav, setNav] = useState({ key, page: 0, cursors: [null] });
  const at = nav.key === key ? nav : { key, page: 0, cursors: [null] };
  const cursor = at.cursors[at.page] ?? null;
  const first = useApiData(
    () => fetchAlerts({ ...filters, cursor, limit: PAGE_STEP }),
    [key, at.page, cursor ?? ""],
    { pollMs: POLL_MS, keepPreviousData: true },
  );
  const page = first.data;

  // Where the next page starts, once this one has said.
  useEffect(() => {
    if (!page?.hasNextPage || !page.cursor) return;
    setNav((n) => {
      const cur = n.key === key ? n : { key, page: 0, cursors: [null] };
      if (cur.cursors[cur.page + 1] === page.cursor) return n;
      const cursors = cur.cursors.slice(0, cur.page + 1);
      cursors[cur.page + 1] = page.cursor;
      return { ...cur, cursors };
    });
  }, [page, key]);

  // The counts come with the first page only (they do not page); kept for
  // the filters they were read under while later pages are open.
  const [kept, setKept] = useState({ key: null, counts: null });
  useEffect(() => { if (page?.counts) setKept({ key, counts: page.counts }); }, [page, key]);

  // Decisions made here, laid over the rows until the server's next answer.
  const [decided, setDecided] = useState(() => new Map());
  useEffect(() => { setDecided(new Map()); }, [page]);

  // Alerts read here, likewise laid over the rows until the server's next answer.
  const [readHere, setReadHere] = useState(() => new Set());
  useEffect(() => { setReadHere(new Set()); }, [page]);

  const rows = useMemo(
    () => (page?.data ?? []).map((r) => {
      const row = decided.get(rowKey(r)) ?? r;
      return !row.read && readHere.has(rowKey(r)) ? { ...row, read: true } : row;
    }),
    [page, decided, readHere],
  );

  // The alerts picked for a batch, kept across pages for the filters they
  // were picked under; a new filter starts an empty selection. Each is read
  // from the row on screen when it has one, so a pick never holds a stale copy.
  const [picked, setPicked] = useState({ key, map: NO_PICKS });
  const pickedMap = picked.key === key ? picked.map : NO_PICKS;
  const [bulk, setBulk] = useState(null); // { start, failed: Map(key -> why) }
  const editPicks = (fn) => setPicked((p) => {
    const m = new Map(p.key === key ? p.map : []);
    fn(m);
    return { key, map: m };
  });
  const rowsByKey = useMemo(() => new Map(rows.map((r) => [rowKey(r), r])), [rows]);
  const pickedAlerts = [...pickedMap].map(([k, a]) => rowsByKey.get(k) ?? decided.get(k) ?? a);
  useEffect(() => { if (pickedMap.size === 0) setBulk(null); }, [pickedMap.size]);

  /** The badge counts open alerts not read: tell it a decision or a read moved one. */
  const recountBadge = () => queryClient.invalidateQueries({ queryKey: ALERT_SUMMARY_KEY });

  const goTo = (n) => {
    if (n < 0 || (n > at.page && !at.cursors[n])) return;
    setNav({ ...at, page: n });
    setOpen(null);
  };

  const refresh = useCallback(() => {
    setNav({ key: null, page: 0, cursors: [null] });
    setEpoch((n) => n + 1);
    first.revalidate();
    queryClient.invalidateQueries({ queryKey: ["alerts", "history"] });
  }, [first, queryClient]);

  /** Fresh counts after a decision made on a later page (page one brings its own). */
  const recount = () => {
    if (at.page === 0) return;
    fetchAlerts({ ...filters, limit: 1 })
      .then((res) => { if (res?.counts) setKept({ key, counts: res.counts }); })
      .catch(() => { /* the chips keep their last figures */ });
  };

  useEffect(() => {
    if (first.error) setToast({ tone: "crit", text: first.error.message ? `Could not load the alerts: ${first.error.message}` : "Could not load the alerts." });
  }, [first.error]);

  const rootRef = useRef(null);
  useEffect(() => watchTableLabels(rootRef.current), []);

  const orgList = useMemo(() => page?.orgs ?? [], [page]);
  const orgById = useMemo(() => new Map(orgList.map((o) => [o.id, o])), [orgList]);
  const decidable = (a) => Boolean(orgById.get(a.orgId)?.canDecide && a.choices.length > 0);
  const togglePick = (a) => editPicks((m) => { const k = rowKey(a); if (m.has(k)) m.delete(k); else m.set(k, a); });
  const shortName = (o) => {
    const c = companies.find((x) => x.id === companyForOrgCode(o?.code));
    return c?.short || o?.name || "-";
  };
  const kindsHeld = new Set(orgList.flatMap((o) => o.kinds));
  // The speed filter only where overspeeding can be listed: Kasulu alone has none.
  const speedingHere = orgList.some((o) => (orgs.length === 0 || orgs.includes(o.id)) && o.kinds.includes("speeding"));
  const counts = page?.counts ?? (kept.key === key ? kept.counts : null);
  // The chart's whole history: not the page's filters, so one read a visit.
  // A new fuel theft rang the Alerts button: opening the page hears it. One
  // that arrives while the page is open shows in the list (read afresh) and
  // lets the button shake a few seconds first, so it is seen to arrive.
  const fuelAlarm = useFuelAlarm(null);
  const opened = useRef(false);
  useEffect(() => {
    if (!fuelAlarm) { opened.current = true; return undefined; }
    if (!opened.current) { opened.current = true; hushFuelAlarm(); return undefined; }
    first.revalidate();
    const t = setTimeout(hushFuelAlarm, 6000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fuelAlarm]);

  const history = useQuery({
    queryKey: ["alerts", "history"],
    queryFn: ({ signal }) => fetchAlertHistory({ signal }),
    staleTime: 60_000,
  });

  // Every chip's number under the OTHER filters (lib/alertsView countWhere).
  const nStatus = (s) => countWhere(counts, { orgs, kind, status: s, read: readF });
  const nKind = (k) => countWhere(counts, { orgs, kind: k, status, read: readF });
  const nOrg = (id) => countWhere(counts, { orgs: [id], kind, status, read: readF });
  const nRead = (r) => countWhere(counts, { orgs, kind, status, read: r });
  const unread = nRead("unread");
  const total = nStatus("all");
  const trend = useMemo(() => alertTrend(history.data ?? null, { orgs }), [history.data, orgs]);
  const pager = {
    ...alertPager({ page: at.page, rows: rows.length, hasNext: Boolean(page?.hasNextPage), listed: nStatus(status), step: PAGE_STEP }),
    setPage: goTo,
  };
  // The last alerts on a later page decided away: step back to one that has some.
  useEffect(() => {
    if (page && !first.stale && page.data.length === 0 && at.page > 0) goTo(at.page - 1);
  });

  const activeCount = (kind !== "all") + (status !== "open") + (orgs.length > 0) + (period !== "7d") + (overBy > 0)
    + (readF !== "all");

  // Selecting: the ones on this page this account may decide.
  const anyDecide = orgList.some((o) => o.canDecide);
  const pageDecidable = rows.filter(decidable);
  const pageAll = pageDecidable.length > 0 && pageDecidable.every((a) => pickedMap.has(rowKey(a)));
  const pageSome = pageDecidable.some((a) => pickedMap.has(rowKey(a)));
  const togglePage = () => editPicks((m) => {
    for (const a of pageDecidable) {
      if (pageAll) m.delete(rowKey(a));
      else m.set(rowKey(a), a);
    }
  });
  const offPage = [...pickedMap.keys()].filter((k) => !rowsByKey.has(k)).length;
  const pageBox = useRef(null);
  useEffect(() => { if (pageBox.current) pageBox.current.indeterminate = pageSome && !pageAll; });

  const onDecided = (alert, choice, note, review) => {
    const next = afterDecision(alert, choice, note, review);
    setDecided((m) => new Map(m).set(rowKey(alert), next));
    editPicks((m) => m.delete(rowKey(alert)));
    markRead([alert]);
    setOpen(null);
    setToast({ tone: "ok", text: `${alert.plate}: ${decisionWords(alert.kind, next.decision).toLowerCase()}.` });
    first.revalidate();
    recount();
    recountBadge();
  };

  /** A batch is back: the decided ones leave the selection, the failed stay with why. */
  const onBulkDone = (done) => {
    const good = done.filter((d) => d.ok);
    const bad = done.filter((d) => !d.ok);
    if (good.length) {
      setDecided((m) => {
        const n = new Map(m);
        for (const d of good) n.set(rowKey(d.alert), afterDecision(d.alert, d, d.note, d.review));
        return n;
      });
      editPicks((m) => { for (const d of good) m.delete(rowKey(d.alert)); });
      markRead(good.map((d) => d.alert));
      first.revalidate();
      recount();
      recountBadge();
    }
    if (bad.length) {
      setBulk((b) => ({ ...b, failed: new Map(bad.map((d) => [rowKey(d.alert), d.error])) }));
      setToast({ tone: "crit", text: `${bulkWords(done)}. The ${bad.length === 1 ? "one that failed is" : `${bad.length} that failed are`} still selected.` });
    } else {
      setBulk(null);
      setToast({ tone: "ok", text: `${bulkWords(done)}.` });
    }
  };

  const showOnMap = (alert) => {
    const org = orgById.get(alert.orgId);
    const company = companyForOrgCode(org?.code);
    if (!company) {
      setToast({ tone: "crit", text: `${org?.name ?? "This organisation"} is not on this dashboard.` });
      return;
    }
    if (company !== activeCompanyId) setActiveCompanyId(company);
    setSelectedVehicleId(alert.plate);
    setPendingFocusId(alert.plate);
    if (alert.kind === "fuel" && alert.fuel.live) requestIncident(alert.plate);
    setMobileActiveTab("map");
    setDesktopActiveTab("fleet");
  };

  /** Opened or decided here: read, for this person. A failed mark is not
   *  worth a toast; the alert just stays bold until the next answer. */
  const markRead = (alerts) => {
    const fresh = alerts.filter((a) => !a.read && !readHere.has(rowKey(a)));
    if (!fresh.length) return;
    setReadHere((cur) => { const n = new Set(cur); for (const a of fresh) n.add(rowKey(a)); return n; });
    markAlertsRead(fresh)
      .then(() => { recountBadge(); recount(); if (readF !== "all") first.revalidate(); })
      .catch(() => {});
  };

  const [markingAll, setMarkingAll] = useState(false);
  const markAll = () => {
    setMarkingAll(true);
    markAllAlertsRead()
      .then(() => {
        setToast({ tone: "ok", text: "Every alert so far is marked read." });
        first.revalidate();
        recountBadge();
      })
      .catch((err) => setToast({ tone: "crit", text: `Could not mark them read: ${err.message}` }))
      .finally(() => setMarkingAll(false));
  };

  const toggle = (alert, start = null) => {
    const k = rowKey(alert);
    setOpen((o) => (o?.key === k && !start ? null : { key: k, start }));
    markRead([alert]);
  };

  // The open alert, read from the page on screen: gone from it (decided away
  // under a filter, or a new page), the panel closes with it.
  const openAlert = open ? rows.find((r) => rowKey(r) === open.key) ?? null : null;
  const openKey = open?.key ?? null;
  // Closed, the focus goes back to the row it was opened from, so the
  // keyboard keeps its place (once the panel holding it has gone).
  const returnTo = useRef(null);
  const closePanel = useCallback(() => {
    returnTo.current = openKey;
    setOpen(null);
  }, [openKey]);
  useEffect(() => {
    if (open || !returnTo.current) return;
    rootRef.current?.querySelector(`tr[data-alert="${CSS.escape(returnTo.current)}"]`)?.focus({ preventScroll: true });
    returnTo.current = null;
  }, [open]);

  const pickOrg = (id) => setOrgs((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const maxFigure = Math.max(1, ...rows.map((r) => figureOf(r) ?? 0));

  return (
    <div className="sp4-root sys-root aud-root alr-root" ref={rootRef}>
      {toast && (
        <div className={`sp4-toast sp4-toast--${toast.tone}`} role="status" aria-live="polite">
          <span className="sp4-toast-text">{toast.text}</span>
          <button type="button" className="sp4-toast-x" aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button>
        </div>
      )}

      {/* Where the period stands, for the organisations and kind picked. */}
      <div data-tour="alerts-stats" className="aud-stats alr-stats">
        <StatCard title="Open" n={nStatus("open")} of={total} color="var(--frv-s2)" loading={first.loading}
                  note="Waiting for somebody to escalate or de-escalate them." />
        <StatCard title="Escalated" n={nStatus("escalated")} of={total} color="var(--frv-crit)" loading={first.loading}
                  note="Confirmed as real and taken up." />
        <StatCard title="De-escalated" n={nStatus("deescalated")} of={total} color="var(--frv-s3)" loading={first.loading}
                  note="Looked at and found not to be one." />
        <TrendCard trend={trend} loading={history.isLoading} kinds={kindsHeld} />
      </div>

      <div className="sp4-body">
        <TableToolbar
          summary={
            <>
              <b>{pager.total}</b> alert{pager.total === 1 ? "" : "s"}
              {orgs.length > 0 && <> · {orgs.map((id) => shortName(orgById.get(id))).join(", ")}</>}
              {period === "custom" && <> · {daysWords(days)}</>}
              {unread > 0 && <> · <b>{unread}</b> unread</>}
              {first.stale && <span className="sp4-muted"> · updating…</span>}
            </>
          }
          loading={first.loading}
          onReload={refresh}
          actions={(
            <button type="button" className="sp4-ghost-btn" onClick={markAll} disabled={markingAll || !page}
                    title="Every alert that has arrived so far, in every organisation, read for you only">
              <i className="ti ti-checks" aria-hidden="true" /> {markingAll ? "Marking…" : "Mark all read"}
            </button>
          )}
        />

        <FilterBar
          label="Filters"
          activeCount={activeCount}
          peek={(
            <div className="sp4-search-wrap alr-search">
              <svg className="sp4-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input className="sp4-search" type="text" placeholder="Search a plate or unit…" aria-label="Search a plate or unit"
                     value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <button type="button" className="sp4-search-clear" aria-label="Clear search" onClick={() => setSearch("")}>✕</button>}
            </div>
          )}
        >
          {orgList.length > 1 && (
            <div className="sp4-filter-group alr-orgs">
              <span className="sp4-filter-label">Organisation</span>
              <Chip on={orgs.length === 0} onClick={() => setOrgs([])} n={countWhere(counts, { kind, status })}>All</Chip>
              {orgList.map((o) => (
                <Chip key={o.id} on={orgs.includes(o.id)} onClick={() => pickOrg(o.id)} n={nOrg(o.id)} title={o.name}>
                  {shortName(o)}
                </Chip>
              ))}
            </div>
          )}
          {kindsHeld.size > 1 && (
            <div className="sp4-filter-group">
              <span className="sp4-filter-label">Alert</span>
              {KINDS.filter((k) => k.id === "all" || kindsHeld.has(k.id)).map((k) => (
                <Chip key={k.id} on={kind === k.id} onClick={() => setKind(k.id)} n={nKind(k.id)}>{k.label}</Chip>
              ))}
            </div>
          )}
          <div className="sp4-filter-group">
            <span className="sp4-filter-label">State</span>
            {STATUSES.map((s) => (
              <Chip key={s.id} on={status === s.id} onClick={() => setStatus(s.id)} n={nStatus(s.id)}>{s.label}</Chip>
            ))}
          </div>
          <div className="sp4-filter-group">
            <span className="sp4-filter-label">Read</span>
            {READS.map((r) => (
              <Chip key={r.id} on={readF === r.id} onClick={() => setReadF(r.id)} n={nRead(r.id)}>{r.label}</Chip>
            ))}
          </div>
          <div className="sp4-filter-group">
            <span className="sp4-filter-label">Period</span>
            {PERIODS.map((p) => (
              <Chip key={p.id} on={period === p.id} onClick={() => { setPeriod(p.id); setCustom(null); }}>{p.label}</Chip>
            ))}
          </div>
          {/* Sensor Monitor's one Day field (operator, 2026-10-13: "just one
              date picker"): one day's alerts; the chips above are the runs. */}
          <div className="sp4-filter-group">
            <span className="sp4-filter-label">Day</span>
            <DayField label="One day" value={period === "custom" && custom ? custom.fromDay : ""} max={today} onPick={pickDay} />
          </div>
          {(kind === "all" || kind === "speeding") && speedingHere && (
            <div className="sp4-filter-group">
              <span className="sp4-filter-label">Over the limit by</span>
              {OVER_BY.map((v) => (
                <Chip key={v} on={overBy === v} onClick={() => setOverBy(v)}>{v === 0 ? "Any" : `${v}+ km/h`}</Chip>
              ))}
            </div>
          )}
        </FilterBar>

        {rows.length === 0 && first.loading ? (
          <EmptyNote icon="ti-loader-2" tone="busy" title="Reading the Alerts">
            The alerts from every organisation you hold.
          </EmptyNote>
        ) : rows.length === 0 && first.error ? (
          <EmptyNote icon="ti-alert-triangle" tone="error" title="The Alerts Could Not Be Loaded"
                     action={{ label: "Try again", onClick: first.retry }}>
            {first.error.message}
          </EmptyNote>
        ) : page && orgList.length === 0 ? (
          <EmptyNote icon="ti-lock" tone="warn" title="No Alerts Open to Your Role">
            This role has no alert access in an organisation you belong to.
          </EmptyNote>
        ) : rows.length === 0 && (
          <EmptyNote icon={(EMPTY_READ[readF] ?? EMPTY[status]).icon} title={(EMPTY_READ[readF] ?? EMPTY[status]).title}>
            {q ? `Nothing matches “${q}”.` : (EMPTY_READ[readF] ?? EMPTY[status]).sub}
          </EmptyNote>
        )}

        {/* The selection: what is picked and what to do with it, then the
            batch itself once Escalate, De-escalate or Decide each is pressed. */}
        {pickedMap.size > 0 && !bulk && (
          <div className="alr-bulkbar" role="region" aria-label="Selected alerts">
            <label className="alr-tick alr-bulkbar-page">
              <input type="checkbox" checked={pageAll} onChange={togglePage} disabled={pageDecidable.length === 0}
                     ref={(el) => { if (el) el.indeterminate = pageSome && !pageAll; }} />
              <span>This page</span>
            </label>
            <span className="alr-bulkbar-n">
              <b>{pickedMap.size}</b> selected{offPage > 0 && <span className="aud-unit"> · {offPage} on other pages</span>}
            </span>
            <span className="alr-bulkbar-actions">
              <button type="button" className="sp4-ghost-btn sp4-ghost-btn--crit" onClick={() => setBulk({ start: "ESCALATED", failed: new Map() })}>
                Escalate
              </button>
              <button type="button" className="sp4-ghost-btn" onClick={() => setBulk({ start: "DEESCALATED", failed: new Map() })}>
                De-escalate
              </button>
              <button type="button" className="sp4-ghost-btn" title="Escalate some and de-escalate others"
                      onClick={() => setBulk({ start: null, failed: new Map() })}>
                Decide each
              </button>
              <button type="button" className="sp4-ghost-btn" onClick={() => editPicks((m) => m.clear())}>Clear</button>
            </span>
          </div>
        )}
        {pickedMap.size > 0 && bulk && (
          <BulkPanel
            alerts={pickedAlerts}
            start={bulk.start}
            failed={bulk.failed}
            orgName={(a) => shortName(orgById.get(a.orgId))}
            onRemove={togglePick}
            onClose={() => setBulk(null)}
            onFinished={onBulkDone}
          />
        )}

        {rows.length > 0 && (
          <div data-tour="page-table" className={"sp4-table-scroll aud-units alr-table" + (first.stale ? " alr-table--stale" : "")}>
            <table className="sp4-table sp4-probe-table sp4-probe-table--comfortable">
              <thead>
                <tr>
                  <th className="sp4-th--left sp4-th--pin">
                    {anyDecide ? (
                      <span className="alr-unit">
                        <span className="alr-tick">
                          <input type="checkbox" ref={pageBox} checked={pageAll} onChange={togglePage}
                                 disabled={pageDecidable.length === 0}
                                 aria-label="Select every alert on this page you can decide" />
                        </span>
                        Unit
                      </span>
                    ) : "Unit"}
                  </th>
                  <th className="sp4-th--left">When</th>
                  <th className="sp4-th--left">Alert</th>
                  <th className="sp4-th--left">Details</th>
                  <th className="sp4-th--left">State</th>
                  <th className="sp4-th--right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const k = rowKey(a);
                  const org = orgById.get(a.orgId);
                  const expanded = open?.key === k;
                  const st = statusOf(a);
                  const h = headline(a);
                  const canDecide = org?.canDecide && a.choices.length > 0;
                  const figure = figureOf(a);
                  const offers = new Set(a.choices.map((c) => c.outcome));
                  return (
                    <Fragment key={k}>
                      <tr
                        className={"sp4-tr aud-tr" + (expanded ? " aud-tr--open" : "") + (pickedMap.has(k) ? " alr-tr--picked" : "")
                          + (a.read ? "" : " alr-tr--unread")}
                        tabIndex={0}
                        data-alert={k}
                        aria-expanded={expanded}
                        aria-controls={expanded ? "alr-panel" : undefined}
                        onClick={() => toggle(a)}
                        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(a); } }}
                      >
                        <td className="sp4-td--left sp4-td--pin">
                          <span className="alr-unit">
                            {anyDecide && (
                              // Its own target: a tick does not open the row.
                              <span className="alr-tick" onClick={(e) => e.stopPropagation()}>
                                {canDecide && (
                                  <input type="checkbox" checked={pickedMap.has(k)} onChange={() => togglePick(a)}
                                         aria-label={`Select ${a.plate}, ${kindOf(a.kind).noun} alert ${when(a.at)}`} />
                                )}
                              </span>
                            )}
                            <span>
                              {!a.read && <span className="alr-unread-dot" role="img" aria-label="Unread" title="Unread" />}
                              <span className="sp4-reg" title={a.vehicleName || a.plate}>{plateIn(a.plate, a.vehicleName) ?? a.plate}</span>
                              <span className="alr-org">{shortName(org)}</span>
                              {/* Reported for a fuel probe repair: the alert still
                                  comes (operator, 2026-10-13), marked so the reader
                                  knows the probe is already suspect. */}
                              {a.fuel?.probeHold && (
                                <span className="alr-probe" title="This unit is already reported for a fuel probe repair">
                                  <i className="ti ti-tool" aria-hidden="true" />Probe reported
                                </span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="sp4-td--left sys-num">
                          {when(a.at)}
                          {reportedLate(a) && <span className="alr-reported">{reportedLate(a)}</span>}
                        </td>
                        <td className="sp4-td--left">
                          <KindTag kind={a.kind} />
                          <span className="aud-cellbar alr-figure">
                            <span><b className="sys-num">{h.figure}</b> <span className="aud-unit">{h.words}</span></span>
                            {figure != null && (
                              <i aria-hidden="true"><b className="aud-cellbar--alert" style={{ width: `${Math.max(2, Math.min(1, figure / maxFigure) * 100)}%` }} /></i>
                            )}
                          </span>
                        </td>
                        <td className="sp4-td--left alr-details">
                          {a.kind === "fuel"
                            ? <>{ruleWords(a.fuel.rule)}{a.fuel.driverName ? ` · ${a.fuel.driverName}` : ""}</>
                            : a.kind === "camera"
                              ? <>{a.camera.severity === "critical" ? "Critical" : "Warning"}{a.camera.clips?.roadFacing || a.camera.clips?.driverFacing ? " · clip" : ""}{a.camera.driverName ? ` · ${a.camera.driverName}` : ""}</>
                              : <>+{Math.round(a.speeding.overByKmh)} km/h for {duration(a.speeding.durationSec)}{a.speeding.driverName ? ` · ${a.speeding.driverName}` : ""}</>}
                        </td>
                        <td className="sp4-td--left">
                          <span className="alr-state">
                            <span className={`sp4-pill sp4-pill--${st.tone}`} title={st.meaning}>{st.label}</span>
                            <span className="alr-state-sub">
                              {a.decision ? `${st.meaning}${a.decision.by ? ` · ${a.decision.by}` : ""}` : st.meaning}
                            </span>
                          </span>
                        </td>
                        <td className="sp4-td--right">
                          <span className="alr-actions">
                            {canDecide && offers.has("ESCALATED") && (
                              <button type="button" className="sp4-ghost-btn sp4-ghost-btn--crit"
                                      onClick={(e) => { e.stopPropagation(); toggle(a, "ESCALATED"); }}>Escalate</button>
                            )}
                            {canDecide && offers.has("DEESCALATED") && (
                              <button type="button" className="sp4-ghost-btn"
                                      onClick={(e) => { e.stopPropagation(); toggle(a, "DEESCALATED"); }}>De-escalate</button>
                            )}
                            {!canDecide && (
                              <button type="button" className="sp4-ghost-btn" onClick={(e) => { e.stopPropagation(); toggle(a); }}>
                                {expanded ? "Hide" : "Details"}
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <TablePager pager={pager} label="Alert pages" />
          </div>
        )}
      </div>
      {openAlert && (
        <AlertPanel
          alert={openAlert}
          org={orgById.get(openAlert.orgId)}
          start={open.start}
          canMap={canIn(openAlert.orgId, "map:read")}
          onClose={closePanel}
          onDecided={onDecided}
          onToast={setToast}
          onShowOnMap={showOnMap}
          onOpenAudit={null}
        />
      )}
    </div>
  );
}
