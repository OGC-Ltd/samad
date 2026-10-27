/**
 * Plates without the organisation's name in front of them.
 *
 * Some providers name every unit "<ORG> - <unit>" or "<ORG>: <unit>"
 * ("MUFINDI - EX 22", "MUFINDI: 012"). On a phone that prefix is most of the
 * width and says nothing: every unit on the screen belongs to the same
 * organisation.
 *
 * The prefix is read off the fleet rather than off the company record, because
 * the two do not agree: the org stored as "Kasulu" names its units "MUFINDI".
 * A leading word counts as the prefix only when at least half of the fleet
 * starts with it, so a fleet of bare plates ("KDA 123A") is never touched.
 */

const PREFIX = /^([A-Za-z][A-Za-z0-9]*)\s*(?:-|:)\s+/;

/** The organisation prefix shared by most of the fleet, or null. */
export function fleetPrefix(ids) {
  const counts = new Map();
  let n = 0;
  for (const id of ids ?? []) {
    if (typeof id !== 'string') continue;
    n++;
    const m = PREFIX.exec(id);
    if (m) counts.set(m[1].toUpperCase(), (counts.get(m[1].toUpperCase()) ?? 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [k, c] of counts) if (c > bestN) { best = k; bestN = c; }
  return best && bestN * 2 >= n ? best : null;
}

/** `id` with the fleet's prefix taken off the front; unchanged otherwise. */
export function withoutPrefix(id, prefix) {
  if (!prefix || typeof id !== 'string') return id;
  const m = PREFIX.exec(id);
  if (!m || m[1].toUpperCase() !== prefix) return id;
  const rest = id.slice(m[0].length).trim();
  return rest || id;
}

/**
 * A provider's unit name without its dashes: "WKS - Naitiri - KDW 536J" reads
 * "WKS · Naitiri · KDW 536J" (operator, 2026-10-20, "remove the dashes").
 * Parts already said in `drop` (the plate leading the same line) are left out,
 * so "West Sugar-Mahindra-KDW 634X-11km/l" beside KDW 634X reads
 * "West Sugar · Mahindra · 11km/l".
 */
export function nameParts(name, ...drop) {
  if (typeof name !== 'string') return '';
  const key = (s) => s.replace(/\s+/g, '').toUpperCase();
  const split = (s) => s.split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
  const gone = new Set(drop.filter((d) => typeof d === 'string').flatMap(split).map(key));
  return split(name).filter((p) => !gone.has(key(p))).join(' · ');
}
