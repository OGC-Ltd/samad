/**
 * User accounts, as a full screen.
 *
 * ## Why it is not a Maintenance sub-tab any more
 *
 * It used to be `MaintenanceScreen`'s third view, gated on `user:create` — so
 * the roster of PEOPLE lived inside the tab about servicing VEHICLES, and the
 * only way to find it was to already know that the Maintenance tab grew an
 * extra sub-tab when you happened to be an admin. It is reached from the
 * avatar menu now, beside Account: both answer "who can use this dashboard".
 *
 * ## The shell, and what it owes UserAdminPanel
 *
 * AccountScreen's back control, so the two pages the avatar menu opens are
 * recognisably one pair. The difference is below it: this page SCROLLS as a
 * whole (`.uadm-page__body`), because the panel is one column of cards rather
 * than AccountScreen's two independent ones.
 *
 * The bar carries ONLY the way out. It had a title and a strapline for about
 * one revision; they went because the page announces itself perfectly well
 * without them — you arrive by clicking "User accounts" in the avatar menu,
 * and the panel's own first line already reads "N people · <org>", which says
 * the same thing while also being a fact. A heading that repeats the control
 * you just clicked is a row of pixels spent on nothing.
 *
 * The panel itself is unchanged and still carries no title of its own.
 * `--maint-gutter` is redeclared on the body because the panel's padding is
 * written against that token — it used to come from the Maintenance scroller.
 */

import { useCallback, useEffect, useState } from "react";
import { useAppActions } from "../../context/AppContext";
import { useAuth } from "../../context/AuthContext";
import { usePermissions } from "../../hooks/usePermissions";
import { useWayBack } from "../../hooks/useWayBack";
import ErrorBoundary from "../shared/ErrorBoundary";
import UserAdminPanel from "../body/UserAdminPanel";
import UserGroupsPanel from "../body/UserGroupsPanel";
import "./UserAdminScreen.css";

export default function UserAdminScreen() {
  const { setUserAdminOpen } = useAppActions();
  const { orgs } = useAuth();
  const { canIn } = usePermissions();
  const [section, setSection] = useState("users");
  const canViewGroups = (orgs ?? []).some((org) => canIn(org.id, "user:read"));

  /* The crumb used to read "← Fleet" and only close, which was wrong twice
     over for an administrator without `map:read`: it named a screen they
     cannot open, and closing dropped them on whichever tab was stored rather
     than on the one it had just promised. Resolved by the same hook the
     account page uses, so both ways out agree — and the crumb takes the NAME
     form ("Fleet", "Maintenance") because it sits in a trail of ancestors
     rather than being a sentence about what it does. */
  const wayBack = useWayBack();

  const goBack = useCallback(() => {
    wayBack.go();
    setUserAdminOpen(false);
  }, [wayBack, setUserAdminOpen]);

  // Escape leaves the same way the crumb does, the contract AccountScreen
  // states — the key and the control must not land in different places.
  useEffect(() => {
    const onKey = (e) => {
      /* A dialog over this page gets the key first. The Add-user panel listens
         in the capture phase and calls preventDefault; without this check the
         same Escape would dismiss the panel AND leave the roster, which is one
         keystroke doing two things the person only asked for one of. */
      if (e.defaultPrevented) return;
      if (e.key === "Escape") goBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [goBack]);

  return (
    <div className="uadm-page">
      {/* The Maintenance tab's orientation strip, and for the same reason it
          exists there: with no page title below it, this is the only thing on
          screen that says where you are. The difference is that the first
          crumb here is a real ancestor you can click — Maintenance IS its own
          tab, so its crumb has nowhere to go, while this page is an overlay
          over the fleet and going back is the whole of the way out. */}
      <header className="uadm-page__bar">
        <nav className="uadm-crumbs" aria-label="Breadcrumb">
          <ol className="uadm-crumbs__list">
            <li className="uadm-crumbs__item">
              <button type="button" className="uadm-page__back" onClick={goBack}>
                ← {wayBack.crumb}
              </button>
            </li>
            <li className="uadm-crumbs__item uadm-crumbs__item--current" aria-current="page">
              Users
            </li>
          </ol>
        </nav>
      </header>

      <div className="uadm-page__body">
        {canViewGroups && (
          <nav className="uadm-sections" aria-label="User administration">
            <button type="button" className={section === "users" ? "uadm-sections__item uadm-sections__item--active" : "uadm-sections__item"}
                    aria-current={section === "users" ? "page" : undefined}
                    onClick={() => setSection("users")}>
              Users
            </button>
            <button type="button" className={section === "groups" ? "uadm-sections__item uadm-sections__item--active" : "uadm-sections__item"}
                    aria-current={section === "groups" ? "page" : undefined}
                    onClick={() => setSection("groups")}>
              Groups
            </button>
          </nav>
        )}
        <ErrorBoundary label={section === "groups" ? "User groups" : "Users"} fullSection>
          {section === "groups" && canViewGroups ? <UserGroupsPanel /> : <UserAdminPanel />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
