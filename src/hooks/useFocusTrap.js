import { useEffect } from "react";

/**
 * Keep the keyboard inside an open dialog, and give it back when it closes.
 *
 * ## Why this exists
 *
 * It is the app's first focus trap, and its absence is the reason the repair
 * form spent its first version as an inline card: `UserAdminPanel` turned its
 * own access editor into a row rather than a dialog on exactly this ground.
 * `MapOverlay`'s fuel-incident window already sets `role="dialog"` and
 * `aria-modal="true"` — which TELLS a screen reader the rest of the page is
 * inert while doing nothing to stop Tab walking straight out of it into the
 * table underneath. This closes that gap, and is written to be reused by the
 * next dialog rather than owned by the one that needed it first.
 *
 * ## What it does, in the order a keyboard meets it
 *
 *   1. Remembers what was focused before the dialog opened.
 *   2. Moves focus INTO the dialog — the first field, so a technician can type
 *      immediately, falling back to the container when there is nothing to
 *      type into.
 *   3. Cycles Tab and Shift+Tab within the dialog.
 *   4. On close, puts focus back where it was. Skipping this drops the caret
 *      at the top of the document, and the row the technician came from is a
 *      dozen Tabs away.
 *
 * Escape is deliberately NOT handled here. A dialog holding unsaved input may
 * want to arm a discard rather than vanish, and that decision belongs to the
 * dialog, not to its plumbing.
 *
 * @param {React.RefObject<HTMLElement>} ref    The dialog element.
 * @param {boolean}                      active Whether the dialog is open.
 */
export default function useFocusTrap(ref, active) {
  useEffect(() => {
    if (!active) return undefined;
    const root = ref.current;
    if (!root) return undefined;

    // `document.activeElement` at open time. Read once: by the time the effect
    // cleans up, focus is somewhere inside the dialog that is being removed.
    const returnTo = document.activeElement;

    /*
     * Recomputed on every Tab rather than cached, because this dialog CHANGES
     * SHAPE as it is filled in — the spare-part select and its "which part"
     * input appear when an outcome chip is clicked. A list captured on open
     * would send Tab into an element that has since been unmounted.
     *
     * `offsetParent === null` drops anything inside a `hidden` subtree. It is
     * the cheap visibility test, and it is enough here because nothing in this
     * dialog hides with `visibility` or a zero clip.
     */
    const focusables = () => Array.from(
      root.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]),'
        + ' select:not([disabled]), textarea:not([disabled]),'
        + ' [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);

    /*
     * `data-autofocus` wins, and it has to be an explicit attribute.
     *
     * The list below is in DOM order, and in every dialog here the first
     * focusable is the close × in the head — so "the first field, so a
     * technician can type immediately" was the intent and not the behaviour.
     * React's own `autoFocus` prop cannot be used to find the field: React
     * handles it specially and never renders an `autofocus` attribute, so
     * querying for one matches nothing.
     *
     * Opt-in, so no existing dialog changes: one without the attribute still
     * gets the first focusable exactly as before.
     */
    const first = root.querySelector('[data-autofocus]') ?? focusables()[0];
    if (first) first.focus();
    else {
      // Nothing to focus — put the caret on the dialog itself so the reader
      // announces it and Tab has somewhere to start from.
      root.setAttribute("tabindex", "-1");
      root.focus();
    }

    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) { e.preventDefault(); return; }

      const firstEl = list[0];
      const lastEl  = list[list.length - 1];

      /*
       * `!root.contains(document.activeElement)` catches the case the naive
       * version misses: focus already OUTSIDE the dialog — a click on the
       * table behind the backdrop, or a browser that restored focus to the
       * body. Without it, Tab from out there walks the page as though the
       * dialog were not open.
       */
      if (!root.contains(document.activeElement)) {
        e.preventDefault();
        firstEl.focus();
        return;
      }
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // `isConnected` — the trigger may have been removed while the dialog was
      // open (the row was filtered out underneath it), and focusing a detached
      // node silently sends focus to the body instead.
      if (returnTo && returnTo.isConnected) returnTo.focus();
    };
  }, [ref, active]);
}
