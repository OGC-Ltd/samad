// SidePanel — left sidebar: weather card, stats grid, nav, map layers.
// Sample 2 design: cloud illustration weather, bordered stat boxes, bordered nav and layers sections.

import { useState, useEffect } from 'react';
import { useAppSelector, useAppActions, useCompanies } from '../../context/AppContext';
import { useFleetLiveShared } from '../../context/FleetLiveContext';
import { usePermissions } from '../../hooks/usePermissions';
import COMPANIES from '../../data/companyData';
import { useMapLayers } from '../../context/MapLayersContext';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { STATUS_STATS, FLAGGED_ONLY_HIDDEN, countStatuses } from '../../lib/fleetStatusStats';
import FleetsTree from './FleetsTree';
import FleetAIInsightCard from '../cards/FleetAIInsightCard';
import ErrorBoundary from '../shared/ErrorBoundary';
import { versionLabel, buildDetail } from '../../lib/version';
import { useAlertSummary, badgeText } from '../../hooks/useAlertSummary';
import { useFuelAlarm } from '../../hooks/useFuelAlarm';
import './SidePanel.css';

export const NAV_ITEMS = [
  { key: 'fleet',        label: 'Live Map',     icon: 'map-2',     permission: 'map:read'         },
  // Fuel and overspeeding alerts from every organisation the account holds,
  // escalated and de-escalated in one place (operator, 2026-10-12). Either
  // grant opens it: the page shows each kind only where it is held.
  { key: 'alerts',       label: 'Alerts',       icon: 'bell-ringing', permission: ['alerts:read', 'fuel_theft:read', 'analytics:read'] },
  { key: 'drivers',      label: 'Drivers',      icon: 'users',     permission: 'driver:read'      },
];

function weatherDesc(code) {
  if (code === 0)              return 'Sunny';
  if (code <= 2)               return 'Partly Cloudy';
  if (code <= 3)               return 'Cloudy';
  if (code <= 49)              return 'Foggy';
  if (code <= 55)              return 'Drizzle';
  if (code <= 65)              return 'Rainy';
  if (code <= 75)              return 'Snow';
  if (code <= 82)              return 'Showers';
  if (code <= 99)              return 'Thunderstorm';
  return 'Cloudy';
}

function WeatherIcon({ code, size = 28 }) {
  const isSun    = code === 0;
  const isPartly = code >= 1 && code <= 2;
  const isCloudy = code === 3;
  const isRainy  = (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
  const isStorm  = code >= 95;

  if (isSun) return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="7" fill="#fbbf24"/>
      {[0,45,90,135,180,225,270,315].map((a,i) => (
        <line key={i}
          x1={16 + 10*Math.cos(a*Math.PI/180)} y1={16 + 10*Math.sin(a*Math.PI/180)}
          x2={16 + 14*Math.cos(a*Math.PI/180)} y2={16 + 14*Math.sin(a*Math.PI/180)}
          stroke="#fbbf24" strokeWidth="2" strokeLinecap="round"/>
      ))}
    </svg>
  );

  if (isPartly) return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <circle cx="18" cy="11" r="6" fill="#fbbf24"/>
      <ellipse cx="14" cy="22" rx="12" ry="6" fill="#94a3b8"/>
      <ellipse cx="10" cy="19" rx="7" ry="6" fill="#94a3b8"/>
      <ellipse cx="18" cy="18" rx="8" ry="6" fill="#cbd5e1"/>
    </svg>
  );

  if (isCloudy) return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <ellipse cx="16" cy="22" rx="13" ry="6" fill="#94a3b8"/>
      <ellipse cx="11" cy="18" rx="8" ry="7" fill="#94a3b8"/>
      <ellipse cx="19" cy="17" rx="9" ry="7" fill="#cbd5e1"/>
    </svg>
  );

  if (isRainy) return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <ellipse cx="16" cy="16" rx="12" ry="6" fill="#94a3b8"/>
      <ellipse cx="11" cy="13" rx="7" ry="6" fill="#94a3b8"/>
      <ellipse cx="19" cy="12" rx="8" ry="6" fill="#cbd5e1"/>
      <line x1="10" y1="23" x2="8"  y2="28" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round"/>
      <line x1="16" y1="24" x2="14" y2="29" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round"/>
      <line x1="22" y1="23" x2="20" y2="28" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );

  if (isStorm) return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <ellipse cx="16" cy="14" rx="12" ry="6" fill="#64748b"/>
      <ellipse cx="11" cy="11" rx="7" ry="6" fill="#64748b"/>
      <polygon points="18,18 12,26 16,22 10,30 20,22 15,26" fill="#fbbf24"/>
    </svg>
  );

  // default cloudy
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <ellipse cx="16" cy="20" rx="12" ry="6" fill="#94a3b8"/>
      <ellipse cx="11" cy="17" rx="7" ry="6" fill="#94a3b8"/>
      <ellipse cx="19" cy="16" rx="8" ry="6" fill="#cbd5e1"/>
    </svg>
  );
}

function useWeather(lat, lng) {
  const [weather, setWeather] = useState(null);
  useEffect(() => {
    if (!lat || !lng) return;
    const url = `https://api.open-meteo.com/v1/forecast?` +
      `latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,weathercode,windspeed_10m,relativehumidity_2m` +
      `&daily=weathercode,temperature_2m_max,precipitation_probability_max` +
      `&timezone=Africa%2FNairobi&forecast_days=4`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const cur  = data.current;
        const daily = data.daily;
        const forecast = [1, 2, 3].map(i => ({
          day:   new Date(daily.time[i]).toLocaleDateString('en-KE', { weekday: 'short' }).toUpperCase(),
          code:  daily.weathercode[i],
          temp:  Math.round(daily.temperature_2m_max[i]),
          rain:  daily.precipitation_probability_max[i],
        }));
        setWeather({
          temp:     Math.round(cur.temperature_2m),
          code:     cur.weathercode,
          desc:     weatherDesc(cur.weathercode),
          humidity: cur.relativehumidity_2m,
          wind:     Math.round(cur.windspeed_10m),
          forecast,
        });
      })
      .catch(() => {});
  }, [lat, lng]);
  return weather;
}

export default function SidePanel() {
  /* Collapse follows the screen until the operator overrides it.
   *
   * `null` means "whatever this screen size wants". Once the hamburger is
   * pressed the choice is theirs and is kept, because a sidebar that
   * re-collapsed itself on the next render would fight the person using it.
   *
   * ## Only a TABLET collapses by default
   *
   * A laptop does not, although it is narrow enough to be tempting. The stat
   * grid lives in here, and StatusRail — the thing that puts those filters
   * back — only appears at 1023px and below. Collapsing at 1100px would leave
   * that range with no status filter on screen at all until somebody thought
   * to open a menu. At 1024 the panel is 260px against a 764px map, which is
   * a worse map but a complete app.
   *
   * The override is dropped when the breakpoint CHANGES, which is the case it
   * would otherwise get wrong: a sidebar opened on a desktop and then carried
   * to a tablet by a rotation would cover the map with no way to tell why. */
  const [userCollapsed, setUserCollapsed] = useState(null);
  const { isTablet, isLaptop } = useBreakpoint();

  const autoCollapsed = isTablet;
  const collapsed = userCollapsed ?? autoCollapsed;
  /* On a tablet the open sidebar is a temporary overlay over the map, not a
   * third column — there is no room for a third column.
   *
   * `isTablet`, not `isCompact`. The only width isCompact adds is the phone,
   * where this sidebar is `display: none` and there is no overlay to dismiss —
   * but `autoCollapsed` is false there too, so every phone rendered the scrim
   * below, a full-screen button over the map that nothing could close. It went
   * unnoticed because the map used to paint over it. */
  const asOverlay = isTablet && !collapsed;

  useEffect(() => { setUserCollapsed(null); }, [isTablet, isLaptop]);

  const desktopActiveTab = useAppSelector((a) => a.desktopActiveTab);

  const { setDesktopActiveTab } = useAppActions();
  const { activeCompany } = useCompanies();
  const { can, flaggedOnly } = usePermissions();
  const mainNavItems = NAV_ITEMS.filter(item => !item.section && can(item.permission));
  const systemItems = NAV_ITEMS.filter(item => item.section === 'system' && can(item.permission));
  // Open alerts across every organisation held (the Alerts page's default week).
  const alertSummary = useAlertSummary(can(NAV_ITEMS.find(n => n.key === 'alerts')?.permission));
  const openAlerts = alertSummary?.open ?? 0;
  // A new fuel theft alert: the Alerts button shakes in red until the page is opened.
  const fuelAlarm = useFuelAlarm(alertSummary);
  // `activeFilter` comes from the map rather than from local state here.
  // The local copy could not see the map clearing the filter on its own — on a
  // company switch, or when focusing a single unit — so a card stayed lit over
  // a map showing the whole fleet again.
  const { applyFilter, activeFilter } = useMapLayers();

  const { vehicles = [], loading, orgId } = useFleetLiveShared();
  // The unit picked on the map: the AI card at the foot speaks for it alone.
  const selectedVehicleId = useAppSelector((a) => a.selectedVehicleId);
  const picked = selectedVehicleId != null ? vehicles.find((x) => x.id === selectedVehicleId) : null;
  const aiUnit = picked?.vehicleId && orgId ? { orgId, vehicleId: picked.vehicleId, plate: picked.id } : null;

  // Counted with the SAME predicate the map filter uses, so clicking a card
  // always shows exactly the number printed on it. One pass over the fleet for
  // all six — see lib/fleetStatusStats.
  const counts  = countStatuses(vehicles);
  const waiting = loading && vehicles.length === 0;

  // Fallback to companyData coordinates if server company lacks them
  const companyFallback = COMPANIES?.find(c =>
    c.id === activeCompany?.id ||
    c.name === activeCompany?.name
  );
  const hqLat = activeCompany?.hqLat ?? companyFallback?.hqLat;
  const hqLng = activeCompany?.hqLng ?? companyFallback?.hqLng;
  const hqLocation = activeCompany?.hqLocation ?? companyFallback?.hqLocation;

  // Weather card removed for now — useWeather(hqLat, hqLng) is ready when it returns.

  const handleNav = (key) => {
    if (can(NAV_ITEMS.find(n => n.key === key)?.permission)) {
      setDesktopActiveTab(key);
      // Picking a destination is the end of the errand the overlay was opened
      // for, so it closes itself rather than staying over the screen it just
      // navigated to.
      if (asOverlay) setUserCollapsed(true);
    }
  };

  return (
    <>
    {/* Tap-anywhere-else dismissal for the tablet overlay. A button rather
        than a div so it is reachable from a keyboard and announces itself. */}
    {asOverlay && (
      <button
        type="button"
        className="app-scrim"
        aria-label="Close menu"
        onClick={() => setUserCollapsed(true)}
      />
    )}
    <aside
      className={[
        'side-panel',
        collapsed  ? 'side-panel--collapsed' : '',
        asOverlay  ? 'side-panel--overlay'   : '',
      ].filter(Boolean).join(' ')}
    >

      {/* Head: the panel's own toggle. Open, it sits at the far end of a
          labelled row (where a "put this away" control is looked for); folded,
          it is the first tile of the icon rail, on the same centre line as
          every icon under it. The glyph says which way the panel will go. */}
      <div className="side-panel__head">
        {!collapsed && <span className="side-panel__head-label">Menu</span>}
        <button
          type="button"
          className="side-panel__toggle"
          onClick={() => setUserCollapsed(collapsed ? false : true)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
        >
          <i className={`ti ti-layout-sidebar-left-${collapsed ? 'expand' : 'collapse'}`} aria-hidden="true" />
        </button>
      </div>

      {!collapsed && (
        <div className="side-panel__body">


          {/* Fleet status controls are part of the map and only render with map access. */}
          {can('map:read') && (() => {
            // filterKey must match cases in lib/vehicleMap.js matchesFilter()
            const stats = STATUS_STATS.map(s => ({
              ...s,
              value: waiting ? '–' : counts[s.key],
            }));
            const by = Object.fromEntries(stats.map(s => [s.key, s]));
            // Three rows, by what the figures ARE (lib/vehicleMap
            // matchesFilter): the whole fleet; the two halves it splits into,
            // Online + Offline = All; then Idling (part of Online) and the two
            // alerts, which overlap and sum to nothing.
            const order = ['all', 'online', 'offline', 'idling', 'warning', 'critical']
              .filter(key => !(flaggedOnly && FLAGGED_ONLY_HIDDEN.has(key)));
            const total = counts.all || 0;
            const onShare = !waiting && total ? counts.online / total : 0;
            return (
              <div className="sp-stats-grid" data-tour="status">
                {order.map(key => {
                  const s = by[key];
                  const isActive = activeFilter === s.filterKey;
                  // Clicking the lit card clears back to ALL, which is also
                  // what the ALL card does — so it can never leave the map
                  // filtered with nothing showing as filtered.
                  const next = isActive ? 'all' : s.filterKey;
                  // Colour on the figure only where it asks for a look: an
                  // alert with something in it. Everywhere else the dot
                  // carries the status and the figure stays ink.
                  const alert = (key === 'warning' || key === 'critical') && s.value > 0;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      className={[
                        'sp-stat-box',
                        `sp-stat-box--${s.key}`,
                        isActive ? 'sp-stat-box--active' : '',
                        alert ? 'sp-stat-box--alert' : '',
                        s.value === 0 ? 'sp-stat-box--zero' : '',
                      ].join(' ')}
                      style={{ '--stat-color': s.color }}
                      aria-pressed={isActive}
                      title={`Show ${s.label.toLowerCase()} on the map`}
                      onClick={() => applyFilter(next)}
                    >
                      <span className="sp-stat-num">{s.value}</span>
                      <span className="sp-stat-lbl">
                        {key !== 'all' && <i className="sp-stat-dot" aria-hidden="true" />}
                        {s.label}
                      </span>
                      {key === 'all' && (
                        // The fleet split the way the row beneath it is:
                        // online, then offline. Only these two, because they
                        // are the one pair that partitions the total.
                        <span className="sp-stat-split" aria-hidden="true">
                          {onShare > 0 && <b style={{ flexGrow: counts.online }} />}
                          {onShare > 0 && <b style={{ flexGrow: counts.offline }} />}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })()}

          {/* ── Navigation ── */}
          {mainNavItems.length > 0 && (
            <nav className="sp-nav-box" data-tour="nav">
              {mainNavItems.map(item => {
                const isActive = desktopActiveTab === item.key;
                return (
                  <button
                    key={item.key}
                    className={[
                      'sp-nav-item',
                      isActive  ? 'sp-nav-item--active'   : '',
                      item.key === 'alerts' && fuelAlarm ? 'nav-alarm' : '',
                    ].join(' ')}
                    onClick={() => handleNav(item.key)}
                  >
                    {isActive && <span className="sp-nav-bar" />}
                    <i className={`ti ti-${item.icon} sp-nav-icon`} aria-hidden="true" />
                    <span className="sp-nav-label">{item.label}</span>
                    {item.key === 'alerts' && openAlerts > 0 && (
                      <span className="sp-nav-count" title={`${openAlerts} open alert${openAlerts === 1 ? '' : 's'} you have not read, last 7 days${fuelAlarm ? ' · a new fuel theft alert' : ''}`}>
                        {badgeText(openAlerts)}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          )}

          {/* ── The map's own controls, as trees ──────────────────────────
              Fleets, Units and Map layers used to be three buttons floating in
              the map's control rail, each opening a popover over the imagery.
              On a desktop they are here: the panel is already open, and a tree
              can keep one branch showing while the rest stay shut, which a
              popover cannot. The map keeps all three below 1024px, where there
              is no sidebar body to hold them.

              The flat checkbox list that used to be here said the same words
              the map's menu said and grouped nothing: "Weighbridges", "Sukari
              Oyani" and "Nyaondo" as three peers, which is three names for two
              kinds of thing. */}
          {can('map:read') && (
            <div data-tour="fleets" className="sp-trees">
              <FleetsTree />
              {/* No Map layers here since 2026-10-07: base map and layers are in
                  the map rail's Maps panel, live traffic is its own rail button. */}
            </div>
          )}

        </div>
      )}

      {/* ── The organisation's AI brief, at the foot ──
          Back in the sidebar (operator, 2026-10-15), at the bottom (operator,
          same day). It lived on the old right-hand map overlay, which
          MapOverlay no longer renders, so it had been gone from every screen.
          Outside the scrolling body like Fuel Audit below, so it stays put
          however long the trees get; the two never share the foot, since this
          needs map:read and that one is drawn only without it. */}
      {/* Not for technicians: a summary of the whole fleet says nothing about
          the flagged units they are limited to (operator, 2026-10-27). */}
      {!collapsed && can('map:read') && !flaggedOnly && (
        <div className="sp-foot">
          <ErrorBoundary label="Fleet AI insight">
            <FleetAIInsightCard companyId={activeCompany?.id} unit={aiUnit} className="sp-ai-card" />
          </ErrorBoundary>
        </div>
      )}

      {/* ── System resources at the foot ──
          Without map access the fleet tree is absent, so permitted system
          pages remain available here. */}
      {!collapsed && systemItems.length > 0 && !can('map:read') && (
        <div className="sp-foot">
          <nav className="sp-nav-box" aria-label="Fuel audit">
            {systemItems.map(item => {
              const isActive = desktopActiveTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`sp-nav-item${isActive ? ' sp-nav-item--active' : ''}`}
                  onClick={() => handleNav(item.key)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {isActive && <span className="sp-nav-bar" />}
                  <i className={`ti ti-${item.icon} sp-nav-icon`} aria-hidden="true" />
                  <span className="sp-nav-label">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {/* Collapsed — icons only */}
      {collapsed && (
        mainNavItems.length > 0 && (
          <nav className="side-panel__nav" aria-label="Main" data-tour="nav">
            {mainNavItems.map(item => {
              const isActive = desktopActiveTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={[
                    'side-panel__nav-item',
                    isActive ? 'side-panel__nav-item--active'   : '',
                    item.key === 'alerts' && fuelAlarm ? 'nav-alarm' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleNav(item.key)}
                  aria-current={isActive ? 'page' : undefined}
                  // The label is the only thing naming this button when the
                  // sidebar is a 56px icon rail, so it has to be readable to a
                  // screen reader and not only on hover.
                  aria-label={item.key === 'alerts' && fuelAlarm ? `${item.label}, new fuel theft alert` : item.label}
                  title={item.label}
                >
                  <i className={`ti ti-${item.icon} side-panel__nav-icon`} aria-hidden="true" />
                  {item.key === 'alerts' && openAlerts > 0 && (
                    <span className="side-panel__nav-count" aria-hidden="true">{badgeText(openAlerts)}</span>
                  )}
                </button>
              );
            })}
          </nav>
        )
      )}

      {/* Collapsed Fuel Audit, at the foot of the icon rail like the open one. */}
      {collapsed && systemItems.length > 0 && (
        <nav className="side-panel__nav side-panel__nav--foot" aria-label="Fuel audit">
          {systemItems.map(item => {
            const isActive = desktopActiveTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`side-panel__nav-item${isActive ? ' side-panel__nav-item--active' : ''}`}
                onClick={() => handleNav(item.key)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={item.label}
                title={item.label}
              >
                <i className={`ti ti-${item.icon} side-panel__nav-icon`} aria-hidden="true" />
              </button>
            );
          })}
        </nav>
      )}

      {/* The very bottom: the login page's mark in the text's own muted ink,
          beside the SAMAD RESOURCES wordmark with the version under it (the year
          stays off; the login page keeps it). Folded to the rail there is no room
          for the wordmark, so the mark names the company there. The tooltip
          carries the build and its date. */}
      <div className="side-panel__meta" title={buildDetail()}>
        {/* The two-colour Samad mark, drawn as it is. */}
        <span
          className="side-panel__meta-mark"
          {...(collapsed ? { role: 'img', 'aria-label': 'Samad Resources' } : { 'aria-hidden': true })}
        />
        <span className="side-panel__meta-text">
          {!collapsed && <span className="side-panel__meta-word">SAMAD RESOURCES</span>}
          <span className="side-panel__meta-version">{versionLabel()}</span>
        </span>
      </div>

    </aside>
    </>
  );
}
