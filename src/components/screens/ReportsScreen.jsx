// Reports — Samad's three letterhead reports (operator, 2026-11-03), built the
// way RaiTrack's are: Samad Resources' logo on the left of the dark band, OGC
// Monitoring's on the right.
//
//   Policy Breaches  overspeeding, harsh braking/acceleration, no seatbelt,
//                    on phone and camera covered, per unit
//   Movements        where every unit is (in a zone, or out since when) and
//                    every zone crossing in the period
//   End of Shift     the shift's critical alarms, breaches (top 5 units of
//                    each), units still out of a geofence, and the handover
//
// The figures come from the server's events (api/fleetReport); the reports
// and their letterhead pages from lib/samadReports. The preview IS the page
// the PDF is drawn from, so what is on screen is what is saved.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useFleetLiveShared } from '../../context/FleetLiveContext'
import { useAppActions } from '../../context/AppContext'
import { loadFleetReport, distancesIn, placesNow } from '../../api/fleetReport'
import { saveLetterheadPdf, saveLetterheadJpeg, letterheadLogos } from '../../api/letterheadPdf'
import { layOutLetterhead } from '../../lib/letterhead'
import {
  PRESETS, presetRange, SHIFTS, shiftRange, currentShift, periodWords,
  breachesReport, movementsReport, shiftReport, breachesHtml, movementsHtml, shiftHtml,
  dayKey, LIMITED_NOTE,
} from '../../lib/samadReports'
import TableToolbar from '../body/TableToolbar'
import EmptyNote from '../shared/EmptyNote'
import '../body/SensorPanel.scss'
import './SystemScreen.scss'
import './ReportsScreen.scss'

const TABS = [
  { key: 'breaches',  label: 'Policy Breaches' },
  { key: 'movements', label: 'Movements' },
  { key: 'shift',     label: 'End of Shift' },
]

const MAX_DAYS = 30
const DAY = 86_400_000

/** "2026-11-03T14:05" in Nairobi ⇄ epoch ms, for the custom period's inputs. */
const toInput = (ms) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 16)
const fromInput = (s) => Date.parse(`${s}:00+03:00`)

export default function ReportsScreen() {
  const { orgId } = useFleetLiveShared()
  const { setDesktopActiveTab } = useAppActions()

  const [tab, setTab] = useState('breaches')
  const [preset, setPreset] = useState('today')
  const [custom, setCustom] = useState(() => { const r = presetRange('7d'); return { from: toInput(r.from), to: toInput(r.to) } })
  const [shift, setShift] = useState(currentShift)
  // The period is fixed when it is picked (and on Refresh), not on every render:
  // "today" ends at the moment it was asked for.
  const [stamp, setStamp] = useState(() => Date.now())
  const [busy, setBusy] = useState(null)        // 'pdf' | 'jpeg' | null
  const [progress, setProgress] = useState('')
  const [saveError, setSaveError] = useState(null)

  const range = useMemo(() => {
    if (tab === 'shift') {
      const r = shiftRange(shift.day, shift.shift)
      return { ...r, to: Math.min(r.to, stamp) }
    }
    if (preset === 'custom') return { from: fromInput(custom.from), to: Math.min(fromInput(custom.to), stamp) }
    return presetRange(preset, stamp)
  }, [tab, preset, custom, shift, stamp])

  const problem = !Number.isFinite(range.from) || !Number.isFinite(range.to) ? 'Pick a start and an end.'
    : range.from >= range.to ? (tab === 'shift' ? 'That shift has not started yet.' : 'The period must start before it ends.')
      : range.to - range.from > MAX_DAYS * DAY ? `A report covers ${MAX_DAYS} days at most.`
        : range.from < stamp - MAX_DAYS * DAY ? `Events are kept for ${MAX_DAYS} days; pick a later start.`
          : null

  const q = useQuery({
    queryKey: ['reports', 'fleet', orgId, range.from, range.to],
    queryFn: ({ signal }) => loadFleetReport({ orgId, from: range.from, to: range.to, signal }),
    enabled: Boolean(orgId) && !problem,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: 60_000,
  })
  const data = q.data && !q.isPlaceholderData ? q.data : null

  const shiftWords = `${SHIFTS.find((s) => s.key === shift.shift)?.label ?? 'Day'}, ${SHIFTS.find((s) => s.key === shift.shift)?.words ?? ''}`
  // End of Shift: each unit's distance in the shift, from its trip history
  // (api/fleetReport distancesIn). If it fails, the column says so.
  const distancesQ = useQuery({
    queryKey: ['reports', 'distances', orgId, data?.from, data?.to],
    queryFn: ({ signal }) => distancesIn({ orgId, vehicles: data.vehicles, from: data.from, to: data.to, signal }),
    enabled: (tab === 'shift' || tab === 'movements') && Boolean(data),
    retry: 0,
    staleTime: 60_000,
  })
  // Movements and End of Shift: where each unit is, as a place name.
  const placesQ = useQuery({
    queryKey: ['reports', 'places', orgId, data?.generatedAt],
    queryFn: () => placesNow(data.vehicles),
    enabled: (tab === 'shift' || tab === 'movements') && Boolean(data),
    retry: 0,
    staleTime: 5 * 60_000,
  })
  const needsUnits = tab === 'shift' || tab === 'movements'
  const distances = needsUnits ? distancesQ.data ?? null : null
  const places = needsUnits ? placesQ.data ?? null : null
  const waitReported = needsUnits && Boolean(data) && (distancesQ.isPending || placesQ.isPending)

  const built = useMemo(() => {
    if (!data || waitReported) return null
    const now = data.generatedAt
    const logos = letterheadLogos()
    if (tab === 'movements') {
      const model = movementsReport(data, { distances, places })
      return { model, ...movementsHtml(data, model, { logos, now }) }
    }
    if (tab === 'shift') {
      const model = shiftReport(data, now, { distances, places })
      return { model, ...shiftHtml(data, model, { logos, now, shiftWords }) }
    }
    const model = breachesReport(data)
    return { model, ...breachesHtml(data, model, { logos, now }) }
  }, [data, tab, shiftWords, waitReported, distances, places])

  useEffect(() => { setSaveError(null) }, [tab, range.from, range.to])

  const save = async (kind) => {
    if (!built || busy) return
    setBusy(kind); setSaveError(null); setProgress('Laying out the pages')
    try {
      const opts = { filename: built.filename, onProgress: setProgress }
      if (kind === 'pdf') await saveLetterheadPdf(built.html, opts)
      else await saveLetterheadJpeg(built.html, opts)
    } catch (e) {
      setSaveError(e?.message || 'The file could not be made.')
    } finally {
      setBusy(null); setProgress('')
    }
  }

  const summary = (() => {
    if (problem) return <span className="sp4-muted">{problem}</span>
    if (!data || !built) return <span className="sp4-muted">{waitReported ? 'Measuring each unit\'s distance and finding where it is…' : `Reading ${periodWords(range.from, range.to)}…`}</span>
    const m = built?.model
    const words = periodWords(data.from, data.to)
    if (tab === 'breaches') return <><b>{m.total}</b> breach{m.total === 1 ? '' : 'es'} · <b>{m.rows.length}</b> vehicle{m.rows.length === 1 ? '' : 's'} · {words}</>
    if (tab === 'movements') return <><b>{m.totalKm}</b> km · <b>{m.rows.filter((r) => r.state === 'Moving').length}</b> moving now · {words}</>
    return <><b>{m.critical.length}</b> critical · <b>{m.breachTotal}</b> breaches · <b>{m.reporting}</b> of {data.vehicles.length} units reporting · {words}</>
  })()

  return (
    <div className="sp4-root sys-root rpt-root">
      <div className="sp4-tabs" role="tablist" aria-label="Reports">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                  className={`sp4-tab${tab === t.key ? ' sp4-tab--on' : ''}`}
                  onClick={() => { setTab(t.key); setStamp(Date.now()) }}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="sp4-body">
        <TableToolbar
          summary={<>{summary}{q.isFetching && data && <span className="sp4-muted"> · updating…</span>}</>}
          loading={q.isFetching}
          onReload={() => { setStamp(Date.now()); q.refetch() }}
          actions={(
            <>
              <button type="button" className="sp4-ghost-btn" onClick={() => save('pdf')} disabled={!built || Boolean(busy)}>
                <i className="ti ti-file-type-pdf" aria-hidden="true" /> {busy === 'pdf' ? 'Making PDF…' : 'PDF'}
              </button>
              <button type="button" className="sp4-ghost-btn" onClick={() => save('jpeg')} disabled={!built || Boolean(busy)}
                      title="One image of every page, for a WhatsApp group">
                <i className="ti ti-photo" aria-hidden="true" /> {busy === 'jpeg' ? 'Making JPEG…' : 'JPEG'}
              </button>
              <button type="button" className="sp4-ghost-btn" onClick={() => setDesktopActiveTab('fleet')}>
                <i className="ti ti-arrow-left" aria-hidden="true" /> Live Map
              </button>
            </>
          )}
        />

        <div className="rpt-controls">
          {tab === 'shift' ? (
            <>
              <label className="rpt-field">
                <span>Date</span>
                <input type="date" value={shift.day} max={dayKey(stamp)}
                       min={dayKey(stamp - (MAX_DAYS - 1) * DAY)}
                       onChange={(e) => { if (e.target.value) { setShift((s) => ({ ...s, day: e.target.value })); setStamp(Date.now()) } }} />
              </label>
              <div className="rpt-field">
                <span>Shift</span>
                <div className="rpt-chips">
                  {SHIFTS.map((s) => (
                    <button key={s.key} type="button" aria-pressed={shift.shift === s.key}
                            className={`sp4-filter-chip${shift.shift === s.key ? ' sp4-filter-chip--on' : ''}`}
                            onClick={() => { setShift((x) => ({ ...x, shift: s.key })); setStamp(Date.now()) }}>
                      {s.label} <span className="rpt-dim">{s.words}</span>
                    </button>
                  ))}
                </div>
              </div>
              <button type="button" className="sp4-ghost-btn rpt-now"
                      onClick={() => { setShift(currentShift()); setStamp(Date.now()) }}>
                This shift
              </button>
            </>
          ) : (
            <>
              <div className="rpt-field">
                <span>Period</span>
                <div className="rpt-chips">
                  {PRESETS.map((p) => (
                    <button key={p.key} type="button" aria-pressed={preset === p.key}
                            className={`sp4-filter-chip${preset === p.key ? ' sp4-filter-chip--on' : ''}`}
                            onClick={() => { setPreset(p.key); setStamp(Date.now()) }}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              {preset === 'custom' && (
                <>
                  <label className="rpt-field">
                    <span>From</span>
                    <input type="datetime-local" value={custom.from}
                           onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
                  </label>
                  <label className="rpt-field">
                    <span>To</span>
                    <input type="datetime-local" value={custom.to}
                           onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
                  </label>
                </>
              )}
            </>
          )}
        </div>

        {data && data.has?.crossings === false && (
          <div className="rpt-limited" role="note">
            <i className="ti ti-info-circle" aria-hidden="true" />
            {LIMITED_NOTE}
          </div>
        )}
        {saveError && <div className="rpt-error" role="alert">{saveError}</div>}
        {busy && progress && <div className="rpt-progress" role="status">{progress}…</div>}

        {problem ? (
          <EmptyNote icon="ti-calendar-x" tone="warn" title="Pick Another Period">{problem}</EmptyNote>
        ) : q.isError && !data ? (
          <EmptyNote icon="ti-alert-triangle" tone="error" title="The Report Could Not Be Made"
                     action={{ label: 'Try again', onClick: () => q.refetch() }}>
            {q.error?.message ?? 'The server did not answer.'}
          </EmptyNote>
        ) : !built ? (
          <EmptyNote icon="ti-loader-2" tone="busy" title={waitReported ? 'Checking Each Unit' : 'Reading the Fleet'}>
            {waitReported ? 'Reading each unit\'s trip history and current location.' : periodWords(range.from, range.to)}
          </EmptyNote>
        ) : (
          <iframe className="rpt-preview" title={`${TABS.find((t) => t.key === tab)?.label} preview`}
                  sandbox="allow-same-origin" srcDoc={built.html}
                  onLoad={(e) => { layOutLetterhead(e.currentTarget.contentDocument) }} />
        )}
      </div>
    </div>
  )
}
