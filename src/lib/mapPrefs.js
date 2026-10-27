/**
 * What the map looks like, per organisation.
 *
 * Two operators' worth of state used to live in one place each: the site plan's
 * visibility in a single global key, the other layers in nothing at all (forced
 * off on every org switch), and the status filter in component state that
 * simply carried across. So arriving at an organisation showed you the LAST
 * organisation's narrowing — "moving only", chosen on a fleet of 800, silently
 * applied to a fleet of 20 — and the layers you had open on a site were shut.
 *
 * Every one of these is an answer to "what do I want to see at THIS place", and
 * places differ. They are keyed by company accordingly, and a company you have
 * never opened gets its own sensible default rather than the last one's state.
 *
 * ## Defaults are per company, because the layers are
 *
 * A layer is offered by the map only where it has something to draw, and where
 * it is the main thing to look at it should already be on: Mufindi's estate
 * areas ARE the map of Mufindi, and the Kabras survey is the map of Kabras.
 * The weighbridges are not — they are six pins inside a national fleet and a
 * genuine "take me there", so they stay off until asked for.
 *
 * ## Storage is best-effort, and a bad value is not a broken map
 *
 * A stored preference is a convenience. Anything unreadable, of the wrong
 * shape, or naming a layer this build no longer has falls back to the default
 * rather than propagating: the map is the product, and it must draw.
 */

import { readCache, writeCache } from "../services/cache";

const key = (companyId) => `ft-map-prefs:${companyId}`;

/**
 * Every layer this module remembers. A key absent from a stored blob takes its
 * default; a key present that is not here is discarded.
 *
 * `site` is the ORIGINAL works-site key, from when an organisation could have
 * at most one survey. It still means exactly what it meant — Kabras on West
 * Kenya, the plant on Sukari — so every preference stored before the map could
 * carry more than one keeps working. Surveys added since are namespaced by the
 * place they draw. Which key a survey uses is declared next to it, in
 * FleetMap's SITE_PLANS.
 *
 * The alternative was one key per survey with a migration reading the old one.
 * It would read better and it would cost someone their setting the first time
 * the migration was wrong, for no gain an operator can see.
 */
export const LAYERS = [
  "plan", "site", "bridges", "zones",
  "traffic",       // Google live traffic, any org
  "weather",       // Google current weather, any org; off until asked for
  "site:nzoia",    // Nzoia's survey while it sat under West Kenya; kept so old blobs still read
  "site:naitiri",  // and the sugar factory the lorries load at
  "site:raiply",   // and where that sugar is taken
  "site:bigfarm",  // Menengai's estate
  "site:molo",     // and the river beside it
  "site:oyani",    // Sukari's two out-centres, the cane end of the same run
  "site:nyaondo",
];

/** The status chips. `all` is the absence of a narrowing, not a state. */
export const DEFAULT_FILTER = "all";

/**
 * The layers a company opens with.
 *
 * Only the ones that are ON are listed — everything else defaults off. Keyed by
 * the company slug rather than by the layer, because the question being
 * answered is "what is the map of this place".
 */
export const LAYER_DEFAULTS = {
  // The surveyor's planting plan. The "Estate areas" layer was removed
  // 2026-10-20, so the plan is the one map of the place and opens on.
  kasulu:    { plan: true },
  // Each mill opens on its own survey, as Sukari does on its plant. They were
  // one org until 2026-10-07, when only Kabras could open on (two default-on
  // surveys 29 km apart would race for the camera); as organisations of their
  // own each has one survey and nothing to race. West Kenya keeps Naitiri and
  // Raiply, off until asked for.
  kabras:    { site: true },
  nzoia:     { site: true },
  // The Ndhiwa plant's survey, on for the same reason and with an extra one:
  // this org already opens ON the plant — half its located units sit within
  // 600 m of it — so the layer's camera fit frames the ground the map was
  // going to show anyway, rather than flying away from the fleet to find it.
  sukari:    { site: true },
  // Menengai has two surveys and neither is listed: this is an oil refinery
  // with a national fleet, and Big Farm is one estate inside it. The map of
  // Menengai is the fleet. Both layers are offered, both are off until asked
  // for — the same rule the weighbridges have always had.
};

const offAll = () => Object.fromEntries(LAYERS.map(l => [l, false]));

/** What a company looks like before anyone has touched it. */
export function defaultPrefs(companyId) {
  return {
    filter: DEFAULT_FILTER,
    // Live traffic is on everywhere until switched off (operator, 2026-10-04:
    // "I still don't see the changes" with it defaulting off).
    layers: { ...offAll(), traffic: true, ...(LAYER_DEFAULTS[companyId] ?? {}) },
  };
}

/**
 * The stored preferences for one company, merged over its defaults.
 *
 * Merged rather than returned raw so a build that ADDS a layer does not have to
 * migrate anyone: the new key is simply absent from every stored blob and takes
 * its default until someone touches it.
 */
export function readMapPrefs(companyId) {
  const base = defaultPrefs(companyId);
  if (!companyId) return base;

  const raw = readCache(key(companyId));
  if (!raw || typeof raw !== "object") return base;

  const layers = { ...base.layers };
  if (raw.layers && typeof raw.layers === "object") {
    for (const l of LAYERS) {
      if (typeof raw.layers[l] === "boolean") layers[l] = raw.layers[l];
    }
  }
  return {
    filter: typeof raw.filter === "string" && raw.filter ? raw.filter : base.filter,
    layers,
  };
}

/**
 * Merge a change in and store it. Returns the merged result, so a caller can
 * use what was written rather than re-reading.
 *
 * A patch, not a replacement: the filter chips and the layer switches are
 * different controls on different parts of the screen, and neither should have
 * to know the other's current value to save its own.
 */
export function writeMapPrefs(companyId, patch = {}) {
  const current = readMapPrefs(companyId);
  const next = {
    filter: typeof patch.filter === "string" && patch.filter ? patch.filter : current.filter,
    layers: { ...current.layers },
  };
  if (patch.layers) {
    for (const l of LAYERS) {
      if (typeof patch.layers[l] === "boolean") next.layers[l] = patch.layers[l];
    }
  }
  if (companyId) writeCache(key(companyId), next);
  return next;
}
