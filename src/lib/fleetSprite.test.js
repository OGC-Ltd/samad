import { describe, it, expect } from 'vitest';
import { spriteColumn, bearingDeg, spriteIcon } from './fleetSprite';

const maps = {
  Size: function Size(w, h) { this.width = w; this.height = h; },
  Point: function Point(x, y) { this.x = x; this.y = y; },
};

describe('fleetSprite', () => {
  it('maps a heading to one of 24 columns clockwise from north', () => {
    expect(spriteColumn(0)).toBe(0);
    expect(spriteColumn(90)).toBe(6);
    expect(spriteColumn(359)).toBe(0);
    expect(spriteColumn(-90)).toBe(18);
    expect(spriteColumn(undefined)).toBe(0);
  });
  it('measures bearings clockwise from north', () => {
    expect(Math.round(bearingDeg({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }))).toBe(0);
    expect(Math.round(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }))).toBe(90);
    expect(Math.round(bearingDeg({ lat: 0, lng: 0 }, { lat: -1, lng: 0 }))).toBe(180);
  });
  it('cuts the cell for the heading and status out of the truck atlas', () => {
    const icon = spriteIcon(maps, 'mtr', { heading: 90, status: 'idling', px: 40 });
    expect(icon.url).toBe('/truck-atlas.png');
    expect([icon.origin.x, icon.origin.y]).toEqual([240, 160]);
    expect([icon.scaledSize.width, icon.scaledSize.height]).toEqual([960, 200]);
    expect(spriteIcon(maps, undefined).url).toBe('/truck-atlas.png');
  });
});
