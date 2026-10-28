/**
 * The map's supplementary layers, behind one button.
 *
 * ## What it replaces
 *
 * Two labelled buttons in a row across the top-centre of the map (241x30) and,
 * below them, a separate collapsible "Map key" box. Three floating things
 * competing for the only clear space there is: the rails either side take 676px
 * of a 1280px screen, leaving a 604px column for everything the map wants to
 * put on top of itself.
 *
 * They also said the same thing twice. A toggle called "Estate areas" and a key
 * headed "Estate areas" are one idea, read at one moment, and the operator had
 * to look in two places to use it. Here a layer is one row: the switch, and its
 * colours underneath once it is on. A key for a layer that is off is not
 * information, it is furniture.
 *
 * ## Why it lives in the camera rail
 *
 * `.map-cam-controls` is already the map's own control cluster — zoom, zoom,
 * reset — already clear of both rails and the footer, and already the place an
 * operator looks for a map control. Adding a fourth button there costs no new
 * screen space at all, and it is where Google and Mapbox put this exact control,
 * so it needs no learning.
 *
 * ## A popover, not a window
 *
 * The three draggable windows on this screen (the vehicle card, the playback
 * transport, the incident window) are things an operator keeps. This is a menu:
 * it belongs to its button, it closes on Escape and on a click outside, and it
 * hands focus back when it goes. Nothing about it is remembered — the LAYER
 * states persist, as they always did, but where the menu was is not a fact
 * about the fleet.
 */

import { useEffect, useRef, useState, useId } from "react";
import "./MapLayersMenu.scss";

/** Stacked sheets. An icon rather than a glyph — ▤ reads as a list. */
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
      <path d="m3 12.5 9 4.5 9-4.5" />
      <path d="m3 17 9 4.5 9-4.5" />
    </svg>
  );
}

/**
 * `rail`: drawn as a button of the map's left tool rail (MapToolRail) rather
 * than of the camera stack — the same menu, a different trigger skin, and the
 * panel opening to the RIGHT of the button instead of to its left. `label` is
 * the rail's expanded-state caption.
 */
export default function MapLayersMenu({ layers, rail = false, label = null, bases = null, base = null, onBase = null, baseNote = null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const panelId = useId();

  /**
   * Close on Escape or on a press outside.
   *
   * `pointerdown`, not `click`: a press that starts inside the panel and
   * releases outside it — dragging across a row, or letting go past the edge —
   * fires `click` on the common ancestor and would close the menu out from
   * under a gesture that never left it.
   *
   * Escape also returns focus to the trigger, or the keyboard user is left
   * at the top of the document with no way back to the control they just used.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * Which keys are expanded, as an override on the default below.
   *
   * Every key starts closed, because the colours now sit ON the layer's row —
   * see the strip below. What the expanded block adds is the NAMES, and with
   * four surveys switched on this panel was six switches above twenty-odd rows
   * of labelled swatch: a scrolling colour table, which is the thing nobody
   * reads. Inline, a layer costs the same height on as off.
   *
   * Keyed by layer id and never cleared: an operator who opened Kabras' names
   * has said they want them, and them staying open through the next toggle is
   * the point.
   */
  const [keyOpen, setKeyOpen] = useState({});

  // A control that opens an empty panel is worse than no control. Orgs with
  // neither zone geometry nor a planting plan get nothing.
  // `bases` — the base maps to choose between (rail only): [{ id, label, hint }].
  const hasBases = rail && bases?.length > 1;
  if (!layers?.length && !hasBases) return null;

  const activeCount = layers.filter((l) => l.on).length;

  /** Closed until asked for. The strip on the row already carries the colours;
   *  this is the NAMES for them, which is a question, not a default. */
  const shown = (layer) => keyOpen[layer.id] ?? false;

  return (
    <div className={`map-layers${rail ? " map-layers--rail" : ""}`} ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={rail
          ? `mtr-btn${open ? " mtr-btn--on" : ""}`
          : `map-cam-btn map-layers__btn${open ? " map-layers__btn--open" : ""}${activeCount ? " map-layers__btn--on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${rail ? "Maps" : "Map layers"}${activeCount ? `, ${activeCount} on` : ""}`}
        title={rail ? "Maps: base map and layers" : "Map layers"}
      >
        {/* The count is the whole state of the menu while it is shut — without
            it, a layer left on is invisible until something is clicked. */}
        {rail ? (
          <>
            {/* On the rail the count rides the ICON's corner, not the button's:
                the button is the rail's full width, and wider still with the
                tool names shown, so the button's corner left it floating. */}
            <span className="mtr-btn__icon">
              <i className="ti ti-map" aria-hidden="true" />
              {activeCount > 0 && <span className="map-layers__count" data-digits={String(activeCount).length}>{activeCount}</span>}
            </span>
            {label && <span className="mtr-btn__label">{label}</span>}
          </>
        ) : (
          <>
            <LayersIcon />
            {activeCount > 0 && <span className="map-layers__count" data-digits={String(activeCount).length}>{activeCount}</span>}
          </>
        )}
      </button>

      {open && (
        <div className="map-layers__panel" id={panelId} role="group" aria-label={rail ? "Maps" : "Map layers"}>
          {hasBases && (
            <>
              <div className="map-layers__title">Base map</div>
              <div className="map-layers__bases" role="radiogroup" aria-label="Base map">
                {bases.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    role="radio"
                    aria-checked={base === b.id}
                    className={`map-layers__base${base === b.id ? " map-layers__base--on" : ""}`}
                    onClick={() => onBase?.(b.id)}
                    title={b.hint ?? b.label}
                  >
                    <span className="map-layers__radio" aria-hidden="true" />
                    {b.label}
                  </button>
                ))}
              </div>
              {baseNote && <div className="map-layers__hint map-layers__base-note">{baseNote}</div>}
            </>
          )}
          {layers?.length > 0 && (
            <div className={`map-layers__title${hasBases ? " map-layers__title--gap" : ""}`}>Map layers</div>
          )}

          {layers.map((layer) => (
            <div className="map-layers__layer" key={layer.id}>
              {/* Switch and key share ONE line. The key used to sit under the
                  layer as a labelled table, which was fine for an org with two
                  layers and unreadable for one with four: every layer switched
                  on pushed the next one further down a scrolling panel. Inline,
                  a layer costs the same height whether it is on or off. */}
              <div className="map-layers__head">
                <button
                  type="button"
                  className="map-layers__row"
                  role="switch"
                  aria-checked={layer.on}
                  onClick={layer.onToggle}
                >
                  <span className="map-layers__switch" aria-hidden="true" />
                  <span className="map-layers__label">{layer.label}</span>
                </button>

                {/* The colours, as colours. A sibling button rather than part of
                    the switch — nesting one inside the other is invalid, and
                    these are two different questions ("draw this" and "what do
                    these mean"). The swatch carries its name in `title` for a
                    pointer and the button carries all of them in its label for
                    everything else, so the strip is never the only copy. */}
                {layer.on && layer.legend?.length > 0 && (
                  <button
                    type="button"
                    className="map-layers__strip"
                    aria-expanded={shown(layer)}
                    aria-label={`Key for ${layer.label}: ${layer.legend.map((r) => r.label).join(", ")}`}
                    title={shown(layer) ? "Hide the key" : "What these colours mean"}
                    onClick={() => setKeyOpen((m) => ({ ...m, [layer.id]: !shown(layer) }))}
                  >
                    {layer.legend.map((row) => (
                      <span
                        key={row.key}
                        className="map-layers__swatch"
                        style={{ "--zone-color": row.color }}
                        title={row.label}
                      />
                    ))}
                  </button>
                )}
              </div>

              {/* The key, and only for a layer that is actually drawn. */}
              {layer.on && layer.legend?.length > 0 && shown(layer) && (
                <div className="map-layers__key">
                  {layer.legend.map((row) => (
                    <div className="map-layers__keyrow" key={row.key}>
                      <span className="map-layers__swatch" style={{ "--zone-color": row.color }} />
                      {row.label}
                    </div>
                  ))}
                  {layer.hint && <div className="map-layers__hint">{layer.hint}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
