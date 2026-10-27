import { describe, it, expect } from 'vitest';
import { fleetPrefix, withoutPrefix, nameParts } from './plateLabel.js';

describe('fleetPrefix', () => {
  it('finds the organisation name most of the fleet starts with', () => {
    expect(fleetPrefix(['MUFINDI - EX 22', 'MUFINDI: 012', 'MUFINDI - DZ 20', 'KDA 123A'])).toBe('MUFINDI');
  });

  it('finds nothing in a fleet of bare plates', () => {
    expect(fleetPrefix(['KDA 123A', 'KDB 456B', 'T 123 ABC'])).toBeNull();
  });

  it('finds nothing when no one word covers half the fleet', () => {
    expect(fleetPrefix(['A - 1', 'B - 2', 'C - 3', 'KDA 123A'])).toBeNull();
  });
});

describe('withoutPrefix', () => {
  it('takes the prefix off both separator styles', () => {
    expect(withoutPrefix('MUFINDI - EX 22', 'MUFINDI')).toBe('EX 22');
    expect(withoutPrefix('MUFINDI: 012', 'MUFINDI')).toBe('012');
    expect(withoutPrefix('MUFINDI: OPTIM - 7', 'MUFINDI')).toBe('OPTIM - 7');
  });

  it('leaves plates that do not start with it alone', () => {
    expect(withoutPrefix('KDA 123A', 'MUFINDI')).toBe('KDA 123A');
    expect(withoutPrefix('XNMUFINDI: OPTIM', 'MUFINDI')).toBe('XNMUFINDI: OPTIM');
    expect(withoutPrefix('MUFINDI - EX 22', null)).toBe('MUFINDI - EX 22');
  });
});

describe('nameParts', () => {
  it('turns the dashes into dots', () => {
    expect(nameParts('WKS - Naitiri - KDW 536J')).toBe('WKS · Naitiri · KDW 536J');
  });
  it('leaves out what the line already says', () => {
    expect(nameParts('West Sugar-Mahindra-KDW 634X-11km/l', 'KDW 634X')).toBe('West Sugar · Mahindra · 11km/l');
    expect(nameParts('WKS - Naitiri - KDW 536J', 'WKS - Naitiri - KDW 536J')).toBe('');
  });
  it('is empty for no name', () => {
    expect(nameParts(null)).toBe('');
  });
});
