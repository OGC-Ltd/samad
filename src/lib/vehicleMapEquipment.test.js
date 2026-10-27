import { describe, it, expect } from 'vitest'
import { equipmentLabel, mapSnapshotVehicle } from './vehicleMap.js'

describe('equipmentLabel', () => {
  it('prefers the RaiFactorySuite register name over the unit code', () => {
    expect(equipmentLabel({ id: 'MUFINDI: CTR 19', machineName: 'CASE PUMA' })).toBe('CASE PUMA')
  })

  it('falls back to the code where the register has nothing', () => {
    expect(equipmentLabel({ id: 'MUFINDI: CTR 19', machineName: null })).toBe('Cane Tractor')
    expect(equipmentLabel({ id: 'MUFINDI: CTR 19', machineName: '  ' })).toBe('Cane Tractor')
    expect(equipmentLabel({ id: 'KDL 208X' })).toBeNull()
  })

  it('carries machineName through the snapshot mapping', () => {
    const v = mapSnapshotVehicle({ vehicleId: 'v1', plate: 'MUFINDI: EX 23', vehicleType: 'PLANT', machineName: 'Excavator' })
    expect(v.machineName).toBe('Excavator')
    expect(equipmentLabel(v)).toBe('Excavator')
  })
})
