/**
 * The works-site surveys, as a table: which organisation has which, where the
 * file is, and what camera it wants.
 *
 * Lifted out of FleetMap because it is no longer only FleetMap's. A vehicle
 * can stand inside a survey belonging to an organisation OTHER than the one
 * the operator has open — a West Kenya lorry unloading at Raiply, a Sukari
 * tractor on a neighbour's weighbridge — and lib/guestSitePlans has to be able
 * to test every survey on the platform against this fleet, not just the ones
 * this tenant owns. Two copies of this table would be one place for a new
 * survey to be added and another for it to be forgotten.
 */

// ── works-site plans ───────────────────────────────────────────────────────
//
// A site's own survey, keyed by company: a list of { id, prefKey, url, label,
// fit?, pointMinZoom? } rows, each a GeoJSON file in public/. Samad has none
// yet; a new survey is a row here and a file in public/.
export const SITE_PLANS = {};

/** Stable empty list, so an org with no survey does not hand every memo and
 *  effect below a brand-new array on each render. */
export const NO_PLANS = [];

/**
 * Every survey on the platform, flat, each carrying the organisation that owns
 * it.
 *
 * The lookup the guest layer needs and the per-company table cannot give: "is
 * this point inside ANY surveyed site" is a question about the whole platform,
 * and the answer has to name the owner or the layer cannot say whose yard the
 * unit is standing in.
 */
export const ALL_SITE_PLANS = Object.entries(SITE_PLANS).flatMap(
  ([companyId, plans]) => plans.map((plan) => ({ ...plan, companyId })));

