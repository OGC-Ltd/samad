import { describe, it, expect } from 'vitest';
import { mergeFeedItem } from './useFleetLive';

const ts = new Date(Date.now() - 3600_000).toISOString();
const call = { id: 'fuel-watch-veh_1-1', ts, type: 'critical', text: 'POSSIBLE THEFT — FUEL DRAINED FROM A PARKED MACHINE' };
const NOW = Date.parse('2026-10-22T08:40:00.000Z');

describe('a feed line written again', () => {
  it('carries revisedAt when its verdict rewrites it', () => {
    const [line] = mergeFeedItem([call], { ...call, text: 'POSSIBLE THEFT — FUEL STILL MISSING' }, NOW);
    expect(line.revisedAt).toBe(new Date(NOW).toISOString());
  });

  it('does not, for a replay of the same line', () => {
    expect(mergeFeedItem([call], { ...call }, NOW)[0].revisedAt).toBeUndefined();
  });

  it('keeps the earlier revision through a replay', () => {
    const revised = mergeFeedItem([call], { ...call, type: 'info', text: 'Retracted' }, NOW);
    const replay = mergeFeedItem(revised, { ...call, type: 'info', text: 'Retracted' }, NOW + 60_000);
    expect(replay[0].revisedAt).toBe(new Date(NOW).toISOString());
  });

  it('does not, for a line seen for the first time', () => {
    expect(mergeFeedItem([], call, NOW)[0].revisedAt).toBeUndefined();
  });
});
