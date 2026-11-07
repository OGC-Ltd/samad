// Reports — Samad's three letterhead reports (operator, 2026-11-03), made by
// the server (operator, 2026-11-07: "the logic for generating pdf or reports
// to move to the server … both jpeg pdf csv, ability to edit, preview and
// portrait and landscape"):
//
//   Policy Breaches  overspeeding, harsh braking/acceleration, no seatbelt,
//                    on phone and camera covered, per unit
//   Movements        every unit: distance in the period, where it is, its state
//   End of Shift     the shift's critical alarms, breaches by unit, and every
//                    unit's distance and place
//
// The server builds the report as a document (api/reportDocs); Edit opens it
// in a form; the preview is the server's own drawing of the pages, so what is
// on screen is what the PDF and JPEG hold.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useAppActions } from '../../context/AppContext'
import { loadReportDoc, previewReport, downloadReport } from '../../api/reportDocs'
import { PRESETS, presetRange, SHIFTS, currentShift, periodWords, dayKey } from '../../lib/samadReports'
import TableToolbar from '../body/TableToolbar'
import EmptyNote from '../shared/EmptyNote'
import ReportEditor from './ReportEditor'
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

/** The value, once it has stopped changing for `ms`. */
function useSettled(value, ms) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

function summaryOf(doc) {
  const s = doc?.summary ?? {}
  if (doc?.kind === 'breaches') return <><b>{s.breaches}</b> breach{s.breaches === 1 ? '' : 'es'} · <b>{s.vehicles}</b> vehicle{s.vehicles === 1 ? '' : 's'} · {s.period}</>
  if (doc?.kind === 'movements') return <><b>{s.km}</b> km · <b>{s.moving}</b> moving now · {s.period}</>
  return <><b>{s.critical}</b> critical · <b>{s.breaches}</b> breaches · <b>{s.reporting}</b> of {s.units} units reporting · {s.period}</>
}

export default function ReportsScreen() {
  const { setDesktopActiveTab } = useAppActions()

  const [tab, setTab] = useState('breaches')
  const [preset, setPreset] = useState('today')
  const [custom, setCustom] = useState(() => { const r = presetRange('7d'); return { from: toInput(r.from), to: toInput(r.to) } })
  const [shift, setShift] = useState(currentShift)
  // The period is fixed when it is picked (and on Refresh), not on every
  // render: "today" ends at the moment it was asked for.
  const [stamp, setStamp] = useState(() => Date.now())
  const [orientation, setOrientation] = useState('portrait')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)      // the edited document, or null
  const [busy, setBusy] = useState(null)        // 'pdf' | 'jpeg' | 'csv' | null
  const [progress, setProgress] = useState('')
  const [saveError, setSaveError] = useState(null)

  const range = useMemo(() => {
    if (preset === 'custom') return { from: fromInput(custom.from), to: Math.min(fromInput(custom.to), stamp) }
    return presetRange(preset, stamp)
  }, [preset, custom, stamp])

  const problem = tab === 'shift' ? null
    : !Number.isFinite(range.from) || !Number.isFinite(range.to) ? 'Pick a start and an end.'
      : range.from >= range.to ? 'The period must start before it ends.'
        : range.to - range.from > MAX_DAYS * DAY ? `A report covers ${MAX_DAYS} days at most.`
          : range.from < stamp - MAX_DAYS * DAY ? `Events are kept for ${MAX_DAYS} days; pick a later start.`
            : null

  const docKey = ['reports', 'doc', tab, tab === 'shift' ? shift.day : range.from, tab === 'shift' ? shift.shift : range.to, stamp]
  const docQ = useQuery({
    queryKey: docKey,
    queryFn: ({ signal }) => loadReportDoc({ kind: tab, from: range.from, to: range.to, day: shift.day, shift: shift.shift, signal }),
    enabled: !problem,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: Infinity,          // a report is remade only when asked (Refresh, a new period)
    refetchOnWindowFocus: false,  // which would also throw the edits away
  })
  const built = docQ.data && !docQ.isPlaceholderData ? docQ.data : null
  // A new report (another tab, period or Refresh) drops the edits made to the last one.
  const docKeyText = JSON.stringify(docKey)
  useEffect(() => { setDraft(null) }, [docKeyText])
  useEffect(() => { setSaveError(null) }, [tab, range.from, range.to, shift])

  const doc = useMemo(() => {
    const d = draft ?? built
    return d ? { ...d, orientation } : null
  }, [draft, built, orientation])

  // The preview follows the edits once typing pauses.
  const settled = useSettled(doc, draft ? 700 : 0)
  const settledKey = useMemo(() => (settled ? JSON.stringify(settled) : ''), [settled])
  const previewQ = useQuery({
    queryKey: ['reports', 'preview', settledKey],
    queryFn: ({ signal }) => previewReport(settled, signal),
    enabled: Boolean(settled),
    placeholderData: keepPreviousData,
    retry: 0,
    staleTime: Infinity,
    gcTime: 60_000,
  })

  const save = async (format) => {
    if (!doc || busy) return
    setBusy(format); setSaveError(null); setProgress('')
    try {
      await downloadReport(doc, format, setProgress)
    } catch (e) {
      setSaveError(e?.message || 'The file could not be made.')
    } finally {
      setBusy(null); setProgress('')
    }
  }

  const reload = () => { setStamp(Date.now()) }
  const waitWords = tab === 'breaches' ? 'Reading the fleet\'s events.'
    : 'Reading each unit\'s trip history and current location. The first report of a period can take a minute; the next is quick.'

  const summary = problem ? <span className="sp4-muted">{problem}</span>
    : !built ? <span className="sp4-muted">{docQ.isFetching ? 'Making the report…' : ''}</span>
      : summaryOf(built)

  const pages = previewQ.data ?? []
  const rotated = previewQ.isPlaceholderData || (settled !== doc)

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
          summary={<>{summary}{docQ.isFetching && built && <span className="sp4-muted"> · updating…</span>}{draft && <span className="rpt-edited"> · edited</span>}</>}
          loading={docQ.isFetching}
          onReload={reload}
          actions={(
            <>
              <div className="rpt-seg" role="group" aria-label="Page orientation">
                {[['portrait', 'Portrait', 'ti-file'], ['landscape', 'Landscape', 'ti-file-horizontal']].map(([k, label, icon]) => (
                  <button key={k} type="button" aria-pressed={orientation === k}
                          className={`rpt-seg-btn${orientation === k ? ' rpt-seg-btn--on' : ''}`} onClick={() => setOrientation(k)}>
                    <i className={`ti ${icon}`} aria-hidden="true" /> {label}
                  </button>
                ))}
              </div>
              <button type="button" className={`sp4-ghost-btn${editing ? ' rpt-on' : ''}`} aria-pressed={editing}
                      onClick={() => setEditing((e) => !e)} disabled={!doc}>
                <i className="ti ti-pencil" aria-hidden="true" /> {editing ? 'Done' : 'Edit'}
              </button>
              {draft && (
                <button type="button" className="sp4-ghost-btn" onClick={() => setDraft(null)} title="Back to the report as the server made it">
                  <i className="ti ti-arrow-back-up" aria-hidden="true" /> Undo edits
                </button>
              )}
              <button type="button" className="sp4-ghost-btn" onClick={() => save('pdf')} disabled={!doc || Boolean(busy)}>
                <i className="ti ti-file-type-pdf" aria-hidden="true" /> {busy === 'pdf' ? 'Making PDF…' : 'PDF'}
              </button>
              <button type="button" className="sp4-ghost-btn" onClick={() => save('jpeg')} disabled={!doc || Boolean(busy)}
                      title="Every page in one image, for a WhatsApp group">
                <i className="ti ti-photo" aria-hidden="true" /> {busy === 'jpeg' ? 'Making JPEG…' : 'JPEG'}
              </button>
              <button type="button" className="sp4-ghost-btn" onClick={() => save('csv')} disabled={!doc || Boolean(busy)}
                      title="The figures and tables, for a spreadsheet">
                <i className="ti ti-file-spreadsheet" aria-hidden="true" /> {busy === 'csv' ? 'Making CSV…' : 'CSV'}
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

        {saveError && <div className="rpt-error" role="alert">{saveError}</div>}
        {busy && progress && <div className="rpt-progress" role="status">{progress}…</div>}

        {problem ? (
          <EmptyNote icon="ti-calendar-x" tone="warn" title="Pick Another Period">{problem}</EmptyNote>
        ) : docQ.isError && !built ? (
          <EmptyNote icon="ti-alert-triangle" tone="error" title="The Report Could Not Be Made"
                     action={{ label: 'Try again', onClick: () => docQ.refetch() }}>
            {docQ.error?.message ?? 'The server did not answer.'}
          </EmptyNote>
        ) : !doc ? (
          <EmptyNote icon="ti-loader-2" tone="busy" title="Making the Report">
            {tab === 'shift' ? periodWords(shiftWindow(shift).from, shiftWindow(shift).to) : periodWords(range.from, range.to)}. {waitWords}
          </EmptyNote>
        ) : (
          <div className={`rpt-work${editing ? ' rpt-work--editing' : ''}`}>
            {editing && (
              <div className="rpt-editor">
                <ReportEditor doc={doc} onChange={(d) => setDraft(d)} />
              </div>
            )}
            <div className={`rpt-pages rpt-pages--${orientation}`} aria-busy={previewQ.isFetching}>
              {previewQ.isError && (
                <div className="rpt-error" role="alert">{previewQ.error?.message ?? 'The preview could not be drawn.'}</div>
              )}
              {pages.length === 0 && previewQ.isFetching && <div className="rpt-progress" role="status">Drawing the pages…</div>}
              {pages.map((src, i) => (
                <img key={i} src={src} alt={`Page ${i + 1} of ${pages.length}`}
                     className={`rpt-page${rotated && previewQ.isFetching ? ' rpt-page--stale' : ''}`} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** The shift's window, for the waiting line only (the server works it out itself). */
function shiftWindow(s) {
  const start = Date.parse(`${s.day}T00:00:00+03:00`) + (s.shift === 'night' ? 18 : 6) * 3_600_000
  return { from: start, to: Math.min(start + 12 * 3_600_000, Date.now()) }
}
