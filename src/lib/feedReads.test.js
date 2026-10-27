/**
 * Live feed read marks. Written against a live bug (operator 2026-10-19):
 * reading one message cleared every other unread message with it.
 */

import { describe, it, expect } from 'vitest';
import { isUnread, withRead, allRead, mergeReads, MAX_READ_IDS } from './feedReads';
import { summariseUnread } from '../components/layout/AppHeader';

const SINCE = Date.parse('2026-10-19T06:00:00.000Z');
const line = (id, iso) => ({ id, ts: iso, type: 'info' });
const a = line('ya-1', '2026-10-19T06:10:00.000Z');
const b = line('zn-2', '2026-10-19T06:20:00.000Z');
const c = line('mg-3', '2026-10-19T06:30:00.000Z');
const fresh = { since: SINCE, ids: new Map() };

describe('feed read marks', () => {
  it('reading one line leaves the others unread', () => {
    const r = withRead(fresh, [b]);
    expect([a, b, c].map((x) => isUnread(x, r))).toEqual([true, false, true]);
    expect(summariseUnread([a, b, c], r).unreadCount).toBe(2);
  });

  it('a line at or before the cut-off is read, and so is one without a time', () => {
    expect(isUnread(line('old', '2026-10-19T06:00:00.000Z'), fresh)).toBe(false);
    expect(isUnread({ id: 'x', ts: 'not a date' }, fresh)).toBe(false);
  });

  it('reading an already-read line changes nothing', () => {
    const r = withRead(fresh, [a]);
    expect(withRead(r, [a])).toBe(r);
    expect(withRead(fresh, [line('old', '2026-10-19T05:00:00.000Z')])).toBe(fresh);
  });

  it('"Mark all read" reads everything so far and drops the single marks', () => {
    const r = allRead(fresh, Date.parse('2026-10-19T06:31:00.000Z'));
    expect(summariseUnread([a, b, c], r).unreadCount).toBe(0);
    expect(r.ids.size).toBe(0);
    expect(isUnread(line('next', '2026-10-19T06:40:00.000Z'), r)).toBe(true);
  });

  it('keeps only the newest marks', () => {
    let r = fresh;
    for (let i = 0; i < MAX_READ_IDS + 5; i++) r = withRead(r, [line(`n${i}`, '2026-10-19T07:00:00.000Z')]);
    expect(r.ids.size).toBe(MAX_READ_IDS);
    expect(r.ids.has('n0')).toBe(false);
    expect(r.ids.has(`n${MAX_READ_IDS + 4}`)).toBe(true);
  });
});

describe('a line rewritten after it was read', () => {
  // A parked fall's call is rewritten in place by its verdict hours later.
  const READ_AT = Date.parse('2026-10-19T06:35:00.000Z');
  const read = withRead(fresh, [a], READ_AT);
  const revised = (iso) => ({ ...a, text: 'POSSIBLE THEFT — FUEL STILL MISSING', revisedAt: iso });

  it('is unread again when the rewrite came after the read', () => {
    expect(isUnread(revised('2026-10-19T08:40:00.000Z'), read)).toBe(true);
    expect(summariseUnread([revised('2026-10-19T08:40:00.000Z'), b], read).unreadCount).toBe(2);
  });

  it('stays read when the rewrite was already there when it was read', () => {
    expect(isUnread(revised('2026-10-19T06:20:00.000Z'), read)).toBe(false);
  });

  it('is unread again after "Mark all read" too, when it is rewritten later', () => {
    const all = allRead(fresh, READ_AT);
    expect(isUnread(revised('2026-10-19T06:30:00.000Z'), all)).toBe(false);
    expect(isUnread(revised('2026-10-19T08:40:00.000Z'), all)).toBe(true);
  });

  it('reading it again takes the new read time', () => {
    const line = revised('2026-10-19T08:40:00.000Z');
    const again = withRead(read, [line], Date.parse('2026-10-19T08:45:00.000Z'));
    expect(isUnread(line, again)).toBe(false);
    expect(again.ids.size).toBe(1);
  });

  it('two tabs keep the later read time', () => {
    const line = revised('2026-10-19T08:40:00.000Z');
    const later = withRead(read, [line], Date.parse('2026-10-19T08:45:00.000Z'));
    expect(isUnread(line, mergeReads(read, later))).toBe(false);
    expect(isUnread(line, mergeReads(later, read))).toBe(false);
  });
});

describe('the bell badge', () => {
  it('counts every unread line, however old', () => {
    expect(summariseUnread([a, b, c], fresh).unreadCount).toBe(3);
    expect(summariseUnread([a, b, c], withRead(fresh, [a, c])).unreadCount).toBe(1);
  });

  it('goes only when nothing is left to read', () => {
    const r = withRead(withRead(fresh, [a, b]), [c]);
    expect(summariseUnread([a, b, c], r).unreadCount).toBe(0);
  });
});

describe('two tabs', () => {
  it('keeps the lines each tab read', () => {
    const tabA = withRead(fresh, [a]);
    const tabB = withRead(fresh, [c]);
    const both = mergeReads(tabB, tabA);
    expect([a, b, c].map((x) => isUnread(x, both))).toEqual([false, true, false]);
  });

  it('a "Mark all read" in one tab is not undone by the other', () => {
    const later = allRead(fresh, Date.parse('2026-10-19T06:31:00.000Z'));
    const stale = withRead(fresh, [a]);
    const both = mergeReads(stale, later);
    expect(both.since).toBe(later.since);
    expect(both.ids.size).toBe(0);
    expect(summariseUnread([a, b, c], both).unreadCount).toBe(0);
  });
});

describe('a line the viewer caused', () => {
  it('is read for them and unread for everyone else', () => {
    const fresh = { since: 0, ids: new Map() };
    const mine = { id: 'm', ts: '2026-10-27T06:00:00.000Z', actorId: 'u-1' };
    expect(isUnread(mine, fresh, 'u-1')).toBe(false);
    expect(isUnread(mine, fresh, 'u-2')).toBe(true);
    expect(isUnread(mine, fresh)).toBe(true);
    expect(summariseUnread([mine], fresh, 'u-1').unreadCount).toBe(0);
  });
});

