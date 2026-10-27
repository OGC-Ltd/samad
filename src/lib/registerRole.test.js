import { describe, it, expect } from 'vitest';
import { registerRole } from './vehicleMap';

describe('registerRole', () => {
  it('reads plant from an hour rating and a carrier from a distance rating', () => {
    expect(registerRole({ ratedBurn: { value: 18, basis: 'HOURS' } })).toBe('plant');
    expect(registerRole({ ratedBurn: { value: 3.2, basis: 'DISTANCE' } })).toBe('carrier');
  });

  it('says nothing about a unit the register does not rate', () => {
    expect(registerRole({ ratedBurn: null })).toBe(null);
    expect(registerRole({})).toBe(null);
    expect(registerRole(null)).toBe(null);
  });
});
