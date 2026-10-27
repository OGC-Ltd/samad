/**
 * The only data the sign-in screen can read.
 *
 * It renders before there is a session, so every other module in this folder is
 * unavailable to it — they all carry a token and an organisation. This one
 * reaches a route that is public by design: two integers and a percentage
 * describing the platform as a whole, with no organisation or vehicle named in
 * it.
 *
 * `apiFetch` is deliberately NOT used. That helper attaches credentials and
 * routes 401s into the auth flow, which is exactly wrong on a screen whose
 * whole premise is that nobody is signed in — a failed pulse must never look
 * like a failed session.
 */

import { isPulse } from "../lib/fleetPulse";

const BASE = import.meta.env.VITE_API_URL || "";

/**
 * Resolves to `{ total, inTransit, share, asOf }`, or NULL.
 *
 * Null for every failure, and there is no error path on purpose. A server too
 * old to have this route answers 404; one under load answers 503; a browser
 * offline throws. All three mean the same thing to the caller — there is no
 * number to show — and the card it feeds falls back to saying what the product
 * does instead. Nothing about signing in depends on this succeeding.
 */
export async function getFleetPulse(signal) {
  try {
    const res = await fetch(`${BASE}/api/v1/fleet-pulse`, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = await res.json();
    // One shape test, shared with everything that reads a pulse. It used to
    // check `total` and `inTransit` only, and the card renders `share` — so a
    // response missing that one field passed here and printed "undefined%".
    // The whole-body test also means a half-formed payload is a failure, which
    // the caller already knows how to survive, rather than a partial render.
    const d = body?.data;
    return isPulse(d) ? d : null;
  } catch {
    return null;
  }
}
