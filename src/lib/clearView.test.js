import { describe, it, expect } from 'vitest';
import { clearRects, clearestRect, clearOffset } from './clearView';

/**
 * A fuel alert's unit is put where it can be seen (operator, 28 Sep: "when the
 * modal is opened then we also need to zoom into the vehicle"), not under the
 * incident window in the middle of the map.
 */

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });
const inside = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
const where = (area, off) => ({ x: (area.left + area.right) / 2 + off.x, y: (area.top + area.bottom) / 2 + off.y });

describe('clearRects', () => {
  it('leaves a strip on each side of a window in the middle', () => {
    const got = clearRects(rect(0, 0, 1000, 800), [rect(300, 200, 400, 400)]);
    expect(got).toEqual([
      rect(0, 0, 300, 800),
      rect(700, 0, 300, 800),
      rect(0, 0, 1000, 200),
      rect(0, 600, 1000, 200),
    ]);
  });

  it('keeps the whole map when nothing covers it', () => {
    expect(clearRects(rect(0, 0, 500, 500), [rect(600, 0, 100, 100)])).toEqual([rect(0, 0, 500, 500)]);
  });
});

describe('clearestRect', () => {
  it('skips a strip too thin to show a marker in', () => {
    // Map 800 wide; the window leaves 20px to its right and 150px below.
    const got = clearestRect(rect(280, 52, 800, 848), [rect(380, 150, 680, 600)]);
    expect(got).toEqual({ left: 280, top: 750, right: 1080, bottom: 900 });
  });

  it('is null when every part left is too small', () => {
    expect(clearestRect(rect(0, 0, 300, 300), [rect(10, 10, 280, 280)])).toBeNull();
  });
});

describe('clearOffset', () => {
  it('moves the unit out from under the window on a 1440px desktop', () => {
    const area = rect(280, 52, 800, 848);              // map, between the rails
    const covers = [rect(380, 150, 680, 600)];         // the centred window
    const off = clearOffset(area, covers);
    const at = where(area, off);
    expect(covers.some((c) => inside(at.x, at.y, c))).toBe(false);
    expect(inside(at.x, at.y, area)).toBe(true);
  });

  it('takes the wide strip beside the window on a big screen', () => {
    const area = rect(280, 52, 1280, 1028);
    const window = rect(620, 240, 680, 600);
    const panel = rect(1560, 52, 360, 1028);
    const off = clearOffset(area, [window, panel]);
    expect(where(area, off)).toEqual({ x: 450, y: 566 });
  });

  it('uses the strip above the two sheets on a phone', () => {
    const area = rect(0, 52, 375, 760);
    const panel = rect(0, 179, 375, 633);              // 78vh
    const sheet = rect(0, 292, 375, 520);              // 64dvh
    const at = where(area, clearOffset(area, [panel, sheet]));
    expect(at).toEqual({ x: 187.5, y: 115.5 });
  });

  it('stays put when the unit is already in the clear', () => {
    const area = rect(0, 0, 1600, 900);
    expect(clearOffset(area, [rect(1240, 0, 360, 900)])).toEqual({ x: 0, y: 0 });
  });

  it('counts a window edge right beside the unit as covering its marker', () => {
    const area = rect(0, 0, 1000, 800);
    expect(clearOffset(area, [rect(510, 0, 490, 800)])).not.toEqual({ x: 0, y: 0 });
  });

  it('ignores a panel that is closed to nothing', () => {
    const area = rect(0, 0, 1000, 800);
    expect(clearOffset(area, [rect(1000, 0, 0, 800)])).toEqual({ x: 0, y: 0 });
  });

  it('is null when there is nowhere clear to go', () => {
    expect(clearOffset(rect(0, 0, 300, 300), [rect(0, 0, 300, 300)])).toBeNull();
  });
});
