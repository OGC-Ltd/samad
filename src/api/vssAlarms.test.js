import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/api', () => ({ apiFetch: vi.fn(), refreshOnce: vi.fn() }))
import { apiFetch } from '../services/api'
import { toVssIncident, fetchVssIncidents, fetchVssCameraCount, VSS_BASE } from './vssAlarms'

// One alarm as the backend answers it (the contract at the top of vssAlarms.js).
const row = (over = {}) => ({
  id: 'A1', code: 116, label: 'Phone call', severity: 'critical', category: 'driver',
  occurredAt: '2026-10-22T07:00:01Z', vehicleId: 'cveh1', plate: 'KDR 430Q', deviceId: '111',
  lat: -0.82014, lng: 34.382572, speed: 64,
  videos: [{ key: 'f0', label: 'Road camera', url: `${VSS_BASE}/file?org=o&k=aa`, download: `${VSS_BASE}/file?org=o&k=aa&download=1` }],
  photos: [{ key: 'f1', label: 'In cabin', url: `${VSS_BASE}/file?org=o&k=bb`, download: null }],
  ...over,
})

describe('backend alarm → inbox row', () => {
  it('carries what the screen draws', () => {
    const r = toVssIncident(row())
    expect(r).toMatchObject({
      id: 'A1', label: 'Phone call', initials: 'PC', category: 'driver', severity: 'critical',
      vehicleId: 'cveh1', plate: 'KDR 430Q', lat: -0.82014, lng: 34.382572, speed: 64,
      hasClip: true, hasPhoto: true,
    })
    expect(r.occurredMs).toBe(Date.parse('2026-10-22T07:00:01Z'))
  })

  it('never hands the browser a link that is not the backend’s own file route', () => {
    const r = toVssIncident(row({ videos: [{ url: 'https://vss.controltech-ea.com:9988/fileSrv/fileDown.php?token=SECRET' }] }))
    expect(r.videos).toEqual([])
    expect(r.hasClip).toBe(false)
  })

  it('an unknown category or severity falls back safely', () => {
    const r = toVssIncident(row({ category: 'nonsense', severity: 'loud', label: '' }))
    expect(r.category).toBe('other')
    expect(r.severity).toBe('warning')
    expect(r.label).toBe('Alarm 116')
  })
})

describe('reading alarms and the camera count', () => {
  beforeEach(() => apiFetch.mockReset())

  it('asks for the organisation and window, newest first', async () => {
    apiFetch.mockResolvedValue({ data: { incidents: [row({ id: 'old', occurredAt: '2026-10-22T05:00:00Z' }), row({ id: 'new' })] } })
    const list = await fetchVssIncidents({ orgId: 'org-1', sinceIso: '2026-10-21T21:00:00Z' })
    expect(apiFetch.mock.calls[0][0]).toBe(`${VSS_BASE}/alarms?org=org-1&since=2026-10-21T21%3A00%3A00Z`)
    expect(list.map((i) => i.id)).toEqual(['new', 'old'])
  })

  it('the camera count is 0 on any failure — a backend without the route keeps the tab hidden', async () => {
    apiFetch.mockRejectedValue(Object.assign(new Error('Route not found'), { status: 404 }))
    expect(await fetchVssCameraCount('org-x')).toBe(0)
    apiFetch.mockResolvedValue({ data: { cameras: 52 } })
    expect(await fetchVssCameraCount('org-1')).toBe(52)
    expect(await fetchVssCameraCount(null)).toBe(0)
  })
})
