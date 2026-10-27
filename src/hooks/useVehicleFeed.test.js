import { describe, it, expect, vi } from 'vitest';
import { catchUp } from './useVehicleFeed';

// Pages of newest-first items, 3 to a page, minute-stamped.
const at = (m) => `2026-09-25T10:${String(m).padStart(2, '0')}:00.000Z`;
function pager(minutes, size = 3) {
  const all = minutes.map((m) => ({ id: `n${m}`, ts: at(m) }));
  return vi.fn(async (before) => {
    const from = before ? all.findIndex((i) => i.ts < before) : 0;
    const items = from < 0 ? [] : all.slice(from, from + size);
    const more = from >= 0 && from + size < all.length;
    return { items, nextBefore: more ? items[items.length - 1].ts : null };
  });
}

describe('catchUp', () => {
  it('reads back to the newest row already held, and stops', async () => {
    const fetchPage = pager([59, 58, 57, 56, 55, 54, 53, 52, 51, 50]);
    const { items, complete } = await catchUp(fetchPage, at(55));
    expect(complete).toBe(true);
    // Everything from 59 down to and including 55 is covered.
    for (const m of [59, 58, 57, 56, 55]) expect(items.map((i) => i.id)).toContain(`n${m}`);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('fills a gap wider than one page', async () => {
    const fetchPage = pager([59, 58, 57, 56, 55, 54, 53, 52, 51, 50]);
    const { items } = await catchUp(fetchPage, at(50));
    expect(items).toHaveLength(10);
  });

  it('stops at the end of the history', async () => {
    const fetchPage = pager([59, 58]);
    const { complete } = await catchUp(fetchPage, at(10));
    expect(complete).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxPages and says so, keeping what it read', async () => {
    const fetchPage = pager([59, 58, 57, 56, 55, 54, 53, 52, 51, 50]);
    const { items, complete } = await catchUp(fetchPage, at(0), 2);
    expect(complete).toBe(false);
    expect(items).toHaveLength(6);
  });
});
