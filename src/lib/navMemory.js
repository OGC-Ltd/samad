/**
 * Where the user was, so a refresh puts them back there.
 *
 * Every screen in this app is a piece of state rather than a URL — there is no
 * router — so nothing about where you are survives a reload on its own. Each
 * navigation choice has to be written down deliberately, and this is the one
 * place that knows how.
 *
 * ## Two lifetimes, and the difference is the whole point
 *
 * `restoreChoice` / `persistChoice` are DURABLE: localStorage, so a choice
 * outlives the tab and the machine being turned off. That is right for the
 * screen somebody works in — a technician who lives in Malfunction should open
 * the app in Malfunction next week, not be walked back to Probes every Monday.
 *
 * `restoreOverlay` / `persistOverlay` are SESSION-scoped: sessionStorage, so a
 * choice survives a reload and dies with the tab. That is right for the pages
 * that sit OVER the app — Account and User Accounts. Those were deliberately
 * not remembered at all, on the reasoning that coming back tomorrow should
 * land you on the fleet rather than on your own settings. The reasoning is
 * right and is kept; what it did not separate is the case people actually hit,
 * because a refresh is not coming back tomorrow. Reloading the roster after
 * sending an invite dropped the administrator onto the map, and made them
 * navigate back through the avatar menu to the screen they were already on.
 *
 * sessionStorage draws exactly that line by itself, with no timestamp to pick
 * and no staleness window to argue about.
 *
 * ## Every read is wrapped, and that is not defensive padding
 *
 * Storage access THROWS rather than returning null where storage is
 * unavailable — Safari private browsing, some enterprise policies. These run
 * inside useState initialisers, so an exception here takes the whole dashboard
 * down at boot. Forgetting a tab is the acceptable failure; not starting is
 * not.
 *
 * ## Restoring is not authorising
 *
 * A restored choice says where somebody resumes, never what they may open.
 * `restoreChoice` takes an allow-list so a key this build no longer has falls
 * back rather than reaching a `find` that returns undefined, and every caller
 * grades the restored value against the current permissions afterwards —
 * App.jsx for the nav tabs, SensorPanel for its tab strip, UserAdminGate for
 * the roster. This module widens nothing.
 */

/** The value last saved under `key`, if it is still one we recognise. */
export function restoreChoice(key, allowed, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return allowed.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

/** Save a choice, ignoring a storage that refuses to hold it. */
export function persistChoice(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable or full — the app works, it just won't remember */
  }
}

/** Whether an overlay page was open, for THIS TAB only. */
export function restoreOverlay(key) {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * Save an overlay's state for this tab.
 *
 * Written on CLOSE as well as on open. A stored "1" that nothing ever clears
 * would reopen the page on every reload for the rest of the session, which is
 * a worse bug than the one this fixes.
 */
export function persistOverlay(key, open) {
  try {
    sessionStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* storage unavailable or full — the app works, it just won't remember */
  }
}
