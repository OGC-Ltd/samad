// "Which of my companies is this unit in?"
//
// Every other fleet read is scoped to the company on screen, which is right for
// every screen and wrong for a SEARCH: an operator who holds three tenants does
// not know which one a plate lives in before they look, and asking Sukari for a
// West Kenya truck can only answer "no such unit" — which is false.
//
// `/api/v1/vehicle-lookup` spans the caller's memberships and returns identity
// only. The server decides what is reachable; nothing here widens it.

import { apiFetch } from '../services/api'
import { ORG_CODE_BY_COMPANY } from './org'

// Backend org `code` → fleettrack company slug. Derived from the forward map so
// the two can never drift apart.
const COMPANY_BY_ORG_CODE = Object.fromEntries(
  Object.entries(ORG_CODE_BY_COMPANY).map(([companyId, code]) => [code, companyId]),
)

/** Below this a query matches half a fleet; the server refuses it too. */
export const MIN_LOOKUP_CHARS = 2

/**
 * Units matching `q` across every organisation this account may read.
 *
 * Hits in organisations this dashboard has no company for are dropped: there
 * would be nowhere to switch to, so listing them would offer an answer that
 * cannot be acted on.
 *
 * @returns {Promise<Array<{vehicleId: string, plate: string, name: string|null,
 *   type: string, orgId: string, orgCode: string, orgName: string,
 *   companyId: string}>>}
 */
export async function lookupUnits(q, { signal } = {}) {
  const term = String(q ?? '').trim()
  if (term.length < MIN_LOOKUP_CHARS) return []

  const res = await apiFetch(`/api/v1/vehicle-lookup?q=${encodeURIComponent(term)}`, { signal })
  return (Array.isArray(res?.data) ? res.data : [])
    .map(hit => ({ ...hit, companyId: COMPANY_BY_ORG_CODE[String(hit?.orgCode ?? '').toUpperCase()] ?? null }))
    .filter(hit => hit.companyId && hit.plate)
}
