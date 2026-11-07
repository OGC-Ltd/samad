// The Reports page's periods and shifts, in Nairobi time. The reports
// themselves are built and drawn by the server (server/report_*.go, operator
// 2026-11-07: "the logic for generating pdf or reports to move to the
// server"); the page only picks the period, edits the document and asks for
// the PDF, JPEG or CSV.

// ── time, in Nairobi (UTC+3 all year) ───────────────────────────────────────

const EAT_MS = 3 * 3_600_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const TZ = { timeZone: 'Africa/Nairobi' }
const fmtDay = new Intl.DateTimeFormat('en-GB', { ...TZ, day: 'numeric', month: 'short', year: 'numeric' })
const fmtShort = new Intl.DateTimeFormat('en-GB', { ...TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const fmtClock = new Intl.DateTimeFormat('en-GB', { ...TZ, hour: '2-digit', minute: '2-digit', hour12: false })

/** Nairobi midnight of the day `ms` falls in. */
export const dayStart = (ms) => Math.floor((ms + EAT_MS) / DAY) * DAY - EAT_MS
/** "YYYY-MM-DD" of a Nairobi day. */
export const dayKey = (ms) => new Date(ms + EAT_MS).toISOString().slice(0, 10)
/** Nairobi midnight of "YYYY-MM-DD". */
export const dayOf = (key) => Date.parse(`${key}T00:00:00+03:00`)

export const clock = (ms) => (ms == null ? '-' : fmtClock.format(ms))
/** "3 Nov 14:05", or "14:05" on the same day as `ref`. */
export function when(ms, ref) {
  if (ms == null) return '-'
  return ref != null && dayStart(ms) === dayStart(ref) ? fmtClock.format(ms) : fmtShort.format(ms)
}
/** "2 h 05 min", "3 d 4 h", "12 min". */
export function span(ms) {
  if (ms == null || ms < 0) return '-'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}
/** "1 Nov 00:00 to 3 Nov 14:05". */
export function periodWords(from, to) {
  if (dayStart(from) === from && (to - from) % DAY === 0) {
    const last = to - DAY
    return last === from ? fmtDay.format(from) : `${fmtDay.format(from)} to ${fmtDay.format(last)}`
  }
  return `${fmtShort.format(from)} to ${dayStart(to) === dayStart(from) ? fmtClock.format(to) : fmtShort.format(to)}`
}

// ── periods the page offers ─────────────────────────────────────────────────

export const PRESETS = [
  { key: 'today',     label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d',        label: 'Last 7 days' },
  { key: 'custom',    label: 'Custom' },
]

export function presetRange(key, now = Date.now()) {
  const today = dayStart(now)
  if (key === 'yesterday') return { from: today - DAY, to: today }
  if (key === '7d') return { from: today - 6 * DAY, to: now }
  return { from: today, to: now }
}

/** The day shift is 06:00–18:00, the night 18:00–06:00 the next morning. */
export const SHIFTS = [
  { key: 'day',   label: 'Day',   words: '06:00 to 18:00', start: 6 },
  { key: 'night', label: 'Night', words: '18:00 to 06:00', start: 18 },
]
export function shiftRange(day, shift) {
  const s = SHIFTS.find((x) => x.key === shift) ?? SHIFTS[0]
  const from = dayOf(day) + s.start * HOUR
  return { from, to: from + 12 * HOUR }
}
/** The shift running at `now`, or just ended: the one a control room hands over. */
export function currentShift(now = Date.now()) {
  const h = new Date(now + EAT_MS).getUTCHours()
  if (h >= 6 && h < 18) return { day: dayKey(now), shift: 'day' }
  return { day: dayKey(h < 6 ? now - DAY : now), shift: 'night' }
}
