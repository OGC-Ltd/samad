// The drivers' and units' PDF reports build end to end on jspdf 4 and
// jspdf-autotable 5 (upgraded 2026-10-28 for a critical jspdf advisory).
import { describe, it, expect } from 'vitest'
import { createReport, addSectionTitle, addSummaryCards, addTable } from './pdfReport'

describe('pdfReport', () => {
  it('builds a report with cards and a multi-page table', () => {
    const doc = createReport({ companyName: 'Samad Resources', reportTitle: 'Drivers', subtitle: 'Last 7 days' })
    addSectionTitle(doc, 'Summary')
    addSummaryCards(doc, [{ label: 'Drivers', value: '11' }, { label: 'Distance', value: '1,204 km' }])
    addTable(doc, {
      head: [['Driver', 'Unit', 'Km', 'Trips']],
      body: Array.from({ length: 120 }, (_, i) => [`Driver ${i}`, `KDU ${i}F`, String(i * 3), String(i % 7)]),
    })
    const bytes = new Uint8Array(doc.output('arraybuffer'))
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    expect(doc.getNumberOfPages()).toBeGreaterThan(1)
  })
})
