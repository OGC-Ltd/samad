// Tiny localStorage-backed cache for a stale-while-revalidate first paint.
//
// The server's fleet snapshot query is slow (several seconds on the remote
// pooler), so a cold load has nothing to show until it returns. The data hooks
// cache their last successful response here and hydrate from it synchronously on
// mount, so the app paints instantly with last-known state and then silently
// swaps in fresh data the moment the request lands (the live SSE stream keeps it
// current from there). Ported from fleetdash.
//
// Everything is best-effort: any failure (private mode, quota, corrupt JSON) is
// swallowed and treated as "no cache", so a bad entry can never break a load.

// Bump when a cached payload's MEANING changes, so browsers holding an older
// shape (or data since invalidated server-side) discard it instead of painting
// something stale. v2: the fleet no longer carries simulated positions — every
// vehicle is coordinate-less until RaiFactorySuite supplies real telemetry, and a
// v1 cache would otherwise resurrect retired positions as ghost map markers.
const CACHE_VERSION = 'v2'
const versioned = (key) => `${key}::${CACHE_VERSION}`

export function readCache(key) {
  try {
    const raw = localStorage.getItem(versioned(key))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * Drop cached payloads to make room: every older-version entry, and every
 * current one except `keep`, largest first until `need` characters are freed.
 * Only this module's own entries (the `::` suffix) — never a preference.
 */
function evict(keep, need) {
  const entries = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || k === keep || !/::v\d+$/.test(k)) continue
    entries.push([k, (localStorage.getItem(k) ?? '').length, !k.endsWith(`::${CACHE_VERSION}`)])
  }
  // Stale versions first, then the biggest: a company's fleet snapshot is
  // hundreds of kB, and one of those is what fills the quota.
  entries.sort((a, b) => (b[2] - a[2]) || (b[1] - a[1]))
  let freed = 0
  for (const [k, size, stale] of entries) {
    if (!stale && freed >= need) break
    localStorage.removeItem(k)
    freed += size
  }
}

export function writeCache(key, value) {
  let raw
  try {
    raw = JSON.stringify(value)
    localStorage.setItem(versioned(key), raw)
  } catch {
    // Full: make room from the other cached payloads and try once more. The
    // caches for companies not on screen are the cheapest thing to lose — they
    // only buy a faster first paint on a later visit.
    try {
      evict(versioned(key), raw?.length ?? 0)
      localStorage.setItem(versioned(key), raw)
    } catch {
      /* private mode, or this one payload alone exceeds the quota */
    }
  }
}
