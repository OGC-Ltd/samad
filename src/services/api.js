// Thin fetch wrapper for the fleet-server backend. Mirrors fleetdash's
// services/api.js: an empty/undefined VITE_API_URL resolves to same-origin
// relative paths — served behind nginx in prod and via Vite's /api proxy in
// dev (see vite.config.js). Never fall back to a hardcoded localhost host,
// which would silently point every visitor's browser at their own machine.
const BASE = import.meta.env.VITE_API_URL || ''

/**
 * The access token lives in a MODULE VARIABLE, not localStorage.
 *
 * A token in localStorage is readable by any script the page ever loads; one
 * held in a closure is not, and this one is short-lived anyway. Nothing is lost
 * on reload: the refresh token is an httpOnly cookie the browser keeps, and
 * AuthContext trades it for a new access token on mount.
 *
 * The server also sets the access token as an httpOnly cookie, which is what
 * makes the SSE stream work — EventSource cannot send an Authorization header.
 * So this copy exists purely so ordinary fetch calls can send the Bearer header.
 */
let accessToken = null

export function setAccessToken(token) { accessToken = token ?? null }
export function getAccessToken() { return accessToken }

/**
 * Called when the session is gone for good — a refresh was refused, so the
 * cookie is worthless and the user has to sign in again. AuthContext registers
 * the handler that clears its state and shows the login screen.
 */
let onSessionLost = null
export function setSessionLostHandler(fn) { onSessionLost = fn }

/**
 * Carries the STATUS, which the old wrapper threw away.
 *
 * Every screen surfaced failures through the same "couldn't load, retry"
 * treatment, so a 403 for a permission the user does not hold looked exactly
 * like a server fault — and the Retry button invited them to try again forever.
 */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
  get isAuth()      { return this.status === 401 }
  get isForbidden() { return this.status === 403 }
}

/**
 * The server's message, plus the fields it named.
 *
 * A zod failure answers `{ message: "Validation failed", errors: { field:
 * [why] } }`. Throwing only the message turned every one of those into the
 * same four characterless words on screen — a form telling a person something
 * is wrong and refusing to say what, which is the least useful thing an error
 * can do. The server had the answer the whole time; only the client dropped it.
 *
 * `flatten().fieldErrors` keys NESTED issues under their first path segment, so
 * a bad row inside a repair report arrives as `items: ["…"]` rather than
 * `items.3.sparePart`. The field name is therefore a hint, not a coordinate,
 * and the message after it is the part worth reading — which is why the value
 * is printed and the key is only a prefix.
 */
function detailedMessage(body) {
  if (!body?.message) return null
  const errors = body.errors
  if (!errors || typeof errors !== 'object') return body.message
  const parts = []
  for (const [field, why] of Object.entries(errors)) {
    const text = Array.isArray(why) ? why.join('; ') : String(why)
    if (text) parts.push(`${field}: ${text}`)
  }
  return parts.length > 0 ? `${body.message} - ${parts.join(' · ')}` : body.message
}

/**
 * One refresh at a time.
 *
 * A dashboard load fires a dozen requests at once, so an expired token means a
 * dozen simultaneous 401s. Without this they would each start their own
 * refresh, and because refresh tokens ROTATE, the second one to arrive would
 * present a token the first had already spent — which the server treats as
 * theft and answers by revoking the whole session family. Concurrency here is
 * not a performance concern; it is the difference between refreshing and being
 * logged out.
 */
let refreshInFlight = null

function refreshOnce() {
  refreshInFlight ??= fetch(`${BASE}/api/v1/auth/refresh`, {
    method:      'POST',
    credentials: 'include',
    headers:     { 'Content-Type': 'application/json' },
  })
    .then(async (res) => {
      if (!res.ok) throw new ApiError('Session expired', res.status)
      const body = await res.json().catch(() => ({}))
      setAccessToken(body?.data?.accessToken ?? null)
      return body?.data ?? null
    })
    .finally(() => { refreshInFlight = null })
  return refreshInFlight
}

export { refreshOnce }

/** Auth endpoints must never trigger the retry — that is how you loop forever. */
const isAuthPath = (path) => path.startsWith('/api/v1/auth/')

export async function apiFetch(path, options = {}, retried = false) {
  const res = await fetch(`${BASE}${path}`, {
    // Options FIRST, headers last: the previous order let a caller passing
    // `headers` replace the merged object wholesale and silently drop
    // Content-Type along with the Authorization header.
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
  })

  // Expired access token — refresh once and replay. Only once: a second 401
  // after a successful refresh means the session is genuinely gone.
  if (res.status === 401 && !retried && !isAuthPath(path)) {
    try {
      await refreshOnce()
    } catch {
      setAccessToken(null)
      onSessionLost?.()
      throw new ApiError('Session expired', 401)
    }
    return apiFetch(path, options, true)
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status === 401) { setAccessToken(null); onSessionLost?.() }
    throw new ApiError(detailedMessage(body) ?? `HTTP ${res.status}`, res.status, body)
  }
  return res.json()
}

/**
 * A file from the API — a workbook or a PDF — with the same auth and one
 * refresh-and-retry as apiFetch. Resolves to { blob, filename }, the filename
 * taken from the server's Content-Disposition when it sends one.
 */
export async function apiFetchBlob(path, options = {}, retried = false) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...options.headers },
  })
  if (res.status === 401 && !retried) {
    try { await refreshOnce() } catch { setAccessToken(null); onSessionLost?.(); throw new ApiError('Session expired', 401) }
    return apiFetchBlob(path, options, true)
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(detailedMessage(body) ?? `HTTP ${res.status}`, res.status, body)
  }
  const cd = res.headers.get('Content-Disposition') ?? ''
  const filename = /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? null
  return { blob: await res.blob(), filename }
}

// EventSource can't send headers, so it must hit the same origin as the app —
// the Vite proxy (dev) / nginx (prod) forwards it to the backend. Returning a
// BASE-prefixed path keeps it consistent with apiFetch.
//
// Authentication rides on the httpOnly access cookie the browser attaches by
// itself; nothing is appended to the URL, because a token in a query string is
// written into nginx's access log.
export function sseUrl(path) {
  return `${BASE}${path}`
}
