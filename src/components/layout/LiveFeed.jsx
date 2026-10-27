// LiveFeed — slides in from the right edge.
// The whole fleet day, continuous: the server's record of today paged as it is
// scrolled, with the live stream on top and no gap between them (see
// hooks/useVehicleFeed). Idle while closed.
//
// Redesigned 2026-10-02 (Hallmark, component scope):
//
//   · Unread is real, line by line (lib/feedReads, AppHeader passes `reads`).
//     Everything newer than the last "Mark all read" sits under a "New"
//     heading, with "Earlier today" below; a line not yet opened is tinted,
//     with an accent edge and a dot. Opening a line reads THAT line only
//     (operator 2026-10-19: one read used to clear the lot).
//   · Rows: an icon for what happened (arrived, left, refuelled, alert), the
//     plate with its clock time beside it, the sentence under. The date is
//     gone from every row: this feed is one fleet day.
//   · Arrivals animate in at the top. Scrolled away from the top, they are
//     held behind a "N new" pill rather than shoving the row being read.
//   · Paging: skeleton rows while an older page loads, then the page fades
//     in with a short stagger. All motion collapses under reduced-motion.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFleetLiveShared } from '../../context/FleetLiveContext';
import { useMapLayers } from '../../context/MapLayersContext';
import FeedText from '../shared/FeedText';
import { feedClock } from '../../lib/feedTime';
import { driverIndex, driverFor } from '../../lib/feedDriver';
import { feedItemFollowUp, openFollowUp } from '../../lib/fuelFollowUps';
import { useVehicleFeed } from '../../hooks/useVehicleFeed';
import { usePermissions } from '../../hooks/usePermissions';
import { isUnread } from '../../lib/feedReads';
import { useAuth } from '../../context/AuthContext';
import { nearBottom } from '../shared/FeedFooter';
import './LiveFeed.css';

// Server feed types: info | success | warning | critical
const ALERT_TYPES = new Set(['warning', 'critical']);
/** Rows from a page that fade in one after another; the rest arrive at once. */
const STAGGER_MAX = 8;
/** Within this many px of the top, arrivals show in place. */
const AT_TOP_PX = 48;

/** What happened, as an icon and a tone. Exported for the test. */
export function feedKind(item) {
  const text = String(item?.text ?? '');
  // Repair workflow notices (repair, repair_flag, repair_ticket, repair_verified)
  // wear maintenance tools whatever their wording: "ticket" in a repair line
  // drew the weighbridge scale (operator, 2026-10-27). Severity keeps its tone.
  if (String(item?.source ?? '').startsWith('repair')) {
    return { icon: 'tools', tone: item?.type === 'critical' ? 'critical' : item?.type === 'warning' ? 'warning' : 'depart' };
  }
  if (item?.type === 'critical') return { icon: 'alert-octagon', tone: 'critical' };
  if (item?.type === 'warning') return { icon: 'alert-triangle', tone: 'warning' };
  if (/refuel|fill(ed|ing)?\b/i.test(text)) return { icon: 'gas-station', tone: 'fuel' };
  if (/\barrived\b/i.test(text)) return { icon: 'map-pin-check', tone: 'arrive' };
  if (/\b(left|departed|dispatched)\b/i.test(text)) return { icon: 'arrow-up-right', tone: 'depart' };
  if (/weigh|ticket|tonne/i.test(text)) return { icon: 'scale', tone: 'depart' };
  return { icon: 'point', tone: 'depart' };
}

const tsOf = (item) => {
  const t = Date.parse(item?.ts);
  return Number.isFinite(t) ? t : null;
};

function SkeletonRows({ n }) {
  return Array.from({ length: n }, (_, i) => (
    <div key={i} className="live-feed__skeleton" aria-hidden="true">
      <span className="live-feed__sk-icon" />
      <span className="live-feed__sk-lines"><span /><span /></span>
    </div>
  ));
}

const NO_READS = { reads: { since: Date.now(), ids: new Map() }, markRead: () => {}, markAllRead: () => {} };

export default function LiveFeed({ open, onClose, reads: marks = NO_READS }) {
  const { feed: liveFeed = [], vehicles = [], orgId } = useFleetLiveShared();
  // A technician's feed is their repair notices, kept past midnight.
  const { flaggedOnly } = usePermissions();
  const { items: feed, loading, loadingMore, atEnd, loadMore } = useVehicleFeed(null, open ? orgId : null, liveFeed, null, { allDays: flaggedOnly });
  const { focusVehicle } = useMapLayers();
  const drivers = useMemo(() => driverIndex(vehicles), [vehicles]);
  const alerts  = feed.filter(f => ALERT_TYPES.has(f.type)).length;

  // "New" is everything since the last "Mark all read"; within it, each line
  // is unread until it is opened.
  const { reads, markRead, markAllRead } = marks;
  const isNew = (item) => { const t = tsOf(item); return t != null && t > reads.since; };
  const me = useAuth().user?.id;
  const unread = (item) => isUnread(item, reads, me);
  const newCount = feed.filter(unread).length;
  const firstOld = feed.findIndex((it) => !isNew(it));

  /* ── How each row entered ─────────────────────────────────────────────────
     `seen` holds every id already drawn. A row not in it is either an arrival
     (newer than the newest drawn row: it goes on top) or part of an older
     page (it goes at the bottom). Committed after paint, so a row animates on
     the render that mounts it and never again. */
  const seen = useRef(new Set());
  const newestDrawn = useRef(0);
  const listRef = useRef(null);
  const [heldNew, setHeldNew] = useState(0);

  const entry = useMemo(() => {
    const out = new Map();
    const first = seen.current.size === 0;
    let appended = 0;
    for (const it of feed) {
      const id = it.id;
      if (id == null || seen.current.has(id)) continue;
      const t = tsOf(it) ?? 0;
      if (!first && t > newestDrawn.current) out.set(id, { kind: 'arrive' });
      else out.set(id, { kind: 'append', i: Math.min(appended++, STAGGER_MAX) });
    }
    return out;
  }, [feed]);

  useLayoutEffect(() => {
    let arrivals = 0;
    for (const [id, e] of entry) { seen.current.add(id); if (e.kind === 'arrive') arrivals++; }
    for (const it of feed) { const t = tsOf(it); if (t && t > newestDrawn.current) newestDrawn.current = t; }
    // Arrivals while the reader is down the list: hold them behind the pill,
    // and keep the row they were reading where it was.
    const el = listRef.current;
    if (arrivals && el && el.scrollTop > AT_TOP_PX) setHeldNew((n) => n + arrivals);
  }, [entry, feed]);

  // A closed panel starts over: next open replays the first-page stagger.
  useEffect(() => {
    if (open) return;
    seen.current = new Set();
    newestDrawn.current = 0;
    setHeldNew(0);
  }, [open]);

  const onScroll = (e) => {
    if (heldNew && e.currentTarget.scrollTop <= AT_TOP_PX) setHeldNew(0);
    nearBottom(loadMore)(e);
  };
  const toTop = () => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    listRef.current?.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    setHeldNew(0);
  };

  const activate = (item) => {
    markRead(item);
    const followUp = feedItemFollowUp(item);
    if (typeof followUp === 'string') openFollowUp(followUp);
    else if (item.vehicleId) focusVehicle?.(item.vehicleId);
  };

  const sub = [
    newCount > 0 ? `${newCount} new` : null,
    alerts > 0 ? `${alerts} alert${alerts > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ') || 'All clear';

  return (
    <div className={`live-feed${open ? ' live-feed--open' : ''}`} aria-hidden={!open}>

      <div className="live-feed__top">
        <div className="live-feed__heading">
          <div className="live-feed__title">
            Live feed
            {open && <span className="live-feed__live" title="Updates as they happen"><span />Live</span>}
          </div>
          <div className="live-feed__sub">{sub}</div>
        </div>
        <div className="live-feed__top-actions">
          {newCount > 0 && (
            <button type="button" className="live-feed__mark-read" onClick={markAllRead}>
              Mark all read
            </button>
          )}
          <button type="button" className="live-feed__close" onClick={onClose} aria-label="Close live feed" title="Close">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="live-feed__scroll">
        {heldNew > 0 && (
          <button type="button" className="live-feed__pill" onClick={toTop}>
            <i className="ti ti-arrow-up" aria-hidden="true" /> {heldNew} new
          </button>
        )}

        <div className="live-feed__list" ref={listRef} onScroll={onScroll} role="feed" aria-busy={loading || loadingMore}>
          {feed.length === 0 && (loading
            ? <SkeletonRows n={6} />
            : (
              <div className="live-feed__empty">
                <span className="live-feed__empty-icon" aria-hidden="true"><i className="ti ti-bell-check" /></span>
                <div className="live-feed__empty-title">{flaggedOnly ? 'No Repair Notifications' : 'Nothing Yet Today'}</div>
                <p>{flaggedOnly
                  ? 'Units reported for repair, and every step of their jobs, show here.'
                  : 'Arrivals, departures, fuel and alerts show here as they happen.'}</p>
              </div>
            ))}

          {feed.map((item, i) => {
            const fresh = unread(item);
            const { icon, tone } = feedKind(item);
            const followUp = feedItemFollowUp(item);
            const link = typeof followUp === 'string' || Boolean(item.vehicleId);
            // An unread line with nowhere to go still opens: to read it.
            const clickable = link || fresh;
            const e = entry.get(item.id);
            const heading = i === 0 && isNew(item)
              ? (newCount > 0 ? `New · ${newCount}` : 'New')
              : i === firstOld && firstOld > 0 ? (flaggedOnly ? 'Earlier' : 'Earlier today') : null;
            return (
              <div key={item.id ?? i} role="article" aria-label={`${item.plate ?? 'Fleet'}, ${feedClock(item)}`}>
                {heading && <div className={`live-feed__group${i === 0 && isNew(item) ? ' live-feed__group--new' : ''}`}>{heading}</div>}
                <div
                  className={[
                    'live-feed__item',
                    `live-feed__item--${tone}`,
                    fresh ? 'live-feed__item--unread' : '',
                    link ? 'live-feed__item--link' : '',
                    e?.kind === 'arrive' ? 'live-feed__item--enter-top' : '',
                    e?.kind === 'append' ? 'live-feed__item--enter-page' : '',
                  ].filter(Boolean).join(' ')}
                  style={e?.kind === 'append' ? { '--i': e.i } : undefined}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => activate(item) : undefined}
                  onKeyDown={clickable ? (ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(item); }
                  } : undefined}
                >
                  <span className="live-feed__icon" aria-hidden="true"><i className={`ti ti-${icon}`} /></span>
                  <div className="live-feed__body">
                    <div className="live-feed__row1">
                      <span className="live-feed__plate">{item.plate ?? 'Fleet'}</span>
                      <time className="live-feed__time" dateTime={item.ts}>{feedClock(item)}</time>
                    </div>
                    <div className="live-feed__msg">
                      <FeedText text={item.text} type={item.type} plate={item.plate} driver={driverFor(drivers, item)} />
                    </div>
                  </div>
                  {fresh && <span className="live-feed__unread-dot" aria-label="Unread" />}
                </div>
              </div>
            );
          })}

          {feed.length > 0 && (loadingMore
            ? <SkeletonRows n={3} />
            : atEnd
              ? (
                <div className="live-feed__end">
                  <i className="ti ti-circle-check" aria-hidden="true" />
                  That is everything logged{flaggedOnly ? '' : ' today'} · {feed.length.toLocaleString()} update{feed.length === 1 ? '' : 's'}
                </div>
              )
              : <button type="button" className="live-feed__more" onClick={loadMore}>Load older</button>)}
        </div>
      </div>
    </div>
  );
}
