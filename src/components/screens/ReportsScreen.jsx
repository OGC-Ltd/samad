// Reports — Samad's three letterhead reports (operator, 2026-11-03), made by
// the server (operator, 2026-11-07: "the logic for generating pdf or reports
// to move to the server … both jpeg pdf csv, ability to edit, preview and
// portrait and landscape"):
//
//   Policy Breaches  hidden 2026-11-10 (Driver Conduct covers it): overspeeding,
//                    harsh braking/acceleration, no seatbelt, on phone, per unit
//   Movements        every unit: distance in the period, where it is, its state
//   End of Shift     laid out after the Menengai end-of-shift sheet (operator,
//                    2026-11-07): the shift at a glance, critical alarms, the
//                    breaches with the top units for each, and the handover
//   Weekly Incidents breaches per driver and truck, week by week, to watch
//                    them come down (operator, 2026-11-07)
//   Driver Conduct   each driver's incidents per vehicle, by vehicle type,
//                    after the Menengai Driver Conduct sheet (operator,
//                    2026-11-07); End of Shift also takes a custom period
//   Reefer (Maersk)  the daily reefer consignment sheet sent to Maersk
//                    (operator, 2026-11-10), from the register staff keep
//                    under its Consignments view (ConsignmentsPanel)
//
// The server builds the report as a document (api/reportDocs); Edit opens it
// in a form; the preview is the server's own drawing of the pages, so what is
// on screen is what the PDF and JPEG hold.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useAppActions } from '../../context/AppContext'
import { loadReportDoc, previewReport, downloadReport } from '../../api/reportDocs'
import { PRESETS, presetRange, SHIFTS, currentShift, shiftRange, periodWords, dayKey } from '../../lib/samadReports'
import EmptyNote from '../shared/EmptyNote'
import ReportEditor from './ReportEditor'
import ConsignmentsPanel from './ConsignmentsPanel'
import '../body/SensorPanel.scss'
import './SystemScreen.scss'
import './ReportsScreen.scss'

const TABS = [
  // Policy Breaches is hidden: Driver Conduct covers the same incidents
  // (operator, 2026-11-10). The server still builds it for End of Shift.
  { key: 'conduct',   label: 'Driver Conduct' },
  { key: 'movements', label: 'Movements' },
  { key: 'shift',     label: 'End of Shift' },
  { key: 'weekly',    label: 'Weekly Incidents' },
  { key: 'reefer',    label: 'Reefer (Maersk)' },
]

const WEEKS = [1, 4, 8, 12]

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

/** The report's own figures, as label and value pairs for the status bar. */
function figuresOf(doc) {
  const s = doc?.summary ?? {}
  if (doc?.kind === 'breaches') return [[s.breaches === 1 ? 'Breach' : 'Breaches', s.breaches], [s.vehicles === 1 ? 'Vehicle' : 'Vehicles', s.vehicles]]
  if (doc?.kind === 'conduct') return [[s.incidents === 1 ? 'Incident' : 'Incidents', s.incidents], [s.vehicles === 1 ? 'Vehicle' : 'Vehicles', s.vehicles]]
  if (doc?.kind === 'movements') return [['Km', s.km], ['Moving now', s.moving]]
  if (doc?.kind === 'reefer') return [['On the road', s.open], ['At Alpha/APMT', s.atPort]]
  if (doc?.kind === 'weekly') return [[`Incidents in ${s.week}`, s.incidents], ['Change', s.change], ['Drivers', s.drivers], ['Trucks', s.trucks]]
  return [['Critical', s.critical], ['Breaches', s.breaches], ['Units reporting', `${s.reporting} of ${s.units}`]]
}

/** One choice of a few, as a row of joined buttons. */
function Segmented({ label, options, value, onPick }) {
  return (
    <div className="rpt-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key}
                className={`rpt-seg-btn${value === o.key ? ' rpt-seg-btn--on' : ''}`} onClick={() => onPick(o.key)}>
          {o.icon && <i className={`ti ${o.icon}`} aria-hidden="true" />}
          {o.label}
          {o.hint && <span className="rpt-seg-hint">{o.hint}</span>}
        </button>
      ))}
    </div>
  )
}

export default function ReportsScreen() {
  const { setDesktopActiveTab } = useAppActions()

  const [tab, setTab] = useState('conduct')
  const [preset, setPreset] = useState('today')
  const [custom, setCustom] = useState(() => { const r = presetRange('7d'); return { from: toInput(r.from), to: toInput(r.to) } })
  const [shift, setShift] = useState(currentShift)
  const [weeks, setWeeks] = useState(4)
  const [week, setWeek] = useState('') // a day in the last week shown; '' is the last finished week
  // The period is fixed when it is picked (and on Refresh), not on every
  // render: "today" ends at the moment it was asked for.
  const [stamp, setStamp] = useState(() => Date.now())
  const [orientation, setOrientation] = useState('portrait') // each new report sets its own
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)      // the edited document, or null
  const [busy, setBusy] = useState(null)        // 'pdf' | 'jpeg' | 'csv' | null
  const [progress, setProgress] = useState('')
  const [saveError, setSaveError] = useState(null)
  const [reeferView, setReeferView] = useState('register') // 'register' | 'report'
  const register = tab === 'reefer' && reeferView === 'register'

  const range = useMemo(() => {
    if (preset === 'custom') return { from: fromInput(custom.from), to: Math.min(fromInput(custom.to), stamp) }
    return presetRange(preset, stamp)
  }, [preset, custom, stamp])

  // End of Shift by hand: the custom period's From and To, shared with the other tabs.
  const shiftCustom = tab === 'shift' && shift.shift === 'custom'
  const period = useMemo(() => (shiftCustom
    ? { from: fromInput(custom.from), to: Math.min(fromInput(custom.to), stamp) }
    : range), [shiftCustom, custom, stamp, range])

  const problem = tab === 'weekly' || tab === 'reefer' || (tab === 'shift' && !shiftCustom) ? null
    : !Number.isFinite(period.from) || !Number.isFinite(period.to) ? 'Pick a start and an end.'
      : period.from >= period.to ? 'The period must start before it ends.'
        : period.to - period.from > MAX_DAYS * DAY ? `A report covers ${MAX_DAYS} days at most.`
          : period.from < stamp - MAX_DAYS * DAY ? `Events are kept for ${MAX_DAYS} days; pick a later start.`
            : null

  const docKey = shiftCustom ? ['reports', 'doc', tab, 'custom', period.from, period.to, stamp]
    : tab === 'shift' ? ['reports', 'doc', tab, shift.day, shift.shift, stamp]
    : tab === 'weekly' ? ['reports', 'doc', tab, weeks, week, stamp]
    : tab === 'reefer' ? ['reports', 'doc', tab, stamp]
      : ['reports', 'doc', tab, range.from, range.to, stamp]
  const docQ = useQuery({
    queryKey: docKey,
    queryFn: ({ signal }) => loadReportDoc({ kind: tab, from: period.from, to: period.to, day: shift.day, shift: shift.shift, weeks, week, signal }),
    enabled: !problem && !register,
    placeholderData: keepPreviousData,
    retry: 1,
    staleTime: Infinity,          // a report is remade only when asked (Refresh, a new period)
    refetchOnWindowFocus: false,  // which would also throw the edits away
  })
  const built = docQ.data && !docQ.isPlaceholderData ? docQ.data : null
  // A new report (another tab, period or Refresh) drops the edits made to the last one.
  const docKeyText = JSON.stringify(docKey)
  useEffect(() => { setDraft(null) }, [docKeyText])
  // Each report comes in the orientation the server picked for it (End of
  // Shift and Weekly landscape, like the sheet); the toggle overrides it.
  useEffect(() => { if (built?.orientation) setOrientation(built.orientation) }, [built])
  useEffect(() => { setSaveError(null) }, [tab, period.from, period.to, shift])

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
  const waitWords = tab === 'reefer' ? 'Reading the consignments and where each truck is.'
    : tab === 'breaches' || tab === 'conduct' || tab === 'weekly' ? 'Reading the fleet\'s events.'
    : 'Reading each unit\'s trip history and current location. The first report of a period can take a minute; the next is quick.'

  const customFields = (
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
  )

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
        <header className="rpt-head" data-tour="page-toolbar">
          <div className="rpt-pick">
            {tab === 'reefer' ? (
              <div className="rpt-field">
                <span>View</span>
                <Segmented label="View" value={reeferView} onPick={(k) => { setReeferView(k); if (k === 'report') setStamp(Date.now()) }}
                           options={[{ key: 'register', label: 'Consignments', icon: 'ti-list-details' }, { key: 'report', label: 'Report', icon: 'ti-file-text' }]} />
              </div>
            ) : tab === 'weekly' ? (
              <>
                <label className="rpt-field">
                  <span>Week of</span>
                  <input type="date" value={week || dayKey(lastWeekStart(stamp))} max={dayKey(stamp)}
                         onChange={(e) => { if (e.target.value) { setWeek(e.target.value); setStamp(Date.now()) } }} />
                </label>
                <div className="rpt-field">
                  <span>Weeks</span>
                  <Segmented label="Weeks" value={weeks} onPick={(n) => { setWeeks(n); setStamp(Date.now()) }}
                             options={WEEKS.map((n) => ({ key: n, label: n === 1 ? 'That week' : `${n} weeks` }))} />
                </div>
                <button type="button" className="rpt-btn rpt-btn--quiet"
                        onClick={() => { setWeek(''); setStamp(Date.now()) }}>
                  Last week
                </button>
              </>
            ) : tab === 'shift' ? (
              <>
                {!shiftCustom && (
                  <label className="rpt-field">
                    <span>Date</span>
                    <input type="date" value={shift.day} max={dayKey(stamp)}
                           min={dayKey(stamp - (MAX_DAYS - 1) * DAY)}
                           onChange={(e) => { if (e.target.value) { setShift((s) => ({ ...s, day: e.target.value })); setStamp(Date.now()) } }} />
                  </label>
                )}
                <div className="rpt-field">
                  <span>Shift</span>
                  <Segmented label="Shift" value={shift.shift} onPick={(k) => { setShift((x) => ({ ...x, shift: k })); setStamp(Date.now()) }}
                             options={[...SHIFTS.map((s) => ({ key: s.key, label: s.label, hint: s.words })), { key: 'custom', label: 'Custom' }]} />
                </div>
                {shiftCustom && customFields}
                <button type="button" className="rpt-btn rpt-btn--quiet"
                        onClick={() => { setShift(currentShift()); setStamp(Date.now()) }}>
                  This shift
                </button>
              </>
            ) : (
              <>
                <div className="rpt-field">
                  <span>Period</span>
                  <Segmented label="Period" value={preset} onPick={(k) => { setPreset(k); setStamp(Date.now()) }}
                             options={PRESETS.map((p) => ({ key: p.key, label: p.label }))} />
                </div>
                {preset === 'custom' && customFields}
              </>
            )}
            {!register && <div className="rpt-field rpt-setup">
              <span>Page</span>
              <Segmented label="Page orientation" value={orientation} onPick={setOrientation}
                         options={[{ key: 'portrait', label: 'Portrait', icon: 'ti-file' }, { key: 'landscape', label: 'Landscape', icon: 'ti-file-horizontal' }]} />
            </div>}
            <button type="button" className="rpt-btn rpt-btn--quiet rpt-away" onClick={() => setDesktopActiveTab('fleet')}>
              <i className="ti ti-map-2" aria-hidden="true" /> Live Map
            </button>
          </div>

          {!register && <div className="rpt-bar">
            <div className="rpt-status" aria-live="polite">
              {problem ? <span className="rpt-quiet">{problem}</span>
                : !built ? <span className="rpt-quiet">{docQ.isFetching ? 'Making the report…' : ''}</span>
                  : (
                    <>
                      <span className="rpt-period">{built.summary?.period}</span>
                      <dl className="rpt-figs">
                        {figuresOf(built).map(([label, value]) => (
                          <div key={label} className="rpt-fig"><dt>{label}</dt><dd>{value ?? '-'}</dd></div>
                        ))}
                      </dl>
                      {docQ.isFetching && <span className="rpt-quiet">Updating…</span>}
                      {draft && <span className="rpt-edited">Edited</span>}
                    </>
                  )}
            </div>

            <div className="rpt-actions">
              <button type="button" className={`rpt-btn${editing ? ' rpt-btn--on' : ''}`} aria-pressed={editing}
                      onClick={() => setEditing((e) => !e)} disabled={!doc}>
                <i className="ti ti-pencil" aria-hidden="true" /> {editing ? 'Done' : 'Edit'}
              </button>
              {draft && (
                <button type="button" className="rpt-btn rpt-btn--quiet" onClick={() => setDraft(null)} title="Back to the report as the server made it">
                  <i className="ti ti-arrow-back-up" aria-hidden="true" /> Undo edits
                </button>
              )}
              <div className="rpt-save" role="group" aria-label="Download">
                <button type="button" className="rpt-btn rpt-btn--primary" onClick={() => save('pdf')} disabled={!doc || Boolean(busy)} aria-busy={busy === 'pdf'}>
                  <i className="ti ti-file-type-pdf" aria-hidden="true" /> {busy === 'pdf' ? 'Making PDF…' : 'PDF'}
                </button>
                <button type="button" className="rpt-btn" onClick={() => save('jpeg')} disabled={!doc || Boolean(busy)} aria-busy={busy === 'jpeg'}
                        title="Every page in one image, for a WhatsApp group">
                  <i className="ti ti-photo" aria-hidden="true" /> {busy === 'jpeg' ? 'Making JPEG…' : 'JPEG'}
                </button>
                <button type="button" className="rpt-btn" onClick={() => save('csv')} disabled={!doc || Boolean(busy)} aria-busy={busy === 'csv'}
                        title="The figures and tables, for a spreadsheet">
                  <i className="ti ti-file-spreadsheet" aria-hidden="true" /> {busy === 'csv' ? 'Making CSV…' : 'CSV'}
                </button>
              </div>
              <button type="button" className="rpt-btn rpt-btn--quiet" onClick={reload} disabled={docQ.isFetching} aria-busy={docQ.isFetching}>
                <i className="ti ti-refresh" aria-hidden="true" /> {docQ.isFetching ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>}
        </header>

        {saveError && <div className="rpt-error" role="alert">{saveError}</div>}
        {busy && progress && <div className="rpt-progress" role="status">{progress}…</div>}

        {register ? (
          <ConsignmentsPanel onShowReport={() => { setReeferView('report'); setStamp(Date.now()) }} />
        ) : problem ? (
          <EmptyNote icon="ti-calendar-x" tone="warn" title="Pick Another Period">{problem}</EmptyNote>
        ) : docQ.isError && !built ? (
          <EmptyNote icon="ti-alert-triangle" tone="error" title="The Report Could Not Be Made"
                     action={{ label: 'Try again', onClick: () => docQ.refetch() }}>
            {docQ.error?.message ?? 'The server did not answer.'}
          </EmptyNote>
        ) : !doc ? (
          <EmptyNote icon="ti-loader-2" tone="busy" title="Making the Report">
            {tab === 'reefer' ? 'The reefer consignments as they stand now' : tab === 'weekly' ? weeklyWords(weeks, week, stamp) : tab === 'shift' && !shiftCustom ? periodWords(shiftWindow(shift).from, shiftWindow(shift).to) : periodWords(period.from, period.to)}. {waitWords}
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

/** Monday 00:00 (Nairobi) of the week holding ms; the server works the weeks out itself. */
function weekStartOf(ms) {
  const day = Date.parse(`${dayKey(ms)}T00:00:00+03:00`)
  const wd = new Date(day + 3 * 3600e3).getUTCDay()
  return day - ((wd + 6) % 7) * DAY
}
const lastWeekStart = (now) => weekStartOf(now) - 7 * DAY

/** The waiting line's words for the weeks asked for. */
function weeklyWords(n, week, now) {
  const last = week ? weekStartOf(Date.parse(`${week}T12:00:00+03:00`)) : lastWeekStart(now)
  const first = last - 7 * DAY * (n - 1)
  const fmt = (ms, year) => new Date(ms + 3 * 3600e3).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' })
  const end = Math.min(last + 7 * DAY - 1, now)
  const words = `${n === 1 ? 'The week' : `${n} weeks`} from Monday ${fmt(first)} to ${fmt(end, true)}`
  return last + 7 * DAY > now ? `${words}, this week so far` : words
}

/** The shift's window, for the waiting line only (the server works it out itself). */
function shiftWindow(s) {
  const { from } = shiftRange(s.day, s.shift)
  return { from, to: Math.min(from + 12 * 3_600_000, Date.now()) }
}
