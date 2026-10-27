// What a live frame is allowed to say about the load on the bed — and what the
// paperwork is allowed to say.
//
// The answer for a position frame is "nothing", on this fleet, and the reason
// is worth a test rather than a comment: the Wialon adapter sends
// `cargoWeightKg: null` on every frame — the channel is a load cell and there
// are no load cells here — and a null that is PRESENT looks exactly like a
// measurement to any code testing for presence rather than for a value.
//
// The visible failure was "Empty · 29.0 t · 580 bags": the first frame after
// the snapshot relabelled the cargo from the null and kept the tonnage from the
// dispatch, so the card contradicted itself within seconds of being opened.
//
// `dash` holds the same pair of rules in its own vehicleMapCargo.test.js. The
// two copies of vehicleMap are separate files and have drifted before; this is
// the half new-ui was missing.

import { describe, it, expect } from 'vitest'
import { applyLiveUpdate, applyDispatchUpdate } from './vehicleMap'

/** A truck mid-run, as the snapshot hands it over: load declared at sign-out. */
const loaded = () => ({
  id: 'KCP 136P',
  vehicleId: 'ckv0000000000000000000ab',
  name: 'Faw Prime mover CA4181',
  vehicleType: 'TRUCK',
  cargo: 'Processed Sugar',
  weight: 29,
  cargoBags: 580,
  driver: 'Maxwell Masinde',
  destination: 'Raiply',
  speed: 0,
  capturedAt: '2026-09-22T03:22:00Z',
})

/** A Wialon position frame, verbatim in the fields that matter here. */
const frame = (over = {}) => ({
  vehicleId: 'ckv0000000000000000000ab',
  lat: 0.79,
  lng: 34.75,
  speedKmh: 41,
  engineOn: true,
  capturedAt: '2026-09-22T03:31:00Z',
  flags: {},
  ...over,
})

describe('applyLiveUpdate, the declared load', () => {
  it('survives a frame that carries a null weight', () => {
    // Exactly what the Wialon adapter emits: the key is absent AND, on an
    // older server, present-and-null. Neither may clear the load.
    for (const f of [frame(), frame({ cargoWeightKg: null, cargoDesc: null })]) {
      const next = applyLiveUpdate(loaded(), f)
      expect(next.cargo).toBe('Processed Sugar')
      expect(next.weight).toBe(29)
      expect(next.cargoBags).toBe(580)
    }
  })

  it('still yields to a real measurement, including a measured zero', () => {
    const laden = applyLiveUpdate(loaded(), frame({ cargoWeightKg: 12_400, cargoDesc: 'Raw Sugarcane' }))
    expect(laden.cargo).toBe('Raw Sugarcane')
    expect(laden.weight).toBe(12.4)

    // 0 kg is a load cell saying the bed is empty, which is a fact and wins.
    const empty = applyLiveUpdate(loaded(), frame({ cargoWeightKg: 0 }))
    expect(empty.cargo).toBe('Empty')
    expect(empty.weight).toBe(0)
  })
})

describe('applyDispatchUpdate, the paperwork', () => {
  /** What the server pushes when the guard signs a sales run out. */
  const signedOut = {
    vehicleId: 'ckv0000000000000000000ab',
    externalId: 'sale-1',
    driverName: 'Maxwell Masinde',
    destination: 'Raiply',
    cargoWeightKg: 29_000,
    cargoBags: 580,
    cargoDesc: 'Processed Sugar',
  }

  it('puts the delivery on an empty truck', () => {
    const idle = { ...loaded(), cargo: 'Empty', weight: 0, cargoBags: null, destination: null, driver: null }
    const next = applyDispatchUpdate(idle, signedOut)
    expect(next.cargo).toBe('Processed Sugar')
    expect(next.weight).toBe(29)
    expect(next.cargoBags).toBe(580)
    expect(next.destination).toBe('Raiply')
    expect(next.driver).toBe('Maxwell Masinde')
  })

  it('empties the bed when the run closes', () => {
    // Every field null is how a closed run arrives.
    const next = applyDispatchUpdate(loaded(), {
      vehicleId: 'ckv0000000000000000000ab',
      externalId: null, driverName: null, destination: null,
      cargoWeightKg: null, cargoBags: null, cargoDesc: null,
    })
    expect(next.cargo).toBe('Empty')
    expect(next.weight).toBe(0)
    expect(next.cargoBags).toBeNull()
    // The run is over, so where it went is no longer a fact about the truck.
    expect(next.destination).toBeNull()
    // Whoever is assigned to the vehicle is still assigned to it, and this
    // event carries no assignment to fall back to.
    expect(next.driver).toBe('Maxwell Masinde')
  })

  it('leaves the measured trip alone, it carries a name, not coordinates', () => {
    const onTrip = { ...loaded(), trip: { destination: 'Raiply', destinationLat: 0.1, destinationLng: 34.9 } }
    const next = applyDispatchUpdate(onTrip, signedOut)
    expect(next.trip).toBe(onTrip.trip)
  })
})

describe('applyDispatchUpdate, the seal serial', () => {
  const base = { id: 'v1', cargo: 'Empty', weight: 0, trip: { serialNumber: null, destination: 'Raiply' }, sealSerial: null };

  it('takes a serial that arrives after the sign-out, over the trip\'s empty one', () => {
    const next = applyDispatchUpdate(base, { destination: 'Raiply', serialNumber: 'C098062' });
    expect(next.sealSerial).toBe('C098062');
    expect(next.trip.serialNumber).toBe('C098062');
    expect(next.trip.destination).toBe('Raiply');
  });

  it('clears it when the run closes', () => {
    const loaded = { ...base, sealSerial: 'C098062', trip: { serialNumber: 'C098062' } };
    const next = applyDispatchUpdate(loaded, { serialNumber: null });
    expect(next.sealSerial).toBeNull();
    expect(next.trip.serialNumber).toBeNull();
  });

  it('leaves it alone when the server does not send the field', () => {
    const loaded = { ...base, sealSerial: 'C098062', trip: { serialNumber: 'C098062' } };
    const next = applyDispatchUpdate(loaded, { destination: 'Raiply' });
    expect(next.sealSerial).toBe('C098062');
    expect(next.trip.serialNumber).toBe('C098062');
  });
});
