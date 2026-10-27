// Shared vocabulary of the dashcam Alarms inbox (components/screens/
// DashcamIncidentsScreen): the filter chips, the time windows, the row badge
// initials and what the tab's badge counts.

/** The inbox's filter chips. The server files every alarm under one key. */
export const CATEGORIES = [
  { key: 'braking',   label: 'Braking'   },
  { key: 'speeding',  label: 'Speeding'  },
  { key: 'driver',    label: 'Driver'    },
  { key: 'lane',      label: 'Lane'      },
  { key: 'collision', label: 'Collision' },
  { key: 'other',     label: 'Other'     },   // shown only when it has something
]

export const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key))

/** Two letters for the row's badge: "Harsh braking" → "HB", "Impact" → "IM". */
export function initialsOf(label) {
  const words = String(label || '').replace(/[_·-]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase()
}

/**
 * What the tab's badge counts: alarms that need someone to look, not yet
 * marked reviewed. Informational ones would keep it lit all day.
 */
export function needsAttention(incidents, reviewed) {
  return (incidents ?? []).filter((i) => i.severity !== 'informational' && !reviewed.has(i.id))
}

/** The three windows the inbox offers. */
export const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '24h',   label: 'Last 24 hours' },
  { key: '7d',    label: 'Last 7 days' },
]

/**
 * A window → a ROUNDED start time (local midnight, or a 5-minute step), so the
 * same window asked twice is the same request and the server's cached answer
 * can be reused.
 */
export function sinceFor(rangeKey, now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (rangeKey === '7d') {
    midnight.setDate(midnight.getDate() - 6)
    return iso(midnight)
  }
  if (rangeKey === '24h') {
    const step = 5 * 60_000
    return iso(new Date(Math.floor(now.getTime() / step) * step - 24 * 3_600_000))
  }
  return iso(midnight)
}

/** How often the alarms are re-read. The server keeps each answer ~90 s. */
export const INCIDENTS_REFRESH_MS = 120_000
