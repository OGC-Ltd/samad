/**
 * The sidebar's disclosure tree.
 *
 * Three map controls used to live in the map's own floating rail — Map layers,
 * Fleets and Units — each a button that opened a popover over the imagery. On a
 * desktop they are here instead, as trees in the panel that is already open and
 * already the place this app puts navigation. The map keeps them below 1024px,
 * where there is no sidebar body to hold them (see FleetMap.css).
 *
 * The difference that matters is not where they sit but what they can now say.
 * A popover has one state — open — so a fleet's machine types, its stranded
 * units and its site plans all had to be visible at once or not at all, and the
 * panels grew taller than the map column they opened into. A tree has a state
 * per branch: an operator watching for stranded units keeps that one node open
 * and everything else shut, and the panel stays the height of what they asked
 * for.
 *
 * ## The primitives
 *
 * `TreeNode`   a branch. Owns nothing but its own open/shut, which is local by
 *              design: which branch you last looked at is not a fact about the
 *              fleet and does not belong in storage.
 * `TreeSwitch` a leaf that turns something on. The control IS the row.
 * `TreeLink`   a leaf that goes somewhere — a stranded unit, a weighbridge, a
 *              unit to open. Never a switch: a row that navigates and a row
 *              that toggles must not look alike, which is the mistake
 *              FleetsMenu documents in its own header, and which the Units
 *              branch made when its rows were tick boxes.
 * `TreeEmpty`  what a branch says when it has nothing, so a node that opens
 *              onto silence still reads as answered rather than broken.
 */

import { createContext, useContext, useId, useState } from 'react';
import './SideTree.css';

/**
 * Counts masked (operator, 2026-10-01): an account with limited access (no
 * map:read) sees every tree count as a dash, never the figure — the same "–"
 * the status cards above show — and no alert dot, which is a count by another
 * name. Provided by SidePanel around the trees.
 */
export const TreeCountsMasked = createContext(false);
export const MASKED_COUNT = '–';

function Chevron({ open }) {
  return (
    <svg
      className={`side-tree__chev${open ? ' side-tree__chev--open' : ''}`}
      viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="2.2"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/**
 * A branch.
 *
 * `count` is the number this branch wants to be read at a glance while shut —
 * how many stranded units, how many plans drawn. `tone` colours it: 'alert'
 * for something wrong, 'on' for something switched on, default for a plain
 * total. A branch with nothing to report shows no badge at all rather than a 0,
 * because a zero here is furniture.
 */
export function TreeNode({ label, icon, count = null, tone = 'plain', alert = false, alertTitle, alertTone = 'alert', defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const masked = useContext(TreeCountsMasked);
  if (masked) {
    alert = false;
    if (count != null) { count = MASKED_COUNT; tone = 'plain'; }
  }

  return (
    <div className={`side-tree__node${open ? ' side-tree__node--open' : ''}`}>
      <button
        type="button"
        className="side-tree__branch"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(v => !v)}
      >
        <Chevron open={open} />
        {icon && <i className={`ti ti-${icon} side-tree__icon`} aria-hidden="true" />}
        <span className="side-tree__label">{label}</span>
        {/* Something inside this branch is news.
            A DOT rather than a second number: the branch already carries one
            count, two circles in a 260px row is a row of badges, and the
            question a shut branch has to answer is "is there anything in
            here", not "how many". The figure is one click away. */}
        {alert && (
          <span className={`side-tree__alertdot side-tree__alertdot--${alertTone}`} title={alertTitle} role="img"
                aria-label={alertTitle ?? 'Needs attention'} />
        )}
        {/* `data-len` is how many digits. CSS cannot count characters, and a
            circle has to know: one size for every length either clips "597" or
            leaves a huge empty ring around "4". Same knob the map's cluster
            badge uses — see .lf-cluster-badge. */}
        {count != null && count !== 0 && (
          <span
            className={`side-tree__count side-tree__count--${tone}`}
            data-len={String(count).length}
          >{count}</span>
        )}
      </button>
      {/* Unmounted rather than hidden. These branches carry live lists — 597
          units, every stranded unit re-derived on each SSE frame — and a shut
          branch that is still rendering them costs exactly as much as an open
          one. */}
      {open && <div className="side-tree__children" id={id}>{children}</div>}
    </div>
  );
}

/** A leaf that turns something on. */
export function TreeSwitch({ label, on, onToggle, count = null, swatches = null, title }) {
  if (useContext(TreeCountsMasked) && count != null) count = MASKED_COUNT;
  return (
    <button
      type="button"
      className={`side-tree__row side-tree__row--switch${on ? ' side-tree__row--on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      title={title}
    >
      <span className="side-tree__box" aria-hidden="true" />
      <span className="side-tree__rowlabel">{label}</span>
      {/* The layer's colours, where the layer is. Read-only here: the key that
          names them stays in the map's own legend, because a sidebar 260px wide
          is not where anybody reads a colour table. */}
      {swatches?.length > 0 && (
        <span className="side-tree__swatches" aria-hidden="true">
          {swatches.map(sw => (
            <span key={sw.key} className="side-tree__swatch" style={{ '--sw': sw.color }} />
          ))}
        </span>
      )}
      {count != null && <span className="side-tree__rowcount">{count}</span>}
    </button>
  );
}

/** A leaf that goes somewhere.
 *
 *  `count` is for a leaf that OPENS something with a size to it — a list, a
 *  panel — rather than one that names a single thing. `countTone: 'alert'`
 *  colours it, for a figure that is news rather than a total. */
export function TreeLink({ label, meta, count = null, countTone = 'plain', onClick, tone = 'plain', title }) {
  if (useContext(TreeCountsMasked) && count != null) { count = MASKED_COUNT; countTone = 'plain'; }
  return (
    <button
      type="button"
      className={`side-tree__row side-tree__row--link side-tree__row--${tone}`}
      onClick={onClick}
      title={title}
    >
      <span className="side-tree__rowlabel">{label}</span>
      {meta && <span className="side-tree__rowmeta">{meta}</span>}
      {count != null && (
        <span className={`side-tree__rowcount side-tree__rowcount--${countTone}`}>{count}</span>
      )}
    </button>
  );
}

export function TreeEmpty({ children }) {
  return <div className="side-tree__empty">{children}</div>;
}
