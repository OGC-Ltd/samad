/**
 * One side panel at a time (operator, 2026-10-20: "whenever we select the
 * notification it override the current side panel ... no cards or modal are
 * to be stacked over the other").
 *
 * The notifications feed, every page's detail sidebar (DetailSidebar), the
 * Drivers panel and the map's own cards and windows all live on or over the
 * right of the screen, and each was opened and closed on its own, so the
 * feed could open on top of an alert's sidebar and the other way round.
 *
 * Whatever opens CLAIMS the space with its own name, and everything else that
 * is open hears the claim and closes. The newest thing asked for wins; nothing
 * is stacked under it. A window event rather than shared state, because the
 * owners are far apart (the header, a page, the map) and each already closes
 * itself; this only tells them when.
 */

const EVENT = "ft-side-panel-claim";

/** Say that `owner` is opening, so everything else closes. */
export function claimSidePanel(owner) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { owner } }));
}

/**
 * Call `close` whenever something other than `owner` claims the space.
 * Returns the unsubscribe, for an effect's cleanup.
 */
export function onSidePanelClaim(owner, close) {
  if (typeof window === "undefined") return () => {};
  const on = (e) => { if (e.detail?.owner !== owner) close(); };
  window.addEventListener(EVENT, on);
  return () => window.removeEventListener(EVENT, on);
}

/**
 * One map window at a time (operator, 2026-10-20: "when I click on the fuel
 * alerts we get the modal fuel alerts and when I click on the arrivals button
 * i get the arrivals modal on the same ui ... the arrivals should have
 * cleared the fuel alerts modal").
 *
 * The map's windows (Units, Halted, Fuel alerts, Arrivals, a fuel alert's
 * incident window, a halted unit's investigation) all float over the map,
 * which the side-panel claim above treats as one owner. This is the same
 * claim one level down: each window claims with its own name and the others
 * close. `keep` names the windows a listener stays open for — the list a
 * window was opened from, so a row clicked in Halted or Fuel alerts still
 * opens its unit's window beside the list.
 */
const MAP_EVENT = "ft-map-window-claim";

/** Say that map window `name` is opening, so the other windows close. */
export function claimMapWindow(name) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MAP_EVENT, { detail: { owner: name } }));
}

/**
 * Call `close(owner)` whenever a map window not named in `keep` claims the
 * map. `keep` is a name or a list of them. Returns the unsubscribe.
 */
export function onMapWindowClaim(keep, close) {
  if (typeof window === "undefined") return () => {};
  const kept = new Set([].concat(keep));
  const on = (e) => { const owner = e.detail?.owner; if (!kept.has(owner)) close(owner); };
  window.addEventListener(MAP_EVENT, on);
  return () => window.removeEventListener(MAP_EVENT, on);
}
