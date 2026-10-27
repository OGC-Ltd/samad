/* Which units have a payload at all.
 *
 * The unit card printed "No load expected 0 / 30 t" on MUFINDI - DG 11 (a
 * generator) and KMGJ 333W (a KM-plate motorbike): carriesCargo already called
 * both non-carriers, but maxPayloadTonnes gave every type it did not know 30 t
 * and the card drew the row regardless. The payload follows carriesCargo now,
 * the same rule the map sprites and the header counts use.
 */

import { describe, it, expect } from 'vitest'
import { carriesCargo, mapSnapshotVehicle } from './vehicleMap.js'

const row = (plate, name, vehicleType) => ({ vehicleId: plate, plate, name, vehicleType })

describe('carriesCargo', () => {
  it.each([
    ['MUFINDI - DG 11', null, 'GENERATOR'],                         // equipment code DG
    ['GEN-01', 'Site Genset 60kVA', 'TRUCK'],                      // keyword
    ['KMGJ 333W', 'West Sugar-Bike-KMGJ 333W', 'TRUCK'],           // Bike keyword
    ['KMGJ 333W', null, null],                                     // KM plate, nothing stronger
    ['MC-1', null, 'MOTORCYCLE'],                                  // provider type
    ['MUFINDI: EX 23', null, 'PLANT'],                             // excavator
    ['MUFINDI: GR 02', null, 'PLANT'],                             // grader
    ['KBX 101A', 'Toyota Hilux Double Cab', 'COMPANY_VEHICLE'],    // light vehicle
    ['KBX 102A', 'Water Pump 3in', 'TRUCK'],                       // pump
  ])('%s (%s) carries nothing', (id, name, vehicleType) => {
    expect(carriesCargo({ id, name, vehicleType })).toBe(false)
  })

  it.each([
    ['KCC 386Z', 'Faw Prime mover CA4181', 'TRUCK'],
    ['KHMA 858U', '125F Bell 38 KHMA 858U', 'TRACTOR'],
    ['MUFINDI - FT 13', null, 'TRUCK'],
    ['KMHA 326X', 'SAME 9358 (KMHA 326X)', 'TRACTOR'],             // tractor on a KM plate
    ['KDA 001B', 'Water Bowser', 'TRUCK'],
  ])('%s (%s) is a carrier', (id, name, vehicleType) => {
    expect(carriesCargo({ id, name, vehicleType })).toBe(true)
  })
})

describe('maxPayload on the mapped vehicle', () => {
  it('is null for non-carriers, so no 30 t default reaches the card', () => {
    expect(mapSnapshotVehicle(row('MUFINDI - DG 11', null, 'GENERATOR')).maxPayload).toBeNull()
    expect(mapSnapshotVehicle(row('KMGJ 333W', 'West Sugar-Bike-KMGJ 333W', 'TRUCK')).maxPayload).toBeNull()
    expect(mapSnapshotVehicle(row('MUFINDI: EX 23', null, 'PLANT')).maxPayload).toBeNull()
  })

  it('keeps the legal payload for carriers', () => {
    expect(mapSnapshotVehicle(row('KCC 386Z', 'Faw Prime mover CA4181', 'TRUCK')).maxPayload).toBe(36)
    expect(mapSnapshotVehicle(row('KHMA 858U', '125F Bell 38 KHMA 858U', 'TRACTOR')).maxPayload).toBe(20)
  })
})
