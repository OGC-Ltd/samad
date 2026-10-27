// A unit's journey so far today — where and when it set off, and the ground
// covered since, and its burn rate (lib/vehicleDay journeySoFar) — for the
// unit card.
//
// `load` is for a card somebody has clicked. It reads the fleet day through
// loadDay, which the vehicle panel opening beside it shares — one request for
// the two — and re-reads the tail every minute while the card stays up. A
// hover card passes `load` false and only shows what is already held, so
// sweeping the pointer across a yard does not fire a request per unit.
//
// Null until the day is to hand.

import { useEffect, useMemo, useState } from 'react';
import { cachedDay, journeySoFar, loadDay } from '../lib/vehicleDay';
import { fleetDayKey } from './useFuelEvents';

const REFRESH_MS = 60_000;

export function useJourneySoFar(orgId, vehicleId, load = false, tankL = null) {
  const day = fleetDayKey();
  const held = () => (orgId && vehicleId ? cachedDay(orgId, vehicleId, day)?.pings ?? null : null);
  const [pings, setPings] = useState(held);

  useEffect(() => {
    setPings(held());
    if (!load || !orgId || !vehicleId) return undefined;
    let live = true;
    const pull = () => loadDay(orgId, vehicleId, day)
      .then((r) => { if (live) setPings(r.pings); })
      .catch(() => { /* keep what is shown; the next minute tries again */ });
    pull();
    const timer = setInterval(pull, REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, vehicleId, day, load]);

  return useMemo(() => (pings ? journeySoFar(pings, tankL) : null), [pings, tankL]);
}
