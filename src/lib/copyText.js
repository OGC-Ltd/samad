/**
 * Copy text, on a page that may not have the Clipboard API.
 *
 * `navigator.clipboard` needs a secure context and this deployment is served
 * over plain HTTP, so on the box the object is simply undefined. That is the
 * whole of the bug this file exists to close: a caller writing
 *
 *     navigator.clipboard?.writeText(t).then(...)
 *
 * reads as careful — the `?.` looks like it handles the missing API — but the
 * optional chain returns `undefined` and `.then` is then read off it, so the
 * handler throws before anything is copied and the button does nothing at all.
 * It works perfectly in dev, where localhost IS a secure context, and fails on
 * every machine an operator uses.
 *
 * The textarea fallback is what actually runs in production today; the first
 * branch takes over for free the day TLS lands. `execCommand` is deprecated
 * and deliberately kept: it is the only clipboard write a non-secure context
 * has, and dropping it would mean dropping the feature.
 *
 * Returns whether the text landed. Never throws, never rejects — a caller can
 * always tell the operator which of the two happened.
 */
export async function copyText(text) {
  if (typeof text !== "string" || text === "") return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Permission denied, or a document that is not focused. Fall through —
       the textarea path needs neither. */
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Fixed and off-screen rather than display:none — a hidden textarea cannot
    // be selected, and any on-screen position scrolls the page on focus.
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    // iOS ignores .select() on a readonly field; setSelectionRange is what it
    // honours, and it is harmless everywhere else.
    ta.setSelectionRange?.(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** The pair, at the precision a GPS fix is worth reading at. */
export function formatCoords(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}
