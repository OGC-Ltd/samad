import { describe, it, expect } from 'vitest';
import {
  segmentTrack, edgeLevels, engineMs, buildFuelReport, chartSeries, durationLabel, PARKING_MS, smoothFuel,
} from './fuelReport';

const MIN = 60_000;
const T0 = Date.parse('2026-09-30T03:00:00Z');

/** One reading a minute. `moving` advances ~500 m north per minute. */
function track(spec) {
  const out = [];
  let t = T0;
  let lat = -0.82;
  for (const [n, kind, fuelL, engine = kind !== 'off'] of spec) {
    for (let i = 0; i < n; i++) {
      if (kind === 'move') lat += 0.0045;
      out.push({ t, lat, lng: 34.38, speedKmh: kind === 'move' ? 30 : 0, engineOn: engine, fuelLevelMl: fuelL * 1000 });
      t += MIN;
    }
  }
  return out;
}

describe('segmentTrack', () => {
  it('cuts the track into trips, stops and parkings', () => {
    const s = segmentTrack(track([[10, 'move', 100], [3, 'idle', 99], [10, 'move', 98], [20, 'off', 97]]));
    expect(s.map((x) => x.kind)).toEqual(['trip', 'stop', 'trip', 'parking']);
    expect(s[0].distanceKm).toBeGreaterThan(4);
    expect(s[3].durationMs).toBeGreaterThanOrEqual(PARKING_MS);
  });

  it('ends an interval at a gap in the readings rather than bridging it', () => {
    const a = track([[10, 'off', 100]]);
    const b = track([[10, 'off', 100]]).map((p) => ({ ...p, t: p.t + 3 * 3600_000 }));
    const s = segmentTrack([...a, ...b]);
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.durationMs < 3600_000)).toBe(true);
  });
});

describe('edgeLevels', () => {
  it('takes the median of the first and last readings, not a sloshed single one', () => {
    const p = track([[7, 'off', 100], [7, 'off', 80]]);
    p[0].fuelLevelMl = 140_000; // one slosh spike
    expect(edgeLevels(p)).toEqual({ start: 100, end: 80 });
  });
});

describe('engineMs', () => {
  it('sums engine-on time between readings', () => {
    expect(engineMs(track([[61, 'idle', 50]]))).toBe(60 * MIN);
    expect(engineMs(track([[61, 'off', 50]]))).toBe(0);
  });
});

describe('buildFuelReport', () => {
  it('balances the tank: start + filled − end − thefts', () => {
    const pings = track([[10, 'move', 100], [30, 'off', 90], [10, 'move', 150], [10, 'off', 140]]);
    const r = buildFuelReport({
      pings,
      fillings: [{ id: 'f1', filledAt: new Date(T0 + 40 * MIN).toISOString(), filledMl: 60_000, verdict: 'REFILL', initialFuelLevelMl: 90_000, finalFuelLevelMl: 150_000 }],
      drains: [
        { id: 'd1', beganAt: new Date(T0 + 20 * MIN).toISOString(), stolenMl: 5_000, verdict: 'DRAIN', drainCause: 'SIPHON' },
        { id: 'd2', beganAt: new Date(T0 + 50 * MIN).toISOString(), stolenMl: 8_000, verdict: 'DRAIN', drainCause: 'SLOSH' },
      ],
    });
    expect(r.stats.fuelStartL).toBe(100);
    expect(r.stats.fuelEndL).toBe(140);
    expect(r.stats.filledL).toBe(60);
    expect(r.stats.theftL).toBe(5);       // the slosh is not subtracted
    expect(r.stats.consumedL).toBe(15);   // 100 + 60 − 140 − 5
    expect(r.stats.fillingCount).toBe(1);
    expect(r.stats.drainCount).toBe(2);
    expect(r.stats.tripCount).toBe(2);
    expect(r.drains[0].theft).toBe(true);
  });

  it('leaves out a filling the server judged a redistribution', () => {
    const r = buildFuelReport({
      pings: track([[10, 'off', 50]]),
      fillings: [{ id: 'f', filledAt: new Date(T0).toISOString(), filledMl: 9000, verdict: 'REDISTRIBUTION' }],
    });
    expect(r.stats.filledL).toBe(0);
  });
});

describe('chartSeries', () => {
  it('keeps a short dip that a stride would have cut out', () => {
    const p = track([[3000, 'off', 100]]);
    p[1501].fuelLevelMl = 60_000;
    const s = chartSeries(p, 300);
    expect(s.length).toBeLessThanOrEqual(400);
    expect(Math.min(...s.map((x) => x.fuelL))).toBe(60);
  });

  it('carries the engine as 1 / 0 and keeps every on and off through the thinning', () => {
    // Engine on for a few minutes, twice, inside an otherwise idle day.
    const p = track([[1000, 'off', 100], [7, 'idle', 100], [1000, 'off', 100], [3, 'idle', 100], [990, 'off', 100]]);
    const s = chartSeries(p, 300);
    expect(s.length).toBeLessThan(p.length);
    const steps = s.filter((x, i) => i > 0 && x.engineOn !== s[i - 1].engineOn).map((x) => [x.t, x.engineOn]);
    expect(steps).toEqual([[p[1000].t, 1], [p[1007].t, 0], [p[2007].t, 1], [p[2010].t, 0]]);
    expect(chartSeries([{ t: 1, engineOn: undefined }])[0].engineOn).toBeNull();
  });
});

describe('durationLabel', () => {
  it('reads like the yard says it', () => {
    expect(durationLabel(45 * MIN)).toBe('45m');
    expect(durationLabel(125 * MIN)).toBe('2h 05m');
  });
});

describe('dead probe readings', () => {
  it('are not a level: the end of the day is the last real reading', () => {
    const p = track([[20, 'off', 15]]);
    for (let i = 14; i < 20; i++) p[i].fuelLevelMl = 96; // probe died
    expect(edgeLevels(p).end).toBe(15);
    expect(chartSeries(p).slice(-1)[0].fuelL).toBeNull();
  });
});

describe('a drop that ends on a dead probe', () => {
  it('is listed as a probe dropout and not taken off the balance', () => {
    const p = track([[14, 'off', 18.5], [6, 'off', 15.2]]);
    const r = buildFuelReport({
      pings: p,
      drains: [{ id: 'x', beganAt: new Date(T0 + 19 * MIN).toISOString(), stolenMl: 15_100,
                 initialFuelLevelMl: 15_200, finalFuelLevelMl: 120, verdict: 'DRAIN', drainCause: 'SIPHON' }],
    });
    expect(r.drains[0]).toMatchObject({ probeDropout: true, theft: false });
    expect(r.stats.theftL).toBe(0);
    expect(r.stats.consumedL).toBeCloseTo(3.3, 5);
  });
});

describe('the balance', () => {
  it('closes on the figures as shown, to the tenth of a litre', () => {
    const p = track([[10, 'off', 665.04], [10, 'off', 279.06]]);
    const r = buildFuelReport({
      pings: p,
      fillings: [{ id: 'f', filledAt: new Date(T0 + 5 * MIN).toISOString(), filledMl: 128_040, verdict: 'REFILL' }],
      drains: [{ id: 'd', beganAt: new Date(T0 + 12 * MIN).toISOString(), stolenMl: 24_140, verdict: 'DRAIN', drainCause: 'SIPHON' }],
    });
    const s = r.stats;
    expect(Math.round((s.fuelStartL + s.filledL + s.unrecordedL - s.theftL - s.consumedL) * 10) / 10).toBe(s.fuelEndL);
  });

  it('names a rise no filling explains instead of clamping it away', () => {
    const r = buildFuelReport({ pings: track([[10, 'off', 50], [10, 'off', 80]]) });
    expect(r.stats.consumedL).toBe(0);
    expect(r.stats.unrecordedL).toBe(30);
  });
});

describe("smoothFuel (processed fuel level)", () => {
  const pts = (vals) => vals.map((v, i) => ({ t: i * 30_000, fuelL: v }));
  it("drops a one-reading spike and keeps a step where it is", () => {
    const out = smoothFuel(pts([100, 100, 100, 160, 100, 100, 100, 50, 50, 50, 50, 50]));
    expect(out[3].fuelSmoothL).toBe(100);
    expect(out[1].fuelSmoothL).toBe(100);
    expect(out[11].fuelSmoothL).toBe(50);
  });
  it("leaves a reading with no level empty", () => {
    const out = smoothFuel(pts([100, null, 100]));
    expect(out[1].fuelSmoothL).toBeNull();
    expect(out[0].fuelSmoothL).toBe(100);
  });
});
