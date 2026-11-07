/* Hallmark · component: alerts stats strip · genre: modern-minimal
 * theme: in-project tokens, preserved (DriversScreen.scss .dr-tones / .dr-strip)
 * redesign: restyle, after new-ui's AlertsStrip (2026-11-07)
 * pre-emit critique: P5 H5 E4 S5 R5 V4
 * states: default · loading (counts, history) · clear (nothing open) · zero
 *   segment hidden · chart hover + focus (TrendStat) · rising = red delta
 * contrast: figures ink / --text-2 on --card; tones on dots, bars and counts
 *   that also carry a word, so none is read by colour alone
 *
 * new-ui's Alerts strip, brought over (operator, 2026-11-07: "restyle the
 * samad 4 stats card elements and the whole alerts page to be like that of
 * new-ui"). One frame split by hairlines: the alerts in the period with how
 * they were decided, one trend cell per kind the organisations hold, and what
 * is still waiting. It replaces three gauges and an all-time chart.
 *
 * Samad holds overspeeding and camera alarms, not fuel, so the kinds are read
 * from the organisations rather than fixed at fuel and overspeeding: two kinds
 * make the four cells new-ui has.
 */
import TrendStat from "./TrendStat";
import { countWhere, orgsWhere } from "../../lib/alertsView";

const fmt = (n) => (n == null ? "-" : Number(n).toLocaleString());
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const fmtDay = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Each kind's cell: its title, tone (DriversScreen.scss .dr-statchart--*),
// chart and the Waiting rows' names.
const KIND_CELLS = {
  fuel: { title: "Fuel alerts", fact: "Fuel", tone: "theft", type: "bar", what: "fuel alerts", open: "Fuel theft open", escalated: "Theft escalated" },
  speeding: { title: "Overspeeding", fact: "Overspeeding", tone: "speed", type: "line", what: "overspeeding alerts", open: "Overspeeding open", escalated: "Speeding escalated" },
  hours: { title: "Driver hours", fact: "Hours", tone: "hours", type: "bar", what: "driver-hours breaches", open: "Hours open", escalated: "Hours escalated" },
  camera: { title: "Camera alarms", fact: "Camera", tone: "camera", type: "bar", what: "camera alarms", open: "Camera open", escalated: "Camera escalated" },
};

// How the period's alerts were decided, in the Ratings bar's tones: waiting is
// amber, confirmed is red, cleared is green.
const DECISIONS = [
  { key: "escalated", label: "Escalated", mix: "low" },
  { key: "open", label: "Open", mix: "fair" },
  { key: "deescalated", label: "De-escalated", mix: "good" },
];

/**
 * counts: the server's per-org counts (countWhere). series: alertDays for the
 * period, or null while the history is read. kinds: the alert kinds the
 * organisations hold, in ALERT_KINDS order. orgs / kind / read: the page's
 * filters; the strip follows them, as the chips' numbers do.
 */
export default function AlertsStrip({ counts, countsLoading, series, seriesLoading, kinds, orgs, kind, read, scope }) {
  const shown = kinds.filter((k) => KIND_CELLS[k]);
  const days = series?.length ?? 0;
  const half = Math.max(1, Math.floor(days / 2));
  const sub = days > 1 ? `last ${half}d vs previous ${half}d, ${scope}` : days ? `one day, ${scope}` : "";
  const sum = (k) => (series ?? []).reduce((t, d) => t + d[k], 0);
  const pointWords = (k) => (at) => `${fmtDay(at.day)}: ${fmt(at[k])} ${plural(at[k], "alert")}`;

  return (
    <section className="dr-strip alr-strip" aria-label="Alerts in the period" style={{ "--alr-kinds": shown.length }}>
      <DecisionsCell counts={counts} loading={countsLoading} kinds={shown} orgs={orgs} kind={kind} read={read} />
      {shown.map((k) => {
        const c = KIND_CELLS[k];
        return (
          <TrendStat
            key={k}
            title={c.title}
            series={series ?? []}
            valueKey={k}
            value={series ? fmt(sum(k)) : "-"}
            unit={plural(sum(k), "alert")}
            tone={c.tone}
            type={c.type}
            what={c.what}
            sub={sub}
            upIsBad
            pointWords={pointWords(k)}
            loading={seriesLoading}
          />
        );
      })}
      <WaitingCell counts={counts} loading={countsLoading} kinds={shown} orgs={orgs} read={read} />
    </section>
  );
}

/** The period's alerts: how many, what kind, and how they were decided. */
function DecisionsCell({ counts, loading, kinds, orgs, kind, read }) {
  if (loading && !counts) {
    return (
      <div className="dr-cell dr-fleet">
        <div className="dr-cell__empty" aria-busy="true">Reading alerts…</div>
      </div>
    );
  }
  const n = (q) => countWhere(counts, { orgs, kind, read, status: "all", ...q });
  const total = n({});
  const unread = countWhere(counts, { orgs, kind, status: "all", read: "unread" });
  const facts = [
    // A kind the Kind chip leaves out counts 0, as its chip does.
    ...kinds.map((k) => ({ label: KIND_CELLS[k].fact, value: kind === "all" || kind === k ? n({ kind: k }) : 0 })),
    { label: "Unread", value: unread },
  ];
  const mix = DECISIONS.map((d) => ({ ...d, n: n({ status: d.key }) ?? 0 }));

  return (
    <div className="dr-cell dr-fleet">
      <div className="dr-statchart__head">
        <span className="dr-statchart__label">Alerts</span>
      </div>
      <div className="dr-summary__lead">
        <span className="dr-summary__figure">{fmt(total)}</span>
        <span className="dr-summary__caption">in the period,<br />{fmt(unread)} unread</span>
      </div>
      <dl className="dr-fleet__facts">
        {facts.map((f) => (
          <div key={f.label} className="dr-fleet__fact">
            <dt>{f.label}</dt>
            <dd>{fmt(f.value)}</dd>
          </div>
        ))}
      </dl>
      <div className="dr-fleet__mix">
        <span className="dr-fleet__mixlabel">Decisions</span>
        <span className="dr-fleet__bar" role="img"
              aria-label={total ? mix.map((m) => `${m.n} ${m.label.toLowerCase()}`).join(", ") : "No alerts in the period"}>
          {mix.map((m) => m.n > 0 && (
            <span key={m.key} className={`dr-fleet__seg dr-fleet__seg--${m.mix}`}
                  style={{ flexGrow: m.n }}
                  title={`${m.label}: ${fmt(m.n)} ${plural(m.n, "alert")}`} />
          ))}
        </span>
        <ul className="dr-fleet__legend">
          {mix.map((m) => (
            <li key={m.key} className={`dr-fleet__key dr-fleet__key--${m.mix}`}>
              <span className="dr-fleet__swatch" aria-hidden="true" />{m.label}<b>{fmt(m.n)}</b>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * What is still waiting for somebody, and what was confirmed: the strip's
 * exceptions, the only rows allowed colour. Every kind held, whatever the Kind
 * chip says, so a camera-only view still shows overspeeding piling up.
 */
function WaitingCell({ counts, loading, kinds, orgs, read }) {
  if (loading && !counts) {
    return (
      <div className="dr-cell dr-summary">
        <div className="dr-cell__empty" aria-busy="true">Reading…</div>
      </div>
    );
  }
  const q = { orgs, read };
  const rows = ["open", "escalated"]
    .flatMap((status) => kinds.map((k) => ({ name: KIND_CELLS[k][status], kind: k, status, tone: KIND_CELLS[k].tone })))
    .map((r) => ({ ...r, n: countWhere(counts, { ...q, kind: r.kind, status: r.status }) ?? 0, who: orgsWhere(counts, { ...q, kind: r.kind, status: r.status }) ?? 0 }));
  const open = countWhere(counts, { ...q, status: "open" }) ?? 0;
  const waitingOrgs = orgsWhere(counts, { ...q, status: "open" }) ?? 0;

  return (
    <div className="dr-cell dr-summary">
      <div className="dr-statchart__head">
        <span className="dr-statchart__label">Waiting</span>
        {counts && !open && <span className="dr-summary__clean">Clear</span>}
      </div>
      <div className="dr-summary__lead">
        <span className="dr-summary__figure">{fmt(open)}</span>
        <span className="dr-summary__caption">
          to decide,<br />{waitingOrgs ? `in ${fmt(waitingOrgs)} ${plural(waitingOrgs, "organisation")}` : "in no organisation"}
        </span>
      </div>
      <div className="dr-summary__incidents">
        {rows.map((r) => (
          <div key={r.name} className={`dr-summary__incident${r.n ? ` dr-summary__incident--${r.tone}` : ""}`}>
            <span className="dr-summary__dot" aria-hidden="true" />
            <span className="dr-summary__name">
              {r.name}
              {r.n > 0 && <span className="dr-summary__who"> in {fmt(r.who)} {plural(r.who, "org")}</span>}
            </span>
            <span className="dr-summary__count">{fmt(r.n)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
