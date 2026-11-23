// Road Safety Compliance's server routes (server/compliance.go): the period's
// requirements as the system measures them, and the same on the reports'
// letterhead for Export PDF (drawn by the reports' render route, api/reportDocs).

import { apiFetch } from "../services/api";
import { downloadReport } from "./reportDocs";

const ORG = "samad";

const query = (from, to) => new URLSearchParams({ org: ORG, from: String(Math.round(from)), to: String(Math.round(to)) });

/** @returns {Promise<{ from: string, to: string, units: number, monitoredSince: string|null, rows: object[] }|null>} */
export async function fetchCompliance({ from, to }, { signal } = {}) {
  const res = await apiFetch(`/api/v1/compliance?${query(from, to)}`, signal ? { signal } : undefined);
  return res?.data ?? null;
}

/** Saves the period as a PDF on the reports' letterhead. */
export async function downloadCompliancePdf({ from, to }) {
  const res = await apiFetch(`/api/v1/compliance/document?${query(from, to)}`);
  if (!res?.data) throw new Error("The report could not be made");
  await downloadReport(res.data, "pdf");
}
