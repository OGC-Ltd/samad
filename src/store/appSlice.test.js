import { describe, it, expect, beforeEach, vi } from 'vitest';

const local = new Map();
const session = new Map();
const fakeStorage = (m) => ({
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: (k) => m.delete(k),
});
vi.stubGlobal('localStorage', fakeStorage(local));
vi.stubGlobal('sessionStorage', fakeStorage(session));

const { makeStore } = await import('./index');
const { DESKTOP_TABS, loadAppState } = await import('./appSlice');
const { readFileSync } = await import('node:fs');
const {
  fieldSet, companyChosen, tabChosen, mobileTabChosen, fleetTypesSet, trackedIdsSet, incidentRequested,
  selectionRestored,
} = await import('./appSlice');

describe('app slice', () => {
  beforeEach(() => { local.clear(); session.clear(); });
  const fresh = (app = {}) => makeStore({ app: { activeCompanyId: 'sukari', ...app } });

  it('swaps in the new organisation\'s own lists and clears the selection on a switch', () => {
    local.set('ft-fleet-types:kasulu', JSON.stringify(['ex']));
    local.set('ft-tracked-units:kasulu', JSON.stringify(['u9']));
    const store = fresh({ fleetTypes: ['mtr'], trackedIds: ['u1'], selectedVehicleId: 'u1', feedVehicleId: 'u1' });
    store.dispatch(companyChosen('kasulu'));
    const a = store.getState().app;
    expect(a).toMatchObject({
      activeCompanyId: 'kasulu', previousCompanyId: 'sukari',
      fleetTypes: ['ex'], trackedIds: ['u9'], selectedVehicleId: null, feedVehicleId: null,
    });
    expect(local.get('ft-active-company')).toBe('kasulu');
    // The switch must not stamp one fleet's list onto the other's key.
    expect(local.get('ft-fleet-types:sukari')).toBeUndefined();
  });

  it('ignores a switch to the organisation already open', () => {
    const store = fresh({ selectedVehicleId: 'u1' });
    store.dispatch(companyChosen('sukari'));
    expect(store.getState().app).toMatchObject({ previousCompanyId: null, selectedVehicleId: 'u1' });
  });

  it('saves the tracked units and funnel under the organisation that set them', () => {
    const store = fresh();
    store.dispatch(trackedIdsSet(['a', 'b', 'a']));
    store.dispatch(fleetTypesSet(['mtr']));
    expect(store.getState().app.trackedIds).toEqual(['a', 'b']);
    expect(JSON.parse(local.get('ft-tracked-units:sukari'))).toEqual(['a', 'b']);
    expect(JSON.parse(local.get('ft-fleet-types:sukari'))).toEqual(['mtr']);
  });

  it('remembers tabs in localStorage and overlays per browser tab', () => {
    const store = fresh();
    store.dispatch(fieldSet('desktopActiveTab', 'analytics'));
    store.dispatch(fieldSet('accountOpen', true));
    store.dispatch(fieldSet('accountOpen', false));
    store.dispatch(fieldSet('inTransitOnly', true));
    expect(local.get('ft-desktop-tab')).toBe('analytics');
    expect(session.get('ft-account-open')).toBe('0');
    expect([...local.keys()].some((k) => /transit/i.test(k))).toBe(false);
  });

  it('mounts the map on the first visit to the Map tab', () => {
    const store = fresh();
    store.dispatch(mobileTabChosen('map'));
    store.dispatch(mobileTabChosen('home'));
    expect(store.getState().app).toMatchObject({ mapEverMounted: true, mobileActiveTab: 'home' });
  });

  it('counts repeated requests for the same unit as separate requests', () => {
    const store = fresh();
    store.dispatch(incidentRequested('u1'));
    store.dispatch(incidentRequested('u1'));
    expect(store.getState().app.incidentRequest).toEqual({ id: 'u1', n: 2 });
  });

  it('refuses a field that is not a plain one', () => {
    const store = fresh();
    store.dispatch(fieldSet('activeCompanyId', 'kasulu'));
    expect(store.getState().app.activeCompanyId).toBe('sukari');
  });

  it('restores every sidebar page after a reload, not only the main tabs', () => {
    // Read from source rather than imported: SidePanel is a whole component.
    const src = readFileSync(new URL('../components/layout/SidePanel.jsx', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('export const NAV_ITEMS'), src.indexOf('];', src.indexOf('export const NAV_ITEMS')));
    const keys = [...block.matchAll(/key:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(['fleet', 'alerts', 'drivers']);
    expect(keys.filter((k) => !DESKTOP_TABS.includes(k))).toEqual([]);

    local.set('ft-desktop-tab', 'drivers');
    globalThis.window = { location: { search: '' } };
    try {
      expect(loadAppState().desktopActiveTab).toBe('drivers');
    } finally {
      delete globalThis.window;
    }
  });

  it('keeps the selected vehicle per company for this browser tab only', () => {
    const store = fresh();
    store.dispatch(fieldSet('selectedVehicleId', 'FT 05'));
    expect(session.get('ft-selected-vehicle:sukari')).toBe('FT 05');
    expect(local.has('ft-selected-vehicle:sukari')).toBe(false);
    store.dispatch(fieldSet('selectedVehicleId', null));
    expect(session.has('ft-selected-vehicle:sukari')).toBe(false);
  });

  it('brings the selection back on load and marks it for the map to restore', () => {
    session.set('ft-selected-vehicle:kasulu', 'FT 05');
    globalThis.window = { location: { search: '?company=kasulu' } };
    try {
      expect(loadAppState()).toMatchObject({ selectedVehicleId: 'FT 05', restoredVehicleId: 'FT 05' });
    } finally {
      delete globalThis.window;
    }
  });

  it('lets a restored unit go when the fleet no longer has it', () => {
    const gone = fresh({ selectedVehicleId: 'X', restoredVehicleId: 'X' });
    gone.dispatch(selectionRestored({ found: false }));
    expect(gone.getState().app).toMatchObject({ selectedVehicleId: null, restoredVehicleId: null });

    const kept = fresh({ selectedVehicleId: 'X', restoredVehicleId: 'X' });
    kept.dispatch(selectionRestored({ found: true }));
    expect(kept.getState().app).toMatchObject({ selectedVehicleId: 'X', restoredVehicleId: null });
  });

  it("never restores one company's unit into another", () => {
    const store = fresh({ selectedVehicleId: 'X', restoredVehicleId: 'X' });
    store.dispatch(companyChosen('kasulu'));
    expect(store.getState().app).toMatchObject({ selectedVehicleId: null, restoredVehicleId: null });
  });
});

describe('leaving the map clears it', () => {
  const fresh = (app = {}) => makeStore({ app: { activeCompanyId: 'sukari', ...app } });
  it('drops the selection, feed scope, incident and side-panel windows on leaving the map', () => {
    const store = fresh({ desktopActiveTab: 'fleet', selectedVehicleId: 'KCB 200A', feedVehicleId: 'KCB 200A', openIncidentId: 'i1', pendingFocusId: 'KCB 200A' });
    store.dispatch({ type: 'map/windowSet', payload: { name: 'unitsOpen', open: true } });
    store.dispatch(tabChosen('drivers'));
    const st = store.getState();
    expect(st.app).toMatchObject({ desktopActiveTab: 'drivers', selectedVehicleId: null, feedVehicleId: null, openIncidentId: null, pendingFocusId: null, mapClearN: 1 });
    expect(st.map.unitsOpen).toBe(false);
  });

  it('keeps what a page asked the map to show when going TO the map', () => {
    const store = fresh({ desktopActiveTab: 'alerts', pendingFocusId: 'KCB 200A' });
    store.dispatch(tabChosen('fleet'));
    expect(store.getState().app).toMatchObject({ desktopActiveTab: 'fleet', pendingFocusId: 'KCB 200A', mapClearN: 0 });
  });
});
