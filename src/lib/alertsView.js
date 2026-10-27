/**
 * The Alerts page's wording and arithmetic, kept out of the component so it
 * can be tested: the period presets, the counts behind every filter chip, how
 * an alert's decision is named, and the words on each decision button.
 *
 * The server sends one count per organisation, kind and status (only with the
 * first page); every chip's number is a sum over those, under the OTHER
 * filters, so a chip says what picking it would show.
 */

import { ORG_CODE_BY_COMPANY } from "../api/org";
import { ESCALATION_REASONS, OUTCOME } from "./fuelReview";

const DAY_MS = 86_400_000;
/** Nairobi is UTC+3 all year: no daylight saving to step over. */
const FLEET_OFFSET_MS = 3 * 3_600_000;

/** Midnight on the fleet's clock, `daysBack` days before today. */
export function fleetMidnight(now, daysBack = 0) {
  const local = now + FLEET_OFFSET_MS;
  return local - (local % DAY_MS) - FLEET_OFFSET_MS - daysBack * DAY_MS;
}

/**
 * The period chips. Each opens at a fleet midnight and runs to "now", which is
 * left to the server, so a refresh an hour later still catches the hour's
 * alerts without the filter changing.
 */
export const PERIODS = [
  { id: "today", label: "Today", days: 0 },
  { id: "7d", label: "7 days", days: 6 },
  { id: "30d", label: "30 days", days: 29 },
  { id: "90d", label: "90 days", days: 89 },
];

export function periodFrom(id, now = Date.now()) {
  const p = PERIODS.find((x) => x.id === id) ?? PERIODS[1];
  return new Date(fleetMidnight(now, p.days)).toISOString();
}

// ── Dates: the From / To picker ─────────────────────────────────────────────
//
// Sensor Monitor's day field (operator, 2026-10-13: "a date picker just like
// that sensor monitor"), twice: the first and last fleet day, as the
// "2026-10-12" keys an <input type="date"> holds. The period chips fill both.

/** "2026-10-12": the fleet day holding `ms`. */
export const fleetDay = (ms = Date.now()) => new Date(ms + FLEET_OFFSET_MS).toISOString().slice(0, 10);

/** The fleet midnight opening `day`, as epoch ms. */
const dayStart = (day) => Date.parse(`${day}T00:00:00.000Z`) - FLEET_OFFSET_MS;

/** The days a period chip covers, ending today. */
export function periodDays(id, now = Date.now()) {
  const p = PERIODS.find((x) => x.id === id) ?? PERIODS[1];
  return { fromDay: fleetDay(fleetMidnight(now, p.days)), toDay: fleetDay(now) };
}

/**
 * The instants the server reads for a span of fleet days: from the midnight
 * opening the first to the last moment of the last (its `to` is inclusive).
 * A span that ends today leaves `to` to the server, so the list goes on
 * catching the hour's alerts as it polls.
 */
export function daysBounds({ fromDay, toDay }, now = Date.now()) {
  const from = new Date(dayStart(fromDay)).toISOString();
  const to = toDay >= fleetDay(now) ? null : new Date(dayStart(toDay) + DAY_MS - 1).toISOString();
  return { from, to };
}

const SPAN_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "3 Oct – 12 Oct", or one day alone. For the summary line under a custom span. */
export function daysWords({ fromDay, toDay }) {
  const f = SPAN_FMT.format(Date.parse(`${fromDay}T00:00:00Z`));
  return fromDay === toDay ? f : `${f} – ${SPAN_FMT.format(Date.parse(`${toDay}T00:00:00Z`))}`;
}

/** Speeding only: how far over the limit an episode must have gone to be listed. */
export const OVER_BY = [0, 10, 20, 30];

export const KINDS = [
  { id: "all", label: "All" },
  { id: "fuel", label: "Fuel" },
  { id: "speeding", label: "Overspeeding" },
  { id: "camera", label: "Camera" },
];

/**
 * How each kind is drawn and named: its tag in the table (icon and word), the
 * detail's title, the noun in a sentence, and its line on the trend chart.
 * `camera` is the dashcams' driver and road alarms (no seatbelt, phone use,
 * lane departure, fatigue…), one alert per alarm.
 */
export const ALERT_KINDS = {
  fuel: { tag: "Fuel", icon: "ti-droplet", title: "Fuel alert", noun: "fuel", line: "fuel" },
  speeding: { tag: "Speed", icon: "ti-gauge", title: "Overspeeding alert", noun: "overspeeding", line: "speed" },
  camera: { tag: "Camera", icon: "ti-video", title: "Camera alarm", noun: "camera", line: "camera" },
};
export const kindOf = (kind) => ALERT_KINDS[kind] ?? ALERT_KINDS.speeding;

export const STATUSES = [
  { id: "open", label: "Open" },
  { id: "escalated", label: "Escalated" },
  { id: "deescalated", label: "De-escalated" },
  { id: "all", label: "All" },
];

/** This person's read marks (per person, as in a mailbox). */
export const READS = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "read", label: "Read" },
];

/**
 * The sum of the counts that match: `orgs` (empty = every one), `kind`,
 * `status` and `read` ("all" = any). Null while there are no counts to sum.
 */
export function countWhere(counts, { orgs = [], kind = "all", status = "all", read = "all" } = {}) {
  if (!Array.isArray(counts)) return null;
  let n = 0;
  for (const c of counts) {
    if (orgs.length && !orgs.includes(c.orgId)) continue;
    if (kind !== "all" && c.kind !== kind) continue;
    if (status !== "all" && c.status !== status) continue;
    if (read !== "all" && Boolean(c.read) !== (read === "read")) continue;
    n += c.n;
  }
  return n;
}

/** One day on, for "YYYY-MM-DD" keys. */
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** A fleet day as "12 Oct". */
export const dayWords = (day) => SPAN_FMT.format(Date.parse(`${day}T00:00:00Z`));

const MONTH_FMT = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

/** The Monday on or before a day (weeks as the fleet's reports count them). */
function mondayOf(day) {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** How the chart groups: days for two months, weeks for two years, then months. */
export function trendUnit(firstDay, lastDay) {
  const span = (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / DAY_MS;
  return span <= 62 ? "day" : span <= 730 ? "week" : "month";
}

const BUCKET = {
  day: { of: (d) => d, next: nextDay, words: (d) => dayWords(d) },
  week: {
    of: mondayOf,
    next: (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10),
    words: (d) => `Week of ${dayWords(d)}`,
  },
  month: {
    of: (d) => `${d.slice(0, 7)}-01`,
    next: (d) => {
      const [y, m] = d.split("-").map(Number);
      return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
    },
    words: (d) => MONTH_FMT.format(Date.parse(`${d}T00:00:00Z`)),
  },
};

/**
 * Every alert ever received, fuel and overspeeding apart, from the first day
 * with one to today: days, weeks or months (trendUnit), empty ones at 0.
 * Follows the Organisation filter only: it is the whole history, not the
 * period or the state picked. null until the history is in.
 *   → { unit, points: [{ start, words, fuel, speeding, camera }] }
 */
export function alertTrend(history, { orgs = [] } = {}, now = Date.now()) {
  if (!Array.isArray(history)) return null;
  const rows = history.filter((r) => !orgs.length || orgs.includes(r.orgId));
  const today = fleetDay(now);
  const first = rows.reduce((m, r) => (r.day < m ? r.day : m), today);
  const unit = trendUnit(first, today);
  const b = BUCKET[unit];
  const byStart = new Map();
  for (let d = b.of(first); d <= today; d = b.next(d)) {
    byStart.set(d, { start: d, words: b.words(d), fuel: 0, speeding: 0, camera: 0 });
  }
  for (const r of rows) {
    const point = byStart.get(b.of(r.day));
    if (point && r.kind in ALERT_KINDS) point[r.kind] += r.n;
  }
  return { unit, points: [...byStart.values()] };
}

// ── An alert's decision, in words ───────────────────────────────────────────

const FUEL_REASON_WORDS = { theft: "confirmed theft", probe_fault: "faulty fuel probe" };

/** What escalating and de-escalating mean, per kind (fuel's escalation has reasons). */
const MEANS = {
  speeding: { yes: "confirmed overspeed", no: "not an overspeed" },
  camera: { yes: "confirmed alarm", no: "a false alarm" },
};
const meansOf = (kind) => MEANS[kind] ?? MEANS.speeding;

/**
 * The status pill: what it says, its tone (sp4-pill--*), and the longer
 * meaning for its tooltip and the detail.
 */
export function statusOf(alert) {
  const d = alert.decision;
  if (alert.status === "escalated") {
    const what = alert.kind === "fuel" ? FUEL_REASON_WORDS[d?.reason] ?? "confirmed theft" : meansOf(alert.kind).yes;
    return { label: "Escalated", tone: "inc", meaning: what };
  }
  if (alert.status === "deescalated") {
    return { label: "De-escalated", tone: "con", meaning: alert.kind === "fuel" ? "not a theft" : meansOf(alert.kind).no };
  }
  // Open. A fuel alert can be open and off the map: cleared with a newer
  // alert on its unit, or deleted into a case before Delete was retired.
  const meaning = alert.cleared === "case" ? "deleted from the map, waiting in its case"
    : alert.cleared === "unit" ? "cleared from the map with another alert on this unit"
    : alert.kind === "fuel" && alert.fuel?.live ? "on the map now"
    : "waiting for a decision";
  return { label: "Open", tone: "warn", meaning };
}

/** One decision as a sentence's head: "Escalated as confirmed theft". */
export function decisionWords(kind, d) {
  if (!d) return "";
  if (d.outcome === "DEESCALATED") return kind === "fuel" ? "De-escalated as not a theft" : `De-escalated as ${meansOf(kind).no}`;
  if (kind === "fuel") return `Escalated as ${FUEL_REASON_WORDS[d.reason] ?? "confirmed theft"}`;
  return `Escalated as a ${meansOf(kind).yes}`;
}

/**
 * The words for one decision an alert may take: the chip that picks it, the
 * confirm button, the note's prompt and what happens next. Fuel takes them
 * from the incident window's own (lib/fuelReview), so the two places that
 * decide a fuel alert say the same thing.
 */
export function choiceWords(kind, choice) {
  if (kind === "fuel") {
    if (choice.outcome === "DEESCALATED") {
      return {
        label: "Not a theft",
        confirm: OUTCOME.DEESCALATED.confirm,
        placeholder: OUTCOME.DEESCALATED.placeholder,
        hint: "Recorded as not a theft with your reason. If it is on the map, it leaves the map.",
      };
    }
    const r = ESCALATION_REASONS.find((x) => x.id === choice.reason) ?? ESCALATION_REASONS[0];
    return {
      label: r.label,
      confirm: r.confirm,
      placeholder: r.placeholder,
      hint: r.id === "probe_fault"
        ? "Not a theft. A case opens in Fuel Audit and a pending probe job in Maintenance › Repairs; it closes when the job is signed off fixed."
        : "Recorded as a confirmed theft with your reason, and the organisation's feed is told.",
    };
  }
  if (kind === "camera") {
    return choice.outcome === "DEESCALATED"
      ? {
          label: "False alarm",
          confirm: "De-escalate as a false alarm",
          placeholder: "Why is this a false alarm? e.g. seatbelt was on, camera misread, passenger on the phone",
          hint: "Recorded as a false alarm with your reason.",
        }
      : {
          label: "Confirmed alarm",
          confirm: "Escalate as a confirmed alarm",
          placeholder: "What happens next? e.g. spoke to the driver, sent to the transport manager",
          hint: "Recorded as a confirmed alarm with your reason.",
        };
  }
  if (choice.outcome === "DEESCALATED") {
    return {
      label: "Not an overspeed",
      confirm: "De-escalate as not an overspeed",
      placeholder: "Why is this not an overspeed? e.g. GPS jump, wrong limit for the road, authorised run",
      hint: "Recorded as not an overspeed with your reason.",
    };
  }
  return {
    label: "Confirmed overspeed",
    confirm: "Escalate as a confirmed overspeed",
    placeholder: "What happens next? e.g. warned the driver, sent to the transport manager",
    hint: "Recorded as a confirmed overspeed with your reason, and the organisation's feed is told.",
  };
}

// ── Figures ─────────────────────────────────────────────────────────────────

const DAY_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Nairobi" });
const TIME_FMT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Nairobi" });

/** "12 Oct 14:05" on the fleet's clock, or "—". */
export function when(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "-";
  return `${DAY_FMT.format(t)} ${TIME_FMT.format(t)}`;
}

const LATE_MS = 10 * 60_000;

/**
 * "reported 04:30" (or "reported 13 Oct 04:30" on a later day) when an alert
 * reached the page well after it began, else null. The list is newest
 * arrival first, so this is what explains a 01:15 fall sitting above a 04:14
 * overspeed: it was only called at 04:30.
 */
export function reportedLate(alert) {
  const at = Date.parse(alert?.at ?? "");
  const arrived = Date.parse(alert?.arrivedAt ?? "");
  if (!Number.isFinite(at) || !Number.isFinite(arrived) || arrived - at < LATE_MS) return null;
  const sameDay = DAY_FMT.format(at) === DAY_FMT.format(arrived);
  return `reported ${sameDay ? TIME_FMT.format(arrived) : when(alert.arrivedAt)}`;
}

/** "45 s", "3 min", "1 h 05 min". */
export function duration(sec) {
  if (sec == null || !Number.isFinite(sec)) return "-";
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

export const litres = (l) => (l == null ? "-" : `${l.toFixed(1)} L`);
export const kmh = (v) => (v == null ? "-" : `${Math.round(v)} km/h`);

/** The number behind the table's bar: litres lost, km/h over, or null (an alarm has none). */
export function figureOf(alert) {
  if (alert.kind === "fuel") return alert.fuel?.litres ?? null;
  if (alert.kind === "speeding") return alert.speeding?.overByKmh ?? null;
  return null;
}

/** The one figure that says what happened, for the table's Alert column. */
export function headline(alert) {
  if (alert.kind === "fuel") return { figure: litres(alert.fuel?.litres), words: "lost" };
  if (alert.kind === "camera") {
    const c = alert.camera ?? {};
    return { figure: c.label ?? "Alarm", words: c.speedKmh != null ? `at ${kmh(c.speedKmh)}` : "" };
  }
  const s = alert.speeding ?? {};
  return { figure: kmh(s.peakKmh), words: `in ${Math.round(s.limitKmh ?? 0)} km/h` };
}

/** The fuel rule's slug in words; the slug itself when it is one we have not named. */
const RULE_WORDS = {
  "fell-while-standing": "Fell while standing",
  "fell-after-refuel": "Fell after a refuel",
};
export const ruleWords = (slug) => (slug ? RULE_WORDS[slug] ?? slug.replace(/-/g, " ") : "Possible theft");

// ── Pages ───────────────────────────────────────────────────────────────────

/**
 * The figures TablePager draws (Prev · Page n of N · a–b of N · Next), for a
 * list the SERVER pages. It cannot slice an array it does not hold, so the
 * whole is the count for the filters on screen (`listed`) and the page is
 * whatever the server sent. The two can disagree for a moment (a decision
 * moves an alert out of Open before the counts are read again), and the rows
 * win: the last page reports what it holds, and a page with more after it
 * never claims to be the last.
 */
export function alertPager({ page, rows, hasNext, listed, step = 15 }) {
  const from = rows ? page * step + 1 : 0;
  const to = page * step + rows;
  if (!hasNext) return { page, pageCount: page + 1, total: to, from, to };
  const total = Math.max(listed ?? 0, to + 1);
  return { page, pageCount: Math.max(Math.ceil(total / step), page + 2), total, from, to };
}

// ── Many at once ────────────────────────────────────────────────────────────
//
// Operator, 2026-10-13: "consider a situation where we would like to escalate
// or deescalate or both escalate and deescalate multiple". Each selected alert
// carries its own pick, so one batch can escalate some and de-escalate others;
// a fuel escalation takes the batch's one "as" (theft or a faulty probe).

/** May this alert take `outcome` now (as `reason`, when it is a fuel escalation)? */
export function canTake(alert, outcome, reason = null) {
  const fuelEsc = alert.kind === "fuel" && outcome === "ESCALATED";
  return (alert.choices ?? []).some((c) => c.outcome === outcome && (!fuelEsc || c.reason === reason));
}

/** Why an alert cannot take a pick, for the line under it. */
function cannotWords(alert, outcome) {
  if (!alert.choices?.length) {
    return alert.kind === "fuel" && alert.decision?.reason === "probe_fault"
      ? "Escalated as a faulty fuel probe: it closes in Fuel Audit."
      : "Decided in its case: it cannot be changed here.";
  }
  if (alert.decision?.outcome === outcome) return `Already ${decisionWords(alert.kind, alert.decision).toLowerCase()}.`;
  return "Cannot take this decision now.";
}

/**
 * What a batch will do: `picks` maps an alert's key to the outcome picked for
 * it (absent or null: left out of this batch), and `fuelReason` is what fuel
 * escalations are escalated as. `run` is every step to send; `skip` the
 * alerts that cannot take their pick, with why.
 */
export function bulkPlan(alerts, picks, fuelReason, keyOf) {
  const run = [];
  const skip = [];
  for (const alert of alerts) {
    const outcome = picks[keyOf(alert)] ?? null;
    if (!outcome) continue;
    const reason = alert.kind === "fuel" && outcome === "ESCALATED" ? fuelReason : null;
    if (canTake(alert, outcome, reason)) run.push({ alert, outcome, reason });
    else skip.push({ alert, outcome, why: cannotWords(alert, outcome) });
  }
  return { run, skip };
}

/**
 * The steps in the order to send them: one queue per unit, its oldest alert
 * first. Deciding a fuel alert that is on the map also clears the unit's
 * older ones from it (fuel.repository sweepUnitSiblings), so two decisions on
 * one unit sent together could refuse each other; one after another, each
 * finds the other already settled. Different units go side by side.
 */
export function unitQueues(steps) {
  const byUnit = new Map();
  for (const s of steps) {
    const k = `${s.alert.orgId}:${s.alert.vehicleId ?? s.alert.plate}`;
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(s);
  }
  return [...byUnit.values()].map((q) => q.sort((a, b) => Date.parse(a.alert.at) - Date.parse(b.alert.at)));
}

/** A batch's outcome in one line: "4 escalated, 2 de-escalated, 1 failed". */
export function bulkWords(done) {
  const esc = done.filter((d) => d.ok && d.outcome === "ESCALATED").length;
  const de = done.filter((d) => d.ok && d.outcome === "DEESCALATED").length;
  const failed = done.filter((d) => !d.ok).length;
  const parts = [];
  if (esc) parts.push(`${esc} escalated`);
  if (de) parts.push(`${de} de-escalated`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(", ") || "Nothing decided";
}

// ── Where an alert's unit lives on this dashboard ───────────────────────────

const COMPANY_BY_ORG_CODE = Object.fromEntries(
  Object.entries(ORG_CODE_BY_COMPANY).map(([companyId, code]) => [code, companyId]),
);

/** The dashboard's company id for an organisation code, or null if it has none. */
export const companyForOrgCode = (code) => COMPANY_BY_ORG_CODE[String(code ?? "").toUpperCase()] ?? null;
