// The report's editor (operator, 2026-11-07: "ability to edit"): every word
// of the document the server built — the letterhead, the facts, each heading,
// figure, note and table cell — can be changed, rows and sections removed,
// notes and rows added. The server draws whatever is here, as plain text.

import { memo, useCallback } from 'react'

const LABEL = { heading: 'Heading', kpis: 'Figures', table: 'Table', note: 'Note', empty: 'Empty line', spacer: 'Space' }

function Field({ label, value, onChange, wide, placeholder }) {
  return (
    <label className={`red-field${wide ? ' red-field--wide' : ''}`}>
      <span>{label}</span>
      <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function IconBtn({ icon, label, onClick, disabled }) {
  return (
    <button type="button" className="red-icon" onClick={onClick} disabled={disabled} title={label} aria-label={label}>
      <i className={`ti ${icon}`} aria-hidden="true" />
    </button>
  )
}

const TableEditor = memo(function TableEditor({ block, onChange }) {
  const set = (fn) => { const next = structuredClone(block); fn(next); onChange(next) }
  return (
    <div className="red-table-wrap">
      <table className="red-table">
        <thead>
          <tr>
            {(block.cols ?? []).map((c, i) => (
              <th key={i}>
                <input value={c.h} aria-label={`Column ${i + 1} heading`} onChange={(e) => set((b) => { b.cols[i].h = e.target.value })} />
              </th>
            ))}
            <th className="red-row-tools" aria-label="Row tools" />
          </tr>
        </thead>
        <tbody>
          {(block.rows ?? []).map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i}>
                  <input value={cell.text} aria-label={`Row ${r + 1}, ${block.cols[i]?.h ?? `column ${i + 1}`}`}
                         className={`${cell.bold ? 'is-bold' : ''}${cell.muted ? ' is-muted' : ''}${block.cols[i]?.right ? ' is-right' : ''}`}
                         style={cell.indent ? { paddingLeft: 18 } : undefined}
                         onChange={(e) => set((b) => { b.rows[r][i].text = e.target.value })} />
                </td>
              ))}
              <td className="red-row-tools">
                <IconBtn icon="ti-x" label={`Remove row ${r + 1}`} onClick={() => set((b) => { b.rows.splice(r, 1) })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="sp4-ghost-btn red-add"
              onClick={() => set((b) => { (b.rows ??= []).push(b.cols.map(() => ({ text: '' }))) })}>
        <i className="ti ti-plus" aria-hidden="true" /> Row
      </button>
    </div>
  )
})

function BlockEditor({ block, index, count, onChange, onMove, onRemove }) {
  const set = (fn) => { const next = structuredClone(block); fn(next); onChange(next) }
  return (
    <section className="red-block">
      <header className="red-block-head">
        <span>{LABEL[block.type] ?? block.type}</span>
        <div className="red-block-tools">
          <IconBtn icon="ti-arrow-up" label="Move up" onClick={() => onMove(-1)} disabled={index === 0} />
          <IconBtn icon="ti-arrow-down" label="Move down" onClick={() => onMove(1)} disabled={index === count - 1} />
          <IconBtn icon="ti-trash" label={`Remove this ${(LABEL[block.type] ?? 'section').toLowerCase()}`} onClick={onRemove} />
        </div>
      </header>
      {block.type === 'heading' && (
        <div className="red-row">
          <Field label="Heading" wide value={block.text} onChange={(v) => set((b) => { b.text = v })} />
          <Field label="On the right" value={block.small} onChange={(v) => set((b) => { b.small = v })} />
        </div>
      )}
      {(block.type === 'note' || block.type === 'empty') && (
        <Field label={block.type === 'note' ? 'Note' : 'Text'} wide value={block.text} onChange={(v) => set((b) => { b.text = v })} />
      )}
      {block.type === 'kpis' && (
        <div className="red-kpis">
          {(block.kpis ?? []).map((k, i) => (
            <div key={i} className="red-kpi">
              <input value={k.value} aria-label={`${k.label} value`} className="is-bold" onChange={(e) => set((b) => { b.kpis[i].value = e.target.value })} />
              <input value={k.label} aria-label={`Figure ${i + 1} label`} onChange={(e) => set((b) => { b.kpis[i].label = e.target.value })} />
            </div>
          ))}
        </div>
      )}
      {block.type === 'table' && <TableEditor block={block} onChange={onChange} />}
    </section>
  )
}

export default function ReportEditor({ doc, onChange }) {
  const set = useCallback((fn) => { const next = structuredClone(doc); fn(next); onChange(next) }, [doc, onChange])
  const blocks = doc.blocks ?? []
  return (
    <div className="red-root" aria-label="Edit the report">
      <section className="red-block">
        <header className="red-block-head"><span>Letterhead</span></header>
        <div className="red-row">
          <Field label="Title" wide value={doc.title} onChange={(v) => set((d) => { d.title = v })} />
          <Field label="Report no." value={doc.reportNo} onChange={(v) => set((d) => { d.reportNo = v })} />
          <Field label="Date" value={doc.date} onChange={(v) => set((d) => { d.date = v })} />
        </div>
        <div className="red-row">
          <Field label="Footer" wide value={doc.footNote} onChange={(v) => set((d) => { d.footNote = v })} />
          <Field label="File name" value={doc.filename} onChange={(v) => set((d) => { d.filename = v })} />
        </div>
        <div className="red-facts">
          {(doc.info ?? []).map((p, i) => (
            <div key={i} className="red-fact">
              <input value={p.label} aria-label={`Fact ${i + 1} label`} onChange={(e) => set((d) => { d.info[i].label = e.target.value })} />
              <input value={p.value} aria-label={`${p.label} value`} className="is-bold" onChange={(e) => set((d) => { d.info[i].value = e.target.value })} />
              <IconBtn icon="ti-x" label={`Remove ${p.label || 'fact'}`} onClick={() => set((d) => { d.info.splice(i, 1) })} />
            </div>
          ))}
          <button type="button" className="sp4-ghost-btn red-add" onClick={() => set((d) => { (d.info ??= []).push({ label: '', value: '' }) })}>
            <i className="ti ti-plus" aria-hidden="true" /> Fact
          </button>
        </div>
      </section>

      {blocks.map((b, i) => (
        <BlockEditor key={i} block={b} index={i} count={blocks.length}
                     onChange={(nb) => set((d) => { d.blocks[i] = nb })}
                     onMove={(dir) => set((d) => { const [x] = d.blocks.splice(i, 1); d.blocks.splice(i + dir, 0, x) })}
                     onRemove={() => set((d) => { d.blocks.splice(i, 1) })} />
      ))}

      <div className="red-adds">
        <button type="button" className="sp4-ghost-btn" onClick={() => set((d) => { d.blocks.push({ type: 'heading', text: 'Notes', small: '' }) })}>
          <i className="ti ti-heading" aria-hidden="true" /> Add heading
        </button>
        <button type="button" className="sp4-ghost-btn" onClick={() => set((d) => { d.blocks.push({ type: 'note', text: '' }) })}>
          <i className="ti ti-note" aria-hidden="true" /> Add note
        </button>
      </div>
    </div>
  )
}
