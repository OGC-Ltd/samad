/*
 * One unit's feed — the vehicle panel's Alerts tab (2026-10-02, operator: "like
 * the live feed for a single unit, as in dash").
 *
 * The unit's notifications as the Live feed shows them: its live items on top
 * of its history from the server, paged back as the list is scrolled
 * (hooks/useVehicleFeed in unit scope — the same read dash's scoped feed
 * makes). The period narrows it: all history by default, or a range of fleet
 * days from the date picker, read by paging back from the range's end.
 *
 * Rows are the Live feed's (an icon for what happened, the sentence, the
 * time), grouped under sticky day headings because a unit's history spans
 * days where the fleet feed is one.
 */

import { Fragment, useEffect, useMemo, useRef } from 'react';
import { useFleetLiveShared } from '../../context/FleetLiveContext';
import FeedText from '../shared/FeedText';
import { feedClock } from '../../lib/feedTime';
import { driverIndex, driverFor } from '../../lib/feedDriver';
import { feedItemFollowUp, openFollowUp } from '../../lib/fuelFollowUps';
import { useVehicleFeed } from '../../hooks/useVehicleFeed';
import { feedKind } from './LiveFeed';
import './UnitFeed.scss';

const DAY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY_LABEL = new Intl.DateTimeFormat('en-KE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' });
const STAGGER_MAX = 8;

/** "Today", "Yesterday", or "Thu, 1 Oct" for a fleet day key. Exported for the test. */
export function dayHeading(key, todayKey) {
  if (key === todayKey) return 'Today';
  const y = new Date(Date.parse(`${todayKey}T12:00:00+03:00`) - 24 * 3600_000);
  if (key === DAY_KEY.format(y)) return 'Yesterday';
  return DAY_LABEL.format(new Date(`${key}T12:00:00+03:00`));
}

function Skeleton({ n }) {
  return Array.from({ length: n }, (_, i) => (
    <div key={i} className="uf-skel" aria-hidden="true"><span /><span><i /><i /></span></div>
  ));
}

/**
 * `vehicle` is the panel's unit; `range` null for all history, else
 * `{ from, to }` fleet days. `onEmpty` lets the tab draw its own empty and
 * error notes in the middle of the panel.
 */
export default function UnitFeed({ vehicle, range, todayKey, renderEmpty }) {
  const { feed: liveFeed = [], vehicles = [], orgId } = useFleetLiveShared();
  const { items, loading, loadingMore, atEnd, loadMore, error, retry } =
    useVehicleFeed(vehicle, orgId, liveFeed, range);
  const drivers = useMemo(() => driverIndex(vehicles), [vehicles]);

  /* Older pages load as the foot of the list comes into view. A sentinel
     rather than a scroll handler: the vehicle panel scrolls as a whole, so
     this list never scrolls on its own. */
  const footRef = useRef(null);
  const hasItems = items.length > 0;
  useEffect(() => {
    const el = footRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((es) => { if (es.some(x => x.isIntersecting)) loadMore(); }, { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, hasItems]);

  // Rows animate on the render that mounts them: the first page staggers in,
  // later pages fade up, live arrivals drop in at the top (as in LiveFeed).
  const seen = useRef(new Set());
  const newest = useRef('');
  const entry = useMemo(() => {
    const out = new Map();
    const first = seen.current.size === 0;
    let n = 0;
    for (const it of items) {
      if (it.id == null || seen.current.has(it.id)) continue;
      out.set(it.id, !first && String(it.ts) > newest.current ? { kind: 'arrive' } : { kind: 'append', i: Math.min(n++, STAGGER_MAX) });
    }
    return out;
  }, [items]);
  useEffect(() => {
    for (const id of entry.keys()) seen.current.add(id);
    for (const it of items) if (String(it.ts) > newest.current) newest.current = String(it.ts);
  }, [entry, items]);
  // A new unit or period is a new list: replay the first-page stagger.
  useEffect(() => { seen.current = new Set(); newest.current = ''; }, [vehicle?.vehicleId, range?.from, range?.to]);

  const groups = useMemo(() => {
    const out = [];
    for (const it of items) {
      const t = Date.parse(it.ts);
      const key = Number.isFinite(t) ? DAY_KEY.format(t) : 'unknown';
      if (out[out.length - 1]?.key !== key) out.push({ key, items: [] });
      out[out.length - 1].items.push(it);
    }
    return out;
  }, [items]);

  if (items.length === 0) {
    if (loading) return <div className="uf"><Skeleton n={6} /></div>;
    return renderEmpty({ error, retry });
  }

  const activate = (item) => {
    const followUp = feedItemFollowUp(item);
    if (typeof followUp === 'string') openFollowUp(followUp);
  };

  return (
    <div className="uf" role="feed" aria-busy={loadingMore}>
      {groups.map(g => (
        <section key={g.key} className="uf-day" aria-label={g.key === 'unknown' ? 'Undated' : dayHeading(g.key, todayKey)}>
          <header className="uf-day-head">
            <span>{g.key === 'unknown' ? 'Undated' : dayHeading(g.key, todayKey)}</span>
            <span className="uf-day-n">{g.items.length} update{g.items.length === 1 ? '' : 's'}</span>
          </header>
          {g.items.map((item, i) => {
            const { icon, tone } = feedKind(item);
            const opens = typeof feedItemFollowUp(item) === 'string';
            const e = entry.get(item.id);
            const Row = opens ? 'button' : 'div';
            return (
              <Fragment key={item.id ?? `${g.key}-${i}`}>
                <Row
                  {...(opens ? { type: 'button', onClick: () => activate(item) } : {})}
                  className={[
                    'uf-row',
                    `uf-row--${tone}`,
                    opens ? 'uf-row--link' : '',
                    e?.kind === 'arrive' ? 'uf-row--enter-top' : '',
                    e?.kind === 'append' ? 'uf-row--enter-page' : '',
                  ].filter(Boolean).join(' ')}
                  style={e?.kind === 'append' ? { '--i': e.i } : undefined}
                >
                  <span className="uf-icon" aria-hidden="true"><i className={`ti ti-${icon}`} /></span>
                  <span className="uf-msg">
                    <FeedText text={item.text} type={item.type} plate={item.plate} driver={driverFor(drivers, item)} />
                  </span>
                  <time className="uf-time" dateTime={item.ts}>{feedClock(item)}</time>
                </Row>
              </Fragment>
            );
          })}
        </section>
      ))}

      {loadingMore
        ? <Skeleton n={3} />
        : atEnd
          ? (
            <div className="uf-end">
              <i className="ti ti-circle-check" aria-hidden="true" />
              {range ? 'Nothing earlier in this period' : 'The start of this unit’s record'} · {items.length.toLocaleString()} update{items.length === 1 ? '' : 's'}
            </div>
          )
          : <button type="button" className="uf-more" onClick={loadMore}>Load older</button>}
      <span ref={footRef} className="uf-sentinel" aria-hidden="true" />
    </div>
  );
}
