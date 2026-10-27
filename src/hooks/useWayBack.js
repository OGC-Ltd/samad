/**
 * Where "back" goes from a full-screen overlay, and what to call it.
 *
 * ## The question this answers
 *
 * The account page and the user-accounts page are both overlays reached from
 * the avatar menu, and both need a way out. "Out" used to be spelled "the
 * fleet" on each of them, hard-coded — which is wrong for anybody who cannot
 * open the fleet. The Live Map is a permission like any other (`map:read`),
 * and an account holding only `sensor:read` has no map to go back to: the
 * button named a screen it could not deliver, then dropped the reader on
 * whichever tab was last stored, which App promptly corrected to a third
 * place. A control that names one destination and produces another is worse
 * than no control.
 *
 * ## Why it is shared
 *
 * Two surfaces asking the same question two ways is how they come to disagree.
 * The destination is resolved here exactly once, the same way App resolves its
 * own allowed-tab set — NAV_ITEMS in sidebar order, graded by `accessIn`
 * against the organisation currently on screen — so "the first thing you can
 * open" means the same thing in the sidebar, in App's correction effect, and
 * on every way out.
 *
 * ## Two labels, one destination
 *
 * `label` is a sentence for a button ("Back to the fleet"); `crumb` is a name
 * for a breadcrumb ("Fleet"). The same place, in the two voices the two
 * surfaces already speak — the account page's control is a link that says what
 * it does, and the user-accounts control is an ancestor in a trail. Returning
 * both beats each caller re-deriving the wording and drifting.
 *
 * The Live Map keeps the fleet wording it has always had: "Back to Live Map"
 * is the nav item's name, not what an operator calls the screen.
 *
 * ## What it does NOT do
 *
 * It does not close anything. Each overlay owns its own open flag, so `go()`
 * only moves the tab underneath and the caller composes its own close. An
 * account with no screen permission at all is a real state — a member of an
 * organisation with no grants — and there `tab` is null, `go()` is a no-op and
 * the label falls back to a bare "Back": there is nowhere to name, App draws
 * the locked empty state with its own cross-tenant way out, and promising a
 * destination here would be the same lie in a new place.
 */

import { useCallback, useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import { useAppSelector, useAppActions } from "../context/AppContext";
import { accessIn } from "./usePermissions";
import { NAV_ITEMS } from "../components/layout/SidePanel";

/** Sentence form, for a control that has to say what it does. */
export function labelFor(item) {
  return item.key === "fleet" ? "Back to the fleet" : `Back to ${item.label}`;
}

/** Name form, for a crumb sitting in a trail of ancestors. */
export function crumbFor(item) {
  return item.key === "fleet" ? "Fleet" : item.label;
}

/**
 * The destination, as a pure function.
 *
 * `items` is a parameter rather than a closed-over NAV_ITEMS so this can be
 * tested without importing SidePanel — vitest runs `environment: 'node'` here,
 * and pulling a component in to reach a constant would drag its whole module
 * graph and its stylesheet into a unit test.
 *
 * @param {Array<{key: string, label: string, permission: string}>} items
 * @param {(permission: string) => boolean} can
 */
export function resolveWayBack(items, can) {
  const first = (items ?? []).find((t) => can(t.permission)) ?? null;
  if (!first) return { tab: null, label: "Back", crumb: "Back" };
  return { tab: first.key, label: labelFor(first), crumb: crumbFor(first) };
}

/**
 * @returns {{ tab: string|null, label: string, crumb: string, go: () => void }}
 */
export function useWayBack() {
  const { orgs } = useAuth();
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const { setDesktopActiveTab } = useAppActions();

  const access = useMemo(
    () => accessIn(orgs, activeCompanyId),
    [orgs, activeCompanyId],
  );

  const wayBack = useMemo(() => resolveWayBack(NAV_ITEMS, access.can), [access]);

  const go = useCallback(() => {
    if (wayBack.tab) setDesktopActiveTab(wayBack.tab);
  }, [wayBack, setDesktopActiveTab]);

  return { ...wayBack, go };
}
