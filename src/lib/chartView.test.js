import { describe, it, expect } from 'vitest';
import { zoomView, panView, isWholeDay, wheelPixels, zoomFactor } from './chartView';

const H = 3_600_000;
const DAY = [0, 24 * H];
const MIN = 5 * 60_000;

describe('zoomView', () => {
  it('keeps the time under the pointer where it was', () => {
    const at = 6 * H;
    const [a, b] = zoomView(DAY, DAY, at, 0.5, MIN);
    expect(b - a).toBe(12 * H);
    expect((at - a) / (b - a)).toBeCloseTo(0.25, 9);   // 6h was a quarter in, and still is
  });

  it('stops at the narrowest view', () => {
    const [a, b] = zoomView([10 * H, 10 * H + 6 * 60_000], DAY, 10 * H, 0.1, MIN);
    expect(b - a).toBe(MIN);
    expect(zoomView([a, b], DAY, a, 0.5, MIN)).toBeNull();
  });

  it('is null rolling out at the whole day, so the panel scrolls', () => {
    expect(zoomView(DAY, DAY, 12 * H, 1.3, MIN)).toBeNull();
  });

  it('comes back to the whole day, never past it', () => {
    const got = zoomView([20 * H, 23 * H], DAY, 22 * H, 50, MIN);
    expect(got).toEqual(DAY);
    expect(isWholeDay(got, DAY)).toBe(true);
  });

  it('lands on the whole day exactly after a zoom, a pan and a zoom back out', () => {
    // FT 01's day on 28 Sep, and the wheel as it was run in the browser: three
    // notches in, Shift + wheel to the end, three notches out. It stopped
    // 0.0002 ms short of the day and "Whole day" stayed on.
    const day = [1790542857000, 1790553129000];
    const f = 0.3356, plotPx = 266.4;
    const at = (v) => v[0] + f * (v[1] - v[0]);
    let v = day;
    for (let i = 0; i < 3; i++) v = zoomView(v, day, at(v), zoomFactor(-100), MIN) ?? v;
    for (const px of [100, 100, 400]) v = panView(v, day, (px / plotPx) * (v[1] - v[0])) ?? v;
    for (let i = 0; i < 6; i++) v = zoomView(v, day, at(v), zoomFactor(100), MIN) ?? v;
    expect(v).toEqual(day);
    expect(isWholeDay(v, day)).toBe(true);
  });

  it('takes a notch that lands a hair short of the day as the whole day', () => {
    // FT 01 in the browser: the third notch out came to 1 ms short
    const view = [DAY[1] - 7_763_000, DAY[1]];
    expect(zoomView(view, DAY, DAY[1] - 1000, (DAY[1] - 1) / 7_763_000, MIN)).toEqual(DAY);
  });

  it('shifts rather than leave the day when zooming out near an end', () => {
    const [a, b] = zoomView([0, 2 * H], DAY, 0, 3, MIN);
    expect([a, b]).toEqual([0, 6 * H]);
  });

  it('lets a view opened past the day end stay there', () => {
    // An event at 23:50 opened with padding runs to 00:20 the next day
    const view = [23 * H + 20 * 60_000, 24 * H + 20 * 60_000];
    const [, b] = zoomView(view, DAY, 24 * H, 0.5, MIN);
    expect(b).toBeGreaterThan(24 * H);
  });
});

describe('panView', () => {
  it('slides the view along the day', () => {
    expect(panView([2 * H, 4 * H], DAY, H)).toEqual([3 * H, 5 * H]);
  });

  it('stops at the end of the day', () => {
    expect(panView([20 * H, 23 * H], DAY, 5 * H)).toEqual([21 * H, 24 * H]);
    expect(panView([21 * H, 24 * H], DAY, H)).toBeNull();
  });
});

describe('wheelPixels', () => {
  it('turns a line-mode notch (Firefox) into pixels', () => {
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 })).toEqual({ x: 0, y: 48 });
  });

  it('turns Shift + wheel into a sideways move', () => {
    expect(wheelPixels({ deltaY: 100, shiftKey: true })).toEqual({ x: 100, y: 0 });
  });
});

describe('zoomFactor', () => {
  it('zooms in rolling up, out rolling down, by about a quarter a notch', () => {
    expect(zoomFactor(-100)).toBeCloseTo(0.76, 2);
    expect(zoomFactor(100)).toBeCloseTo(1.32, 2);
  });

  it('caps one huge flick', () => {
    expect(zoomFactor(5000)).toBe(zoomFactor(300));
  });
});
