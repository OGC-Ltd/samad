/**
 * The six status buckets, defined once.
 *
 * The sidebar's stat grid and the small-screen status rail are the same six
 * controls at two sizes, and they were drifting: the rail was added with its
 * own copy of the list and immediately disagreed with the sidebar about which
 * filter key ONLINE meant. One list, one predicate, both read from here.
 *
 * `filterKey` is the vocabulary `matchesFilter` speaks, and it is NOT the same
 * word as the label. ONLINE is `ok` there — it is the connection count, decided
 * by the vehicle's own `online` field rather than by its status, so a parked
 * unit that is still reporting counts as online. Renaming these to match the
 * labels would silently change what every card counts.
 */

import { matchesFilter } from './vehicleMap';

/**
 * Idling is cyan everywhere else in this app — the map marker, the run row, the
 * vehicle card and the driver card all take `IDLING_COLOR` from lib/vehicleMap,
 * which exists precisely so idling is neither the healthy colour nor an alert
 * colour. This list had it as #2563eb: not cyan, and not merely off — it is
 * character for character the blue ALL uses one row above it. Two of the six
 * controls were the same colour, and the one that disagreed with the fleet it
 * was counting was the one whose whole point is a state you cannot see from a
 * marker's position.
 *
 * The value is `--accent-idling` (index.scss, App.scss) rather than IDLING_COLOR
 * itself, and the two are the light and mid weights of one cyan. This column
 * is not painted the same way the markers are: StatusRail FILLS the active
 * chip with it and sets white text, and SidePanel prints the count in it on
 * white. #06b6d4 under white text is about 2.3:1 and unreadable at 12px, where
 * #0e7490 is about 4.7:1 and clears AA — and it is the weight the rest of the
 * light theme already draws idling chrome in. The other five entries are the
 * matching -600/-700 weights of their own hues for the same reason.
 */
const IDLING_STAT_COLOR = '#0e7490';

export const STATUS_STATS = [
  { key: 'all',      filterKey: 'all',      label: 'All Units', short: 'All',      color: '#2563eb' },
  { key: 'online',   filterKey: 'ok',       label: 'Online',    short: 'Online',   color: '#16a34a' },
  { key: 'idling',   filterKey: 'idling',   label: 'Idling',    short: 'Idling',   color: IDLING_STAT_COLOR },
  { key: 'warning',  filterKey: 'warning',  label: 'Warning',   short: 'Warn',     color: '#d97706' },
  { key: 'critical', filterKey: 'critical', label: 'Critical',  short: 'Critical', color: '#dc2626' },
  { key: 'offline',  filterKey: 'offline',  label: 'Offline',   short: 'Offline',  color: '#64748b' },
];

/**
 * The buckets a technician does not get (operator, 2026-10-27). They see only
 * units with an open repair job, and idling and the fuel/speed alert counts
 * are the control room's business, not the workshop's.
 */
export const FLAGGED_ONLY_HIDDEN = new Set(['idling', 'warning', 'critical']);

/**
 * Count every bucket in one pass over the fleet.
 *
 * Six separate `.filter().length` calls walked a 597-unit array six times on
 * every SSE frame. This walks it once. The counts use the SAME predicate the
 * map's marker visibility uses, which is the contract that keeps a card
 * reading CRITICAL 3 above a map showing three units.
 */
export function countStatuses(vehicles) {
  const counts = Object.create(null);
  for (const s of STATUS_STATS) counts[s.key] = 0;
  for (const v of vehicles ?? []) {
    for (const s of STATUS_STATS) {
      if (matchesFilter(v, s.filterKey)) counts[s.key] += 1;
    }
  }
  return counts;
}
