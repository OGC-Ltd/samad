// Live feed read marks, per organisation, in this browser.
//
// One message read is ONE message read (operator 2026-10-19). The feed used to
// keep a single "last seen" time and move it to now whenever the panel opened
// or closed — and clicking a row closes it — so reading one line cleared every
// other unread line with it.
//
// Now a line is read when it is opened, and only "Mark all read" moves the
// line under which everything counts as read:
//
//   since  — everything at or before it is read ("Mark all read", or the first
//            visit's 24-hour floor)
//   ids    — the lines opened one at a time since then, each with WHEN it was
//            read: a line rewritten after that (`revisedAt`, set by the feed
//            merge in hooks/useFleetLive) is unread again. A parked fall's
//            call is rewritten by its verdict hours later (2026-10-22).
//
// The bell's badge counts every unread line, so it only goes once nothing is
// left to read; opening and closing the bell changes nothing (operator
// 2026-10-19).
//
// "Mark all read" empties the ids and the list is capped, so it stays small
// however long the tab stays open. Every open tab follows the marks the others
// save (the `storage` event), so a line read in one is read in all.

import { useCallback, useEffect, useState } from 'react';

/** Read lines remembered above the cut-off; the oldest marks fall off first. */
export const MAX_READ_IDS = 500;

const sinceKey = (org) => `ft-feed-seen:${org}`;
const idsKey   = (org) => `ft-feed-read:${org}`;

const msOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Newest marks only, oldest dropped first. */
const capped = (entries) => new Map(entries.slice(-MAX_READ_IDS));

/**
 * Whether a feed line is still unread. A line without a usable time is read,
 * and so is one `me` caused: an action is not news to whoever took it
 * (operator, 2026-10-27; the server names the actor as `actorId`).
 */
export function isUnread(item, reads, me) {
  if (me && item?.actorId === me) return false;
  const t = msOf(item?.ts);
  if (t == null) return false;
  const revised = msOf(item?.revisedAt);
  if (Math.max(t, revised ?? t) <= reads.since) return false;
  const readAt = item?.id != null ? reads.ids.get(item.id) : undefined;
  if (readAt == null) return true;
  return revised != null && revised > readAt;
}

/** Mark these lines read; everything else keeps its mark. */
export function withRead(reads, items, now = Date.now()) {
  const add = items.filter((it) => it?.id != null && isUnread(it, reads));
  if (!add.length) return reads;
  const kept = [...reads.ids].filter(([id]) => !add.some((it) => it.id === id));
  return { ...reads, ids: capped([...kept, ...add.map((it) => [it.id, now])]) };
}

/** "Mark all read": everything so far, and the single marks it covers go. */
export const allRead = (reads, now = Date.now()) => ({ since: now, ids: new Map() });

/**
 * Two copies of the marks (this tab's and another tab's) as one: the later
 * cut-off with its lines (an earlier cut-off's lines are all below it), both
 * sets of lines when the cut-offs agree.
 */
export function mergeReads(a, b) {
  const since = Math.max(a.since, b.since);
  const ids = new Map();
  for (const side of [a, b]) {
    if (side.since !== since) continue;
    for (const [id, at] of side.ids) ids.set(id, Math.max(at, ids.get(id) ?? 0));
  }
  return { since, ids: capped([...ids]) };
}

function load(org) {
  let since = 0;
  let ids = [];
  try {
    since = Number(localStorage.getItem(sinceKey(org))) || 0;
    const raw = JSON.parse(localStorage.getItem(idsKey(org)) ?? '[]');
    // [id, readAt] pairs; a bare id is a mark saved before read times were
    // kept, read at some time before any line could be revised.
    if (Array.isArray(raw)) {
      ids = raw
        .map((x) => (typeof x === 'string' ? [x, 0] : x))
        .filter((x) => Array.isArray(x) && typeof x[0] === 'string' && Number.isFinite(x[1]));
    }
  } catch { /* storage off */ }
  // Never opened in this browser → count only the last 24 hours, so a first
  // visit isn't greeted with every alert in the replayed history.
  since = since || Date.now() - 24 * 3600_000;
  return { since, ids: new Map(ids) };
}

function save(org, reads) {
  try {
    localStorage.setItem(sinceKey(org), String(reads.since));
    localStorage.setItem(idsKey(org), JSON.stringify([...reads.ids]));
  } catch { /* storage off */ }
}

/** The bell's and the panel's shared read marks for one organisation. */
export function useFeedReads(org) {
  const [reads, setReads] = useState(() => load(org));
  useEffect(() => { setReads(load(org)); }, [org]);

  // Another tab saved its marks: take them, so its next save cannot be
  // overwritten by this tab's older copy (or the other way round).
  useEffect(() => {
    const keys = new Set([sinceKey(org), idsKey(org)]);
    const onStorage = (e) => { if (e.key == null || keys.has(e.key)) setReads(load(org)); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [org]);

  const update = useCallback((next) => {
    setReads((cur) => {
      const n = next(cur);
      if (n === cur) return cur;
      // On top of what any other tab saved meanwhile, never over it.
      const merged = mergeReads(n, load(org));
      save(org, merged);
      return merged;
    });
  }, [org]);

  const markRead    = useCallback((...items) => update((cur) => withRead(cur, items)), [update]);
  const markAllRead = useCallback(() => update((cur) => allRead(cur)), [update]);
  return { reads, markRead, markAllRead };
}
