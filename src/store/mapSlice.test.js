import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { makeStore } = await import('./index');
const { filterPublished, windowSet } = await import('./mapSlice');
const {
  publishLayers, publishStranded, registerMapCommand, runMapCommand, resetMapBridge,
} = await import('../lib/mapBridge');

describe('map slice', () => {
  it('takes the filter the map publishes, and "all" for none', () => {
    const store = makeStore();
    store.dispatch(filterPublished('critical'));
    expect(store.getState().map.activeFilter).toBe('critical');
    store.dispatch(filterPublished(undefined));
    expect(store.getState().map.activeFilter).toBe('all');
  });

  it('opens and closes only the windows it knows', () => {
    const store = makeStore();
    store.dispatch(windowSet('strandedOpen', true));
    store.dispatch(windowSet('nope', true));
    expect(store.getState().map).toMatchObject({ strandedOpen: true, unitsOpen: false });
    expect(store.getState().map).not.toHaveProperty('nope');
  });

  it('keeps one window open at a time', () => {
    const store = makeStore();
    store.dispatch(windowSet('unitsOpen', true));
    store.dispatch(windowSet('strandedOpen', true));
    expect(store.getState().map).toMatchObject({ unitsOpen: false, strandedOpen: true, fuelAlertsOpen: false });
    store.dispatch(windowSet('fuelAlertsOpen', true));
    expect(store.getState().map).toMatchObject({ unitsOpen: false, strandedOpen: false, fuelAlertsOpen: true });
    store.dispatch(windowSet('unitsOpen', false));   // closing one leaves the open one alone
    expect(store.getState().map.fuelAlertsOpen).toBe(true);
  });
});

describe('map bridge', () => {
  beforeEach(() => resetMapBridge());

  it('runs a registered command and ignores one not yet registered', () => {
    expect(runMapCommand('focus', 'u1')).toBeUndefined();
    const seen = [];
    registerMapCommand('focus', (id) => { seen.push(id); return 'ok'; });
    expect(runMapCommand('focus', 'u1')).toBe('ok');
    expect(seen).toEqual(['u1']);
    registerMapCommand('focus', null);
    expect(runMapCommand('focus', 'u2')).toBeUndefined();
  });

  it('keeps published lists as given, functions and live objects intact', () => {
    const onToggle = () => {};
    const vehicle = { id: 'v1', speed: 0 };
    publishLayers([{ id: 'bridges', onToggle }]);
    publishStranded([{ vehicle }]);
    vehicle.speed = 12;               // the live feed still writes to it
    expect(vehicle.speed).toBe(12);
    expect(Object.isFrozen(vehicle)).toBe(false);
  });
});
