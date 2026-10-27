/**
 * Copy each column's header text onto the cells beneath it, as `data-label`.
 *
 * This is what lets a wide data grid become a stack of cards on a phone: with
 * the header row hidden, a bare "8m ago" in a list of values means nothing, so
 * the CSS draws `attr(data-label)` in front of it. The labels have to come from
 * the DOM rather than from each panel's markup because the Sensor Monitor
 * screen has five of these tables in four components, with different columns,
 * some of them conditional (the select-all checkbox only exists for a user who
 * can raise a repair) — so a hand-written `data-label` on every <td> is five
 * lists to keep in step with five headers, and the failure mode when one drifts
 * is a card labelled with the wrong column.
 *
 * Deliberately a DOM pass rather than React state: it writes only presentation
 * attributes React does not own, so it cannot fight the reconciler, and one
 * call from the screen root covers every table inside it including the ones
 * that mount later.
 *
 * `:scope >` throughout: a cell belongs to the header of ITS OWN table, and
 * these panels nest tables inside detail rows.
 */
export function labelTableCells(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;

  let written = 0;
  for (const table of root.querySelectorAll('table.sp4-table')) {
    const heads = [...table.querySelectorAll(':scope > thead > tr > th')]
      .map((th) => (th.textContent ?? '').trim());
    if (heads.length === 0) continue;

    for (const cell of table.querySelectorAll(':scope > tbody > tr > td')) {
      const label = heads[cell.cellIndex] ?? '';
      // Only on change: this runs after every render of a panel that repaints
      // on a 15-second poll, and an unconditional write would dirty several
      // hundred nodes each time for no visible difference.
      if (cell.getAttribute('data-label') !== label) {
        cell.setAttribute('data-label', label);
        written += 1;
      }
    }
  }
  return written;
}

/**
 * Keep the labels correct as rows come and go, and return a teardown.
 *
 * A single `useEffect` in the screen root is not enough: each panel under it
 * owns its own fetch and its own state, so a repairs list that arrives two
 * seconds after mount re-renders THAT panel and never the parent whose effect
 * would have labelled it. Measured: the Repairs grid came up with `data-label`
 * null on all ten columns and drew a stack of bare values.
 *
 * An observer covers every such case — a poll, a filter, a tab switch, a row
 * expanding — from one place. Only `childList` is watched, and labelling writes
 * nothing but attributes, so the pass cannot retrigger itself. The rAF collapses
 * a burst of insertions into one pass.
 */
export function watchTableLabels(root) {
  if (!root || typeof MutationObserver === 'undefined') return () => {};

  let queued = 0;
  const run = () => { queued = 0; labelTableCells(root); };

  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = requestAnimationFrame(run);
  });

  labelTableCells(root);
  observer.observe(root, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    if (queued) cancelAnimationFrame(queued);
  };
}
