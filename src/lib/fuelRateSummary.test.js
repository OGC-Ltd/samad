import { describe, it, expect } from 'vitest';
import { fuelRateFindings, fuelRateSummaryText } from './fuelRateSummary';

// KDE 585S (West Kenya Sugar) on 27 Sep 2026, as the ledger holds it: the
// FUEL DOWN posted at 06:46 for 16.6 L.
const row = (over) => ({
  id: 'kde', beganAt: '2026-09-27T03:46:29.000Z', detectedAt: '2026-09-27T03:46:29.000Z',
  verdict: 'DRAIN', drainCause: 'UNEXPLAINED_BURN', causeReason: 'drop-exceeds-distance',
  stolenMl: 16_590, measuredDropMl: 26_872, recoveredMl: 10_141, fallDistanceKm: 3.188,
  dismissedAt: null, ...over,
});

describe('fuelRateFindings, what the daily summary counts', () => {
  it("takes the announced reasons, oldest first, at the alert's time and with its litres", () => {
    const f = fuelRateFindings([
      row({ id: 'late', beganAt: '2026-09-27T09:00:00.000Z', causeReason: 'burn-far-above-band', stolenMl: 14_800 }),
      row(),
    ]);
    expect(f.map(x => [x.id, x.kind, x.litres])).toEqual([['kde', 'FUEL DOWN', 16.59], ['late', 'FUEL RATE', 14.8]]);
    expect(f[0].at).toBe(Date.parse('2026-09-27T03:46:29.000Z'));
    expect(f[0].detail).toBe('Fell more than the 3.2 km driven accounts for (26.9 L down, 10.1 L back)');
  });

  it('leaves out a siphon and anything that is never announced', () => {
    expect(fuelRateFindings([
      // A possible theft still goes out as it happens, never in the summary
      row({ id: 'siphon', drainCause: 'SIPHON', causeReason: 'drop-while-stationary' }),
      row({ id: 'burn', drainCause: 'ENGINE_BURN', causeReason: 'burn-within-band' }),
      row({ id: 'none', causeReason: null }),
      row({ id: 'undated', beganAt: null, detectedAt: null }),
    ])).toEqual([]);
  });

  it('keeps a dismissed one, marked, since its band is still on the chart', () => {
    const [f] = fuelRateFindings([row({
      dismissedAt: '2026-09-27T04:37:37.663Z', dismissedBy: { id: 'u', fullName: 'Administrator' },
    })]);
    expect(f).toMatchObject({
      dismissed: true, dismissedBy: 'Administrator', dismissedAt: Date.parse('2026-09-27T04:37:37.663Z'),
    });
    expect(fuelRateFindings([row()])[0].dismissed).toBe(false);
  });
});

describe('fuelRateSummaryText', () => {
  it("reads like the fleet's daily summary, for one machine", () => {
    expect(fuelRateSummaryText(fuelRateFindings([row()]))).toBe(
      "1 drop beyond what this machine's measured burn or distance accounts for (1 FUEL DOWN), 16.6 L in all.",
    );
    expect(fuelRateSummaryText(fuelRateFindings([
      row({ id: 'a', causeReason: 'burn-above-class-ceiling', stolenMl: 14_800 }),
      row({ id: 'b' }),
      row({ id: 'c', causeReason: 'drop-while-stationary', stolenMl: 9_000 }),
    ]))).toBe(
      "3 drops beyond what this machine's measured burn or distance accounts for (1 FUEL RATE, 2 FUEL DOWN), 40.4 L in all.",
    );
  });

  it('says how many were dismissed', () => {
    const gone = { dismissedAt: '2026-09-27T04:37:37.663Z' };
    const text = (rows) => fuelRateSummaryText(fuelRateFindings(rows));
    expect(text([row(gone)])).toMatch(/16\.6 L in all\. It was dismissed\.$/);
    expect(text([row({ id: 'a', ...gone }), row({ id: 'b', ...gone })])).toMatch(/ All were dismissed\.$/);
    expect(text([row({ id: 'a', ...gone }), row({ id: 'b' }), row({ id: 'c' })])).toMatch(/ 1 of them was dismissed\.$/);
  });

  it('says nothing for a clean day, and never the word theft', () => {
    expect(fuelRateSummaryText([])).toBeNull();
    const text = fuelRateSummaryText(fuelRateFindings([row(), row({ id: 'r', causeReason: 'burn-far-above-band' })]));
    expect(text).not.toMatch(/theft|stolen|loss|lost/i);
  });
});
