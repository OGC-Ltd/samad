/* Hallmark · component: hover list (map cluster) · genre: modern-minimal · theme: project (FleetMap's own)
 * states: default · hover · focus · active · disabled · loading · error · success — see the note below
 * contrast: pass — every glyph carries shape as well as colour
 * pre-emit critique: P4 H5 E4 S5 R5 V4
 */
//
// What a cluster badge is standing for, as a table rather than a list.
//
// ## Why it grew columns
//
// It shipped as one line per unit: a status dot and a registration. That answers
// "which units" and nothing else, and it is the wrong shape for the moment it
// appears in — the reader has zoomed out, several machines have collapsed into
// one icon, and the question is not only who is under there but which of them
// is worth zooming to. A dot carrying seven meanings at 6 px could not say.
//
// Three columns, each answering one question, in the order somebody scans:
//
//   1. WHAT IS IT DOING     moving · idling · stopped · offline, from markerState
//   2. WHICH UNIT           the registration
//   3. HOW OLD IS THIS      the age of the fix behind the row
//
// Columns two and three are the pair that matters. "KCP 411Q, in motion" is a
// claim about right now, and it is only worth as much as the fix behind it —
// a truck shown driving on a four-hour-old position is not driving, it is a
// guess. The map has always known this (it dims dark markers and captions
// them) and the list did not, so the list was the more confident of the two
// about the same fact.
//
// ## Why shapes and not just colours
//
// The panel cannot be hovered — it follows the cursor, so a `title` never
// opens and a row can never be clicked. Everything it says, it says at a
// glance. So each state gets a distinct SILHOUETTE and the map's own colour on
// top: the colour is the recognition (these are the same colours as the
// markers underneath) and the shape is the reading. Colour alone would fail
// anyone who cannot separate the greens from the slates, and would fail
// everyone at 6 px.
//
// ## About the eight states
//
// This is a non-interactive component, so the eight-state checklist collapses
// honestly rather than being padded out: it has no hover, focus, active or
// disabled state because it takes no pointer and no keyboard. Its "loading",
// "error" and "success" are the data conditions it actually meets — a unit not
// found in the snapshot, a unit with no fix timestamp, and a fully resolved
// row. All three are handled below and none of them renders a blank cell.

import { markerState } from "../../lib/vehicleMap";
import { fixAgeLabel, fixRecencyTier, RECENCY_LABEL } from "../../lib/fixRecency";

/**
 * How many registrations to print before summarising.
 *
 * Twelve rows is about 230 px of panel, which still clears a laptop viewport
 * with the cursor near the bottom edge. Past that the list stops answering
 * "which units" and becomes a scroll the reader cannot scroll.
 */
export const CLUSTER_TIP_ROWS = 12;

/**
 * What each marker state means in words, and what it looks like.
 *
 * The four ground states are the map's own — see vehicleMap's markerState.
 * `stationary` is online with the engine off; `parked` is the provider
 * reporting no connection at all. They are different facts and the map has
 * always drawn them differently, so the list does too.
 *
 * The three alert states are here because a unit in a cluster can be in them.
 * Leaving them out would mean the icon quietly falling back to something the
 * unit is not, which is worse than an unfamiliar glyph.
 */
const ACTIVITY = {
  ok:            { label: "In motion",   glyph: "move"  },
  idling:        { label: "Idling",      glyph: "idle"  },
  stationary:    { label: "Stopped",     glyph: "stop"  },
  parked:        { label: "Offline",     glyph: "off"   },
  speeding:      { label: "Speeding",    glyph: "fast"  },
  theft:         { label: "Fuel alert",  glyph: "drop"  },
  "signal-lost": { label: "Signal lost", glyph: "lost"  },
};

/* Drawn on a 10×10 box so every glyph occupies the same optical weight — a
   triangle and a square of equal side lengths do not, so the triangle is
   widened and the square inset. `currentColor` throughout: the row sets the
   colour once from the map's palette and both glyphs inherit it. */
const ACTIVITY_PATHS = {
  // Moving: a solid arrowhead. The one filled, directional shape in the set.
  move: <path d="M2 1.5 L9 5 L2 8.5 Z" fill="currentColor" />,
  // Speeding: the same arrowhead doubled — more of the same thing, which is
  // exactly what speeding is.
  fast: (
    <>
      <path d="M0.5 1.5 L5 5 L0.5 8.5 Z" fill="currentColor" />
      <path d="M5 1.5 L9.5 5 L5 8.5 Z" fill="currentColor" />
    </>
  ),
  // Idling: a ring. Running, going nowhere — the hole is the point.
  idle: <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.7" />,
  // Stopped but present: a solid block.
  stop: <rect x="2.2" y="2.2" width="5.6" height="5.6" rx="1.1" fill="currentColor" />,
  // Offline: the same block, hollowed. Nothing is coming from it.
  off: (
    <rect x="2.2" y="2.2" width="5.6" height="5.6" rx="1.1"
          fill="none" stroke="currentColor" strokeWidth="1.4" />
  ),
  // Lost mid-journey: the moving arrowhead, hollow and struck through. It was
  // driving; we cannot say it still is.
  lost: (
    <>
      <path d="M2 1.5 L9 5 L2 8.5 Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M0.8 9.2 L9.2 0.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  // Fuel: a droplet, the one glyph in the set that is about a substance
  // rather than about motion.
  drop: <path d="M5 1 C7.4 4 8.2 5.4 8.2 6.6 A3.2 3.2 0 0 1 1.8 6.6 C1.8 5.4 2.6 4 5 1 Z" fill="currentColor" />,
};

/* Recency: three bars, filled from the left as the fix gets older is BACKWARDS
   — filled from the left as it gets FRESHER. Three bars is live, one is dark.
   The same reading as any signal meter, which is the point: it needs no
   legend. Unknown gets no bars and a rule through the slot, because "we have
   no timestamp" is not a weak signal, it is a missing one. */
const RECENCY_BARS = { live: 3, delayed: 2, dark: 1, unknown: 0 };

function RecencyGlyph({ tier }) {
  const filled = RECENCY_BARS[tier] ?? 0;
  if (!filled) {
    return (
      <svg viewBox="0 0 10 10" className="lf-ct-glyph" aria-hidden="true">
        <path d="M1.5 8.5 L8.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 10 10" className="lf-ct-glyph" aria-hidden="true">
      {[0, 1, 2].map(i => (
        <rect
          key={i}
          x={0.8 + i * 3.4}
          y={8 - (i + 1) * 2.2}
          width="2.4"
          height={(i + 1) * 2.2 + 1}
          rx="0.6"
          fill="currentColor"
          /* The empty bars stay VISIBLE at low opacity rather than being
             dropped. A meter missing its tall bar and a meter that never had
             one look identical if the unfilled ones are not drawn. */
          opacity={i < filled ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}

/**
 * One unit.
 *
 * @param {object} p
 * @param {string} p.id        the registration — also the key the map uses
 * @param {object|null} p.vehicle  the live snapshot row, or null if the fleet
 *        no longer carries it (an org switch mid-hover). A missing unit still
 *        renders: the badge counted it, so dropping the row here would leave a
 *        list shorter than the number above it.
 * @param {object} p.alertOpts passed through to markerState, so this row and
 *        the marker it stands for cannot disagree about a fuel alert
 * @param {string[]} p.statusColors marker state → colour, the map's own map
 */
function ClusterRow({ id, vehicle, alertOpts, statusColors }) {
  const state = vehicle ? markerState(vehicle, alertOpts) : null;
  const act   = ACTIVITY[state] ?? { label: "Unknown", glyph: "off" };
  const tier  = vehicle ? fixRecencyTier(vehicle) : "unknown";
  const age   = vehicle ? fixAgeLabel(vehicle) : "-";

  return (
    <li className="lf-ct-row">
      <span
        className="lf-ct-act"
        style={{ color: statusColors[state] ?? "#8b93a3" }}
        role="img"
        aria-label={act.label}
        /* Kept for the day this panel becomes hoverable; harmless now. */
        title={act.label}
      >
        <svg viewBox="0 0 10 10" className="lf-ct-glyph" aria-hidden="true">
          {ACTIVITY_PATHS[act.glyph]}
        </svg>
      </span>

      <span className="lf-ct-reg">{id}</span>

      <span
        className={`lf-ct-age lf-ct-age--${tier}`}
        role="img"
        aria-label={`${RECENCY_LABEL[tier]} (${age})`}
        title={`${RECENCY_LABEL[tier]} · ${age}`}
      >
        <RecencyGlyph tier={tier} />
        <span className="lf-ct-age-n">{age}</span>
      </span>
    </li>
  );
}

/**
 * @param {object} p
 * @param {string[]} p.ids       every unit under the badge, in the cluster's order
 * @param {object[]} p.vehicles  the live snapshot
 * @param {object} p.alertOpts
 * @param {object} p.statusColors
 * @param {import("react").Ref} p.nodeRef  the panel follows the cursor via a
 *        transform written straight onto this node — see FleetMap
 */
export default function ClusterList({ ids, vehicles, alertOpts, statusColors, nodeRef }) {
  const shown = ids.slice(0, CLUSTER_TIP_ROWS);
  const byId = new Map();
  for (const v of vehicles ?? []) byId.set(v.id, v);

  return (
    <div ref={nodeRef} className="lf-cluster-tip">
      {/* The count, then the two column captions. The activity column has no
          caption on purpose: a word over it would be a third heading for a
          14 px track, and the glyphs are the only thing in the panel that
          share their colour with the markers on the map behind it. */}
      <div className="lf-ct-head">
        <span className="lf-ct-head-n">{ids.length} units here</span>
      </div>
      <div className="lf-ct-cols" aria-hidden="true">
        <span />
        <span>Unit</span>
        <span>Last fix</span>
      </div>

      <ul className="lf-ct-list">
        {shown.map(id => (
          <ClusterRow
            key={id}
            id={id}
            vehicle={byId.get(id) ?? null}
            alertOpts={alertOpts}
            statusColors={statusColors}
          />
        ))}
      </ul>

      {/* Never a silent truncation: a list that stops at twelve without saying
          so is a list the reader believes is complete. */}
      {ids.length > CLUSTER_TIP_ROWS && (
        <div className="lf-ct-more">and {ids.length - CLUSTER_TIP_ROWS} more</div>
      )}
      <div className="lf-ct-hint">Click to zoom in</div>
    </div>
  );
}
