// Repair reports — what a technician did to the faulty units they were sent to.
//
// The one WRITE path on the Sensor Monitor. Everything else on that screen is
// derived from telemetry and cannot be told anything; this is where a person
// gets to say what they found and what they did about it.
//
// A report is one trip and one email. Its ITEMS are the units, each carrying
// its own outcome, because a trip routinely splits: four fixed on the spot,
// two waiting on a part, one that has to come off the road. That split is why
// the submission is itemised rather than a single verb applied to a selection.

import { apiFetch } from "../services/api";

const base = (orgId) => `/api/v1/organisations/${orgId}/repairs`;

/*
 * Maintenance > Repairs and Fuel > Audit show the same jobs. Every write here
 * says so on `ft-repairs-changed`, and so does the server's `repair_changed`
 * frame for writes made by anybody else (hooks/useFleetLive), so both views
 * re-read and neither goes stale behind the other.
 */
export const REPAIRS_CHANGED = "ft-repairs-changed";
export function repairsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(REPAIRS_CHANGED));
}
async function writeFetch(url, init) {
  const res = await apiFetch(url, init);
  repairsChanged();
  return res;
}

/**
 * Open (or resolved, or all) repair jobs for this organisation.
 *
 * The Probes tab asks for the open set on every load so it can grey out a unit
 * somebody has already reported. The server's partial unique index is the real
 * guard against a duplicate; this only stops the technician filling in a form
 * that was going to be refused.
 *
 * @param {{ orgId: string, status?: 'open'|'resolved'|'unresolved'|'all', limit?: number }} opts
 */
export async function listRepairItems({
  orgId, status = "open", stage, vehicleId, limit = 200,
} = {}) {
  if (!orgId) return null;
  const qs = new URLSearchParams({ status, limit: String(limit) });
  if (stage) qs.set("stage", stage);
  if (vehicleId) qs.set("vehicleId", vehicleId);
  const res = await apiFetch(`${base(orgId)}/items?${qs}`);
  return res.data ?? [];
}

/**
 * Assign one open repair job.
 *
 * technicianId is REQUIRED: a person, or null to unassign. Omitting it used to
 * ask the server to run a least-loaded triage rule over every user in the
 * tenant; that rule is gone and the server rejects a body without the field.
 * Supplying the current user's id is the explicit self-assign path; the server
 * intentionally does not email that user.
 *
 * The server also checks both ends of the hand-off: only an administrator of
 * the organisation (or the platform administrator) may assign, and only a
 * technician or an administrator who belongs to that organisation may be
 * named. A 403 from here is that rule, not a bad request.
 *
 * @param {{ orgId: string, itemId: string, technicianId?: string|null, reason?: string }} opts
 */
export async function assignRepairItem({ orgId, itemId, technicianId, reason } = {}) {
  const res = await writeFetch(`${base(orgId)}/items/${itemId}/assign`, {
    method: "POST",
    body: JSON.stringify({
      technicianId: technicianId ?? null,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
    }),
  });
  return res.data ?? null;
}

/**
 * Who this organisation's triages may be handed to.
 *
 * The server decides. The picker used to ask for the USER ROSTER and work out
 * in the browser which rows held `technician`, which was wrong twice over: the
 * roster is scoped by user GROUP, and an assignee has to share the
 * ORGANISATION but need not share the group — ControlTech are contractors in
 * their own group who service all four tenants, and they are exactly who these
 * jobs go to. Holding a second copy of the role rule here is also how the
 * picker came to offer names the server refuses.
 */
export async function listRepairAssignees(orgId) {
  if (!orgId) return [];
  const res = await apiFetch(`${base(orgId)}/assignees`);
  return res.data ?? [];
}

/** Respond to a repair assignment as the assigned user. */
export async function respondToRepairAssignment({ orgId, itemId, status } = {}) {
  const res = await writeFetch(`${base(orgId)}/items/${itemId}/assignment-response`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  return res.data ?? null;
}

/**
 * The newest repair on one unit, open or closed.
 *
 * The detail panel's tracking line asks this rather than reading the open-jobs
 * map the Probes tab already holds, and the difference matters at exactly one
 * moment: right after a sign-off. The job leaves the open set the instant it
 * is closed, so a line fed from that map would go blank in the same click that
 * put "Fixed" on the end of it — which is the click somebody opened the panel
 * to watch.
 *
 * `null` when the unit has never been reported, which is most of them.
 *
 * @param {{ orgId: string, vehicleId: string }} opts
 */
export async function latestRepairForVehicle({ orgId, vehicleId } = {}) {
  if (!orgId || !vehicleId) return null;
  const rows = await listRepairItems({ orgId, vehicleId, status: "all", limit: 1 });
  return rows?.[0] ?? null;
}

/** @param {{ orgId: string, cursor?: string, limit?: number }} opts */
export async function listRepairReports({ orgId, cursor, limit = 20 } = {}) {
  if (!orgId) return null;
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  const res = await apiFetch(`${base(orgId)}?${qs}`);
  return res;
}

/**
 * File one report covering every unit the technician touched.
 *
 * Resolves with the created report PLUS an `email` block saying what became of
 * the mail. Read it — do not assume a 201 means the handlers were told. The
 * production box has no mail credentials today, so `unconfigured` is the
 * common answer and showing a tick against it would be a lie the technician
 * acts on.
 *
 * @param {{ orgId: string, items: object[], note?: string }} opts
 */
export async function submitRepairReport({ orgId, items, note } = {}) {
  const res = await writeFetch(base(orgId), {
    method: "POST",
    body: JSON.stringify({ items, ...(note ? { note } : {}) }),
  });
  return res.data ?? null;
}

/**
 * Close one job. Per item, never per batch — the spare for one unit arrives on
 * a different day from the spare for the next.
 *
 * The `verdict` is what lands the job on its terminal stage. It defaults to
 * `fixed` on the server too, so an older caller that omits it still closes a
 * job the way it always did.
 *
 * @param {{ orgId: string, itemId: string, fixNote: string, recommendation?: string, verdict?: 'fixed'|'failed' }} opts
 */
export async function resolveRepairItem({
  orgId, itemId, fixNote, recommendation, verdict = "fixed",
} = {}) {
  const res = await writeFetch(`${base(orgId)}/items/${itemId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ fixNote, verdict, ...(recommendation ? { recommendation } : {}) }),
  });
  return res.data ?? null;
}

// ── vocabulary ───────────────────────────────────────────────────────────────
//
// Exported so nothing hardcodes an outcome string in JSX. The same three
// values are a zod enum and a Postgres CHECK on the server; a fourth means
// touching all three, and this is the one a reader meets first.

export const OUTCOMES = ["fixing", "needs_spare", "cannot_fix"];

export const OUTCOME_LABEL = {
  fixing:      "Fixing",
  needs_spare: "Needs a spare part",
  cannot_fix:  "Cannot be fixed",
  // No technician recorded it: a fuel case found the probe faulty (Fuel Audit).
  audit:       "From Fuel Audit",
  // Raised by the Control Room on the Workshop screen (api/repairWorkflow).
  flagged:     "Flagged by the Control Room",
};

/** The verb on the button, which is shorter than the noun on the chip. */
export const OUTCOME_ACTION = {
  fixing:      "Fixing",
  needs_spare: "Fix but needs a spare part",
  cannot_fix:  "Cannot be fixed",
};

/** Maps onto the panel's existing .sp4-pill--* modifiers. */
export const OUTCOME_PILL = { fixing: "con", needs_spare: "warn", cannot_fix: "inc", audit: "info", flagged: "info" };

// ── the ladder ───────────────────────────────────────────────────────────────
//
// WHERE A JOB IS, which is a different question from what the technician found
// when they got there. The outcome is frozen at the moment the report is filed;
// the stage keeps moving for as long as the job is open, and it is the stage
// the people ordering spares actually read.
//
// STAGE_ORDER is the tracking line's rails, so it is an ARRAY and not an object
// — the order is the feature. `failed` is not in it: it is the other end of
// the same last rung as `fixed`, and drawing it as a sixth node would claim
// every job passes through failure on its way to being repaired.

export const STAGE_ORDER = ["pending", "spare_outsourced", "fixing", "fixed"];

export const STAGES = [...STAGE_ORDER, "failed"];

export const STAGE_LABEL = {
  pending:          "Pending",
  spare_outsourced: "Spare outsourced",
  fixing:           "Fixing",
  fixed:            "Fixed",
  // The stored value stays `failed`. Unlike fixed/fixing — renamed because
  // they mean different things — these two are the same word, so the label can
  // read the way people say it without the column drifting from what it holds.
  failed:           "Unsuccessful",
  // The Repair Workflow's stages (Workshop screen). Moved only by their own
  // actions there, never by the stage chips here.
  forwarded:           "With ControlTech",
  remote_fix:          "Remote fix",
  awaiting_assessment: "Awaiting assessment",
  booked:              "Booked in",
  towing:              "Towing",
  field_inspection:    "Field inspection",
  in_workshop:         "In workshop",
  completed:           "Awaiting verification",
  void:                "Void",
};

/** One line under the node, saying what that stage MEANS. A ladder of bare
 *  nouns makes a reader guess at the difference between two of them. */
export const STAGE_BLURB = {
  // The only stage with no row behind it — see PENDING_ITEM below.
  pending:          "Faulty, and no repair has been filed yet.",
  spare_outsourced: "Reported. The part is on order.",
  fixing:           "Reported. The work is under way.",
  fixed:            "Signed off: the unit is back in service.",
  failed:           "Signed off: the repair did not succeed.",
};

export const STAGE_PILL = {
  pending:          "none",
  spare_outsourced: "warn",
  fixing:           "warn",
  fixed:            "con",
  failed:           "inc",
  forwarded:           "info",
  remote_fix:          "warn",
  awaiting_assessment: "warn",
  booked:              "info",
  towing:              "warn",
  field_inspection:    "warn",
  in_workshop:         "warn",
  completed:           "info",
  void:                "none",
};

/**
 * The stages a person may set directly.
 *
 * `fixed` is absent and so is `failed` — both are claims somebody has to stand
 * behind, so they are reachable only through the sign-off, which demands an
 * account of the fix. Zod and a Postgres CHECK hold the same rule; this array
 * only stops the screen offering a button the server would refuse.
 *
 * `pending` is absent for a different reason: it means "nobody has been out to
 * this yet", and a job with a report against it has had somebody out to it.
 * Setting it back would be un-reporting the unit, which is not a thing that
 * can happen — the report exists.
 */
export const SETTABLE_STAGES = ["spare_outsourced", "fixing"];

/**
 * May this account WORK the job (move it, order and collect its parts, sign
 * it off)? Operator, 2026-10-01: a technician works only a job assigned to
 * them that they have accepted; every other job they read. `repair:work_any`
 * (every other role that resolves repairs) lifts that. The server enforces
 * the same rule (repairs.authz requireWorkableJob); this only hides what it
 * would refuse.
 */
export function mayWorkJob(job, { canResolve, canWorkAny, userId }) {
  if (!canResolve || !job || job.resolvedAt) return false;
  if (canWorkAny) return true;
  const assignee = job.assignedToId ?? job.assignedTo?.id ?? null;
  return assignee != null && assignee === userId && (job.assignmentStatus ?? "accepted") === "accepted";
}

/**
 * How a stage chip reads for a job (operator, 2026-10-01). Both chips can be
 * lit: a job on Fixing has also been through Spare outsourced, so that chip
 * stays on beside it. Blue when the spare really was outsourced (it is in the
 * history), amber when the job went to Fixing without one.
 *
 * @returns {'on'|'passed'|'skipped'|null}
 */
export function stageChipState(item, stage) {
  if (!item) return null;
  if (item.stage === stage) return "on";
  const past = STAGE_ORDER.indexOf(item.stage === "failed" ? "fixed" : item.stage);
  const here = STAGE_ORDER.indexOf(stage);
  if (here < 0 || past <= here) return null;
  const history = Array.isArray(item.stageHistory) ? item.stageHistory : [];
  return history.some((e) => e?.stage === stage) ? "passed" : "skipped";
}
export const STAGE_CHIP_CLASS = { on: " sp4-filter-chip--on", passed: " sp4-filter-chip--on", skipped: " sp4-filter-chip--skipped" };

/**
 * Move one open job along the ladder.
 *
 * @param {{ orgId: string, itemId: string, stage: string, note?: string }} opts
 */
// ── overhaul audit (fleet-server repairs.overhaul) ───────────────────────────

/** One job's spare parts and inspections: { parts, inspections }. */
export async function fetchRepairOverhaul({ orgId, itemId } = {}) {
  const res = await apiFetch(`${base(orgId)}/items/${itemId}/overhaul`);
  return res?.data ?? { parts: [], inspections: [] };
}

/** The checklist, in the order a technician walks the unit. */
export const INSPECTION_COMPONENTS = [
  ["probe",        "Fuel probe"],
  ["probe_cable",  "Probe cable & connector"],
  ["tank_bracket", "Tank & bracket"],
  ["tracker",      "Tracker / FLS unit"],
  ["calibration",  "Calibration"],
];
export const INSPECTION_VERDICTS = [
  ["ok",       "OK",       "con"],
  ["faulty",   "Faulty",   "inc"],
  ["replaced", "Replaced", "info"],
];
export const PART_STATUS = {
  requested: { label: "Requested", pill: "warn" },
  issued:    { label: "Issued",    pill: "info" },
  ordered:   { label: "Ordered",   pill: "warn" },
  received:  { label: "Received",  pill: "info" },
  fitted:    { label: "Fitted",    pill: "con" },
  cancelled: { label: "Cancelled", pill: "none" },
};

export async function setRepairInspection({ orgId, itemId, component, verdict, note } = {}) {
  const res = await writeFetch(`${base(orgId)}/items/${itemId}/inspections`, {
    method: "POST",
    body: JSON.stringify({ component, verdict, ...(note?.trim() ? { note: note.trim() } : {}) }),
  });
  return res.data ?? null;
}

/** Order a spare. The first order moves the job to spare_outsourced (server-side). */
export async function addRepairSparePart({ orgId, itemId, part } = {}) {
  const body = { name: part.name.trim(), quantity: Number(part.quantity) || 1 };
  if (part.supplier?.trim()) body.supplier = part.supplier.trim();
  if (part.costKes !== "" && part.costKes != null) body.costKes = Number(part.costKes);
  if (part.expectedAt) body.expectedAt = part.expectedAt;
  if (part.note?.trim()) body.note = part.note.trim();
  const res = await writeFetch(`${base(orgId)}/items/${itemId}/parts`, { method: "POST", body: JSON.stringify(body) });
  return res.data ?? null;
}

/**
 * received | fitted | cancelled. `fixDate` (YYYY-MM-DD) is required on
 * received: the day the fix will happen now the part is collected. The last
 * arrival moves the job to fixing (server-side).
 */
export async function updateRepairSparePart({ orgId, itemId, partId, status, fixDate } = {}) {
  const res = await writeFetch(`${base(orgId)}/items/${itemId}/parts/${partId}`, {
    method: "POST", body: JSON.stringify({ status, ...(fixDate ? { fixDate } : {}) }),
  });
  return res.data ?? null;
}

export async function setRepairStage({ orgId, itemId, stage, note } = {}) {
  const res = await writeFetch(`${base(orgId)}/items/${itemId}/stage`, {
    method: "POST",
    body: JSON.stringify({ stage, ...(note ? { note } : {}) }),
  });
  return res.data ?? null;
}

/**
 * The tracking line, built from one item.
 *
 * REACHED IS READ OUT OF THE HISTORY, never inferred from position. A job
 * filed as "Fixing" was never pending and never waited on a part, and a ladder
 * that ticked those two off because they sit below the current rung would be
 * inventing a past the unit did not have. Three node states come out of this:
 * done (in the history, not current), current, and not reached.
 *
 * `failed` is folded onto the last rung rather than given one of its own — see
 * STAGE_ORDER. A job that failed, was retried and then signed off clean shows
 * the clean end on the rails, and the loop in the history beneath them.
 *
 * A rung the job went past without ever standing on it is DROPPED, not drawn
 * hollow — see `skipped` below. The returned array is therefore between two
 * and four rungs long, and a caller must not index it by STAGE_ORDER.
 *
 * @param {{ stage?: string, stageHistory?: object[], resolvedAt?: string }} item
 */
export function trackingLine(item) {
  const history = Array.isArray(item?.stageHistory) ? item.stageHistory : [];
  /*
   * No item means no repair has been filed, which is not "no information":
   * it is the FIRST rung. A probe the fleet can see is broken and nobody has
   * been out to is pending, and every rung above it reads as not yet.
   */
  const current = item?.stage ?? "pending";
  const endedBadly = current === "failed";

  /*
   * The ladder is SEQUENTIAL: Pending -> Spare outsourced -> Fixing -> Fixed.
   * Every rung below where the job is now is done, the one it is on is
   * current, every rung above it is still to come. Always all four, in order.
   *
   * It is read from the job's stage, never from which stages appear somewhere
   * in its history. A job moved back from Fixing to Spare outsourced (the part
   * was wrong) has Fixing in its history, and drawing that rung done while the
   * one below it is current left a filled line above an unfilled one. Where
   * the job is NOW decides; the history only supplies the dates.
   *
   * An unknown stage indexes to -1: nothing reads as passed, the safe way.
   */
  const reachedIndex = endedBadly ? STAGE_ORDER.length - 1 : STAGE_ORDER.indexOf(current);

  /* The LATEST arrival at each stage: after a return, the date that counts is
     the one the job came back on. */
  const lastAt = new Map();
  for (const e of history) if (e?.stage) lastAt.set(e.stage, e);

  return STAGE_ORDER.map((stage, i) => {
    const isLast = i === STAGE_ORDER.length - 1;
    const key = isLast && endedBadly ? "failed" : stage;
    const state = i < reachedIndex ? "done" : i === reachedIndex ? "current" : "todo";
    const event = state === "todo" ? undefined
      : lastAt.get(key) ?? (isLast ? lastAt.get("failed") ?? lastAt.get("fixed") : undefined);

    /* Pending has no history entry of its own: every reported unit passed
       through it, but when the fault STARTED is probe health's question, so
       no date is guessed for it. */
    const impliedPending = stage === "pending" && item != null && !event;

    return {
      key,
      label: STAGE_LABEL[key],
      blurb: STAGE_BLURB[key],
      state,
      tone:  key === "failed" ? "crit" : key === "fixed" ? "ok" : "mid",
      at:    event?.at ?? null,
      by:    event?.byName ?? null,
      note:  event?.note ?? null,
      auto:  event?.auto === true,
      implied: impliedPending,
      /* The pending rung of a unit with no report at all. */
      unreported: stage === "pending" && item == null,
      /* Passed without anybody standing on it, e.g. no part was needed, so
         the spare rung went by with no order. Done, and says so, rather than
         showing a date it does not have. */
      passedWithout: state === "done" && !event && !impliedPending,
    };
  }).map((n) => (n.passedWithout
    ? { ...n, blurb: n.key === "spare_outsourced" ? "Skipped: no spare part was outsourced." : "Passed without a record." }
    : n));
}

/**
 * What the banner says after a submission — and it only says "emailed" when a
 * mail actually left. Everything else is phrased so the technician knows the
 * report is safe but the handlers are not yet informed.
 */
export function emailBanner(email) {
  const n = email?.sent?.length ?? 0;
  const total = email?.recipients?.length ?? 0;
  switch (email?.status) {
    case "sent":
      return { tone: "ok", text: `Report filed. Emailed to ${n} handler${n === 1 ? "" : "s"}.` };
    /* The server hands mail to a queue now and returns without waiting on
       SMTP, so this status means accepted for delivery — not delivered.
       "Emailed" would be the tick this function's header promises never to
       show. Not a warning either: the handlers WILL be told, with retries
       behind it, and there is nothing for the technician to do about it. */
    case "queued":
      return { tone: "ok", text:
        `Report filed. Queued for delivery to ${total} handler${total === 1 ? "" : "s"}.` };
    case "partial":
      return { tone: "warn", text:
        `Report filed. Emailed to ${n} of ${total} - ${email.failed.join(", ")} was not reached.` };
    case "unconfigured":
      return { tone: "warn", text:
        "Report filed, but no email was sent: the mail service is not configured on the server. Tell an administrator." };
    case "no-recipients":
      return { tone: "warn", text:
        "Report filed, but no handlers are configured to receive it." };
    case "failed":
      return { tone: "warn", text: "Report filed, but the email failed to send." };
    default:
      return { tone: "ok", text: "Report filed." };
  }
}

/**
 * What the toast says after a triage is handed to somebody.
 *
 * A pure function beside emailBanner, and for the same reason: this was a
 * ternary inside an async click handler, which is a place no test can reach.
 * The rule it encodes is the server's — a tick is never shown for a mail that
 * has not left the building — and a rule nothing can check is a rule that
 * lasts until the next edit.
 *
 * `queued` is neither of the two answers that existed before it. Not sent: the
 * message is in Redis and the technician has not been told. Not failed: three
 * attempts sit behind it and there is nothing for anybody to do, so a warning
 * would send the assigner chasing a mail that is simply in flight.
 */
export function assignmentToast(email, assignedName = "the selected person") {
  if (email?.sent) return { tone: "ok", text: `Triage assigned to ${assignedName}. Email sent.` };
  if (email?.reason === "self-assignment") return { tone: "ok", text: "Task assigned to you. No email was sent." };
  if (email?.reason === "in-app") return { tone: "ok", text: `Triage assigned to ${assignedName}. They are notified in the app.` };
  if (email?.reason === "queued") {
    return { tone: "ok", text: `Triage assigned to ${assignedName}. Email queued for delivery.` };
  }
  return { tone: "warn", text: `Triage assigned to ${assignedName}, but the notification email was not sent.` };
}

// ── the estimate ─────────────────────────────────────────────────────────────
//
// When the technician expects the unit back, collected only for `needs_spare`
// — the one outcome that hands the job to somebody else and then waits. The
// point of collecting it is the OVERDUE answer below: without a date,
// "outsourced" and "outsourced three weeks ago" are the same row on the
// Repairs tab, and the second is the only one anybody needs to act on.
//
// ## Everything here is UTC, and that is not laziness
//
// The column is a Postgres `DATE` and the API sends it as an ISO instant at
// midnight UTC. Reading it back with `new Date(...).getDate()` asks the
// BROWSER's timezone, and for a reader in Nairobi (UTC+3) midnight UTC on the
// 25th is still the 25th — but for anyone west of UTC it is the 24th, and a
// date field that reports the previous day for some of its readers is worse
// than no date at all. So the day is taken from the ISO text and compared
// against a UTC-built today, and no local calendar is consulted anywhere.

/** The `YYYY-MM-DD` day inside an ISO instant, without asking the browser. */
export function dayOf(iso) {
  if (!iso) return null;
  const s = String(iso);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Today as `YYYY-MM-DD`, in UTC — the same frame the stored day is in. */
export function utcTodayISO(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The calendar day on the viewer's own clock, `offset` days on, YYYY-MM-DD.
 * For what a person PICKS (a delivery date, a fix date): "today" is the date
 * on their wall, not UTC's. In Kenya (UTC+3) UTC is still on yesterday until
 * 03:00, so the UTC day made 1 Oct read as "tomorrow" just after midnight.
 */
export function localDayISO(offset = 0, now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * How the estimate stands: whole days from today, negative when it has passed.
 *
 * Subtracting two midnight-UTC instants is exact — no hour survives either
 * operand, so there is no daylight-saving remainder to round.
 *
 * @returns {number|null} null when there is no date to judge.
 */
export function daysUntil(iso, now = Date.now()) {
  const day = dayOf(iso);
  if (!day) return null;
  const then = Date.parse(day + "T00:00:00.000Z");
  // Today on the viewer's own clock: a fix date of 1 Oct reads "today" on
  // 1 Oct in Nairobi, not "tomorrow" because UTC is still on 30 Sept.
  const today = Date.parse(localDayISO(0, now) + "T00:00:00.000Z");
  if (Number.isNaN(then)) return null;
  return Math.round((then - today) / 86400000);
}

/**
 * The estimate in the words an operator uses, plus the tone to paint it.
 *
 * ## It is only overdue while the job is OPEN
 *
 * A resolved item's estimate is history: the part arrived, somebody signed the
 * job off, and colouring the row red afterwards would keep flagging work that
 * is finished. `resolvedAt` is therefore an input, not an afterthought.
 *
 * ## An estimate is not a promise, and the wording says so
 *
 * "Expected" throughout, never "due". The technician guessed at a supplier's
 * lead time while standing next to a broken probe; the value of the guess is
 * that it gives somebody a day to ring up on, not that anyone is in breach.
 *
 * @returns {{text: string, tone: 'ok'|'warn'|'inc'|'none', overdue: boolean}}
 */
export function estimateState(item, now = Date.now()) {
  const day = dayOf(item?.expectedResolutionAt);
  if (!day) return { text: "-", tone: "none", overdue: false };
  if (item?.resolvedAt) return { text: day, tone: "none", overdue: false };

  const d = daysUntil(day, now);
  if (d === null) return { text: day, tone: "none", overdue: false };
  if (d < 0) {
    const n = Math.abs(d);
    return { text: `${day} · ${n} day${n === 1 ? "" : "s"} over`, tone: "inc", overdue: true };
  }
  if (d === 0) return { text: `${day} · today`, tone: "warn", overdue: false };
  if (d === 1) return { text: `${day} · tomorrow`, tone: "warn", overdue: false };
  return { text: `${day} · in ${d} days`, tone: "ok", overdue: false };
}

/**
 * Has this job been escalated, and how far?
 *
 * The server's daily sweep appends `{ kind: 'escalation', reason, level, days }`
 * to the same trail a stage change writes, and deliberately does NOT move the
 * stage: escalating a job does not stop the repair, so a row that read
 * "escalated" instead of "waiting for a part" would lose the fact anybody
 * chasing it needs. Which means the escalation is invisible on this screen
 * unless something reads for it — and an escalation nobody can see on the board
 * is the failure the whole feature exists to prevent.
 *
 * Null for a job that has never been escalated. The LEVEL is what a reader
 * sorts by: level 3 is a job that has been raised three times and is still open.
 *
 * @returns {{level: number, reason: 'overdue'|'stalled', days: number, at: string}|null}
 */
export function escalationOf(item) {
  const history = Array.isArray(item?.stageHistory) ? item.stageHistory : [];
  let last = null;
  for (const e of history) if (e?.kind === "escalation") last = e;
  if (!last) return null;
  return {
    level:  Number(last.level) || 1,
    reason: last.reason === "overdue" ? "overdue" : "stalled",
    days:   Number(last.days) || 0,
    at:     last.at ?? null,
  };
}

/** The clause the badge and the tracking line both use, written once so the
 *  two cannot disagree about why a job was raised. */
export function escalationPhrase(esc) {
  if (!esc) return "";
  const d = `${esc.days} day${esc.days === 1 ? "" : "s"}`;
  return esc.reason === "overdue"
    ? `${d} past the expected date`
    : `no movement for ${d}`;
}

/** `fuel_probe_dead` -> `Fuel probe dead`. Episode kinds arrive snake_cased. */
export function humanKind(kind) {
  if (!kind) return "Probe health";
  const s = String(kind).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
