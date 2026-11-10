// Reefer consignments for Maersk (operator, 2026-11-10): the register the
// daily Reefer report is made from (server/consignments.go). Staff enter what
// only they know: client, container, seal, booking, FRO, the stuffing dates,
// the genset time and the temperatures. The roster gives the trailer, driver,
// ID and phone; GPS fills the date left, the arrival at the client and the
// arrival and departure at Alpha/APMT from the zones picked here. A value
// typed by hand always wins over GPS.

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../services/api'
import { usePermissions } from '../../hooks/usePermissions'
import EmptyNote from '../shared/EmptyNote'
import './ConsignmentsPanel.scss'

const URL_LIST = '/api/v1/reports/consignments?org=samad'
const urlOne = (id) => `/api/v1/reports/consignments/${encodeURIComponent(id)}?org=samad`

const BLANK = {
  truck: '', trailer: '', client: '', container: '', seal: '', booking: '', fro: '', zone: '', size: '40',
  emptyPickup: '', left: '', arrivedClient: '', stuffing: '', stuffingEnd: '', gensetOn: '', position: '',
  arrivedPort: '', departedPort: '', offloaded: '', packTemp: '', midTemp: '', portTemp: '',
  originZone: '', clientZone: '', portZone: '',
}
const EDITABLE = Object.keys(BLANK)

/** "2026-11-01T20:50" or "2026-11-01" → "01 Nov 20:50" / "01 Nov". */
function shortWhen(s) {
  if (!s) return ''
  const [d, t] = s.split('T')
  const [y, m, day] = d.split('-').map(Number)
  if (!y) return s
  const mon = new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
  return t ? `${mon} ${t}` : mon
}

/** Where the trip has got to, in a word, for the list. */
function stageOf(c) {
  if (c.done) return 'Offloaded'
  if (c.show?.departedPort) return 'Left Alpha/APMT'
  if (c.show?.arrivedPort) return 'At Alpha/APMT'
  if (c.gensetOn || c.stuffingEnd) return 'Loaded, on the way'
  if (c.show?.arrivedClient) return 'At the client'
  if (c.show?.left) return 'On the way to the client'
  return 'Booked'
}

function Text({ label, k, form, set, placeholder, list, type = 'text', inputMode }) {
  return (
    <label className="cns-field">
      <span>{label}</span>
      <input type={type} value={form[k] ?? ''} placeholder={placeholder} list={list} inputMode={inputMode}
             onChange={(e) => set(k, e.target.value)} />
    </label>
  )
}

/** A date or a time that GPS may already know: the GPS value shows until one is typed. */
function When({ label, k, form, set, gps, withTime = true }) {
  const value = form[k] ?? ''
  return (
    <label className="cns-field">
      <span>{label}</span>
      <input type={withTime ? 'datetime-local' : 'date'} value={value}
             onChange={(e) => set(k, e.target.value)} />
      {gps && !value && <small className="cns-gps"><i className="ti ti-map-pin" aria-hidden="true" /> GPS: {shortWhen(gps)}</small>}
      {gps && value && <small className="cns-gps cns-gps--over">Typed; GPS had {shortWhen(gps)}</small>}
    </label>
  )
}

function Zone({ label, k, form, set, zones, hint }) {
  return (
    <label className="cns-field">
      <span>{label}</span>
      <select value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
        <option value="">Not watched</option>
        {form[k] && !zones.includes(form[k]) && <option value={form[k]}>{form[k]} (no longer a zone)</option>}
        {zones.map((z) => <option key={z} value={z}>{z}</option>)}
      </select>
      {hint && <small className="cns-hint">{hint}</small>}
    </label>
  )
}

function ConsignmentForm({ start, view, zones, trucks, canDelete, onDone }) {
  const qc = useQueryClient()
  const [form, setForm] = useState(start)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const roster = trucks.find((t) => t.plate.replace(/\W/g, '').toUpperCase() === form.truck.replace(/\W/g, '').toUpperCase())
  const gps = view?.gps ?? {}
  const local = (iso) => {
    if (!iso) return ''
    const d = new Date(Date.parse(iso) + 3 * 3600e3)
    return d.toISOString().slice(0, 16)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy('save'); setError(null)
    try {
      const body = JSON.stringify(Object.fromEntries(EDITABLE.map((k) => [k, form[k] ?? ''])))
      await apiFetch(view ? urlOne(view.id) : URL_LIST, { method: view ? 'PUT' : 'POST', body })
      await qc.invalidateQueries({ queryKey: ['reports', 'consignments'] })
      qc.invalidateQueries({ queryKey: ['reports', 'doc', 'reefer'] })
      onDone()
    } catch (err) {
      setError(err?.message || 'The consignment could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!view || busy) return
    if (!window.confirm(`Delete the consignment for ${view.truck}${view.container ? `, container ${view.container}` : ''}? This cannot be undone.`)) return
    setBusy('delete'); setError(null)
    try {
      await apiFetch(urlOne(view.id), { method: 'DELETE' })
      await qc.invalidateQueries({ queryKey: ['reports', 'consignments'] })
      qc.invalidateQueries({ queryKey: ['reports', 'doc', 'reefer'] })
      onDone()
    } catch (err) {
      setError(err?.message || 'The consignment could not be deleted.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <form className="cns-form" onSubmit={submit} aria-label={view ? `Edit consignment ${view.truck}` : 'New consignment'}>
      <div className="cns-form-head">
        <h2>{view ? `${view.truck}${view.container ? ` · ${view.container}` : ''}` : 'New consignment'}</h2>
        <button type="button" className="rpt-btn rpt-btn--quiet" onClick={onDone}>Close</button>
      </div>

      <fieldset className="cns-group">
        <legend>Truck and load</legend>
        <div className="cns-grid">
          <Text label="Truck" k="truck" form={form} set={set} list="cns-trucks" placeholder="KDN 506L" />
          <Text label="Trailer" k="trailer" form={form} set={set} placeholder={roster?.trailer || view?.rosterTrailer || 'From the roster'} />
          <div className="cns-field cns-field--read">
            <span>Driver</span>
            <output>{view?.driver || roster?.driver || 'From the roster'}</output>
          </div>
          <Text label="Client" k="client" form={form} set={set} placeholder="KIBIDULA" />
          <Text label="Container No" k="container" form={form} set={set} placeholder="MCAU6035570" />
          <Text label="Maersk seal" k="seal" form={form} set={set} />
          <Text label="Booking" k="booking" form={form} set={set} />
          <Text label="FRO No" k="fro" form={form} set={set} />
          <Text label="Stuffing zone" k="zone" form={form} set={set} placeholder="MAFINGA" />
          <label className="cns-field">
            <span>Size</span>
            <select value={form.size} onChange={(e) => set('size', e.target.value)}>
              <option value="20">20</option>
              <option value="40">40</option>
              <option value="45">45</option>
            </select>
          </label>
        </div>
        <datalist id="cns-trucks">
          {trucks.map((t) => <option key={t.plate} value={t.plate}>{t.driver}</option>)}
        </datalist>
      </fieldset>

      <fieldset className="cns-group">
        <legend>Dates</legend>
        <div className="cns-grid">
          <When label="Empty pick-up" k="emptyPickup" form={form} set={set} withTime={false} />
          <When label="Date left" k="left" form={form} set={set} gps={local(gps.left)} />
          <When label="Arrived at the client" k="arrivedClient" form={form} set={set} gps={local(gps.arrivedClient)} />
          <When label="Stuffing date" k="stuffing" form={form} set={set} withTime={false} />
          <When label="Stuffing end" k="stuffingEnd" form={form} set={set} />
          <When label="Genset switched on" k="gensetOn" form={form} set={set} />
          <When label="Arrived Alpha/APMT" k="arrivedPort" form={form} set={set} gps={local(gps.arrivedPort)} />
          <When label="Departed Alpha/APMT" k="departedPort" form={form} set={set} gps={local(gps.departedPort)} />
          <When label="Offloaded" k="offloaded" form={form} set={set} withTime={false} />
        </div>
        <p className="cns-note">An offloaded consignment stays on the report for the day it was offloaded, then leaves it.</p>
      </fieldset>

      <fieldset className="cns-group">
        <legend>Temperatures, °C</legend>
        <div className="cns-grid">
          <Text label="Pack-house" k="packTemp" form={form} set={set} inputMode="decimal" placeholder="4.8" />
          <Text label="Mid-stop" k="midTemp" form={form} set={set} inputMode="decimal" />
          <Text label="Alpha/APMT Bonje" k="portTemp" form={form} set={set} inputMode="decimal" />
        </div>
      </fieldset>

      <fieldset className="cns-group">
        <legend>What GPS watches</legend>
        <div className="cns-grid">
          <Zone label="Empty depot" k="originZone" form={form} set={set} zones={zones} hint="Leaving it is the date left." />
          <Zone label="Client" k="clientZone" form={form} set={set} zones={zones} hint="Entering it is the arrival." />
          <Zone label="Alpha or APMT" k="portZone" form={form} set={set} zones={zones} hint="Entering and leaving it." />
          <Text label="Current position" k="position" form={form} set={set} placeholder={view?.here || 'Where GPS has the truck'} />
        </div>
        {zones.length === 0 && <p className="cns-note">No geofences are set up yet, so GPS cannot fill any dates. Type them instead.</p>}
      </fieldset>

      {error && <div className="rpt-error" role="alert">{error}</div>}
      <div className="cns-form-actions">
        <button type="submit" className="rpt-btn rpt-btn--primary" disabled={Boolean(busy)} aria-busy={busy === 'save'}>
          {busy === 'save' ? 'Saving…' : view ? 'Save changes' : 'Add consignment'}
        </button>
        <button type="button" className="rpt-btn" onClick={onDone} disabled={Boolean(busy)}>Cancel</button>
        {view && canDelete && (
          <button type="button" className="rpt-btn rpt-btn--quiet cns-delete" onClick={remove} disabled={Boolean(busy)} aria-busy={busy === 'delete'}>
            <i className="ti ti-trash" aria-hidden="true" /> {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
        )}
      </div>
    </form>
  )
}

export default function ConsignmentsPanel({ onShowReport }) {
  const { can } = usePermissions()
  const canEdit = can(['report:operations', 'cargo:update'])
  const canDelete = can(['report:operations', 'cargo:delete'])
  const [editing, setEditing] = useState(null) // null | 'new' | consignment id
  const [showDone, setShowDone] = useState(false)

  const q = useQuery({
    queryKey: ['reports', 'consignments'],
    queryFn: ({ signal }) => apiFetch(URL_LIST, { signal }).then((r) => r?.data ?? null),
    refetchInterval: 120_000,
  })
  const list = useMemo(() => q.data?.consignments ?? [], [q.data])
  const zones = q.data?.zones ?? []
  const trucks = q.data?.trucks ?? []
  const shown = useMemo(() => list.filter((c) => showDone || !c.done), [list, showDone])
  const doneCount = list.length - list.filter((c) => !c.done).length

  const view = editing && editing !== 'new' ? list.find((c) => c.id === editing) : null
  // A new consignment watches the zones the last one did.
  const start = view
    ? Object.fromEntries(EDITABLE.map((k) => [k, view[k] ?? '']))
    : { ...BLANK, originZone: list[0]?.originZone ?? '', clientZone: list[0]?.clientZone ?? '', portZone: list[0]?.portZone ?? '' }

  if (q.isError && !q.data) {
    return (
      <EmptyNote icon="ti-alert-triangle" tone="error" title="The Consignments Could Not Be Read"
                 action={{ label: 'Try again', onClick: () => q.refetch() }}>
        {q.error?.message ?? 'The server did not answer.'}
      </EmptyNote>
    )
  }

  return (
    <div className={`cns-root${editing ? ' cns-root--editing' : ''}`}>
      <section className="cns-list" aria-label="Reefer consignments">
        <div className="cns-list-head">
          <p className="cns-count">
            {q.isLoading ? 'Reading the register…' : `${list.length - doneCount} on the road`}
            {doneCount > 0 && (
              <label className="cns-toggle">
                <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show offloaded ({doneCount})
              </label>
            )}
          </p>
          <div className="cns-list-actions">
            <button type="button" className="rpt-btn" onClick={onShowReport}>
              <i className="ti ti-file-text" aria-hidden="true" /> See the report
            </button>
            {canEdit && (
              <button type="button" className="rpt-btn rpt-btn--primary" onClick={() => setEditing('new')}>
                <i className="ti ti-plus" aria-hidden="true" /> Add consignment
              </button>
            )}
          </div>
        </div>

        {!q.isLoading && shown.length === 0 ? (
          <EmptyNote icon="ti-snowflake" title="No Reefer Consignments Yet">
            {canEdit ? 'Add one for each container a truck picks up. The daily report for Maersk is made from this list.'
              : 'Nobody has entered a consignment yet.'}
          </EmptyNote>
        ) : (
          <div className="cns-table-wrap">
            <table className="cns-table">
              <thead>
                <tr>
                  <th scope="col">Truck</th>
                  <th scope="col">Driver</th>
                  <th scope="col">Container</th>
                  <th scope="col">Client</th>
                  <th scope="col">Where it is</th>
                  <th scope="col">Stage</th>
                  <th scope="col" className="is-num">Pack-house °C</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className={editing === c.id ? 'is-on' : undefined}>
                    <th scope="row">
                      {canEdit ? (
                        <button type="button" className="cns-open" onClick={() => setEditing(c.id)}>{c.truck}</button>
                      ) : c.truck}
                    </th>
                    <td>{c.driver || '-'}</td>
                    <td>{c.container || '-'}</td>
                    <td>{c.client || '-'}</td>
                    <td>{c.position || c.here || '-'}</td>
                    <td>{stageOf(c)}{c.delay && c.show?.arrivedPort ? `, ${c.delay}` : ''}</td>
                    <td className="is-num">{c.packTemp || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && canEdit && (
        <ConsignmentForm key={editing} start={start} view={view} zones={zones} trucks={trucks}
                         canDelete={canDelete} onDone={() => setEditing(null)} />
      )}
    </div>
  )
}
