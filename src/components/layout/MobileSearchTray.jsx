/**
 * MobileSearchTray — drops below the header when the search icon is tapped.
 *
 * The header is mounted above the tab panels, so this tray is reachable from
 * every page. Acting on a result had to be too, and was not.
 *
 * It used to call `focusVehicle` from MapLayersContext, which is the MAP's own
 * camera. That works on the Fleet tab and does nothing visible anywhere else:
 * FleetMap stays mounted when another tab is showing, so the call succeeded,
 * panned a map nobody could see, and left the reader on Maintenance wondering
 * why the search was broken. It wasn't searching that failed — it was arriving.
 *
 * So selection now uses the handoff the rest of the app already uses for this:
 * set the vehicle, set `pendingFocusId`, switch to the Fleet tab. FleetMap
 * watches that flag and frames the unit once it has one to frame (see the
 * pending-focus effect there, which retries until the vehicle exists and then
 * clears the flag). It is the same three lines behind SensorPanel's "View on
 * Map" button, which is the button sitting directly above this table on the
 * page the search was reported broken on.
 */

import { useMemo, useState } from 'react';
import { useFleetLiveShared } from '../../context/FleetLiveContext';
import { useAppActions } from '../../context/AppContext';
import { usePermissions } from '../../hooks/usePermissions';
import './MobileSearchTray.css';
import { displayPlate } from "../../lib/plate";
import UnitTypeIcon from "../shared/UnitTypeIcon";

const norm = (s) => String(s ?? '').toLowerCase();

export default function MobileSearchTray({ open, onClose }) {
  const [query, setQuery] = useState('');
  const { vehicles = [] } = useFleetLiveShared();
  const { setSelectedVehicleId, setPendingFocusId, setDesktopActiveTab } = useAppActions();
  const { can } = usePermissions();
  /* An account without map:read is bounced straight back off the Fleet tab by
     the guard in App.jsx. Selecting still opens the unit's own sheet, which is
     the part they are allowed to see; only the camera move is withheld. */
  const canOpenMap = can('map:read');

  const q = norm(query).trim();

  /* Plate, machine name and driver. `name` was missing, so a unit searched by
     the name printed on its own row could not be found from here. */
  const results = useMemo(() => {
    if (!q) return [];
    return vehicles
      .filter(v => norm(v.id).includes(q) || norm(v.name).includes(q) || norm(v.driver).includes(q))
      .slice(0, 6);
  }, [vehicles, q]);

  const handleSelect = (v) => {
    setSelectedVehicleId(v.id);
    if (canOpenMap) {
      setPendingFocusId(v.id);
      setDesktopActiveTab('fleet');
    }
    setQuery(v.id);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="mst-tray">
      <div className="mst-input-row">
        <i className="ti ti-search mst-icon" aria-hidden="true" />
        <input
          className="mst-input"
          type="text"
          autoFocus
          placeholder="Search vehicle or driver..."
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <button className="mst-close" onClick={onClose} aria-label="Close search">
          <i className="ti ti-x" aria-hidden="true" />
        </button>
      </div>

      {/* A query that matches nothing says so.
          This used to fall through to `vehicles.slice(0, 3)` under a label
          reading "Results" — so searching for a plate that is not in this
          organisation answered with three arbitrary units presented as
          matches. Three wrong answers is worse than none. */}
      {q && results.length === 0 ? (
        <div className="mst-pills">
          <span className="mst-pills-label">No match</span>
          <span className="mst-empty">
            Nothing in {vehicles.length} unit{vehicles.length === 1 ? '' : 's'} matches
            “{query.trim()}”. Plate, machine name and driver are all searched.
          </span>
        </div>
      ) : (
      <div className="mst-pills">
        <span className="mst-pills-label">
          {/* Not "Recent": the fallback below is `vehicles.slice(0, 3)`, which
              is the first three units of the fleet and has never been a
              history. Naming it after what it is costs nothing and stops the
              reader reading meaning into an arbitrary three. */}
          {q ? 'Results' : 'Jump to'}:
        </span>
        {(results.length > 0 ? results : vehicles.slice(0, 3)).map(v => (
          <button
            key={v.id}
            className={`mst-pill${v.status === 'speeding' ? ' mst-pill--alert' : ''}`}
            onClick={() => handleSelect(v)}
            // The plate alone can be shared: a truck's own tracker and its fuel
            // unit or camera both read "KCC 386Z". The full name tells them apart.
            title={v.name || v.id}
          >
            <UnitTypeIcon vehicle={v} size={18} />
            {displayPlate(v)}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}
