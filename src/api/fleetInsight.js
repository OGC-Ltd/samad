

// AI fleet insight summary text.
//
// Primary source: the server's /dashboard/ai-insight endpoint — a real
// OpenAI-generated brief over the org's live drivers/deliveries/maintenance
// data. While no OPENAI_API_KEY is configured server-side (or on any error)
// we fall back to the local heuristic summary below, so the panel always
// renders.

import { getFleetStatusCounts } from "./vehicles";
import { getMaintenanceSummary } from "./maintenance";
import { apiFetch } from "../services/api";
import { resolveOrgId } from "./org";

export async function getFleetInsight({ companyId } = {}) {
  try {
    const orgId = await resolveOrgId(companyId);
    if (orgId) {
      const res = await apiFetch(`/api/v1/organisations/${orgId}/dashboard/ai-insight`);
      if (res.data?.insight?.msg) return res.data.insight;
    }
  } catch { /* fall through to the local summary */ }
  return buildLocalInsight({ companyId });
}

async function buildLocalInsight({ companyId } = {}) {
  const [statusCounts, maintenance] = await Promise.all([
    getFleetStatusCounts({ companyId }),
    getMaintenanceSummary({ companyId }),
  ]);

  const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const activePct = total > 0 ? Math.round((statusCounts.ok / total) * 100) : 0;

  const parts = [];
  parts.push(`${activePct}% of the fleet is operating normally.`);

  if (statusCounts.warning > 0) {
    parts.push(`${statusCounts.warning} vehicle${statusCounts.warning === 1 ? " is" : "s are"} currently flagged for speeding.`);
  }
  if (statusCounts.critical > 0) {
    parts.push(`${statusCounts.critical} vehicle${statusCounts.critical === 1 ? " needs" : "s need"} immediate attention.`);
  }
  if (maintenance.overdue > 0) {
    parts.push(`${maintenance.overdue} vehicle${maintenance.overdue === 1 ? " has" : "s have"} overdue maintenance, review the Maintenance tab.`);
  } else if (maintenance.dueSoon > 0) {
    parts.push(`${maintenance.dueSoon} vehicle${maintenance.dueSoon === 1 ? " is" : "s are"} due for service soon.`);
  }

  const risk = statusCounts.critical > 0 ? "High" : statusCounts.warning > 0 || maintenance.overdue > 0 ? "Medium" : "Low";

  // No unit ratio: the card renders the text alone, and the server's brief
  // carries the same shape, so a field only this fallback sets would be dead.
  // `local` so the card can say it is a summary, not an AI brief: this runs
  // whenever the server has none, including while OpenAI refuses the key.
  return { msg: parts.join(" "), risk, local: true };
}
