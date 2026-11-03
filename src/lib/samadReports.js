// Samad's three reports, on RaiTrack's letterhead (operator, 2026-11-03: "the
// movements reports, driver policy breach report and end of shift reports …
// the same for Samad, but the left logo should be for Samad"):
//
//   Policy Breaches  per unit: overspeeding, harsh braking, harsh acceleration,
//                    no seatbelt, on phone, camera covered
//   Movements        every unit: in a zone now, or out since it left one; and
//                    every zone crossing in the period
//   End of Shift     the shift at a glance, critical alarms, the breaches with
//                    the top 5 units of each, every unit still out of a zone,
//                    and the handover
//
// All from api/fleetReport (the server's events and units). IntelliFleet sends
// no fuel and Samad has no weighbridge, so neither appears.
//
// Pure: each `*Report` returns the model the screen shows; each `*Html`
// returns the letterhead page (lib/letterhead) the PDF is drawn from.

import { renderLetterheadHtml, table, cells, tag, esc } from './letterhead'

export const COMPANY = 'Samad Resources'

/** The six breaches, in the order every report lists them. `kind` is the server's (reports.go reportKind). */
export const BREACHES = [
  { key: 'overspeed',          label: 'Overspeeding' },
  { key: 'harsh_braking',      label: 'Harsh braking' },
  { key: 'harsh_acceleration', label: 'Harsh acceleration' },
  { key: 'no_seatbelt',        label: 'No seatbelt' },
  { key: 'phone',              label: 'On phone' },
  { key: 'camera_covered',     label: 'Camera covered' },
]
const BREACH_KEYS = new Set(BREACHES.map((b) => b.key))
export const isBreach = (e) => BREACH_KEYS.has(e?.kind)

/**
 * What the data can stand behind (api/fleetReport `has`). Without the server's
 * report route there is no camera covered and no zone crossing, so those
 * columns and sections are left out rather than shown as zeros.
 */
export const hasOf = (data) => ({ cameraCovered: data?.has?.cameraCovered !== false, crossings: data?.has?.crossings !== false })
export const breachesFor = (data) => BREACHES.filter((b) => b.key !== 'camera_covered' || hasOf(data).cameraCovered)
/** The line each report carries when it was made from the limited data. */
export const LIMITED_NOTE = 'Made from the alerts and live positions: camera covered and zone entries and exits are not included until the server is updated for reports.'

// ── time, in Nairobi (UTC+3 all year) ───────────────────────────────────────

const EAT_MS = 3 * 3_600_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const TZ = { timeZone: 'Africa/Nairobi' }
const fmtDate = new Intl.DateTimeFormat('en-GB', { ...TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
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

/** "SR-PB-20261103-1405": who, which report, when made. */
export function reportNumber(prefix, now) {
  const s = new Date(now + EAT_MS).toISOString()
  return `${prefix}-SAMAD-${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 16).replace(':', '')}`
}

// ── shared pieces ───────────────────────────────────────────────────────────

const byPlate = (a, b) => String(a.plate).localeCompare(String(b.plate))
const typeWords = (t) => (t ? t.charAt(0) + t.slice(1).toLowerCase() : 'Vehicle')
const vehicleIndex = (data) => new Map(data.vehicles.map((v) => [String(v.vehicleId), v]))
const driverOf = (v) => (v?.driver && v.driver !== 'Unassigned' ? v.driver : null)

/** Where a unit is now, in words: the zone it is in, or how far from the nearest. */
export function placeNow(v) {
  if (!v || v.lat == null) return 'No position'
  if (v.zoneNow) return v.zoneNow
  if (v.nearestZone) return v.nearestKm != null && v.nearestKm < 0.5 ? `Next to ${v.nearestZone}` : `${Math.round((v.nearestKm ?? 0) * 10) / 10} km from ${v.nearestZone}`
  return `${Number(v.lat).toFixed(4)}, ${Number(v.lng).toFixed(4)}`
}
export function stateNow(v) {
  if (!v || !v.online) return 'Offline'
  return v.moving ? 'Moving' : 'Stopped'
}

/** Is the unit out of every zone now, having last LEFT one? Since when. */
export function outSince(v) {
  if (!v || v.zoneNow || v.lat == null) return null
  const c = v.lastCrossing
  return c && c.action === 'exit' && c.at ? c : null
}

// ── Policy Breaches ─────────────────────────────────────────────────────────

/**
 * Per unit, the six breaches counted over the period, the worst first.
 * @returns {{ rows, sections, kpis, total, units }}
 */
export function breachesReport(data) {
  const list = breachesFor(data)
  const vs = vehicleIndex(data)
  const per = new Map()
  for (const e of data.events) {
    if (!isBreach(e) || !list.some((b) => b.key === e.kind)) continue
    const id = String(e.vehicleId)
    const v = vs.get(id)
    const r = per.get(id) ?? {
      vehicleId: id, plate: v?.plate || e.plate || id, type: v?.type ?? null, driver: driverOf(v),
      counts: Object.fromEntries(BREACHES.map((b) => [b.key, 0])), total: 0, topSpeed: null, clips: 0,
    }
    r.counts[e.kind]++
    r.total++
    if (e.hasClip) r.clips++
    if (e.kind === 'overspeed' && Number.isFinite(e.speed)) r.topSpeed = Math.max(r.topSpeed ?? 0, Math.round(e.speed))
    per.set(id, r)
  }
  const rows = [...per.values()].sort((a, b) => b.total - a.total || byPlate(a, b))
  const totals = Object.fromEntries(list.map((b) => [b.key, rows.reduce((s, r) => s + r.counts[b.key], 0)]))
  const total = rows.reduce((s, r) => s + r.total, 0)
  const types = [...new Set(rows.map((r) => r.type ?? ''))]
  const sections = types.length > 1
    ? types.map((t) => ({ name: typeWords(t), rows: rows.filter((r) => (r.type ?? '') === t) }))
      .sort((a, b) => b.rows.length - a.rows.length)
    : [{ name: 'All vehicles', rows }]
  const kpis = [
    ...list.map((b) => ({ label: b.label, value: totals[b.key] })),
    { label: 'Total breaches', value: total },
    { label: 'Vehicles', value: rows.length },
  ]
  return { rows, sections, kpis, totals, total, units: data.vehicles.length, list, limited: !hasOf(data).cameraCovered }
}

const breachCols = (list) => [
  { h: 'Vehicle', w: 24 }, { h: 'Driver', w: 34 },
  ...list.map((b) => ({ h: b.label.replace('Harsh ', 'Harsh<br>').replace('Camera ', 'Camera<br>').replace('No ', 'No<br>').replace('On ', 'On<br>'), w: 16, r: true })),
  { h: 'Total', w: 14, r: true },
]
const breachCells = (list) => (r) => [
  { html: esc(r.plate), cls: 'b' },
  r.driver ? esc(r.driver) : { html: '-', cls: 'm' },
  ...list.map((b) => (r.counts[b.key] ? String(r.counts[b.key]) : { html: '0', cls: 'm' })),
  { html: String(r.total), cls: 'b' },
]

// ── Movements ───────────────────────────────────────────────────────────────

/**
 * Every unit, where it is and since when; and every crossing in the period.
 * Order: units out of a zone first (longest out first), then those moving,
 * then the rest by plate.
 */
export function movementsReport(data) {
  const vs = vehicleIndex(data)
  const crossings = data.events.filter((e) => e.kind === 'geofence' && e.action)
    .map((e) => ({ ...e, plate: vs.get(String(e.vehicleId))?.plate || e.plate }))
    .sort((a, b) => a.at - b.at)
  const inPeriod = new Map()
  for (const c of crossings) inPeriod.set(String(c.vehicleId), (inPeriod.get(String(c.vehicleId)) ?? 0) + 1)

  const rows = data.vehicles.map((v) => {
    const out = outSince(v)
    return {
      vehicleId: String(v.vehicleId), plate: v.plate, driver: driverOf(v), v,
      status: v.zoneNow ? 'in' : out ? 'out' : v.lat == null ? 'none' : 'away',
      out, place: placeNow(v), state: stateNow(v), fixAt: v.fixAt, crossings: inPeriod.get(String(v.vehicleId)) ?? 0,
      last: v.lastCrossing,
    }
  })
  const rank = { out: 0, away: 1, in: 2, none: 3 }
  rows.sort((a, b) => rank[a.status] - rank[b.status]
    || (a.status === 'out' ? a.out.at - b.out.at : 0)
    || (b.state === 'Moving') - (a.state === 'Moving')
    || byPlate(a, b))
  const n = (s) => rows.filter((r) => r.status === s).length
  const limited = !hasOf(data).crossings
  const kpis = [
    { label: 'Units', value: rows.length },
    { label: 'In a zone now', value: n('in') },
    { label: 'Out of zones now', value: n('out') + n('away') },
    { label: 'Moving now', value: rows.filter((r) => r.state === 'Moving').length },
    ...(limited ? [{ label: 'Offline', value: rows.filter((r) => r.state === 'Offline').length }] : [
      { label: 'Exits', value: crossings.filter((c) => c.action === 'exit').length },
      { label: 'Entries', value: crossings.filter((c) => c.action === 'entry').length },
    ]),
  ]
  return { rows, crossings, kpis, limited }
}

/** The Status column: "In Mombasa Yard", "Out since 2 Nov 14:05 (left Mombasa Yard)". */
export function statusWords(r, now) {
  if (r.status === 'in') return `In ${r.v.zoneNow}`
  if (r.status === 'out') return `Out since ${when(r.out.at, now)} · left ${r.out.zone || 'a zone'}`
  if (r.status === 'away') return 'Out of zones'
  return 'No position'
}

// ── End of Shift ────────────────────────────────────────────────────────────

/** Critical alarms: the camera's own critical ones that are not a breach above (a collision, say). */
const isCritical = (e) => e.kind === 'critical'

/**
 * The shift's report.
 * `distances`: vehicleId → km covered in the shift (api/fleetReport distancesIn),
 * null where a unit's history could not be read.
 * @returns {{ kpis, critical, breaches: [{ key, label, count, units: [{ plate, n }] }], breachTotal, reporting, units }}
 */
// `_now` is kept so callers need not change; the report does not measure from it.
// eslint-disable-next-line no-unused-vars
export function shiftReport(data, _now = Date.now(), { distances = null } = {}) {
  const vs = vehicleIndex(data)
  const plateOf = (e) => vs.get(String(e.vehicleId))?.plate || e.plate
  const critical = data.events.filter(isCritical).sort((a, b) => a.at - b.at).map((e) => ({
    ...e, plate: plateOf(e), driver: driverOf(vs.get(String(e.vehicleId))),
  }))
  // Every unit that had the breach, most first: the fleet is small (operator, 2026-11-03).
  const breaches = breachesFor(data).map((b) => {
    const list = data.events.filter((e) => e.kind === b.key)
    const per = new Map()
    for (const e of list) per.set(plateOf(e), (per.get(plateOf(e)) ?? 0) + 1)
    const units = [...per].map(([plate, n]) => ({ plate, n })).sort((a, b2) => b2.n - a.n || a.plate.localeCompare(b2.plate))
    return { ...b, count: list.length, units }
  })
  const breachTotal = breaches.reduce((s, b) => s + b.count, 0)
  // Units reporting: online now (operator, 2026-11-03: "revert … online units reporting").
  const reporting = data.vehicles.filter((v) => v.online).length
  // Every unit: how far it went in the shift and where it is now, furthest first.
  const units = data.vehicles.map((v) => {
    const d = distances?.get(String(v.vehicleId))
    return { plate: v.plate, km: Number.isFinite(d) ? d : null, place: placeNow(v), state: stateNow(v) }
  }).sort((a, b) => (b.km ?? -1) - (a.km ?? -1) || String(a.plate).localeCompare(String(b.plate)))
  const breachUnits = new Set(data.events.filter(isBreach).map((e) => String(e.vehicleId))).size
  const kpis = [
    { label: 'Critical alarms', value: critical.length },
    { label: 'Policy breaches', value: breachTotal },
    { label: 'Units with breaches', value: breachUnits },
    { label: 'Units reporting', value: `${reporting} of ${data.vehicles.length}` },
  ]
  return { kpis, critical, breaches, breachTotal, reporting, units }
}

// ── the letterhead pages ────────────────────────────────────────────────────

const kpiCells = (kpis) => cells(kpis.map((k) => [k.label, esc(String(k.value))]))
const mm = (n) => `${n}mm`
const INNER = 184

function page({ title, prefix, now, from, to, info, flow, logos }) {
  const words = periodWords(from, to)
  const html = renderLetterheadHtml({
    title: title.toUpperCase(),
    reportNo: reportNumber(prefix, now),
    date: fmtDate.format(from),
    companyName: COMPANY,
    info: [['Fleet', esc(COMPANY)], ['Period', esc(words)], ...info, ['Generated', esc(fmtShort.format(now))]],
    flow,
    footNote: `${COMPANY} · ${title} · ${words}`,
    logos,
  })
  return { html, filename: `${title} ${COMPANY} ${dayKey(now)}.pdf` }
}

/** The widths, scaled so the columns fill the page. */
const fit = (cols) => {
  const used = cols.reduce((s, c) => s + c.w, 0)
  return cols.map((c) => ({ ...c, w: mm(((c.w * INNER) / used).toFixed(1)) }))
}

export function breachesHtml(data, model, { logos, now = Date.now() }) {
  const flow = [`<h2>1. Overview <small>${esc(periodWords(data.from, data.to))}</small></h2>`, kpiCells(model.kpis)]
  if (!model.rows.length) flow.push('<div class="none">No policy breaches in this period.</div>')
  model.sections.forEach((s, i) => {
    const sum = s.rows.reduce((n, r) => n + r.total, 0)
    flow.push(`<h2>${i + 2}. ${esc(s.name)} <small>${s.rows.length} vehicle${s.rows.length === 1 ? '' : 's'} · ${sum} breach${sum === 1 ? '' : 'es'}</small></h2>`)
    flow.push(table(fit(breachCols(model.list)), s.rows.map(breachCells(model.list))))
  })
  flow.push(`<div class="note">Overspeeding, harsh braking and harsh acceleration come from the trackers and dashcams; no seatbelt, on phone${model.limited ? '' : ' and camera covered'} from the dashcams, so only units with a camera can raise them.</div>`)
  flow.push('<div class="note">Driver is the driver assigned to the vehicle when the report was made, who may not have been driving at the time of every breach.</div>')
  return page({
    title: 'Policy Breaches Report', prefix: 'PB', now, from: data.from, to: data.to, logos, flow,
    info: [['Vehicles', `${model.rows.length} with breaches of ${model.units}`], ['Breaches', String(model.total)]],
  })
}

export function movementsHtml(data, model, { logos, now = Date.now() }) {
  const flow = [`<h2>1. Overview <small>At ${esc(when(now, now))}</small></h2>`, kpiCells(model.kpis)]
  flow.push(`<h2>2. Where each unit is <small>${model.rows.length} units</small></h2>`)
  flow.push(table(fit([
    { h: 'Vehicle', w: 22 }, { h: 'Driver', w: 30 }, { h: 'Status', w: 52 }, { h: 'Location now', w: 44 },
    { h: 'State', w: 16 }, { h: 'Last fix', w: 20 },
  ]), model.rows.map((r) => [
    { html: esc(r.plate) + (r.status === 'out' ? tag('Out', true) : ''), cls: 'b' },
    r.driver ? esc(r.driver) : { html: '-', cls: 'm' },
    { html: esc(statusWords(r, now)), cls: r.status === 'in' ? 'wrap' : 'b wrap' },
    { html: esc(r.place), cls: 'wrap' },
    r.state === 'Offline' ? { html: 'Offline', cls: 'm' } : esc(r.state),
    r.fixAt ? esc(when(r.fixAt, now)) : { html: '-', cls: 'm' },
  ])))
  if (model.limited) {
    flow.push('<div class="note">Zones are the geofences set up in Samad\'s IntelliFleet360 account.</div>')
    return page({
      title: 'Movements Report', prefix: 'MV', now, from: data.from, to: data.to, logos, flow,
      info: [['Units', String(model.rows.length)], ['Zones', String(data.zones.length)]],
    })
  }
  flow.push(`<h2>3. Zone crossings <small>${model.crossings.length} in the period</small></h2>`)
  if (!model.crossings.length) flow.push('<div class="none">No unit entered or left a zone in this period.</div>')
  else {
    flow.push(table(fit([{ h: 'Time', w: 26 }, { h: 'Vehicle', w: 26 }, { h: 'Crossing', w: 20 }, { h: 'Zone', w: 70 }, { h: 'Speed', w: 18, r: true }]),
      model.crossings.map((c) => [
        esc(when(c.at, data.from)), { html: esc(c.plate), cls: 'b' }, c.action === 'exit' ? { html: 'Left', cls: 'b' } : 'Entered',
        esc(c.zone || '-'), Number.isFinite(c.speed) && c.speed > 0 ? `${Math.round(c.speed)} km/h` : { html: '-', cls: 'm' },
      ])))
  }
  flow.push('<div class="note">Zones are the geofences set up in Samad\'s IntelliFleet360 account. "Out since" is the unit\'s last exit from a zone, as far back as events are kept (30 days).</div>')
  return page({
    title: 'Movements Report', prefix: 'MV', now, from: data.from, to: data.to, logos, flow,
    info: [['Units', String(model.rows.length)], ['Zones', String(data.zones.length)]],
  })
}

export function shiftHtml(data, model, { logos, now = Date.now(), shiftWords }) {
  let k = 1
  const flow = [`<h2>${k++}. Shift Overview <small>${esc(periodWords(data.from, data.to))}</small></h2>`, kpiCells(model.kpis)]

  flow.push(`<h2>${k++}. Critical alarms <small>${model.critical.length}</small></h2>`)
  if (!model.critical.length) flow.push('<div class="none">No critical alarm in this shift.</div>')
  else {
    flow.push(table(fit([{ h: 'Time', w: 16 }, { h: 'Vehicle', w: 24 }, { h: 'Driver', w: 34 }, { h: 'Alarm', w: 46 }, { h: 'Speed', w: 18, r: true }, { h: 'Clip', w: 14 }]),
      model.critical.map((e) => [
        esc(when(e.at, data.from)), { html: esc(e.plate), cls: 'b' }, e.driver ? esc(e.driver) : { html: '-', cls: 'm' },
        esc(e.label), Number.isFinite(e.speed) && e.speed > 0 ? `${Math.round(e.speed)} km/h` : { html: '-', cls: 'm' },
        e.hasClip ? 'Yes' : { html: 'No', cls: 'm' },
      ])))
  }

  flow.push(`<h2>${k++}. Policy breaches <small>${model.breachTotal}</small></h2>`)
  flow.push(cells(model.breaches.map((b) => [`${b.label} · ${b.units.length} unit${b.units.length === 1 ? '' : 's'}`, String(b.count)])))
  flow.push('<div style="height:1.6mm"></div>')
  // One row per breach with its total, then one row per unit with its own count.
  const rows = []
  for (const b of model.breaches) {
    rows.push([{ html: esc(b.label), cls: 'b' }, { html: String(b.count), cls: 'b' }])
    if (!b.units.length) rows.push([{ html: 'None', cls: 'm', style: 'padding-left:5mm' }, ''])
    for (const u of b.units) rows.push([{ html: esc(u.plate), style: 'padding-left:5mm' }, String(u.n)])
  }
  flow.push(table(fit([{ h: 'Breach / unit', w: 150 }, { h: 'Count', w: 34, r: true }]), rows))

  // The units (operator, 2026-11-03: in place of the handover lines).
  const totalKm = model.units.reduce((s, u) => s + (u.km ?? 0), 0)
  flow.push(`<h2>${k++}. Units <small>${model.units.length} · ${Math.round(totalKm * 10) / 10} km in the shift</small></h2>`)
  flow.push(table(fit([{ h: 'Vehicle', w: 30 }, { h: 'Distance in shift', w: 34, r: true }, { h: 'Location now', w: 90 }, { h: 'State', w: 22 }]),
    model.units.map((u) => [
      { html: esc(u.plate), cls: 'b' },
      u.km == null ? { html: 'Not available', cls: 'm' } : `${u.km.toFixed(1)} km`,
      { html: esc(u.place), cls: 'wrap' },
      u.state === 'Offline' ? { html: 'Offline', cls: 'm' } : esc(u.state),
    ])))
  if (model.units.some((u) => u.km == null)) flow.push('<div class="note">Not available: the unit\'s trip history for the shift could not be read.</div>')

  return page({
    title: 'End of Shift Report', prefix: 'ES', now, from: data.from, to: data.to, logos, flow,
    info: [['Shift', esc(shiftWords)], ['Units', `${data.vehicles.length} (${model.reporting} reporting)`]],
  })
}
