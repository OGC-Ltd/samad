// Searching for a unit that is in another one of your organisations.
//
// An account with several tenants searches the units list from whichever one
// happens to be open. When the unit is not in that one, the honest answer is
// not "no unit matches that search" — it is "that unit is in West Kenya
// Sugar". This hook asks the server that question, and, when the answer is
// unambiguous, moves the dashboard to the organisation holding it.
//
// ## Why it only runs on an EMPTY local result
//
// Switching organisation is a heavy move: it re-seeds the fleet, the feed, the
// tracked selection and the map camera. Doing that while the operator is
// looking at matching rows would yank a list out from under them mid-read. So
// the lookup is a last resort — it fires only once the fleet in front of them
// has nothing to offer, which is the same moment the panel would otherwise
// print "No unit matches that search".
//
// ## Why it does not guess between two organisations
//
// "KDM" can match units in two tenants. Picking one would be a coin toss that
// costs a full org switch to undo, so a split result is LISTED and the operator
// picks. Automatic movement is reserved for the case with exactly one answer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lookupUnits, MIN_LOOKUP_CHARS } from '../api/vehicleLookup'

// Long enough that typing a plate is one request rather than eight, short
// enough that it lands before the operator has finished reading the empty row.
const DEBOUNCE_MS = 350

/**
 * @param {object}  opts
 * @param {string}  opts.query            what is typed in the search box
 * @param {boolean} opts.enabled          false while the local list still matches
 * @param {string}  opts.activeCompanyId  the company on screen
 * @param {Array}   opts.visibleCompanies the companies this account may open
 * @returns {{ hits: Array, companies: Array, loading: boolean }}
 *   `hits` are units in OTHER companies; `companies` is that list grouped, in
 *   the order the switcher shows them.
 */
export function useCrossOrgUnits({ query, enabled, activeCompanyId, visibleCompanies }) {
  const [hits, setHits] = useState([])
  const [loading, setLoading] = useState(false)

  const term = String(query ?? '').trim()
  // Only an account that can open more than one company can be in the wrong
  // one, so a single-tenant operator never pays for this request.
  const multiTenant = (visibleCompanies?.length ?? 0) > 1
  const live = Boolean(enabled) && multiTenant && term.length >= MIN_LOOKUP_CHARS

  useEffect(() => {
    if (!live) { setHits([]); setLoading(false); return undefined }

    let alive = true
    const ac = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      lookupUnits(term, { signal: ac.signal })
        .then(found => { if (alive) { setHits(found); setLoading(false) } })
        // A lookup that fails is a search that found nothing EXTRA. The list
        // the operator is already looking at is unaffected, so this stays
        // silent rather than putting an error over a working panel.
        .catch(() => { if (alive) { setHits([]); setLoading(false) } })
    }, DEBOUNCE_MS)

    return () => { alive = false; ac.abort(); clearTimeout(timer) }
  }, [live, term])

  // Hits in the company already open are not news — the local list has them,
  // or the operator has filtered them away with the fleet-type funnel.
  const foreign = useMemo(
    () => hits.filter(h => h.companyId !== activeCompanyId),
    [hits, activeCompanyId],
  )

  const companies = useMemo(() => {
    const allowed = new Map((visibleCompanies ?? []).map(c => [c.id, c]))
    const byCompany = new Map()
    for (const hit of foreign) {
      // A membership the server knows about but this dashboard does not show
      // has nowhere to switch to.
      const company = allowed.get(hit.companyId)
      if (!company) continue
      const bucket = byCompany.get(company.id) ?? { company, units: [] }
      bucket.units.push(hit)
      byCompany.set(company.id, bucket)
    }
    return [...byCompany.values()]
  }, [foreign, visibleCompanies])

  return { hits: foreign, companies, loading }
}

/**
 * The same search, plus the move.
 *
 * When exactly one other company holds the unit, this switches to it and asks
 * the map to focus the unit once that company's fleet has loaded.
 *
 * The move ANNOUNCES ITSELF and needs no caption: the header carries the new
 * organisation's name and vehicle count, the map re-frames on the unit, and
 * the list the operator was looking at fills with the matching rows. A notice
 * sat over that saying the same thing in words — and stayed there while they
 * read the results it was describing.
 *
 * @returns {{ companies: Array, loading: boolean, move: Function }}
 */
export function useCrossOrgUnitHandoff({
  query, enabled, activeCompanyId, visibleCompanies, setActiveCompanyId, setPendingFocusId,
}) {
  const { companies, loading } = useCrossOrgUnits({ query, enabled, activeCompanyId, visibleCompanies })

  // What we have already acted on. Without this the switch re-fires every time
  // the lookup re-resolves — and since switching changes `activeCompanyId`,
  // that is a loop between two tenants rather than a one-off move.
  const actedOn = useRef(null)
  const term = String(query ?? '').trim()

  useEffect(() => {
    if (!term) actedOn.current = null
  }, [term])

  // One move, however it was decided — automatically below, or by the operator
  // clicking one of the organisations offered when the answer was ambiguous.
  const move = useCallback((company, unit) => {
    if (!company || !unit) return
    actedOn.current = `${term}→${company.id}`
    setActiveCompanyId?.(company.id)
    // The plate, not the cuid: FleetMap matches either, and the plate is what
    // the operator can see is being focused.
    setPendingFocusId?.(unit.plate)
  }, [term, setActiveCompanyId, setPendingFocusId])

  useEffect(() => {
    if (!enabled || loading || companies.length !== 1) return
    const { company, units } = companies[0]
    if (!units[0]) return
    if (actedOn.current === `${term}→${company.id}`) return
    move(company, units[0])
  }, [enabled, loading, companies, term, move])

  return { companies, loading, move }
}
