

// Fleet analytics data: trends, KPIs, incidents, fuel.

import ANALYTICS_TREND_BY_COMPANY from "../data/analyticsData";
import DRIVER_SAFETY_BY_COMPANY, { DRIVER_SAFETY_AXES } from "../data/driverSafetyData";
import VEHICLES from "../data/vehicleData";
import { getMaintenanceSummary, getMaintenanceRecords } from "./maintenance";
import { apiFetch } from "../services/api";
import { resolveOrgId } from "./org";

/**
 * Org-wide delivery analytics straight from the fleet-server DB — the same
 * /analytics/deliveries endpoint fleetdash renders. Turns the fleettrack
 * company slug into a backend orgId (via /bootstrap, see api/org.js) and pulls
 * the trailing-`days` aggregate: products ferried, busiest days, depots served
 * (most→least), timely vs interrupted deliveries and distance covered. Real
 * persisted Trip + CargoManifest rows — an unseeded company resolves to no org
 * and returns null, so the screen renders empty rather than fabricated numbers.
 */
export async function getDeliveryAnalytics({ companyId, days = 30, to, categories, vehicles } = {}) {
  const orgId = await resolveOrgId(companyId);
  if (!orgId) return null;
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/analytics/deliveries?days=${days}${anchor(to)}${types(categories)}${units(vehicles)}`
  );
  return res.data ?? null;
}

/**
 * `&to=…` when the caller wants a window that does NOT end today.
 *
 * Omitting it is not the same as passing "now": the server serves the anchorless
 * form from a warmed per-org cache and computes an anchored one live, so the
 * default path must stay literally absent from the query string.
 */
const anchor = (to) => (to ? `&to=${encodeURIComponent(to)}` : "");

/**
 * `&categories=EX,CTR` — the vehicle-type filter.
 *
 * Absent for an empty selection, and that is the whole convention: no
 * categories chosen means the WHOLE FLEET, not an empty set. The parameter has
 * to be literally missing rather than empty, because its presence is what
 * moves the request off the server's warm cache and onto a live query.
 */
const types = (categories) =>
  categories?.length ? `&categories=${encodeURIComponent(categories.join(","))}` : "";

/**
 * `&vehicles=id,id` — the unit filter, by exactly the same convention.
 *
 * Absent for an empty selection, so the unfiltered request is byte-identical to
 * what it was before this filter existed and stays on the server's warm entry.
 * The server intersects the two selections; nothing here tries to reconcile
 * them.
 */
const units = (vehicles) =>
  vehicles?.length ? `&vehicles=${encodeURIComponent(vehicles.join(","))}` : "";

/**
 * Fuel put in, fuel lost, and what both cost — /analytics/fuel-cost, the
 * FuelFilling + FuelTheft ledger the Wialon fuel sync persists.
 *
 * These are MEASURED litres, not the distance-derived estimate this page used
 * to show. Cost is litres × a pump rate: nothing in the backend records what
 * fuel actually cost, so the server prices the litres at its configured rate
 * and returns it in `price` — render that rather than assuming a rate here.
 *
 * Independent of the deliveries feed: this fleet's fuel probes report even
 * through windows where no trips were persisted, so the fuel card has data
 * when the delivery cards do not.
 */
export async function getFuelCost({ companyId, days = 30, to, categories, vehicles } = {}) {
  const orgId = await resolveOrgId(companyId);
  if (!orgId) return null;
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/analytics/fuel-cost?days=${days}${anchor(to)}${types(categories)}${units(vehicles)}`
  );
  return res.data ?? null;
}

/**
 * One unit's fuel history, day by day — /analytics/vehicle-fuel-days.
 *
 * The series behind the single-vehicle fuel chart: kilometres, engine hours,
 * the tank's own measured burn, and the rates over both. `getFuelCost` above
 * already answers what went IN and what was drained under the same filter, so
 * this deliberately does not repeat either — the chart joins the two by day.
 *
 * Not `getFuelRateSeries`: that one is floored for a whole yard's denominator
 * (200 km a day) and deletes most of a single unit's history. Measured on the
 * box, a unit clears the tank-balance guards on 11 to 13 days in 30, so expect
 * a gappy series and draw the gaps.
 */
export async function getVehicleFuelDays({ companyId, days = 30, to, categories, vehicles } = {}) {
  const orgId = await resolveOrgId(companyId);
  if (!orgId) return null;
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/analytics/vehicle-fuel-days?days=${days}${anchor(to)}${types(categories)}${units(vehicles)}`
  );
  return res.data ?? null;
}

/**
 * Today on the ground — /analytics/operations-today.
 *
 * A DIFFERENT WINDOW from everything else on the Analytics page: local midnight
 * in the fleet's timezone to now, not the month to date. The card that renders
 * it has to say so, because "4 trucks dispatched" beside "331 completed trips"
 * is two windows wearing the same typeface.
 *
 * Takes no `days`: the window is the fleet day, which is not the caller's to
 * choose. Returns null on an unseeded company, same as the calls above.
 */
export async function getOperationsToday({ companyId, categories, vehicles } = {}) {
  const orgId = await resolveOrgId(companyId);
  if (!orgId) return null;
  // Still takes no `days` — the window is the fleet day, which is not the
  // caller's to choose. The vehicle filter is a different axis and does apply:
  // "today on the ground" for excavators, or for one lorry, is a question worth
  // asking.
  const qs = (types(categories) + units(vehicles)).replace(/^&/, "?");
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/analytics/operations-today${qs}`
  );
  return res.data ?? null;
}

const RANGE_DAYS = { Today: 1, Week: 7, Month: 30 };

const KES_PER_LITRE = 180;

function seedFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function daysForRange(range) {
  return RANGE_DAYS[range] ?? RANGE_DAYS.Week;
}

function trendFor(companyId, range) {
  const fullTrend = ANALYTICS_TREND_BY_COMPANY[companyId] || ANALYTICS_TREND_BY_COMPANY.sukari;
  const n = daysForRange(range);
  return fullTrend.slice(-n);
}

function byCompany(companyId) {
  return companyId ? VEHICLES.filter((v) => v.companyId === companyId) : VEHICLES;
}

export async function getAnalyticsTrend({ companyId, range = "Week" } = {}) {

  const trend = trendFor(companyId, range);

  const fleetSize = byCompany(companyId).length || 1;
  return trend.map((d) => ({
    ...d,
    activeTrips: Math.max(0, Math.round((d.utilizationRate / 100) * fleetSize)),
  }));
}

export async function getAnalyticsSummary({ companyId, range = "Week" } = {}) {
  const trend = trendFor(companyId, range);
  const totalDeliveries = trend.reduce((sum, d) => sum + d.deliveries, 0);
  const totalDistanceKm = trend.reduce((sum, d) => sum + d.distanceKm, 0);
  const avgFuelEfficiency = trend.reduce((sum, d) => sum + d.fuelEfficiency, 0) / trend.length;
  const avgOnTimeRate = trend.reduce((sum, d) => sum + d.onTimeRate, 0) / trend.length;

  return {
    totalDeliveries,
    totalDistanceKm,
    avgFuelEfficiency: Math.round(avgFuelEfficiency * 10) / 10,
    avgOnTimeRate: Math.round(avgOnTimeRate * 10) / 10,
  };
}

export async function getWeeklyKPIs({ companyId, range = "Week" } = {}) {

  const trend = trendFor(companyId, range);
  const vehicles = byCompany(companyId);
  const maintenance = await getMaintenanceSummary({ companyId });

  const speedingEvents = trend.reduce((sum, d) => sum + d.minorSpeeding + d.majorSpeeding, 0);
  const speedingDrivers = new Set(
    vehicles.filter((v) => v.status === "speeding").map((v) => v.driver)
  ).size;

  const theftVehicles = vehicles.filter((v) => v.status === "theft");

  const fuelLossLitres = theftVehicles.length * 24;
  const fuelLossCostKes = fuelLossLitres * KES_PER_LITRE;

  const offlineVehicles = vehicles.filter((v) => v.status === "parked");
  const downCount = offlineVehicles.length;
  const maintCount = maintenance.overdue + maintenance.dueSoon;

  return {
    fuelTheft: { litres: fuelLossLitres, costKes: fuelLossCostKes, openCases: theftVehicles.length },
    speeding: { events: speedingEvents, driversFlagged: speedingDrivers },
    openAlerts: { count: maintCount, criticalCount: maintenance.overdue },
    vehiclesDown: { count: downCount, total: vehicles.length, maintCount: maintenance.overdue, offlineCount: downCount },
  };
}

export async function getFleetStatusBreakdown({ companyId } = {}) {

  const vehicles = byCompany(companyId);
  const maintenance = await getMaintenanceRecords({ companyId });
  const overdueIds = new Set(maintenance.filter((m) => m.status === "overdue").map((m) => m.vehicleId));

  const counts = { active: 0, idle: 0, maintenance: 0, offline: 0 };
  vehicles.forEach((v) => {
    if (overdueIds.has(v.id)) counts.maintenance += 1;
    else if (v.engine === "off") counts.offline += 1;
    else if (v.speed === 0) counts.idle += 1;
    else counts.active += 1;
  });
  return counts;
}

export async function getDriverSafetyProfiles({ companyId } = {}) {

  const profiles = DRIVER_SAFETY_BY_COMPANY[companyId] || DRIVER_SAFETY_BY_COMPANY.sukari;
  return { axes: DRIVER_SAFETY_AXES, profiles };
}

export async function getFleetIncidentKPIs({ companyId, range = "Week" } = {}) {

  const trend = trendFor(companyId, range);
  const totalIncidents = trend.reduce((sum, d) => sum + d.incidents, 0);
  const seed = seedFor(`${companyId || "sukari"}-${range}`);

  const accidents = Math.round(totalIncidents * 0.15) + (seed % 2);
  const diversions = Math.round(totalIncidents * 0.3) + (seed % 3) + 1;

  const withheld = 1 + (seed % 3);

  return { accidents, diversions, withheld };
}

export async function getFuelConsumptionByType({ companyId, range = "Week" } = {}) {

  const vehicles = byCompany(companyId);
  const days = daysForRange(range);

  const AVG_HOURS_PER_DAY = 6;

  const totalsByType = {};
  vehicles.forEach((v) => {
    totalsByType[v.cargo] = (totalsByType[v.cargo] || 0) + v.fuelConsumption;
  });

  const byType = Object.entries(totalsByType)
    .map(([type, litresPerHour]) => ({
      type,
      litres: Math.round(litresPerHour * AVG_HOURS_PER_DAY * days),
    }))
    .sort((a, b) => b.litres - a.litres);

  const total = byType.reduce((sum, t) => sum + t.litres, 0);
  return { total, byType };
}

const TODAY_ISO = "2026-07-03";
const FUEL_THEFT_CASES_BY_COMPANY = {
  sukari: [
    { vehicleId: "KBP 789L", driver: "F. Mwangi",  date: "2026-07-03", litres: 24, action: "Under investigation",        tone: "warn", open: true },
    { vehicleId: "KDC 890F", driver: "M. Njoroge", date: "2026-06-28", litres: 31, action: "Driver suspended",           tone: "bad",  open: false },
    { vehicleId: "KBW 678P", driver: "C. Wambu",   date: "2026-06-22", litres: 18, action: "Resolved: sensor fault",    tone: "good", open: false },
    { vehicleId: "KBV 012M", driver: "G. Wekesa",  date: "2026-06-15", litres: 40, action: "Escalated to management",    tone: "info", open: false },
    { vehicleId: "KDF 123J", driver: "R. Koech",   date: "2026-06-09", litres: 22, action: "Resolved: fuel card audit", tone: "good", open: false },
  ],
};

function daysAgo(dateIso) {
  return Math.round((new Date(TODAY_ISO) - new Date(dateIso)) / 86400000);
}

export async function getFuelTheftCases({ companyId, range = "Week" } = {}) {

  const cases = FUEL_THEFT_CASES_BY_COMPANY[companyId] || FUEL_THEFT_CASES_BY_COMPANY.sukari;
  const days = daysForRange(range);
  const filtered = cases.filter((c) => daysAgo(c.date) < days);

  return filtered.map((c) => ({
    ...c,
    costKes: c.litres * KES_PER_LITRE,
    dateLabel: new Date(c.date).toLocaleDateString("en-KE", { day: "numeric", month: "short" }),
  }));
}
