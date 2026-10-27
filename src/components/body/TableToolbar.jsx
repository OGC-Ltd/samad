// The one bar every tab of the Sensor Monitor wears.
//
// ## Why one component and not four bars
//
// Probe & Sensor Health had Refresh · CSV · PDF; Fuel FSL, Speed and
// Malfunction had nothing, and the panel header carried a single "Download
// PDF" menu that exported the whole fleet regardless of what was on screen.
// Four tabs of one panel disagreed about how you get data out of them, and the
// one place that answered it lied about which rows you were getting.
//
// So the affordance moves down to the tab, where the filtered rows actually
// live, and it is the SAME affordance in all four — same three buttons, same
// order, same wording. A bar per tab written four times is how the four drift
// apart again in six months.
//
// It is deliberately not styled anew. `sp4-gridbar`, `sp4-ghost-btn` and
// `sp4-table-sub` are the panel's own classes, already carrying this exact
// shape on the probes tab; a second visual language on one screen reads as two
// products.
//
// ## What the buttons promise
//
// CSV is the working document — a planner sorts it, filters it, ticks units
// off. PDF is the record — what was on screen the morning somebody signed the
// week's list. Both carry ONLY the rows the tab is currently showing, which is
// why `note` states the filter out loud: an export with no filter control on
// it has to say what it is a set of.

/**
 * @param {object} p
 * @param {import("react").ReactNode} p.summary  the left half — tallies, in the tab's own words
 * @param {string}   [p.note]      one line naming what the export would contain
 * @param {boolean}  [p.loading]
 * @param {() => void} [p.onReload]
 * @param {() => void} [p.onCsv]   omitted or with `disabled` when there is nothing to export
 * @param {() => void} [p.onPdf]
 * @param {boolean}  [p.disabled]  true when the table is empty or still arriving
 * @param {import("react").ReactNode} [p.actions]  tab-specific buttons, shown
 *   BEFORE Refresh. Optional and absent by default, so no existing caller
 *   changes. They lead because they are what the operator came to the tab to
 *   do; CSV and PDF are the archival afterthought. Putting a group that
 *   appears and disappears at the END of the row would make Refresh jump
 *   under the cursor every time a selection changed.
 */
export default function TableToolbar({
  summary, loading = false, onReload, onCsv, onPdf, disabled = false, actions,
}) {
  return (
    <div data-tour="page-toolbar" className="sp4-table-sub sp4-gridbar">
      <span>
        {summary}
      </span>
      <span className="sp4-gridbar-tools">
        {actions && (
          <>
            {actions}
            <span className="sp4-gridbar-sep" aria-hidden="true" />
          </>
        )}
        {onReload && (
          <button type="button" className="sp4-ghost-btn" onClick={onReload} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        )}
        {onCsv && (
          <button
            type="button"
            className="sp4-ghost-btn"
            onClick={onCsv}
            disabled={disabled}
            title="CSV, the rows on screen, opens in Excel"
          >CSV</button>
        )}
        {onPdf && (
          <button
            type="button"
            className="sp4-ghost-btn"
            onClick={onPdf}
            disabled={disabled}
            title="PDF, the rows on screen, as a filed record"
          >PDF</button>
        )}
      </span>
    </div>
  );
}
