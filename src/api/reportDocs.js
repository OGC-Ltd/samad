// The Reports page's server routes (server/report_handlers.go). The server
// builds each report as a document of plain text (headings, figures, tables,
// notes), the page lets the operator edit it, and the server draws it as a
// PDF, a JPEG, a CSV or the preview pages.

import { apiFetch, apiFetchBlob } from '../services/api'

const ORG = 'samad'

/**
 * The report the server built.
 * @param {{ kind: 'breaches'|'conduct'|'movements'|'shift'|'weekly', from?: number, to?: number, day?: string, shift?: string, weeks?: number, signal?: AbortSignal }} o
 */
export async function loadReportDoc({ kind, from, to, day, shift, weeks, signal }) {
  const q = new URLSearchParams({ org: ORG })
  if (kind === 'shift' && shift === 'custom') { q.set('shift', 'custom'); q.set('from', String(Math.round(from))); q.set('to', String(Math.round(to))) }
  else if (kind === 'shift') { q.set('day', day); q.set('shift', shift) }
  else if (kind === 'weekly') q.set('weeks', String(weeks))
  else { q.set('from', String(Math.round(from))); q.set('to', String(Math.round(to))) }
  const res = await apiFetch(`/api/v1/reports/${kind}/document?${q}`, signal ? { signal } : undefined)
  return res?.data ?? null
}

const post = (doc, signal) => ({
  method: 'POST',
  body: JSON.stringify(doc),
  headers: { 'Content-Type': 'application/json' },
  ...(signal ? { signal } : {}),
})

/** The pages as pictures (data URLs), drawn by the server exactly as the PDF is laid out. */
export async function previewReport(doc, signal) {
  const res = await apiFetch(`/api/v1/reports/render?org=${ORG}&format=preview`, post(doc, signal))
  return res?.data?.pages ?? []
}

function save(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const EXT = { pdf: 'pdf', jpeg: 'jpg', csv: 'csv' }

/**
 * Saves the report as a PDF, JPEG or CSV. A long report's JPEG comes as
 * several images (the server says how many in X-Sheets), saved one by one.
 */
export async function downloadReport(doc, format, onProgress) {
  const base = `/api/v1/reports/render?org=${ORG}&format=${format}`
  const first = await apiFetchBlob(base, post(doc))
  save(first.blob, first.filename ?? `${doc.filename || doc.title}.${EXT[format]}`)
  const sheets = format === 'jpeg' ? Number(first.headers?.get('X-Sheets')) || 1 : 1
  for (let i = 1; i < sheets; i++) {
    onProgress?.(`Image ${i + 1} of ${sheets}`)
    const next = await apiFetchBlob(`${base}&sheet=${i}`, post(doc))
    save(next.blob, next.filename ?? `${doc.filename || doc.title} (${i + 1} of ${sheets}).jpg`)
  }
}
