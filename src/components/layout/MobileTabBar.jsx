// MobileTabBar — bottom navigation for mobile, mirrors the React Native app exactly.
// Only visible on screens < 768px. Desktop is unaffected.
//
// Unavailable resources are omitted, not shown as disabled controls. Permission
// metadata comes from NAV_ITEMS so mobile and desktop stay in sync.
//
// ## The centre button belongs to whoever can use it
//
// The raised button in the middle is the one a thumb reaches without looking,
// and it was nailed to the Live Map. For an account without map:read that made
// the best position on the bar a dead one, and left the screen they actually
// work in as a small tab in the corner.
//
// When the map is unavailable, the centre goes to an available screen instead.

import { useAppSelector, useAppActions } from '../../context/AppContext';
import { usePermissions } from '../../hooks/usePermissions';
import { NAV_ITEMS } from './SidePanel';
import './MobileTabBar.scss';

/* `fleet` carries a map icon for the case where it is NOT in the centre — the
   truck is drawn for the centre position only, and a demoted Fleet tab with no
   icon at all would render as a bare label. */
const TABS = [
  { key: 'drivers',      label: 'Drivers',      icon: 'users'     },
  { key: 'fleet',        label: 'Fleet',        icon: 'map-2'     },
];

const permissionFor = (key) => NAV_ITEMS.find((n) => n.key === key)?.permission;

/**
 * The available buttons in order, each marked with whether it is the centre one.
 *
 * Pure and exported for test: this is the whole ordering decision, and the rest
 * of this file is markup. `allowed` is a predicate on a tab key.
 *
 * Unavailable tabs are not returned. If Fleet is unavailable, an available
 * screen takes the centre slot; if nothing is available, the bar is empty.
 */
export function barTabs(allowed) {
  const visible = TABS.filter((tab) => allowed(tab.key));
  if (visible.length === 0) return [];

  const centre = visible.find((tab) => tab.key === 'fleet')
    ?? visible[Math.floor(visible.length / 2)];
  const centreIndex = visible.indexOf(centre);
  const middleIndex = Math.floor(visible.length / 2);
  const ordered = [...visible];
  ordered.splice(centreIndex, 1);
  ordered.splice(middleIndex, 0, centre);
  return ordered.map((tab) => ({ ...tab, fab: tab.key === centre.key }));
}

export default function MobileTabBar() {
  const desktopActiveTab = useAppSelector((a) => a.desktopActiveTab);
  const { setDesktopActiveTab } = useAppActions();
  const { can } = usePermissions();

  /* The list and its permission come from the shared navigation catalogue. */
  const allowed = (key) => {
    const perm = permissionFor(key);
    return Boolean(perm) && can(perm);
  };
  const tabs = barTabs(allowed);
  if (tabs.length === 0) return null;

  return (
    <nav
      className="mobile-tab-bar"
      data-tour="m-tabs"
      style={tabs.length > 0 && tabs.length < TABS.length
        ? { gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }
        : undefined}
    >
      {tabs.map(tab => {
        const isActive = desktopActiveTab === tab.key;

        if (tab.fab) {
          return (
            <button
              key={tab.key}
              className={`mobile-tab-bar__fab${isActive ? ' mobile-tab-bar__fab--active' : ''}`}
              onClick={() => setDesktopActiveTab(tab.key)}
              aria-label={tab.key === 'fleet' ? 'Fleet map' : tab.label}
            >
              {tab.key === 'fleet' ? (
                /* Truck SVG — same as RN app */
                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
                </svg>
              ) : (
                <i className={`ti ti-${tab.icon} mobile-tab-bar__fab-icon`} aria-hidden="true" />
              )}
              <span className="mobile-tab-bar__fab-label">{tab.label}</span>
            </button>
          );
        }

        return (
          <button
            key={tab.key}
            className={`mobile-tab-bar__item${isActive ? ' mobile-tab-bar__item--active' : ''}`}
            onClick={() => setDesktopActiveTab(tab.key)}
          >
            <i className={`ti ti-${tab.icon} mobile-tab-bar__icon`} aria-hidden="true" />
            <span className="mobile-tab-bar__label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
