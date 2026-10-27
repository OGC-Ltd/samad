/**
 * The sign-in screen's figure: how many units are in transit across the WHOLE
 * platform, and when that was true.
 *
 * The server already answers the right question — `/fleet-pulse` counts every
 * active vehicle in every organisation, with no org filter anywhere in the
 * query, so Sukari's movers plus Menengai's plus the other two IS the number.
 * What was wrong was everything around it on the client, and all of it in the
 * three moments the figure is actually looked at:
 *
 *   FIRST RENDER   the hook started at null, so the card painted "Live" and a
 *                  line of marketing copy, then jumped to a count when the
 *                  request landed. The one number on the page arrived last.
 *   PAGE REFRESH   the same, every time, because nothing was kept between
 *                  loads. A figure that vanishes on every refresh reads as a
 *                  figure that is not really there.
 *   IDLING         a fixed 30-second interval that has no idea when the server
 *                  will next have anything new, and no ceiling on how old a
 *                  remembered number may be before showing it becomes a claim
 *                  rather than a reading.
 *
 * ## Two caches, doing two different jobs
 *
 * The SERVER's cache is what makes devices agree. `/fleet-pulse` recomputes at
 * most once every 30 seconds and serves one shared value to everyone in
 * between, so any two devices asking in the same window are given the same
 * integer by construction — there is nothing to reconcile.
 *
 * The BROWSER's cache (localStorage, per device) is only about the first
 * paint: it holds the last figure this device was told, so a refresh starts
 * from the last known reading instead of from nothing. It is never the source
 * of truth and is replaced by the first real response.
 *
 * `asOf` is what joins them. It is the server's stamp on the value, not the
 * moment this browser received it, so it is the same for everyone holding the
 * same figure — which makes it usable both for deciding when the server will
 * next have something new (`nextPollDelay`) and for deciding when a remembered
 * number has gone too old to show (`isFresh`).
 *
 * Extracted from LoginScreen so these rules can be tested: this project's
 * vitest runs in `node` with no jsdom, by choice, so a decision reachable only
 * through a React component is a decision that never gets a test.
 */

/** Where the last figure this device saw is kept. */
export const PULSE_CACHE_KEY = "ft-fleet-pulse";

/**
 * The server's own recompute window, mirrored here.
 *
 * Not a guess: dashboard.service's PULSE_TTL_MS. Polling faster asks the same
 * question of the same cache and is handed the same answer, so the only thing
 * a shorter interval buys is requests.
 */
export const PULSE_TTL_MS = 30_000;

/**
 * How old a figure may be and still be shown as the current one.
 *
 * Ten minutes, which is twenty recompute windows. Well beyond any normal gap,
 * and far short of the case this exists for: a sign-in page left open
 * overnight, or reopened in the morning, against a server that has stopped
 * answering. The old rule was "only ever replace a number with a number",
 * which is right for one failed poll and wrong for eight hours of them — it
 * left yesterday's traffic on screen presented as live.
 *
 * Past this the card says what the product does instead. Saying nothing is
 * honest; saying a number that is not true any more is not.
 */
export const PULSE_MAX_AGE_MS = 10 * 60_000;

/** A pulse this module is willing to reason about. */
export function isPulse(v) {
  return Boolean(v)
    && typeof v === "object"
    && Number.isFinite(v.total)
    && Number.isFinite(v.inTransit)
    && Number.isFinite(v.share)
    && typeof v.asOf === "string"
    && Number.isFinite(Date.parse(v.asOf));
}

/**
 * How old this reading is, in milliseconds, or null when that cannot be said.
 *
 * A NEGATIVE age is returned as-is rather than clamped: `asOf` comes from the
 * server's clock and the comparison is against this device's, so "the future"
 * means the two disagree, and every caller here treats that as fresh. What it
 * must not do is silently become a large positive number.
 */
export function pulseAgeMs(pulse, now = Date.now()) {
  if (!isPulse(pulse)) return null;
  return now - Date.parse(pulse.asOf);
}

/** Is this reading current enough to put on the screen as the live figure? */
export function isFresh(pulse, now = Date.now()) {
  const age = pulseAgeMs(pulse, now);
  return age != null && age <= PULSE_MAX_AGE_MS;
}

/**
 * The figure to paint before anything has been fetched, or null.
 *
 * Null for a malformed blob, a payload from an older build, or one too old to
 * assert — all of which mean the same thing to the card, which is built to say
 * something true without a number.
 */
export const usablePulse = (cached, now = Date.now()) =>
  (isFresh(cached, now) ? cached : null);

/**
 * How long to wait before asking again.
 *
 * Aimed at the moment the SERVER's cache expires rather than at a fixed
 * cadence from whenever this tab happened to load. Two consequences, and the
 * second is the point:
 *
 *   · a poll that lands inside the window is handed the figure it already has,
 *     so a fixed interval spends half its requests confirming what it knows;
 *   · every device is aiming at the same instant, because they are all reading
 *     the same `asOf`. Devices converge on each new figure within a second of
 *     each other instead of drifting up to a full window apart depending on
 *     when each one was opened.
 *
 * The half-second lead is so the request arrives after the server has let the
 * value go, not during the last tick of it holding on.
 *
 * Clamped both ways, because `asOf` is one clock and `now` is another: a
 * device hours behind must not conclude it should wait hours, and one ahead
 * must not poll in a tight loop. Inside the clamp the worst a bad clock costs
 * is the old fixed-interval behaviour.
 */
export function nextPollDelay(pulse, now = Date.now()) {
  if (!isPulse(pulse)) return PULSE_TTL_MS;
  const wait = Date.parse(pulse.asOf) + PULSE_TTL_MS - now + 500;
  return Math.min(PULSE_TTL_MS, Math.max(1_000, wait));
}

/**
 * What to hold after a response.
 *
 * `next` null is a FAILED read, not an empty one — a 404 from an older server,
 * a 503 under load, an offline browser. One of those must not blank the card,
 * so the previous figure stands; a run of them long enough to make it stale
 * drops it, which is the `isFresh` test doing the work rather than a separate
 * timer racing this one.
 */
export function mergePulse(prev, next, now = Date.now()) {
  if (isPulse(next)) return next;
  return usablePulse(prev, now);
}
