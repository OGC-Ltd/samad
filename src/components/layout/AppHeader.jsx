// AppHeader — light top bar: logo, org switcher, live KPI carousel, notifications, avatar.

import { useState, useRef, useEffect } from 'react';
import { useAppFields, useAppActions, useCompanies } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useFleetLiveShared } from '../../context/FleetLiveContext';
import { usePermissions } from '../../hooks/usePermissions';
import { useDashboardSummary } from '../../hooks/useDashboardSummary';
import { useApiData } from '../../hooks/useApiData';
import { getDeliveryAnalytics } from '../../api/analytics';
import { isInTransit, carriesCargo, equipmentLabel, registerRole } from '../../lib/vehicleMap';
import { statMeta, statValues, StatButton, productKey } from '../header/StatKpis';
import StatCarousel from '../header/StatCarousel';
import LiveFeed from './LiveFeed';
import { FuelFollowUpHost } from '../body/FuelFollowUp';
import FilterStrip from '../header/FilterStrip';
import './AppHeader.scss';
import { companyMark as companyLogo } from '../../lib/companyLogos';
import { initialsOf, avatarHue } from '../../lib/avatar';
import { requestTour } from '../../lib/productTour';
import { refreshPush } from '../../lib/pushNotifications';
import ManualIcon from './ManualIcon';
import { isUnread, useFeedReads } from '../../lib/feedReads';
import { claimSidePanel, onSidePanelClaim } from '../../lib/sidePanels';

/**
 * How many feed items this operator has not seen, and whether any of them is
 * a problem.
 *
 * EVERY unseen item counts, not just the warning/critical ones. The filter
 * here used to admit those two severities and nothing else, and almost
 * nothing this fleet produces is either: a dispatch, a gate crossing and both
 * halves of a sale are published `info` or `success`
 * (raifactorysuite-events.service), and the telemetry narration spends
 * `warning` on a service redirect and `critical` on suspected theft. So the
 * feed filled all day behind a badge that sat at zero — the counter was
 * working, on a set that is empty on almost every fleet-day.
 *
 * The bell OPENS the feed, so its badge has to count what the feed holds.
 * Bounded twice over: pruneFeed caps the panel at MAX_FEED_ITEMS across a
 * 12-hour horizon; the badge itself is a dot and shows no figure.
 *
 * It returns a COUNT and nothing else. There was an `alarming` flag beside it,
 * colouring the badge red only when a warning or a critical was among the
 * unseen; the badge is now always red, so the flag drove nothing and is gone
 * rather than left computed on every render for a caller that ignores it.
 *
 * Exported because it is the whole of the rule and none of the rendering,
 * the same reason groupLayers is exported from MapLayersTree.
 */
export function summariseUnread(feed, reads, me) {
  // `reads` is lib/feedReads' marks; a bare time reads as a cut-off with no
  // single lines read. Every unread line counts, so the badge only goes once
  // nothing is left to read (operator 2026-10-19: opening and closing the bell
  // used to empty it while the panel still held unread lines).
  const r = typeof reads === 'number' ? { since: reads, ids: new Map() } : reads;
  let unreadCount = 0;
  // A malformed or missing timestamp cannot be placed against the cut-off,
  // and counting it would make the badge tick up on every reconnect that
  // replays it. isUnread reads it as read, the safe reading.
  for (const f of feed ?? []) if (isUnread(f, r, me)) unreadCount += 1;
  return { unreadCount };
}

// Company logo, or its coloured letter when there's no logo on file.
function CompanyMark({ company, size = 'md' }) {
  if (!company) return null;
  const logo = companyLogo(company);
  return (
    <span className={`app-header__co-mark app-header__co-mark--${size}`}>
      {logo
        ? <img src={logo} alt="" />
        : <span className="app-header__co-letter" style={{ background: company.avatarColor ?? '#64748b' }}>
            {company.avatarLetter ?? company.name?.[0] ?? '?'}
          </span>}
    </span>
  );
}

// FilterStrip chip status from the live vehicle's 4-state scheme.
const CHIP_STATUS = { ok: "ok", speeding: "warn", theft: "crit", parked: "ok" };
const SUKARI_PRODUCTS = /^(processed sugar|raw sugarcane)$/i;
const ENROUTE = /^(TO_FARM|TO_INDUSTRY|TO_DEPOT|TO_PARKING|TO_GARAGE|FROM_GARAGE)$/;
const OPERATIONAL_STOP = /^(LOADING|UNLOADING|OFFLOADING|AT_GARAGE)$/;

export default function AppHeader() {
  const { activeCompanyId, selectedVehicleId, desktopActiveTab } = useAppFields("activeCompanyId", "selectedVehicleId", "desktopActiveTab");

  // A device that already allowed push notifications is re-linked to whoever
  // is signed in; the switch itself is under Account › Preferences.
  useEffect(() => { refreshPush(activeCompanyId); }, [activeCompanyId]);
  const { setActiveCompanyId, setAccountOpen, setUserAdminOpen, setSelectedVehicleId } = useAppActions();
  const { activeCompany, companies } = useCompanies();
  const { can, flaggedOnly } = usePermissions();
  const { user, logout } = useAuth();

  /* The server's field is `fullName`. This header asked for `user.name`, which
   * is not on the object and never was — api/account.js writes `fullName`, and
   * UserAdminPanel, RepairJobsPanel and header/UserMenu all read it. So the
   * name line fell through to the email on every account, and the menu printed
   * the same address twice: once where the person's name belongs and once as
   * the address underneath it.
   *
   * `||` rather than `??`, because an account synced from the driver registry
   * can carry an empty string here, which `??` would happily render as a blank
   * line. */
  const displayName = user?.fullName?.trim() || user?.name?.trim() || '';
  const { feed, vehicles } = useFleetLiveShared();

  const [orgOpen,        setOrgOpen]        = useState(false);
  const [feedOpen,       setFeedOpen]       = useState(false);
  const [userOpen,       setUserOpen]       = useState(false);
  const [activeStat,     setActiveStat]     = useState(null);

  const orgRef  = useRef(null);
  const userRef = useRef(null);

  // ── Fleet KPI data ──────────────────────────────────────────────────────────
  const summary = useDashboardSummary(activeCompany?.id);

  const { data: deliveryAnalytics } = useApiData(
    () => getDeliveryAnalytics({ companyId: activeCompany?.id, days: 30 }),
    [activeCompany?.id],
    { cacheKey: `ft-header-products:${activeCompany?.id}` }
  );

  const products = (deliveryAnalytics?.products ?? []).filter(
    (p) => activeCompany?.id !== "sukari" || SUKARI_PRODUCTS.test(p.product)
  );

  // Only an organisation with a machine register (KASULU) has a Plant button:
  // its hour-rated units in transit, and nothing else (operator 2026-10-19).
  // Elsewhere nothing names a unit's type for certain, so there is no plant —
  // every unit out with no load counts as empty.
  const hasRegister = vehicles.some((v) => registerRole(v) != null);
  const noLoadOf = (v) => {
    if (!hasRegister) return "empty";
    const role = registerRole(v);
    if (role === "plant") return "plant";
    // Not plant by the register. A carrier is empty; a non-carrier the
    // register does not rate is still out working, just in no sub-count.
    return role === "carrier" || carriesCargo(v) ? "empty" : "other";
  };

  const bucketOf = (v) => {
    if (!v.online) return null;
    const noLoad = noLoadOf(v);
    const phase = v.phase ?? "";
    if (OPERATIONAL_STOP.test(phase)) return noLoad;
    if (ENROUTE.test(phase)) return v.weight > 0 ? "product" : noLoad;
    if (!phase && isInTransit(v)) return v.weight > 0 ? "product" : noLoad;
    return null;
  };

  const activeFleet = vehicles.flatMap((v) => {
    const bucket = bucketOf(v);
    if (!bucket) return [];
    return [{
      vehicleId: v.vehicleId ?? v.id,
      plate: v.id,
      driver: v.driver,
      cargo: v.cargo,
      machine: equipmentLabel(v),
      phase: v.phase,
      tonnes: v.weight,
      bucket,
      status: CHIP_STATUS[v.status] ?? "ok",
    }];
  });

  const emptyFleet   = activeFleet.filter((c) => c.bucket === "empty");
  const plantFleet   = activeFleet.filter((c) => c.bucket === "plant");
  const ferrying     = activeFleet.filter((c) => c.bucket === "product");

  const liveSummary = summary
    ? {
        ...summary,
        emptyFleet,
        plantFleet,
        inTransit: {
          vehicleCount: activeFleet.length,
          sugarTonnes: +ferrying.reduce((sum, c) => sum + (c.tonnes ?? 0), 0).toFixed(1),
          vehicles: activeFleet,
        },
      }
    : summary;

  const cargoWord = activeCompany?.id === "sukari" ? "sugar" : "cargo";

  const liveByProduct = new Map();
  for (const v of ferrying) {
    if (!v.cargo) continue;
    const k = productKey(v.cargo);
    const entry = liveByProduct.get(k) ?? { name: v.cargo, liveTonnes: 0 };
    entry.liveTonnes += v.tonnes;
    liveByProduct.set(k, entry);
  }
  const activeProducts = [...liveByProduct.entries()]
    .sort((a, b) => b[1].liveTonnes - a[1].liveTonnes)
    .map(([k, { name }]) => products.find((p) => productKey(p.product) === k) ?? { product: name, tonnes: null });

  const liveProductKeys = [...liveByProduct.keys()].sort().join(",");

  useEffect(() => { setActiveStat(null); }, [activeCompany?.id]);
  useEffect(() => { if (desktopActiveTab !== "fleet") setActiveStat(null); }, [desktopActiveTab]);
  useEffect(() => {
    if (activeStat?.startsWith("product:") && !liveProductKeys.split(",").includes(productKey(activeStat.slice("product:".length)))) {
      setActiveStat(null);
    }
  }, [activeStat, liveProductKeys]);

  const toggleStat = (key) => setActiveStat((prev) => (prev === key ? null : key));

  // No In transit or Empty card for a technician (operator, 2026-10-27).
  const statButtons = statMeta(liveSummary, activeProducts)
    .filter(({ key }) => !(flaggedOnly && (key === "inTransit" || key === "empty")))
    .map(({ key, label, color, icon }) => {
    const { value, unit, sub } = statValues(key, liveSummary, cargoWord, products);
    return (
      <StatButton
        key={key}
        label={label}
        value={value}
        unit={unit}
        sub={sub}
        color={color}
        icon={icon}
        active={activeStat === key}
        onClick={() => toggleStat(key)}
      />
    );
  });

  // Unread = feed lines this operator has not opened, remembered per
  // organisation in this browser (lib/feedReads). Opening the panel reads
  // nothing; a row is read when it is opened, or by "Mark all read". The
  // badge counts every unread line.
  const feedReads = useFeedReads(activeCompanyId);
  // No rights to the fleet (no map:read, operator 2026-10-01): no bell and no
  // feed at all. The feed is the fleet's events, which such an account is not
  // shown anywhere else (the sidebar dashes its counts).
  const limited = !can('map:read');
  const { unreadCount } = limited ? { unreadCount: 0 } : summariseUnread(feed, feedReads.reads, user?.id);
  // The bell swings once when the count goes up — news arrived — and not when
  // it falls (lines read) or on a re-render with the same count.
  const prevUnread = useRef(unreadCount);
  const [swing, setSwing] = useState(0);
  useEffect(() => {
    if (unreadCount > prevUnread.current) setSwing(n => n + 1);
    prevUnread.current = unreadCount;
  }, [unreadCount]);
  const bellWords = unreadCount === 0 ? 'Notifications'
    : `Notifications, ${unreadCount} unread event${unreadCount === 1 ? '' : 's'}`;

  // The live feed and the vehicle detail panel share the right edge — only one
  // may be open. Selecting a vehicle (map pin, search, feed row) closes the feed…
  useEffect(() => {
    if (selectedVehicleId) setFeedOpen(false);
  }, [selectedVehicleId]);

  // …and opening the feed closes the vehicle panel.
  const toggleFeed = () => {
    if (!feedOpen) {
      setSelectedVehicleId(null);
      // …and every other side panel, card and window (lib/sidePanels): the
      // feed takes the space rather than stacking over what was open.
      claimSidePanel('feed');
    }
    // Opening or closing the feed reads nothing: each line stays unread until
    // it is opened (operator 2026-10-19 — one read used to clear them all),
    // and the badge keeps counting it.
    setFeedOpen(!feedOpen);
  };

  // Anything else opening (a page's sidebar, a map card or window, an
  // incident) closes the feed in turn.
  useEffect(() => onSidePanelClaim('feed', () => setFeedOpen(false)), []);

  /* The account menu answers the keyboard: it opens on its first item, the
     arrows walk it, and Escape puts focus back on the avatar it came from. */
  const userMenuRef = useRef(null);
  useEffect(() => {
    if (userOpen) userMenuRef.current?.querySelector('[role="menuitem"]')?.focus();
  }, [userOpen]);
  const onUserMenuKey = (e) => {
    const items = [...(userMenuRef.current?.querySelectorAll('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setUserOpen(false);
      userRef.current?.querySelector('.app-header__avatar')?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    }
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (orgRef.current  && !orgRef.current.contains(e.target))  setOrgOpen(false);
      if (userRef.current && !userRef.current.contains(e.target)) setUserOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleOrgSelect = (id) => {
    setActiveCompanyId(id);
    setOrgOpen(false);
  };

  return (
    <>
      <header className="app-header">

        {/* Logo */}
        {/* Active company's logo (the Samad mark if the company has none).
            Its left edge lines up with the side panel's cards below. */}
        <img
          src={companyLogo(activeCompany) ?? '/samad-logo.svg'}
          alt={activeCompany?.name ?? 'Samad Resources'}
          className="app-header__logo"
        />
        <span className="app-header__divider" />

        {/* One organisation, so its name is a label rather than a switcher. */}
        <div className="app-header__org-wrap" ref={orgRef}>
          <span data-tour="org" className="app-header__org-btn">
            {activeCompany?.name ?? 'Samad Resources'}
          </span>
        </div>

        {/* No search box here since 2026-10-07: vehicle, driver and place search
            live in the map's tool rail (MapToolRail), beside the sidebar. */}

        {/* Live KPI carousel — fleet tab only, fills the middle gap */}
        {desktopActiveTab === "fleet" && !limited && (
          <div className="app-header__carousel">
            <StatCarousel>{statButtons}</StatCarousel>
          </div>
        )}

        {/* Notification bell — not rendered without rights to the fleet. */}
        {!limited && (
        <button
          data-tour="alerts"
          className={`app-header__bell${feedOpen ? ' app-header__bell--active' : ''}${unreadCount > 0 ? ' app-header__bell--news' : ''}${flaggedOnly ? ' app-header__bell--figure' : ''}`}
          onClick={toggleFeed}
          // The count lives in the name: a label on the badge inside a labelled
          // button is never read out.
          aria-label={bellWords}
          aria-expanded={feedOpen}
        >
          {/* The badge's notch is cut from this still frame, so the bell swings
              behind the badge instead of dragging the notch with it. */}
          <span className="app-header__bell-glyph" aria-hidden="true">
            <i
              key={`icon-${swing}`}
              className={`ti ${feedOpen ? 'ti-bell-filled' : 'ti-bell'}${swing ? ' app-header__bell-icon--swing' : ''}`}
            />
          </span>
          {unreadCount > 0 && (
            // A dot, no figure (operator 2026-10-19): it says "something to
            // read" and goes once everything is read. Keyed on the swing so it
            // pops when news arrives.
            // A technician's bell carries the figure (operator, 2026-10-27):
            // their feed is the repair notices sent to them, few enough to count.
            flaggedOnly
              ? <span key={`dot-${swing}`} className="app-header__bell-count app-header__bell-count--figure" aria-hidden="true">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              : <span key={`dot-${swing}`} className="app-header__bell-count" aria-hidden="true" />
          )}
        </button>
        )}
        {/* Holds the bell's place so the avatar stays where it always sits. */}
        {limited && <span className="app-header__bell" aria-hidden="true" style={{ visibility: 'hidden', pointerEvents: 'none' }} />}

        {/* User avatar */}
        <div className="app-header__user-wrap" ref={userRef}>
          {/* Initials in a small tinted circle, in a target the bell's size: the
              old grey silhouette filled 30px solid and outweighed the bell's
              outline icon (operator, 2026-10-02). */}
          <button
            data-tour="account"
            className={`app-header__avatar${userOpen ? ' app-header__avatar--open' : ''}`}
            onClick={() => setUserOpen(o => !o)}
            aria-label="User menu"
            aria-haspopup="menu"
            aria-expanded={userOpen}
          >
            {user
              ? (
                <span className="app-header__avatar-face" style={{ '--ua': avatarHue(displayName || user.email) }} aria-hidden="true">
                  {initialsOf(displayName, user.email)}
                </span>
              )
              : <i className="ti ti-user-circle" aria-hidden="true" />}
          </button>

          {userOpen && (
            <div className="app-header__user-menu" role="menu" aria-label="Account"
                 ref={userMenuRef} onKeyDown={onUserMenuKey}>
              <div className="app-header__user-info">
                <div className="app-header__user-name" title={displayName || user?.email || undefined}>
                  {displayName || user?.email || 'Signed in'}
                </div>
                {/* Only when it is saying something the line above did not. With
                    no name on the account the address IS the identity, and
                    repeating it just makes the menu look broken. */}
                {displayName && user?.email && (
                  <div className="app-header__user-email" title={user.email}>{user.email}</div>
                )}
              </div>
              <div className="app-header__user-divider" role="separator" />
              <button className="app-header__user-item" role="menuitem" onClick={() => { setAccountOpen(true); setUserOpen(false); }}>
                <i className="ti ti-user-circle" aria-hidden="true" />
                Account
              </button>
              {can('user:create') && (
                <button className="app-header__user-item" role="menuitem" onClick={() => { setUserAdminOpen(true); setUserOpen(false); }}>
                  <i className="ti ti-users" aria-hidden="true" />
                  Users
                </button>
              )}
              {/* The Guide: the first-time tour, again (lib/productTour). */}
              <button className="app-header__user-item" role="menuitem" onClick={() => { setUserOpen(false); requestTour(); }}>
                <ManualIcon />
                Guide
              </button>
              <div className="app-header__user-divider" role="separator" />
              <button className="app-header__user-item" role="menuitem" onClick={logout}>
                <i className="ti ti-logout" aria-hidden="true" />
                Sign out
              </button>
            </div>
          )}
        </div>

      </header>

      {/* FilterStrip — slides in below the header when a KPI button is active */}
      {desktopActiveTab === "fleet" && activeStat && liveSummary && (
        <FilterStrip
          stat={activeStat}
          summary={liveSummary}
          cargoWord={cargoWord}
          products={products}
          onClose={() => setActiveStat(null)}
        />
      )}

      {/* Live feed panel — slides in from right */}
      {!limited && <LiveFeed open={feedOpen} onClose={() => setFeedOpen(false)} reads={feedReads} />}
      {/* The fuel follow-up case window. Here rather than on the map because
          it opens from the Live Feed too, and technicians have no map. */}
      <FuelFollowUpHost />
    </>
  );
}
