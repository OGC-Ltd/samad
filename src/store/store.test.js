import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
});

const { makeStore } = await import('./index');
const { loadPrefs } = await import('./persist');
const { headerToggled, layerToggled, unitChosen, executed, spanChosen } = await import('./fuelReportSlice');

describe('store', () => {
  beforeEach(() => mem.clear());

  it('starts from the slice defaults merged with kept preferences', () => {
    const store = makeStore({ fuelReport: { headerCollapsed: true } });
    const s = store.getState().fuelReport;
    expect(s.headerCollapsed).toBe(true);
    expect(s.tab).toBe('graph');
    expect(s.lines.fuelL).toBe(true);
  });

  it('keeps the unit and layout preferences but never the request', () => {
    const store = makeStore();
    store.dispatch(headerToggled());
    store.dispatch(layerToggled({ group: 'lines', key: 'speedKmh' }));
    store.dispatch(unitChosen('org1', 'u1'));
    store.dispatch(executed({ orgId: 'o', unitId: 'u1', from: 1, to: 2 }));
    const kept = loadPrefs().fuelReport;
    expect(kept.headerCollapsed).toBe(true);
    expect(kept.lines.speedKmh).toBe(true);
    expect(kept.unitByOrg).toEqual({ org1: 'u1' });
    expect(kept.request).toBeUndefined();
  });

  it('remembers the unit per organisation and forgets it when cleared', () => {
    const store = makeStore();
    store.dispatch(unitChosen('org1', 'u1'));
    store.dispatch(unitChosen('org2', 'u7'));
    store.dispatch(unitChosen('org1', null));
    expect(loadPrefs().fuelReport.unitByOrg).toEqual({ org2: 'u7' });
  });

  it('distrusts a malformed stored unit map', () => {
    mem.set('ft-prefs', JSON.stringify({ fuelReport: { unitByOrg: ['u1'] } }));
    expect(loadPrefs().fuelReport.unitByOrg).toEqual({});
  });

  it('remembers the period preset, not hand-typed dates', () => {
    const store = makeStore();
    expect(store.getState().fuelReport.presetId).toBe('today');
    store.dispatch(spanChosen({ from: 'a', to: 'b', id: 'yesterday' }));
    store.dispatch(spanChosen({ from: 'c', to: 'd', id: null }));
    const kept = loadPrefs().fuelReport;
    expect(kept.presetId).toBe('yesterday');
    expect(kept.span).toBeUndefined();
  });

  it('distrusts a stored preset it does not know', () => {
    mem.set('ft-prefs', JSON.stringify({ fuelReport: { presetId: 'decade' } }));
    expect(loadPrefs().fuelReport.presetId).toBeUndefined();
  });

  it('carries the old header-fold key over', () => {
    mem.set('ft-fuel-report-header-collapsed', '1');
    expect(loadPrefs().fuelReport.headerCollapsed).toBe(true);
  });

  it('ignores a toggle for a layer that does not exist', () => {
    const store = makeStore();
    store.dispatch(layerToggled({ group: 'lines', key: 'nope' }));
    expect(store.getState().fuelReport.lines).not.toHaveProperty('nope');
  });
});
