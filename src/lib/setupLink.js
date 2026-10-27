/**
 * Reading a set-password link.
 *
 * ## Why a fragment
 *
 * The emailed link is `https://host/#setup=<token>`, not `?setup=` and not
 * `/set-password/<token>`.
 *
 *   · A PATH is out because neither nginx nor `vite preview` is configured
 *     with an SPA history fallback, so a deep link 404s at the web server
 *     before React ever loads.
 *   · A QUERY is out because nginx writes query strings into access.log, and
 *     this token is a single-use credential that grants a password set. A
 *     fragment is never sent to any server at all. That is the same reasoning
 *     auth.cookies.ts gives for keeping the access token out of URLs.
 *
 * ## Why the hash is an argument
 *
 * The dash test runner has no DOM (`environment: 'node'`, and vite.config.js
 * says to add jsdom "the day a component test earns it, not before"). Taking
 * the hash as a defaulted parameter is what makes this testable without one.
 */

/** base64url, and long enough to be 32 bytes rather than somebody's typo. */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;

export function readSetupToken(hash = typeof window === "undefined" ? "" : window.location.hash) {
  const raw = String(hash ?? "");
  if (!raw.startsWith("#setup=")) return null;
  const token = raw.slice("#setup=".length);
  return TOKEN_RE.test(token) ? token : null;
}

/**
 * Drop the token out of the address bar once it has been used.
 *
 * replaceState rather than assigning location.hash: the latter pushes a
 * history entry, so Back would put a consumed token back on screen.
 */
export function clearSetupHash() {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
