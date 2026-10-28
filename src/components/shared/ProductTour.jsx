// The first-time tour, drawn by driver.js. What it says and to whom is in
// lib/productTour; this mounts it once in the app shell, starts it for a
// person who has not seen it, and runs it again from the account menu.

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "./ProductTour.scss";
import { useAppFields, useAppActions, useAppSelector, useCompanies } from "../../context/AppContext";
import { authKeys, useAuth } from "../../context/AuthContext";
import { recordTourSeen } from "../../api/account";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { usePermissions } from "../../hooks/usePermissions";
import {
  TOUR_VERSION, accountBehind, buildTourSteps, claimFirstRun, coveredItems,
  markCovered, onTourRequest, tourDue, visibleMark,
} from "../../lib/productTour";

/** After the fleet has drawn, so the status cards show figures and not dashes;
 *  never longer than this, so a slow snapshot does not keep the tour away. */
const FIRST_RUN_MAX_WAIT_MS = 6000;
const FIRST_RUN_SETTLE_MS = 900;

export default function ProductTour() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const { activeCompany, companies } = useCompanies();
  const { loading } = useFleetLiveShared();
  const { desktopActiveTab } = useAppFields("desktopActiveTab");
  const overlayOpen = useAppSelector((a) => a.accountOpen || a.userAdminOpen);
  const { setDesktopActiveTab, setAccountOpen, setUserAdminOpen } = useAppActions();

  const canMap = can("map:read");
  // The latest of everything, for a start that runs from a timer or an event.
  const live = useRef({});
  live.current = { user, can, canMap, activeCompany, companies, desktopActiveTab, overlayOpen, setDesktopActiveTab, setAccountOpen, setUserAdminOpen };

  const tourRef = useRef(null);

  const drive = useCallback((steps) => {
    if (!steps.length) return;
    const tour = driver({
      steps,
      popoverClass: "ft-tour",
      showProgress: true,
      progressText: "{{current}} of {{total}}",
      nextBtnText: "Next",
      prevBtnText: "Back",
      doneBtnText: "Done",
      stagePadding: 6,
      stageRadius: 10,
      overlayOpacity: 0.5,
      smoothScroll: true,
      // The highlighted control is shown, not live: a click on a sidebar item
      // mid-tour would change the screen out from under the next step.
      disableActiveInteraction: true,
      // A stray click on the dimmed page must not end a first-timer's tour;
      // the close button and Esc still do.
      overlayClickBehavior: () => {},
      // Covered as it is shown, so another page does not explain it again
      // (lib/productTour, items already covered).
      onHighlighted: (_el, step) => markCovered(live.current.user?.id, step?.key),
      onDestroyed: () => { tourRef.current = null; },
    });
    tourRef.current = tour;
    tour.drive();
  }, []);

  const start = useCallback(({ replay = false } = {}) => {
    if (tourRef.current?.isActive()) return;
    const c = live.current;
    // The tour runs on the home page alone (operator, 2026-10-20: "remove
    // driver.js from all other pages except the home page"). The pages'
    // own tours (lib/productTour PAGE_TOURS) are no longer started; Guide
    // from any page takes the person to the map and runs it there.
    // Most of the tour is about the map, so it runs on the map — and over
    // nothing: the Account and User accounts pages open on top of the app.
    const moving = c.canMap && c.desktopActiveTab !== "fleet";
    if (moving) c.setDesktopActiveTab("fleet");
    if (c.overlayOpen) { c.setAccountOpen?.(false); c.setUserAdminOpen?.(false); }

    // Measured after the switch has laid out, because which steps survive
    // depends on what is on screen.
    setTimeout(() => {
      const now = live.current;
      const steps = buildTourSteps({
        can: now.can,
        firstName: (now.user?.fullName || now.user?.name || "").trim().split(/\s+/)[0] ?? "",
        orgName: now.activeCompany?.name ?? "",
        multiOrg: (now.companies?.length ?? 0) > 1,
        visible: (mark) => visibleMark(mark),
        covered: replay ? new Set() : coveredItems(now.user?.id),
      });
      drive(steps);
    }, moving ? 350 : 60);
  }, [drive]);

  // The tour version this person's account has been shown, from /auth/me:
  // null for never, undefined from a server that does not keep it.
  const accountVersion = user?.tourSeenVersion;
  const queryClient = useQueryClient();
  const tellAccount = useCallback(() => {
    recordTourSeen(TOUR_VERSION)
      .then((v) => queryClient.setQueryData(authKeys.me, (me) => (
        me?.user ? { ...me, user: { ...me.user, tourSeenVersion: v } } : me
      )))
      // This browser's own record stands; accountBehind tries again at the
      // next sign-in.
      .catch(() => {});
  }, [queryClient]);

  // First run: once per person on any machine, when the app has something to
  // show. Recorded as it opens, not as it closes (claimFirstRun).
  const startedFor = useRef(null);
  useEffect(() => {
    const id = user?.id;
    if (!id || startedFor.current === id || !tourDue(id, accountVersion)) return undefined;
    if (!activeCompany?.id || overlayOpen) return undefined;
    const ready = !canMap || !loading;
    const t = setTimeout(() => {
      startedFor.current = id;
      if (!claimFirstRun(id, accountVersion)) return;
      if (accountVersion !== undefined) tellAccount();
      start();
    }, ready ? FIRST_RUN_SETTLE_MS : FIRST_RUN_MAX_WAIT_MS);
    return () => clearTimeout(t);
  }, [user?.id, accountVersion, activeCompany?.id, overlayOpen, canMap, loading, start, tellAccount]);

  // Seen in this browser before the account kept it, or the save failed: tell
  // the account now, or every other machine shows it again.
  useEffect(() => {
    if (user?.id && accountBehind(user.id, accountVersion)) tellAccount();
  }, [user?.id, accountVersion, tellAccount]);

  // Again, from the account menu.
  useEffect(() => onTourRequest(() => start({ replay: true })), [start]);

  // Signed out or unmounted mid-tour: take the overlay with it.
  useEffect(() => () => { tourRef.current?.destroy(); }, []);

  return null;
}
