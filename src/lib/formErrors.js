/**
 * Reading a failed mutation.
 *
 * Until now nothing in this app mutated anything — every module under src/api/
 * is a read, and the only failure any of them had to handle was "the whole
 * request died", which useApiData renders as a LoadError. Forms need something
 * else: a 400 that names a field, which the server already sends and ApiError
 * already carries and nobody has ever unpacked.
 *
 * The server's envelope is `{ status, message, errors }` where `errors` is
 * `Record<field, string[]>` (see core/response/response.ts and the ZodError
 * branch in middleware/errorHandler.ts). services/api.js puts the whole body on
 * `err.body`, so everything needed is already here.
 *
 * Pure on purpose — the dash test runner has no DOM, so this is testable and a
 * component would not be.
 */

/** The server's per-field messages, or null when it did not send any. */
export function fieldErrors(err) {
  const errors = err?.body?.errors;
  if (!errors || typeof errors !== "object") return null;
  return errors;
}

/**
 * The best single sentence to show a human.
 *
 * Prefers the named field's first message, then the top-level message, then
 * the fallback. The order matters: "Use at least 12 characters" is more useful
 * than "Validation failed", and both are more useful than "Something went
 * wrong" — but a network error has only the last of the three.
 */
export function firstMessage(err, field, fallback = "Something went wrong. Try again.") {
  const errors = fieldErrors(err);
  const named = field && Array.isArray(errors?.[field]) ? errors[field][0] : null;
  if (named) return named;

  // Any field at all, when the caller did not name one — a 400 that mentions
  // a field the form does not know about is still better than a generic line.
  if (errors) {
    for (const value of Object.values(errors)) {
      if (Array.isArray(value) && value[0]) return value[0];
    }
  }

  return err?.message || fallback;
}

/**
 * Is this failure "the server does not have this endpoint"?
 *
 * A 404 from an endpoint the client knows about does not mean the thing was
 * not found — it means the API serving this app predates the feature. Worth
 * telling apart, because the honest advice differs completely: retrying or
 * checking your connection will never fix a route that is not deployed, and
 * saying so sends people to look in the wrong place.
 */
export function isMissingEndpoint(err) {
  return err?.status === 404 && /route not found/i.test(err?.body?.message ?? err?.message ?? "");
}
