import { describe, it, expect } from 'vitest';
import {
  fuelEpisodes, drainKind, fillingKind, fuelRateKind, fuelRateDetail, levelsFromPings,
  FUEL_EVENT_KINDS, FUEL_EVENT_ORDER,
} from './fuelEpisodes';

// Every shape below is a real one, from MUFINDI units on 26 Sep 2026; times are
// minutes from the ledger's own timestamp.
const T = Date.parse('2026-09-26T08:30:19Z');
const at = (min) => T + min * 60_000;
const iso = (min) => new Date(at(min)).toISOString();
const line = (pairs) => pairs.map(([m, L]) => ({ t: at(m), ml: L * 1000 }));

const drain = (over) => ({
  id: 'd1', beganAt: iso(0), detectedAt: iso(4), verdict: 'DRAIN', drainCause: 'SIPHON',
  causeReason: null, fallSeconds: null, measuredDropMl: null, stolenMl: 20_000, ...over,
});
const fill = (over) => ({
  id: 'f1', filledAt: iso(0), verdict: 'REFILL', filledMl: 80_000, observedRiseMl: null, ...over,
});

describe('drainKind / fillingKind, the server decides, this only names it', () => {
  it('names the four kinds the chart shades, and the FUEL RATE finding', () => {
    expect(drainKind({ verdict: 'DRAIN', drainCause: 'SIPHON' })).toBe('theft');
    expect(drainKind({ verdict: 'DRAIN', drainCause: 'SLOSH' })).toBe('slosh');
    expect(drainKind({ verdict: 'DRAIN', drainCause: 'SETTLING' })).toBe('slosh');
    expect(drainKind({ verdict: 'REDISTRIBUTION', drainCause: null })).toBe('redistribution');
    expect(drainKind({ verdict: 'DRAIN', drainCause: 'UNEXPLAINED_BURN' })).toBe('drop');
    expect(fillingKind({ verdict: 'REFILL' })).toBe('refill');
    expect(fillingKind({ verdict: 'PENDING' })).toBe('refill');
    expect(fillingKind({ verdict: 'REDISTRIBUTION' })).toBe('redistribution');
  });

  it('shades nothing for a machine burning as expected, or a case nobody could decide', () => {
    for (const drainCause of ['ENGINE_BURN', 'HIGH_BURN', 'INDETERMINATE']) {
      expect(drainKind({ verdict: 'DRAIN', drainCause })).toBeNull();
    }
    expect(drainKind({ verdict: 'PENDING', drainCause: null })).toBeNull();
    expect(drainKind({ verdict: 'SENSOR_FAULT', drainCause: null })).toBeNull();
    expect(fillingKind({ verdict: 'SENSOR_FAULT' })).toBeNull();
  });
});

describe('fuelEpisodes, placed on the tank line', () => {
  it("covers a siphon's whole descent, not just the ledger's first step (FT 05)", () => {
    const levels = line([
      [-6, 285], [-2, 285], [0, 285], [2, 285], [4, 284], [6, 280], [8, 247], [10, 216], [12, 211],
      [14, 211], [16, 210], [17, 203], [19, 203], [21, 174], [23, 153], [25, 153], [27, 152],
      [29, 151], [31, 136], [33, 112], [35, 95], [37, 88], [39, 88], [45, 88], [55, 88],
    ]);
    const [e] = fuelEpisodes({ drains: [drain({ fallSeconds: 958, measuredDropMl: 132_000 })], levels });
    // 285 at +2 min and 284 at +4 is noise; the fall leaves the base after +4.
    expect(e).toMatchObject({ kind: 'theft', n: 1, litres: 132, start: at(4), end: at(37) });
  });

  it('runs a redistribution from the dip to where the level came back (EX 16)', () => {
    const levels = line([
      [-6, 275], [-4, 279], [-3, 273], [0, 272], [3, 272], [4, 257], [5, 254], [7, 246], [8, 246],
      [9, 273], [10, 273], [12, 267], [14, 270], [20, 268],
    ]);
    const [e] = fuelEpisodes({
      drains: [drain({ verdict: 'REDISTRIBUTION', drainCause: null, detectedAt: iso(2), stolenMl: 21_000 })],
      levels,
    });
    expect(e.kind).toBe('redistribution');
    expect(e.start).toBe(at(-4));
    expect(e.end).toBe(at(9));
  });

  it('finds a delivery that the ledger timed halfway through it (DZ 20)', () => {
    const levels = line([
      [-25, 127], [-20, 127], [-19, 127], [-18, 133], [-16, 158], [-14, 195], [-12, 231], [-10, 264],
      [-8, 291], [-6, 319], [-4, 358], [-2, 389], [0, 418], [2, 448], [4, 479], [6, 509], [9, 533],
      [10, 545], [13, 549], [16, 556], [20, 557], [25, 560], [30, 560],
    ]);
    const [e] = fuelEpisodes({ fillings: [fill({ filledMl: 432_000, observedRiseMl: 297_000 })], levels });
    expect(e).toMatchObject({ kind: 'refill', litres: 297, start: at(-19), end: at(10) });
  });

  it('starts a band where the rise began, not where the window did (GR 01)', () => {
    const levels = line([[-40, 204], [-10, 204], [-3, 205], [-1, 216], [1, 231], [3, 246], [6, 259], [9, 274], [13, 283], [18, 288], [25, 286]]);
    const [e] = fuelEpisodes({ fillings: [fill({ filledMl: 84_000, observedRiseMl: 84_000 })], levels });
    expect(e.start).toBe(at(-3));
    // 283 L at +13 min is 94% of the way; the delivery topped out at +18.
    expect(e.end).toBe(at(18));
  });

  it("keeps the ledger's times where the line shows no such move", () => {
    const flat = line([[-30, 200], [0, 200], [30, 200]]);
    const [e] = fuelEpisodes({ fillings: [fill()], levels: flat });
    expect([e.start, e.end]).toEqual([at(-1), at(1)]);
    const [d] = fuelEpisodes({ drains: [drain({ fallSeconds: 600 })], levels: [] });
    expect([d.start, d.end]).toEqual([at(0), at(10)]);
  });

  it('shades a slosh over the whole stretch the server measured moving', () => {
    const [e] = fuelEpisodes({ drains: [drain({ drainCause: 'SLOSH', fallSeconds: 8519 })], levels: [] });
    expect(e.kind).toBe('slosh');
    expect(e.end - e.start).toBe(8519 * 1000);
  });

  it('keeps the stretch the server measured for a FUEL DOWN, not the slosh around it (KDE 585S)', () => {
    // Driving off the pump on 27 Sep, the level swung by tens of litres from
    // one reading to the next, down to a single 41.8 L at 07:14:46. Placed on
    // the line, that spike stretched the band to 07:14; the alert said 06:46.
    const eat = (hms) => Date.parse(`2026-09-27T${hms}+03:00`);
    const levels = [
      ['06:44:21', 5.4], ['06:44:28', 95.7], ['06:46:32', 95.7], ['06:46:38', 105.7], ['06:47:48', 105.7],
      ['06:50:22', 79.3], ['06:50:44', 69.7], ['06:51:10', 84.4], ['06:55:21', 84.5], ['06:58:20', 72.7],
      ['07:01:53', 90.4], ['07:03:09', 69.0], ['07:03:38', 83.5], ['07:05:13', 54.0], ['07:06:28', 46.0],
      ['07:09:06', 81.0], ['07:14:01', 71.4], ['07:14:46', 41.8], ['07:15:06', 88.1], ['07:19:36', 81.4],
    ].map(([hms, L]) => ({ t: eat(hms), ml: L * 1000 }));
    const began = eat('06:46:29');
    const [e] = fuelEpisodes({
      drains: [drain({
        beganAt: new Date(began).toISOString(), detectedAt: new Date(began).toISOString(),
        drainCause: 'UNEXPLAINED_BURN', causeReason: 'drop-exceeds-distance', fallSeconds: 1045,
        measuredDropMl: 26_872, recoveredMl: 10_141, stolenMl: 16_590, fallDistanceKm: 3.188,
      })],
      levels,
    });
    // The alert's own figure, 16.6 L: 26.9 L fell and 10.1 L came back.
    expect(e).toMatchObject({ kind: 'drop', label: 'FUEL DOWN', start: began, end: eat('07:03:54'), litres: 16.59 });
    expect(e.detail).toBe('Fell more than the 3.2 km driven accounts for (26.9 L down, 10.1 L back)');
  });

  it('shades one dip the provider reported twice as one event (COMP 01, 17:01)', () => {
    const levels = line([[-10, 250], [0, 250], [3, 239], [5, 238], [7, 250], [15, 250]]);
    const eps = fuelEpisodes({
      drains: [
        drain({ id: 'a', verdict: 'REDISTRIBUTION', drainCause: null, stolenMl: 11_000 }),
        drain({ id: 'b', verdict: 'REDISTRIBUTION', drainCause: null, beganAt: iso(1), stolenMl: 12_000 }),
      ],
      levels,
    });
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ kind: 'redistribution', litres: 12, reports: 2, n: 1 });
    // Both reports still find their band
    expect(eps[0].ids).toEqual(['drain-a', 'drain-b']);
  });

  it('keeps two different events that only touch', () => {
    const eps = fuelEpisodes({
      drains: [drain({ id: 'a', fallSeconds: 600 }), drain({ id: 'b', beganAt: iso(8), fallSeconds: 600 })],
    });
    expect(eps).toHaveLength(2);
  });

  it('numbers every event by when it started, drains and fillings together', () => {
    const eps = fuelEpisodes({
      drains: [drain({ id: 'late', beganAt: iso(60) }), drain({ id: 'early', beganAt: iso(-60), drainCause: 'SLOSH' })],
      fillings: [fill({ id: 'mid' })],
    });
    expect(eps.map(e => [e.n, e.id])).toEqual([[1, 'drain-early'], [2, 'fill-mid'], [3, 'drain-late']]);
  });
});

describe('fuelEpisodes, wording', () => {
  it('names a FUEL RATE or FUEL DOWN band the way its alert is headed', () => {
    const one = (causeReason) =>
      fuelEpisodes({ drains: [drain({ drainCause: 'UNEXPLAINED_BURN', causeReason })] })[0];
    expect(one('burn-far-above-band').label).toBe('FUEL RATE');
    expect(one('burn-above-class-ceiling').label).toBe('FUEL RATE');
    expect(one('drop-while-stationary').label).toBe('FUEL DOWN');
    expect(one('drop-exceeds-distance').label).toBe('FUEL DOWN');
    // No announced reason: the kind's own name stands
    expect(one(null).label).toBeUndefined();
    expect(fuelRateKind('burn-within-band')).toBeNull();
  });

  it('says what each rule measured', () => {
    expect(fuelRateDetail({ causeReason: 'burn-far-above-band', impliedLph: 61.7 }))
      .toBe('Fell at 62 L/h, faster than this machine is measured to burn');
    expect(fuelRateDetail({ causeReason: 'drop-while-stationary' })).toBe('Fell while standing, with nothing driven');
    expect(fuelRateDetail({ causeReason: 'drop-exceeds-distance' })).toBe('Fell more than the distance driven accounts for');
    // Nothing came back: no down/back figures
    expect(fuelRateDetail({ causeReason: 'drop-while-stationary', measuredDropMl: 12_000, recoveredMl: 0 }))
      .toBe('Fell while standing, with nothing driven');
  });

  it('uses the word theft only as the siphon kind\'s label, qualified', () => {
    expect(FUEL_EVENT_KINDS.theft.label).toBe('Possible theft');
    const eps = fuelEpisodes({
      drains: ['SIPHON', 'SLOSH', 'SETTLING', 'UNEXPLAINED_BURN'].map((drainCause, i) => drain({ id: String(i), drainCause }))
        .concat(drain({ id: 'r', verdict: 'REDISTRIBUTION', drainCause: null })),
      fillings: [fill(), fill({ id: 'p', verdict: 'PENDING' }), fill({ id: 'x', verdict: 'REDISTRIBUTION' })],
    });
    for (const e of eps) expect(e.detail).not.toMatch(/theft|stolen|loss|lost/i);
    for (const k of FUEL_EVENT_ORDER.filter(k => k !== 'theft')) expect(FUEL_EVENT_KINDS[k].label).not.toMatch(/theft/i);
  });

  it('marks a refill nobody has checked yet', () => {
    const [e] = fuelEpisodes({ fillings: [fill({ verdict: 'PENDING' })] });
    expect(e.pending).toBe(true);
    expect(e.detail).toMatch(/not yet checked/);
  });
});

describe('levelsFromPings', () => {
  it('keeps only readings with a level', () => {
    expect(levelsFromPings([{ t: 1, fuelLevelMl: 5 }, { t: 2, fuelLevelMl: null }, { t: 3 }]))
      .toEqual([{ t: 1, ml: 5 }]);
  });
});
