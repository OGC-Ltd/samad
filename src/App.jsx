// Root layout — new sidebar shell.
// All tab routing, screen rendering, auth and server wiring unchanged.
// Real authentication: login, set-password links, account and user admin.

import React, { useEffect, useMemo, useState } from 'react';
import './App.css';
import { AppProvider, useAppFields, useAppActions, useCompanies, useAppSelector } from './context/AppContext';
import { useSelector } from 'react-redux';
import { AuthProvider, useAuth } from './context/AuthContext';
import { FleetLiveProvider, useFleetLiveShared } from './context/FleetLiveContext';
import { usePermissions, accessIn } from './hooks/usePermissions';
import { NAV_ITEMS } from './components/layout/SidePanel';
import ErrorBoundary from './components/shared/ErrorBoundary';
import TabEmptyState from './components/shared/TabEmptyState';
import ProductTour from './components/shared/ProductTour';

// New layout components
import AppHeader          from './components/layout/AppHeader';
import SidePanel          from './components/layout/SidePanel';
import MobileTabBar       from './components/layout/MobileTabBar';
import MobileHeader       from './components/layout/MobileHeader';
import MobileLiveFeedSheet   from './components/layout/MobileLiveFeedSheet';
import MobileCompanyProfile  from './components/layout/MobileCompanyProfile';
import VehicleDetailPanel    from './components/layout/VehicleDetailPanel';
import MobileSearchTray   from './components/layout/MobileSearchTray';

// Screens — unchanged from original
import FleetMap          from './components/body/FleetMap';
import DriversScreen     from './components/screens/DriversScreen';
import AlertsScreen      from './components/screens/AlertsScreen';
import DashcamIncidentsScreen from './components/screens/DashcamIncidentsScreen';

// Auth + account screens
import LoginScreen       from './components/screens/LoginScreen';
import SetPasswordScreen from './components/screens/SetPasswordScreen';
import AccountScreen     from './components/screens/AccountScreen';
import UserAdminScreen   from './components/screens/UserAdminScreen';
import { readSetupToken } from './lib/setupLink';
import { claimSidePanel, onSidePanelClaim } from './lib/sidePanels';

function AppShell() {
  const { activeCompanyId, previousCompanyId, desktopActiveTab, selectedVehicleId } = useAppFields("activeCompanyId", "previousCompanyId", "desktopActiveTab", "selectedVehicleId");
  const { setActiveCompanyId, setDesktopActiveTab, setSelectedVehicleId } = useAppActions();
  const { activeCompany, companies } = useCompanies();

  const { can } = usePermissions();
  const { vehicles: _liveVehicles = [] } = useFleetLiveShared();
  const [mobileFeedOpen,    setMobileFeedOpen]    = useState(false);
  // The phone's notifications sheet closes when anything else opens (lib/sidePanels).
  useEffect(() => onSidePanelClaim('feed', () => setMobileFeedOpen(false)), []);
  const [mobileSearchOpen,  setMobileSearchOpen]  = useState(false);
  const [mobileProfileOpen, setMobileProfileOpen] = useState(false);
  const { orgs } = useAuth();

  // Tab title: the organisation's name, "Samad Resources" on sign-out.
  useEffect(() => {
    document.title = activeCompany?.name ?? 'Samad Resources';
    return () => { document.title = 'Samad Resources'; };
  }, [activeCompany?.name]);

  // Keep allowed-tab guard identical to original
  const allowedTabs = NAV_ITEMS.filter(t => can(t.permission));
  const tabAllowed  = allowedTabs.some(t => t.key === desktopActiveTab);

  useEffect(() => {
    if (!tabAllowed && allowedTabs.length > 0) {
      setDesktopActiveTab(allowedTabs[0].key);
    }
  }, [tabAllowed, allowedTabs, setDesktopActiveTab]);

  // Way-out logic for empty-permission orgs — identical to original
  const wayOut = useMemo(() => {
    const opensSomething = (companyId) => {
      const { can: canThere } = accessIn(orgs, companyId);
      return NAV_ITEMS.some(t => canThere(t.permission));
    };
    const back = companies.find(
      c => c.id === previousCompanyId && c.id !== activeCompanyId && opensSomething(c.id)
    );
    return back
      ?? companies.find(c => c.id !== activeCompanyId && opensSomething(c.id))
      ?? null;
  }, [orgs, companies, previousCompanyId, activeCompanyId]);

  // The Account and User admin pages open OVER the app rather than as a tab
  // (AccountGate / UserAdminGate below), so the map stayed "on" under them —
  // and its floating windows are position: fixed at z-index up to 9999 (the
  // unit card, its camera, the replay, the fuel incident window), above the
  // pages' 2500. A unit card belongs over its unit on the map, so while one of
  // those pages is open the map panel is hidden exactly as it is for another
  // tab: still mounted, every card and window kept, back as it was on return.
  const overlayPageOpen = useAppSelector((a) => a.accountOpen || a.userAdminOpen);
  // The map's Fuel alerts list (store `map` slice) — the unit panel folds
  // away while it is open; see the panel below.
  const fuelAlertsOpen = useSelector((st) => st.map?.fuelAlertsOpen ?? false);

  const show = (key) => {
    const tab = NAV_ITEMS.find(t => t.key === key);
    return Boolean(tab) && desktopActiveTab === key && can(tab.permission);
  };

  return (
    <div className="app-container app--light">
      {/* Top bar */}
      <ErrorBoundary label="Header" fullSection>
        <AppHeader />
      </ErrorBoundary>

      {/* Mobile header — shown only on mobile (< 768px) */}
      <MobileHeader
        onSearchOpen={() => setMobileSearchOpen(o => !o)}
        onFeedOpen={() => { claimSidePanel('feed'); setMobileFeedOpen(true); }}
        onProfileOpen={() => setMobileProfileOpen(true)}
      />
      {/* Mobile search tray */}
      <MobileSearchTray open={mobileSearchOpen} onClose={() => setMobileSearchOpen(false)} />

      {/* Body: sidebar + content */}
      <div className="app-body">

        {/* Left sidebar */}
        <ErrorBoundary label="SidePanel" fullSection>
          <SidePanel onLayersClick={() => {/* wire to MapLayersMenu */}} />
        </ErrorBoundary>

        {/* Content area */}
        <div className="app-content">

          {/* Fleet map — always mounted, hidden when not active */}
          {/* `app-map-panel`, NOT `fleet-map-body`. FleetMap's own root element
              already carries that class, and reusing it here put two nested
              elements under every `.fleet-map-body` rule at once — including
              the mobile `overflow: visible`, which stopped this wrapper
              clipping the map, and the margin that holds the map clear of the
              bottom tab bar, which was applied twice. */}
          {/* Always mounted, hidden when not active — so switching back to the
              map does not re-create it, re-fetch the fleet and re-fit the
              viewport. That is worth doing for somebody who HAS the map.

              It is not worth doing for somebody who does not.               Without map:read the Live Map is closed to them everywhere else —
              its sidebar and tab bar items are omitted, `show('fleet')` is
              false — and mounting it anyway kept a live fleet subscription, a
              status count and a full set of markers running behind a hidden
              div for an account that cannot open it. Not drawn is not the same
              as not there. */}
          {can('map:read') && (
            <div className={`app-map-panel${!show('fleet') || overlayPageOpen ? ' app-tab-panel--hidden' : ''}`} data-tour="map">
              <ErrorBoundary label="Map" fullSection>
                <FleetMap />
              </ErrorBoundary>
            </div>
          )}


          {show('alerts') && (
            <div className="app-tab-panel app-tab-panel--screen">
              <ErrorBoundary label="Alerts" fullSection>
                <AlertsScreen />
              </ErrorBoundary>
            </div>
          )}

          {show('drivers') && (
            <div className="app-tab-panel app-tab-panel--screen">
              <ErrorBoundary label="Drivers" fullSection>
                <DriversScreen />
              </ErrorBoundary>
            </div>
          )}

          {show('dashcam') && (
            <div className="app-tab-panel app-tab-panel--screen">
              <ErrorBoundary label="Camera" fullSection>
                <DashcamIncidentsScreen />
              </ErrorBoundary>
            </div>
          )}

          {allowedTabs.length === 0 && (
            <div className="app-tab-panel app-tab-panel--screen">
              <TabEmptyState
                icon={<span aria-hidden="true" style={{ fontSize: 28 }}>🔒</span>}
                title={`Nothing to open in ${activeCompany?.name ?? 'this organisation'}`}
                hint="This account holds no screen permission here. An administrator can grant access."
                action={wayOut && (
                  <button type="button" onClick={() => setActiveCompanyId(wayOut.id)}>
                    {wayOut.id === previousCompanyId ? 'Back to ' : 'Go to '}
                    {wayOut.short || wayOut.name}
                  </button>
                )}
              />
            </div>
          )}

        </div>

        {/* Vehicle detail — a column beside the map on a desktop, an overlay
            over it on a laptop, a bottom sheet on a phone. One component: the
            shape is a CSS decision, and rendering it here rather than per
            breakpoint is what keeps a tap on a pin from losing its panel on
            the way down to mobile, which it used to (`display: none`). */}
        {/* Not on Analytics, Maintenance, Weighbridges, Fuel Audit or Fuel Report (operator, 2026-10-03: "whenever I open the
            analytics page and the side panel for the unit is open, let's not
            shrink the analytics page"). The panel is a column, so a unit left
            open on the map took its 320–360px out of the charts. On Analytics
            it stays collapsed; the selection itself stays in the store, so the
            panel is back, on the same unit, when the map is. */}
        {(() => {
          // Maintenance, Weighbridges, Fuel Audit and Fuel Report too
          // (operator, 2026-10-03: "the same as the maintenance page", "same
          // as the weighbridge", "same for fuel audit", "same as fuel
          // report"): their tables lose the same width to the column.
          // And on the map while the Fuel alerts list is open (operator,
          // 2026-10-03: "whenever we click fuel alerts then the right side
          // card is open, do the same"): the list wants the map's width, and
          // the unit comes back when the list closes.
          // Drivers as well (operator, 2026-10-03: "do the same with the
          // drivers page") — so the panel now takes width on the map only.
          const panelAllowed = !['alerts', 'drivers', 'dashcam'].includes(desktopActiveTab)
            && !fuelAlertsOpen;
          const selectedVehicle = selectedVehicleId && panelAllowed
            ? _liveVehicles.find(v => v.id === selectedVehicleId) ?? { id: selectedVehicleId }
            : null;
          return (
            <VehicleDetailPanel
              vehicle={selectedVehicle}
              onClose={() => setSelectedVehicleId(null)}
            />
          );
        })()}
      </div>
      {/* Mobile bottom tab bar */}
      <MobileTabBar />
      {/* Mobile live feed sheet */}
      {can('map:read') && <MobileLiveFeedSheet open={mobileFeedOpen} onClose={() => setMobileFeedOpen(false)} />}
      {/* Mobile company profile sheet */}
      <MobileCompanyProfile open={mobileProfileOpen} onClose={() => setMobileProfileOpen(false)} />
      {/* The first-time tour: starts once per person, again from the account menu. */}
      <ProductTour />
    </div>
  );
}

// ── Overlay pages (render beside the app so the map + live stream survive) ──

function AccountGate() {
  const accountOpen = useAppSelector((a) => a.accountOpen);
  if (!accountOpen) return null;
  /* Light, whatever the theme preference says.
     This page is where the theme is CHOSEN, and the two dark options in it are
     disabled — so a stored `dark` from before that change would otherwise paint
     the one screen that explains why dark is unavailable in dark. */
  return (
    <div className="app-root app--light">
      <AccountScreen />
    </div>
  );
}

function UserAdminGate() {
  const userAdminOpen = useAppSelector((a) => a.userAdminOpen);
  const { setUserAdminOpen } = useAppActions();
  const { can } = usePermissions();
  const allowed = can('user:create');

  // Roles are per-organisation: switching company can remove the grant.
  useEffect(() => {
    if (userAdminOpen && !allowed) setUserAdminOpen(false);
  }, [userAdminOpen, allowed, setUserAdminOpen]);

  if (!userAdminOpen || !allowed) return null;
  return (
    <div className="app-root app--light">
      <UserAdminScreen />
    </div>
  );
}

// ── Auth gate ───────────────────────────────────────────────────────────────

function AuthGate() {
  const { booting, isAuthenticated } = useAuth();
  /* One theme. `.app--dark` still exists in the stylesheets and is simply
     never applied — left there rather than stripped out of a dozen CSS files,
     which would be a far larger edit than the decision warrants. */
  const themed = 'app-root app--light';

  // Emailed set-password link (URL fragment). Checked before `booting` so an
  // invite for a different account is never swallowed by an existing session.
  const [setupToken, setSetupToken] = useState(readSetupToken);

  if (setupToken) {
    return (
      <div className={themed}>
        <SetPasswordScreen token={setupToken} onDone={() => setSetupToken(null)} />
      </div>
    );
  }

  // Silent refresh on mount — render nothing rather than flash the login form.
  if (booting) return <div className={themed} />;

  if (!isAuthenticated) {
    return <div className={themed}><LoginScreen /></div>;
  }

  return (
    <FleetLiveProvider>
      <AppShell />
      <AccountGate />
      <UserAdminGate />
    </FleetLiveProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <AuthGate />
      </AppProvider>
    </AuthProvider>
  );
}
