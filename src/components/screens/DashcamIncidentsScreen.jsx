// Camera — the dashcam alarms (seatbelt, phone use, lane departure, fatigue,
// forward collision…) with their clips, below Drivers in the sidebar.
// usePermissions grants the page ('vss:alarms') only where the backend
// reports at least one camera.
//
// Layout: an inbox. The alarms on the left, the selected one on the right —
// its clip or snapshot first (the evidence is what the page is for), then the
// facts and a small map. Built from the same parts as Alerts and Sensor
// Monitor (TableToolbar, FilterBar, the sp4 chips, pills and EmptyNote), so it
// reads as one of the app's pages rather than a page of its own.
//
// Data: api/vssAlarms — the backend lists the dashcam alarms the
// IntelliFleet360 feed brought with a clip, and serves each clip through its
// own file route (seeking supported), so the page only plays our own URLs. A file that fails says why. "Reviewed" marks are kept in this
// browser only (lib/dashcamReviewed); the button says so.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import '../body/SensorPanel.css'
import './SystemScreen.css'
import './DashcamIncidentsScreen.css'
import { useAppSelector, useAppActions, useCompanies } from '../../context/AppContext'
import { useFleetLiveShared } from '../../context/FleetLiveContext'
import { usePlaceName } from '../../hooks/usePlaceName'
import { CATEGORIES, RANGES } from '../../lib/dashcamIncidents'
import { vssIncidentsQuery, ensureVssSession } from '../../api/vssAlarms'
import { useDashcamReviewed } from '../../lib/dashcamReviewed'
import { diagnoseMedia } from '../../lib/mediaDiagnose'
import TableToolbar from '../body/TableToolbar'
import FilterBar from '../body/FilterBar'
import EmptyNote from '../shared/EmptyNote'

const UPLOAD_GRACE_MS = 15 * 60_000     // a clip younger than this may still be uploading
const NONE = []

// ── small helpers ───────────────────────────────────────────────────────────

const two = (n) => String(n).padStart(2, '0')
const clock = (ms) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}` }
const clockSec = (ms) => { const d = new Date(ms); return `${clock(ms)}:${two(d.getSeconds())}` }
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
function whenLabel(ms) {
  if (ms == null) return '-'
  const d = new Date(ms), now = new Date()
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return `Today ${clockSec(ms)}`
  if (sameDay(d, y)) return `Yesterday ${clockSec(ms)}`
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${clockSec(ms)}`
}
function rowTime(ms) {
  if (ms == null) return ''
  const d = new Date(ms)
  return sameDay(d, new Date()) ? clock(ms) : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock(ms)}`
}

/** Each severity as a word and the app's pill tone for it — never colour alone. */
const SEVERITY = {
  critical:      { word: 'Critical', pill: 'inc'  },
  warning:       { word: 'Warning',  pill: 'warn' },
  informational: { word: 'Info',     pill: 'none' },
}

/** Who has looked: the page's third filter. */
const REVIEW = [
  { key: 'all',      label: 'All'      },
  { key: 'waiting',  label: 'Waiting'  },
  { key: 'reviewed', label: 'Reviewed' },
]

const EMPTY_REVIEW = {
  all:      { icon: 'ti-video-off',     title: 'No Camera Alarms', sub: 'No camera raised an alarm with evidence in this period.' },
  waiting:  { icon: 'ti-circle-check',  title: 'Nothing Waiting',   sub: 'Every alarm in this period has been reviewed.' },
  reviewed: { icon: 'ti-eye-off',       title: 'Nothing Reviewed',  sub: 'No alarm in this period has been marked reviewed yet.' },
}

/** Everything the alarm carries to look at: clips first, then snapshots. */
function mediaOf(inc) {
  const videos = (inc.videos ?? []).map((v) => ({ ...v, kind: 'video' }))
  const photos = (inc.photos ?? []).map((p, i, all) => ({
    ...p, kind: 'photo',
    label: videos.length || all.length > 1 ? `Snapshot · ${p.label}` : 'Snapshot',
  }))
  return [...videos, ...photos]
}

const isFresh = (inc) => inc.occurredMs != null && Date.now() - inc.occurredMs < UPLOAD_GRACE_MS

// ── the screen ──────────────────────────────────────────────────────────────

export default function DashcamIncidentsScreen() {
  const companyId = useAppSelector((a) => a.activeCompanyId)
  const { activeCompany } = useCompanies()
  const company = activeCompany?.short || activeCompany?.name || 'this organisation'
  const { setSelectedVehicleId, setPendingFocusId, setMobileActiveTab, setDesktopActiveTab } = useAppActions()
  const { vehicles = [], orgId } = useFleetLiveShared()

  const [range, setRange] = useState('today')
  const [category, setCategory] = useState('all')
  const [review, setReview] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  // Shared with the rail's count (hooks/useVssBadge): a mark here lowers it at once.
  const [reviewed, toggleReviewed] = useDashcamReviewed(`vss:${companyId}`)

  // A different organisation is a different inbox.
  useEffect(() => { setSearch(''); setSelectedId(null); setCategory('all'); setReview('all') }, [orgId])

  const q = useQuery({
    ...vssIncidentsQuery(orgId, range),
    placeholderData: keepPreviousData,
    retry: 1,
  })
  const all = useMemo(() => q.data ?? NONE, [q.data])

  const byVehicle = useMemo(() => new Map(vehicles.map((v) => [v.vehicleId, v])), [vehicles])
  const plateOf = (inc) => byVehicle.get(inc.vehicleId)?.id ?? inc.plate
  const driverOf = (inc) => {
    const d = byVehicle.get(inc.vehicleId)?.driver
    return d && d !== 'Unassigned' ? d : null
  }

  // Search narrows first; the chips then count within what is left, so every
  // number on a chip is what pressing it would show.
  const term = search.trim().toLowerCase()
  const searched = useMemo(() => (term
    ? all.filter((i) => [plateOf(i), driverOf(i), i.label].some((f) => String(f ?? '').toLowerCase().includes(term)))
    : all), [all, term, byVehicle]) // eslint-disable-line react-hooks/exhaustive-deps
  const inReview = (i, key) => key === 'all' || (key === 'reviewed') === reviewed.has(i.id)
  const counts = useMemo(() => {
    const kind = { all: 0 }, rev = { all: 0, waiting: 0, reviewed: 0 }
    for (const cat of CATEGORIES) kind[cat.key] = 0
    for (const i of searched) {
      if (inReview(i, review)) { kind.all++; kind[i.category] = (kind[i.category] ?? 0) + 1 }
      if (category === 'all' || i.category === category) {
        rev.all++
        rev[reviewed.has(i.id) ? 'reviewed' : 'waiting']++
      }
    }
    return { kind, rev }
  }, [searched, review, category, reviewed]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(
    () => searched.filter((i) => (category === 'all' || i.category === category) && inReview(i, review)),
    [searched, category, review, reviewed], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const waiting = list.filter((i) => !reviewed.has(i.id)).length
  const critical = list.filter((i) => i.severity === 'critical' && !reviewed.has(i.id)).length

  // Keep a selection: the first row when nothing (or something filtered away) is picked.
  const selected = list.find((i) => i.id === selectedId) ?? list[0] ?? null
  useEffect(() => { if (selected && selected.id !== selectedId) setSelectedId(selected.id) }, [selected, selectedId])

  // Up and down move through the inbox from anywhere in the list.
  const listRef = useRef(null)
  const onListKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const at = list.findIndex((i) => i.id === selected?.id)
    const next = list[Math.min(list.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (!next) return
    setSelectedId(next.id)
    listRef.current?.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.focus()
  }

  const openOnMap = (inc) => {
    const plate = plateOf(inc)
    setSelectedVehicleId(plate)
    setPendingFocusId(plate)
    setMobileActiveTab('map')
    setDesktopActiveTab('fleet')
  }

  const activeCount = (category !== 'all') + (review !== 'all') + (range !== 'today')
  const rangeWord = RANGES.find((r) => r.key === range)?.label ?? ''

  let body
  if (q.isPending) {
    body = (
      <EmptyNote icon="ti-loader-2" tone="busy" title="Reading the Camera Alarms">
        {company}’s cameras, {rangeWord.toLowerCase()}.
      </EmptyNote>
    )
  } else if (q.isError && !all.length) {
    body = (
      <EmptyNote icon="ti-alert-triangle" tone="error" title="The Alarms Could Not Be Loaded"
                 action={{ label: 'Try again', onClick: () => q.refetch() }}>
        {q.error?.message ?? 'The video server did not answer.'}
      </EmptyNote>
    )
  } else if (list.length === 0) {
    const e = EMPTY_REVIEW[review]
    body = (
      <EmptyNote icon={term ? 'ti-search' : e.icon} title={term ? 'No Matching Alarms' : e.title}
                 tone={term ? 'info' : 'ok'}
                 action={term ? { label: 'Clear search', onClick: () => setSearch('') } : null}>
        {term ? `Nothing matches “${search.trim()}” here.` : e.sub}
      </EmptyNote>
    )
  } else {
    body = (
      <div className="dci-bench">
        <div ref={listRef} className={`dci-list${q.isPlaceholderData ? ' dci-list--stale' : ''}`}
             role="list" aria-label="Dashcam alarms" onKeyDown={onListKey}>
          {list.map((i) => (
            <AlarmRow key={i.id} inc={i} on={selected?.id === i.id} reviewed={reviewed.has(i.id)}
                      plate={plateOf(i)} driver={driverOf(i)} onClick={() => setSelectedId(i.id)} />
          ))}
        </div>
        <section className="dci-detail" aria-label="Selected alarm">
          {selected && (
            <Detail key={selected.id} inc={selected} orgId={orgId} company={company}
                    vehicle={byVehicle.get(selected.vehicleId)} plate={plateOf(selected)} driver={driverOf(selected)}
                    reviewed={reviewed.has(selected.id)} onReviewed={() => toggleReviewed(selected.id)}
                    onMap={() => openOnMap(selected)}
                    onUnit={() => setSearch(plateOf(selected))} unitFiltered={term === String(plateOf(selected)).toLowerCase()} />
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="sp4-root sys-root dci-root">
      <div className="sp4-body">
        <TableToolbar
          summary={
            <>
              <b>{list.length}</b> alarm{list.length === 1 ? '' : 's'} · {rangeWord}
              {waiting > 0 && <> · <b>{waiting}</b> waiting</>}
              {critical > 0 && <> · <b className="dci-crit-n">{critical}</b> critical</>}
              {q.isFetching && !q.isPending && <span className="sp4-muted"> · updating…</span>}
            </>
          }
          loading={q.isFetching}
          onReload={() => q.refetch()}
          actions={(
            <button type="button" className="sp4-ghost-btn" onClick={() => setDesktopActiveTab('fleet')}>
              <i className="ti ti-arrow-left" aria-hidden="true" /> Live Map
            </button>
          )}
        />

        <FilterBar
          label="Filters"
          activeCount={activeCount}
          peek={(
            <div className="sp4-search-wrap dci-search">
              <svg className="sp4-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input className="sp4-search" type="text" placeholder="Plate, driver or alarm…" aria-label="Search a plate, driver or alarm"
                     value={search} onChange={(e) => setSearch(e.target.value)} />
              {search && <button type="button" className="sp4-search-clear" aria-label="Clear search" onClick={() => setSearch('')}>✕</button>}
            </div>
          )}
        >
          <div className="sp4-filter-group">
            <span className="sp4-filter-label">Alarm</span>
            <Chip on={category === 'all'} onClick={() => setCategory('all')} n={counts.kind.all}>All</Chip>
            {CATEGORIES.filter((c) => c.key !== 'other' || counts.kind.other > 0).map((c) => (
              <Chip key={c.key} on={category === c.key} onClick={() => setCategory(c.key)} n={counts.kind[c.key]}>{c.label}</Chip>
            ))}
          </div>
          <div className="sp4-filter-group">
            <span className="sp4-filter-label">Review</span>
            {REVIEW.map((r) => (
              <Chip key={r.key} on={review === r.key} onClick={() => setReview(r.key)} n={counts.rev[r.key]}
                    title={r.key === 'all' ? undefined : 'Review marks are kept in this browser only'}>{r.label}</Chip>
            ))}
          </div>
          <div className="sp4-filter-group">
            <span className="sp4-filter-label">Period</span>
            {RANGES.map((r) => (
              <Chip key={r.key} on={range === r.key} onClick={() => setRange(r.key)}>{r.label}</Chip>
            ))}
          </div>
        </FilterBar>

        {body}
      </div>
    </div>
  )
}

function Chip({ on, onClick, children, n, title }) {
  return (
    <button type="button" className={'sp4-filter-chip' + (on ? ' sp4-filter-chip--on' : '')}
            aria-pressed={on} onClick={onClick} title={title}>
      {children}
      {n != null && <span className="sys-chip-n">{n}</span>}
    </button>
  )
}

function AlarmRow({ inc, on, reviewed, plate, driver, onClick }) {
  const sev = SEVERITY[inc.severity] ?? SEVERITY.warning
  const fresh = isFresh(inc)
  const media = inc.hasClip
    ? (fresh ? { icon: 'ti-clock', word: 'Uploading' } : { icon: 'ti-player-play', word: 'Clip' })
    : inc.hasPhoto ? { icon: 'ti-photo', word: 'Snapshot' } : null
  const sub = [driver, inc.speed != null ? `${inc.speed} km/h` : null].filter(Boolean).join(' · ')
  return (
    <div role="listitem" className="dci-row-wrap">
      <button type="button" data-id={inc.id}
              className={`dci-row dci-row--${inc.severity}${on ? ' dci-row--on' : ''}${reviewed ? ' dci-row--done' : ''}`}
              onClick={onClick} aria-current={on || undefined}
              aria-label={`${inc.label}, ${sev.word}, ${plate}${sub ? `, ${sub}` : ''}, ${whenLabel(inc.occurredMs)}${reviewed ? ', reviewed' : ''}`}>
        <span className="dci-row__main">
          <span className="dci-row__t">{inc.label}</span>
          <span className="dci-row__s">
            <span className="sp4-reg">{plate}</span>
            {sub && <span className="dci-row__who">{sub}</span>}
          </span>
        </span>
        <span className="dci-row__side">
          <span className="dci-row__time">{rowTime(inc.occurredMs)}</span>
          <span className="dci-row__meta">
            {reviewed
              ? <span className="dci-row__done"><i className="ti ti-check" aria-hidden="true" />Reviewed</span>
              : <span className={`dci-row__sev dci-row__sev--${inc.severity}`}>{sev.word}</span>}
            {media && <span className="dci-row__media" title={media.word}><i className={`ti ${media.icon}`} aria-hidden="true" /></span>}
          </span>
        </span>
      </button>
    </div>
  )
}

function Detail({ inc, orgId, company, vehicle, plate, driver, reviewed, onReviewed, onMap, onUnit, unitFiltered }) {
  const place = usePlaceName(inc.lat, inc.lng, { enabled: inc.lat != null && inc.lng != null })
  const where = place ?? (inc.lat != null ? `${inc.lat.toFixed(4)}, ${inc.lng.toFixed(4)}` : null)
  const model = vehicle?.name ? vehicle.name.replace(vehicle.id, '').trim() : ''
  const sev = SEVERITY[inc.severity] ?? SEVERITY.warning
  const items = mediaOf(inc)
  const [shownKey, setShownKey] = useState(items[0]?.key ?? null)
  const shown = items.find((m) => m.key === shownKey) ?? items[0] ?? null

  return (
    <div className="dci-detail__inner">
      <header className="dci-head">
        <div className="dci-head__title">
          <h2 className="dci-head__t">{inc.label}</h2>
          <span className={`sp4-pill sp4-pill--${sev.pill}`}>{sev.word}</span>
        </div>
        <p className="dci-head__when">
          <span className="sp4-reg">{plate}</span> · {whenLabel(inc.occurredMs)}
        </p>
        <div className="dci-head__actions">
          <button type="button" className={`dci-review${reviewed ? ' dci-review--done' : ''}`} onClick={onReviewed}
                  aria-pressed={reviewed} title="Saved in this browser only">
            <i className={`ti ${reviewed ? 'ti-circle-check' : 'ti-check'}`} aria-hidden="true" />
            {reviewed ? 'Reviewed' : 'Mark reviewed'}
          </button>
          <button type="button" className="sp4-ghost-btn" onClick={onMap}>
            <i className="ti ti-map-pin" aria-hidden="true" /> Open on map
          </button>
          {shown?.download && (
            <a className="sp4-ghost-btn" href={shown.download} download>
              <i className="ti ti-download" aria-hidden="true" /> {shown.kind === 'photo' ? 'Snapshot' : 'Clip'}
            </a>
          )}
        </div>
      </header>

      <div className="dci-evidence">
        <div className="dci-evidence__media">
          {shown
            ? <MediaPlayer inc={inc} orgId={orgId} company={company} items={items} shown={shown} plate={plate} onPick={setShownKey} />
            : (
              <div className="dci-stage dci-stage--empty">
                <i className="ti ti-video-off" aria-hidden="true" />
                <b>No recording for this alarm</b>
                <span>The camera raised it without attaching a clip or a snapshot.</span>
              </div>
            )}
        </div>

        <section className="dci-card dci-card--facts" aria-label="Who and when">
          <dl className="dci-facts">
            <dt>Unit</dt><dd><span className="sp4-reg">{plate}</span>{model ? <span className="dci-dim"> · {model}</span> : null}</dd>
            <dt>Driver</dt><dd>{driver ?? <span className="dci-dim">Not assigned</span>}</dd>
            <dt>When</dt><dd>{whenLabel(inc.occurredMs)}</dd>
            <dt>Speed</dt><dd>{inc.speed != null ? `${inc.speed} km/h` : <span className="dci-dim">Not reported</span>}</dd>
            <dt>Where</dt><dd>{where ?? <span className="dci-dim">No location</span>}</dd>
            <dt>Alarm</dt><dd>{inc.label} <span className="dci-dim">· code {inc.code}</span></dd>
          </dl>
          <button type="button" className="dci-unit-link" onClick={onUnit} disabled={unitFiltered}>
            {unitFiltered ? `Showing ${plate} only` : `Every alarm from ${plate}`}
            {!unitFiltered && <i className="ti ti-arrow-right" aria-hidden="true" />}
          </button>
        </section>

        <div className="dci-card dci-card--map">
          <MiniMap lat={inc.lat} lng={inc.lng} severity={inc.severity} />
        </div>
      </div>
    </div>
  )
}

/**
 * Why a clip or snapshot failed, in words — from lib/mediaDiagnose, which asks
 * the file route for two bytes after the <video>/<img> gives up.
 */
function FailMessage({ reason, fresh, item, company, onRetry }) {
  const what = item.kind === 'photo' ? 'snapshot' : 'clip'
  const download = item.download
    ? <a className="dci-stage__btn" href={item.download} download><i className="ti ti-download" aria-hidden="true" /> Download {what}</a>
    : null
  const retry = <button type="button" className="dci-stage__btn" onClick={onRetry}><i className="ti ti-refresh" aria-hidden="true" /> Try again</button>
  if (reason === 'checking') return <b>Checking why the {what} didn’t load…</b>
  if (reason === 'codec') return (
    <>
      <b>This clip is in a format your browser can’t play</b>
      <span>The dashcam records in H.265 (HEVC). Download it and open it in VLC, or ask IntelliFleet360 to set the cameras to record H.264.</span>
      {download}
    </>
  )
  if (reason === 'missing') return fresh ? (
    <>
      <b>The {what} is probably still uploading</b>
      <span>The camera sends it a few minutes after the alarm.</span>
      {retry}
    </>
  ) : (
    <>
      <b>No footage for this {what}</b>
      <span>The alarm arrived, but the camera has not uploaded this file, or it was deleted.</span>
    </>
  )
  if (reason === 'session') return <><b>Your sign-in has expired</b><span>Refresh the page and try again.</span></>
  if (reason === 'denied') return <><b>Your account can’t open {company}’s clips</b><span>Ask an administrator for access.</span></>
  if (reason === 'refused') return (
    <>
      <b>The video server refused this {what}</b>
      <span>It may be busy. Try again in a minute.</span>
      {retry}
    </>
  )
  return <><b>This {what} wouldn’t load</b><span>Check your connection and try again.</span>{retry}{download}</>
}

/** The clip or snapshot, with a switch between cameras, and honest failure states. */
function MediaPlayer({ inc, orgId, company, items, shown, plate, onPick }) {
  const [state, setState] = useState('loading')        // loading | ready | failed
  const [reason, setReason] = useState(null)           // why it failed — see FailMessage
  const [attempt, setAttempt] = useState(0)
  const [sessionReady, setSessionReady] = useState(false)
  useEffect(() => { setState('loading'); setReason(null) }, [shown.key, attempt])
  // The login cookie must be fresh before the <video>/<img> asks (it carries no token).
  useEffect(() => {
    let alive = true
    setSessionReady(false)
    ensureVssSession(orgId).finally(() => { if (alive) setSessionReady(true) })
    return () => { alive = false }
  }, [attempt, orgId])

  const src = sessionReady ? shown.url : undefined
  const fresh = isFresh(inc)

  const fail = async () => {
    setState('failed')
    setReason('checking')
    const r = await diagnoseMedia(shown.url)
    // The file arrived but the browser couldn't decode it: the format.
    setReason(r === 'ok' ? (shown.kind === 'photo' ? 'error' : 'codec') : r)
  }
  // Loaded, but with no picture: a codec the browser can't show.
  const checkPicture = (e) => {
    if (e.currentTarget.videoWidth === 0 && e.currentTarget.videoHeight === 0) { setState('failed'); setReason('codec') }
  }

  return (
    <figure className="dci-player">
      <div className={`dci-stage${state === 'loading' ? ' dci-stage--loading' : ''}`}>
        {src && shown.kind === 'video' && (
          <video key={`${src}#${attempt}`} src={src} controls playsInline preload="metadata"
            onLoadedMetadata={checkPicture}
            onLoadedData={() => setState((s) => (s === 'failed' ? s : 'ready'))}
            onError={fail} />
        )}
        {src && shown.kind === 'photo' && (
          <img key={`${src}#${attempt}`} src={src} alt={`${inc.label}, ${shown.label}`}
            onLoad={() => setState((s) => (s === 'failed' ? s : 'ready'))} onError={fail} />
        )}
        {state === 'failed' && (
          <div className="dci-stage__msg" role="status">
            <FailMessage reason={reason} fresh={fresh} item={shown} company={company} onRetry={() => setAttempt((n) => n + 1)} />
          </div>
        )}
      </div>
      <figcaption className="dci-player__bar">
        {items.length > 1 ? (
          <div className="dci-seg" role="group" aria-label="Camera">
            {items.map((m) => (
              <button key={m.key} type="button" className={`dci-seg__btn${shown.key === m.key ? ' dci-seg__btn--on' : ''}`}
                      aria-pressed={shown.key === m.key} onClick={() => onPick(m.key)}>
                <i className={`ti ${m.kind === 'photo' ? 'ti-photo' : 'ti-video'}`} aria-hidden="true" />{m.label}
              </button>
            ))}
          </div>
        ) : <span className="dci-player__cam"><i className={`ti ${shown.kind === 'photo' ? 'ti-photo' : 'ti-video'}`} aria-hidden="true" />{shown.label}</span>}
        <span className="dci-player__stamp">{plate} · {inc.occurredMs != null ? clockSec(inc.occurredMs) : ''}</span>
      </figcaption>
    </figure>
  )
}

/** Pin colours for the mini map, read from the page's own severity tokens. */
function pinColour(el, severity) {
  const name = severity === 'critical' ? '--sp4-crit' : severity === 'warning' ? '--sp4-warn' : '--sp4-accent'
  return getComputedStyle(el).getPropertyValue(name).trim() || 'currentColor'
}

/** A small, still map with a pin where the alarm happened. */
function MiniMap({ lat, lng, severity }) {
  const box = useRef(null)
  const map = useRef(null)
  const pin = useRef(null)

  useEffect(() => {
    if (!box.current || map.current) return undefined
    const m = L.map(box.current, {
      zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
    })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(m)
    m.setView([-0.5, 36.5], 7)
    map.current = m
    // The map spans the footage and the facts, so its height follows the
    // window; re-measure whenever the box changes or tiles leave a seam.
    const ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => { try { m.invalidateSize() } catch { /* removed */ } })
      : null
    ro?.observe(box.current)
    return () => { ro?.disconnect(); m.remove(); map.current = null; pin.current = null }
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m) return
    if (pin.current) { pin.current.remove(); pin.current = null }
    if (lat == null || lng == null) return
    pin.current = L.circleMarker([lat, lng], {
      radius: 8, color: getComputedStyle(box.current).getPropertyValue('--sp4-surface').trim() || 'white',
      weight: 2, fillColor: pinColour(box.current, severity), fillOpacity: 1,
    }).addTo(m)
    m.setView([lat, lng], 13)
    // The box can change size with the layout; let Leaflet re-measure.
    setTimeout(() => { try { m.invalidateSize() } catch { /* unmounted */ } }, 50)
  }, [lat, lng, severity])

  return (
    <div className="dci-mini">
      <div ref={box} className="dci-mini__map" />
      {(lat == null || lng == null) && <div className="dci-mini__none">No location</div>}
    </div>
  )
}
