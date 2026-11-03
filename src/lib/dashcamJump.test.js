import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../store/queryClient', () => ({ queryClient: { fetchQuery: vi.fn() } }))
import { queryClient } from '../store/queryClient'
import { rangeFor, isDashcamItem, findDashcamAlarm, openDashcamAlarm, clearDashcamJump } from './dashcamJump'

const now = new Date(2026, 9, 31, 15, 0)

describe('rangeFor', () => {
  it('today for a moment since midnight', () => {
    expect(rangeFor(new Date(2026, 9, 31, 8, 30).toISOString(), now)).toBe('today')
  })
  it('the last 7 days for earlier in the week', () => {
    expect(rangeFor(new Date(2026, 9, 27, 8, 30).toISOString(), now)).toBe('7d')
  })
  it('nothing for older than the page shows', () => {
    expect(rangeFor(new Date(2026, 9, 10).toISOString(), now)).toBeNull()
  })
})

describe('isDashcamItem', () => {
  it('only device events', () => {
    expect(isDashcamItem({ id: 'e1', source: 'device' })).toBe(true)
    expect(isDashcamItem({ id: 'e1', source: 'platform' })).toBe(false)
    expect(isDashcamItem(null)).toBe(false)
  })
})

describe('findDashcamAlarm', () => {
  beforeEach(() => { queryClient.fetchQuery.mockReset() })
  const item = { id: 'ev-9', source: 'device', ts: new Date().toISOString() }

  it('finds an alarm that has a clip', async () => {
    queryClient.fetchQuery.mockResolvedValue([{ id: 'ev-9', hasClip: true }])
    expect(await findDashcamAlarm(item, 'org')).toBe('today')
  })
  it('null when the alarm brought no evidence', async () => {
    queryClient.fetchQuery.mockResolvedValue([{ id: 'other', hasClip: true }])
    expect(await findDashcamAlarm(item, 'org')).toBeNull()
  })
  it('null, not a throw, when the list fails', async () => {
    queryClient.fetchQuery.mockImplementation(() => Promise.reject(new Error('down')))
    expect(await findDashcamAlarm(item, 'org')).toBeNull()
  })
  it('never asks for a non-camera item', async () => {
    expect(await findDashcamAlarm({ id: 'x', source: 'platform' }, 'org')).toBeNull()
    expect(queryClient.fetchQuery).not.toHaveBeenCalled()
  })
})

describe('hand-over', () => {
  it('open then clear', () => {
    openDashcamAlarm('ev-9', '7d')
    clearDashcamJump()
  })
})
