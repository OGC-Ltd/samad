/**
 * One sidebar for "open a row, read its details" across the app: the Drivers
 * page's panel (DriversScreen DriverPanel), lifted so every page that opens a
 * row opens it the same way (operator, 2026-10-20: "the sidebar is to look
 * like that on the drivers page", for the Alerts page, then Maintenance's
 * Repairs, Malfunction, Speed and Fuel FSL).
 *
 * Down the right of the page under the header; another row swaps its content
 * in place; × or Esc closes it. The page behind stays usable. A full-width
 * sheet on a phone. The panel is only the frame: what is in it, and how that
 * is read, stays with the page that opens it.
 *
 *   title     the kind of thing open ("Repair job"), in the head beside the ×
 *   label     what a screen reader announces for the panel
 *   itemKey   which row is open: a new one starts at the top of the panel
 *   footer    actions that belong to the item (map, export), pinned at the foot
 *   wide      for content drawn to a chart's width (Fuel FSL's day trace)
 */

import { useEffect, useRef } from "react";
import { claimSidePanel, onSidePanelClaim } from "../../lib/sidePanels";
import "./DetailSidebar.css";

export default function DetailSidebar({ title, label, itemKey, onClose, footer = null, wide = false, children }) {
  const body = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // A reason half typed is not thrown away by a stray Esc, and a dialog
      // opened from inside the panel closes first, on its own.
      if (e.target instanceof HTMLTextAreaElement && e.target.value.trim()) return;
      if (document.querySelector('.sp4-modal-overlay, [aria-modal="true"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // A new item starts at the top of the panel, not where the last one was left.
  useEffect(() => { body.current?.scrollTo?.({ top: 0 }); }, [itemKey]);

  // One side panel at a time (lib/sidePanels): opening this closes the
  // notifications feed and the map's cards; opening one of those closes this.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    claimSidePanel("detail");
    return onSidePanelClaim("detail", () => closeRef.current?.());
  }, []);

  return (
    <aside className={"dsb" + (wide ? " dsb--wide" : "")} role="dialog" aria-label={label ?? title}>
      <header className="dsb__head">
        <span className="dsb__title">{title}</span>
        <button type="button" className="dsb__x" onClick={onClose} aria-label={`Close ${String(title).toLowerCase()}`}>×</button>
      </header>
      <div className="dsb__body" ref={body}>{children}</div>
      {footer && <footer className="dsb__foot">{footer}</footer>}
    </aside>
  );
}

/** Who or what is open: a small kind line, the name, one line under it. */
export function DetailSidebarIdent({ kind, name, nameTitle, sub, children }) {
  return (
    <div className="dsb__ident">
      {kind}
      <h2 className="dsb__name" title={nameTitle}>{name}</h2>
      {sub && <span className="dsb__sub">{sub}</span>}
      {children}
    </div>
  );
}

/** The three-up facts strip under the name (two-up on a phone). */
export function DetailSidebarFacts({ facts }) {
  return (
    <dl className="dsb__facts">
      {facts.filter(Boolean).map((f) => (
        <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>
      ))}
    </dl>
  );
}

/** A section under a hairline, headed in small capitals. */
export function DetailSidebarSection({ title, aside = null, children }) {
  return (
    <section className="dsb__sec">
      {title && <h3 className="dsb__h">{title}{aside}</h3>}
      {children}
    </section>
  );
}
