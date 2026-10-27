// The Alerts page: fuel and overspeeding alerts from every organisation this
// account holds, on one page (operator, 2026-10-12: "list all organizations
// alerts and we can filter so that it ease the pain of navigating from one
// organization to the next").
//
// `/api/v1/alerts` spans organisations and decides on the server what this
// account may read in each. Deciding an alert goes to the alert's OWN
// organisation's route, so the usual per-organisation checks run there.

import { apiFetch } from "../services/api";
import { reviewIncident } from "../lib/fuelReview";

/**
 * One page of alerts.
 *
 * @param {object} f
 * @param {"all"|"fuel"|"speeding"} f.kind
 * @param {"open"|"escalated"|"deescalated"|"all"} f.status
 * @param {string[]} f.orgs     organisation ids; empty = every one
 * @param {string}   f.from     ISO
 * @param {string}   f.to       ISO
 * @param {string}   [f.q]      plate or unit name
 * @param {number}   [f.minOverKmh]
 * @param {string}   [f.cursor]
 * @param {"all"|"read"|"unread"} [f.read]  this person's read marks
 */
export async function fetchAlerts(f, { signal } = {}) {
  const qs = new URLSearchParams();
  qs.set("kind", f.kind);
  qs.set("status", f.status);
  if (f.orgs?.length) qs.set("orgs", f.orgs.join(","));
  if (f.from) qs.set("from", f.from);
  if (f.to) qs.set("to", f.to);
  if (f.q) qs.set("q", f.q);
  if (f.minOverKmh) qs.set("minOverKmh", String(f.minOverKmh));
  if (f.read && f.read !== "all") qs.set("read", f.read);
  if (f.cursor) qs.set("cursor", f.cursor);
  qs.set("limit", String(f.limit ?? 50));
  const res = await apiFetch(`/api/v1/alerts?${qs}`, { signal });
  return res?.data ?? null;
}

/** The badge: open alerts over the page's default week, every organisation. */
export async function fetchAlertSummary() {
  const res = await apiFetch("/api/v1/alerts/summary");
  return res?.data ?? null;
}

/** Every alert ever received, a fleet day at a time: [{ orgId, kind, day, n }]. */
export async function fetchAlertHistory({ signal } = {}) {
  const res = await apiFetch("/api/v1/alerts/history", { signal });
  return res?.data?.days ?? null;
}

/** Mark alerts read, for this person only: [{ kind, id }]. */
export async function markAlertsRead(alerts) {
  const res = await apiFetch("/api/v1/alerts/read", {
    method: "POST",
    body: JSON.stringify({ items: alerts.map((a) => ({ kind: a.kind, id: a.id })) }),
  });
  return res?.data ?? null;
}

/** "Mark all read": every alert so far is read, for this person only. */
export async function markAllAlertsRead() {
  const res = await apiFetch("/api/v1/alerts/read-all", { method: "POST" });
  return res?.data ?? null;
}

/**
 * Escalate or de-escalate one alert, in its own organisation.
 *
 * A fuel alert goes through lib/fuelReview, which also takes it off the map
 * in this browser at once; `reason` is what a fuel escalation is for
 * (theft | probe_fault). Speeding takes no reason.
 */
export async function decideAlert(alert, outcome, note, reason = null) {
  if (alert.kind === "fuel") {
    return reviewIncident(alert.orgId, alert.id, outcome, note, outcome === "ESCALATED" ? reason ?? "theft" : undefined);
  }
  const res = await apiFetch(
    `/api/v1/organisations/${alert.orgId}/incidents/${alert.kind === "camera" ? "camera" : "speeding"}/${encodeURIComponent(alert.id)}/review`,
    { method: "POST", body: JSON.stringify({ outcome, note }) },
  );
  return res?.data?.review ?? null;
}
