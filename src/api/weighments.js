// Weighbridge tickets — one fleet day at a time.
//
// A ticket is a TOKEN, not a trip across a scale: the lorry crosses empty and
// loaded, and the factory's scale software issues one numbered ticket carrying
// both stamps. That is the unit everything on this page counts in, because it
// is the unit the people at the bridges count in.
//
// The whole day comes back in one response — rows, the day's stats and the
// per-centre counts — because the stats describe every bridge while the grid
// shows one, and reading them separately would let the two disagree about a
// ticket that landed between the requests. See modules/weighments on the
// server for why the sequence numbers and the gaps cannot be computed here.

import { apiFetch } from "../services/api";
import { resolveOrgId } from "./org";

/**
 * @param {{orgId: string, day?: string, centre?: number|null, q?: string}} opts
 * @returns {Promise<{
 *   day: string,
 *   centres: {code:number,name:string,count:number}[],
 *   stats: {weighments:number, uniqueVehicles:number, heaviestNetKg:number|null,
 *           heaviest:object|null, totalNetKg:number},
 *   rows: object[], matched: number, total: number,
 *   captured: {first:string,last:string}|null,
 * }|null>}
 */
export async function getWeighmentDay({ orgId, day, centre, q } = {}) {
  if (!orgId) return null;
  const params = new URLSearchParams();
  if (day) params.set("day", day);
  // 0 is not a centre code here (they start at 101), but `!= null` is still the
  // right test: `centre` is null for "all bridges" and must not be sent at all.
  if (centre != null) params.set("centre", String(centre));
  if (q) params.set("q", q);
  const qs = params.toString();
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/weighments${qs ? `?${qs}` : ""}`,
  );
  return res.data ?? null;
}

/**
 * The scales over a WINDOW of days, for the analytics screen's card.
 *
 * A third read rather than a mode of the day above, because it answers a third
 * question: not "what happened on this date" and not "where are the bridges",
 * but "how have they been running". The response carries a point per fleet day,
 * the same measures broken down by centre, and the span tickets actually exist
 * over.
 *
 * That last field is the one the card cannot render without. The provider's
 * feed serves a rolling two days and cannot be backfilled, so a 30-day window
 * over this table is six days of tickets and twenty-four of nothing — and a day
 * outside the captured span comes back with NULLS, not zeros. A zero means the
 * bridges were open and nothing crossed them; a null means we cannot say. The
 * card must never draw them the same way.
 *
 * @param {{companyId: string, days?: number, to?: string, centre?: number|null}} opts
 * @returns {Promise<{
 *   from: string, to: string,
 *   captured: {first:string,last:string}|null, capturedDays: number,
 *   days: {day:string, captured:boolean, tickets:number|null, lorries:number|null,
 *          netKg:number|null, ticketsTimed:number|null,
 *          turnaroundP50Ms:number|null, turnaroundP90Ms:number|null}[],
 *   centres: {code:number, name:string, tickets:number, lorries:number,
 *             netKg:number, ticketsTimed:number, turnaroundP50Ms:number|null,
 *             turnaroundP90Ms:number|null, activeDays:number}[],
 *   totals: {tickets:number, lorries:number, netKg:number, ticketsTimed:number,
 *            turnaroundP50Ms:number|null, turnaroundP90Ms:number|null,
 *            activeDays:number, heaviestDay:{day:string,netKg:number}|null},
 *   centre: number|null,
 * }|null>}
 */
export async function getWeighmentAnalytics({ companyId, days, to, centre } = {}) {
  /* A COMPANY here, not an orgId — the one function in this file that takes
   * one, because it is the one whose caller is the analytics screen.
   *
   * That screen holds `activeCompanyId`, which is a fleettrack slug
   * ("sukari"). The two reads above it are called from the weighbridge grid
   * and the map layer, and both of those already hold a resolved cuid from
   * `useFleetLiveShared`. Passing the slug straight through is not an error
   * anything reports: the server takes it as the organisation id, matches no
   * row against it, and answers 200 with a well-formed window in which every
   * day is uncaptured and every total is zero — which the card then withholds
   * itself for, exactly as it would on an org that has no bridges. Resolving
   * HERE is what makes that unrepresentable, rather than leaving it to each
   * caller to remember which of the two vocabularies this file speaks. */
  const orgId = await resolveOrgId(companyId);
  if (!orgId) return null;
  const params = new URLSearchParams();
  if (days != null) params.set("days", String(days));
  if (to) params.set("to", to);
  if (centre != null) params.set("centre", String(centre));
  const qs = params.toString();
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/weighments/analytics${qs ? `?${qs}` : ""}`,
  );
  return res.data ?? null;
}

/**
 * The scales themselves, each carrying the last weighing it took.
 *
 * A separate read from the day above, and deliberately so: that one answers
 * "what happened on this date", this one answers "where are the bridges and
 * what is the latest at each". A marker on a map must not go blank because the
 * operator happens to be looking at a quiet Sunday.
 *
 * @param {{orgId: string}} opts
 * @returns {Promise<Array<{
 *   id: string, centerCode: number, centerName: string, bridgeNo: number,
 *   lat: number, lng: number, spreadM: number, samples: number,
 *   last: {
 *     token: string, category: 'CANE_DELIVERY'|'CANE_TRANSFER',
 *     stage: 'gross'|'tare', atFactoryLeg: boolean, at: string,
 *     vehicleNo: string, vehiclePlate: string, vehicleId: string|null,
 *     driverName: string, operator: string|null,
 *     grossWeightKg: number|null, tareWeightKg: number|null,
 *     netWeightKg: number|null, productName: string|null,
 *   }|null,
 * }>>}
 */
export async function getWeighbridges({ orgId } = {}) {
  if (!orgId) return [];
  const res = await apiFetch(`/api/v1/organisations/${orgId}/weighments/bridges`);
  return res.data ?? [];
}

/**
 * The trucks and tractors FactorySuite dispatched for this organisation and
 * that are not signed back yet — the board's units on the road.
 *
 * @returns {Promise<{
 *   asOf: string,
 *   units: Array<{ id: string, plate: string, vehicleType: 'TRUCK'|'TRACTOR'|'OTHER',
 *     driverName: string, destination: string|null, siteCode: number|null,
 *     siteName: string|null, dispatchedAt: string, elapsedMs: number,
 *     typicalHours: number, typicalSource: string, overdue: boolean }>,
 *   counts: { trucks: number, tractors: number, other: number, overdue: number },
 *   staleCount: number,
 *   lastDispatchAt: string|null,
 * }|null>}
 */
export async function getDispatchedUnits({ orgId } = {}) {
  if (!orgId) return null;
  const res = await apiFetch(`/api/v1/organisations/${orgId}/weighments/dispatched`);
  return res.data ?? null;
}

// ── formatting ─────────────────────────────────────────────────────────────
// Kept beside the fetch, like the incidents module's labels, so the grid and
// the detail card cannot format the same number two ways.

/** Kilograms as tonnes — the unit a weighbridge conversation actually uses.
 *  Two decimals: these scales resolve to 20 kg, so a third digit would be
 *  precision the machine does not have. */
export function tonnes(kg) {
  return kg == null ? "-" : `${(kg / 1000).toFixed(2)} t`;
}

/** Kilograms, grouped. The number printed on the ticket. */
export function kilos(kg) {
  return kg == null ? "-" : `${Math.round(kg).toLocaleString()} kg`;
}

/** A duration as the yard says it: "3h 24m", "18m", "—" for unknown. */
export function gapLabel(ms) {
  if (ms == null) return "-";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "under a minute";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Clock time of a stamp, to the minute — which is all the provider sends
 *  (the times arrive as HHMM integers, so there are no seconds to show). */
export function clockLabel(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Date and clock together, for a stamp that may not be on the day you are
 *  looking at — a tare taken the night before is common, and showing it as a
 *  bare "23:41" beside today's gross reads as a two-minute turnaround. */
export function stampLabel(iso, dayIso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const sameDay = dayIso && new Date(dayIso).toDateString() === d.toDateString();
  const p = (n) => String(n).padStart(2, "0");
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameDay ? clock : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${clock}`;
}

// `fleetDayKey` is NOT re-declared here. The fuel hook already owns it, the
// bridges and the fuel day are the same Nairobi day, and two copies of one
// offset is how a page ends up disagreeing with itself for three hours a
// night. Import it from ../hooks/useFuelEvents.
