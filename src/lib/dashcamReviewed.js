// "Reviewed" marks on dashcam incidents — kept in this browser, per company.
//
// There is no database behind these marks yet, so a mark lives in localStorage. Two
// places read it at once — the Alarms screen (the ✓ and "Hide
// reviewed") and the Alarms badge in the side panel (which counts what is NOT
// reviewed) — so it is a tiny shared store: marking on the screen updates the
// badge immediately, and a mark made in another tab arrives via `storage`.

import { useEffect, useState, useCallback } from 'react'

const keyOf = (companyId) => `ft-dashcam-reviewed:${companyId}`
const KEEP = 2000                       // newest marks kept; old ids age out
const listeners = new Set()

export function readReviewed(companyId) {
  try { return new Set(JSON.parse(localStorage.getItem(keyOf(companyId)) || '[]')) } catch { return new Set() }
}

function write(companyId, set) {
  try { localStorage.setItem(keyOf(companyId), JSON.stringify([...set].slice(-KEEP))) } catch { /* full or blocked */ }
  for (const fn of listeners) fn(companyId)
}

export function toggleReviewed(companyId, id) {
  const set = readReviewed(companyId)
  if (set.has(id)) set.delete(id); else set.add(id)
  write(companyId, set)
}

/** The marks for one company, kept current. Returns [Set, toggle(id)]. */
export function useDashcamReviewed(companyId) {
  const [set, setSet] = useState(() => readReviewed(companyId))
  useEffect(() => {
    setSet(readReviewed(companyId))
    const onLocal = (cid) => { if (cid === companyId) setSet(readReviewed(companyId)) }
    const onStorage = (e) => { if (e.key === keyOf(companyId)) setSet(readReviewed(companyId)) }
    listeners.add(onLocal)
    window.addEventListener('storage', onStorage)
    return () => { listeners.delete(onLocal); window.removeEventListener('storage', onStorage) }
  }, [companyId])
  const toggle = useCallback((id) => toggleReviewed(companyId, id), [companyId])
  return [set, toggle]
}
