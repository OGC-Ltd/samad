/**
 * The roster's view state: sorting, paging, selection.
 *
 * All pure, and in lib/ for the reason every other pure module here is: vitest
 * runs `environment: 'node'` with no jsdom, so logic inside a component cannot
 * be pinned by a test. A 380-row roster with a pager is exactly the place
 * off-by-ones live, and "page 3 of 2" is a bug you find in production unless
 * something holds it still.
 */

/** A page is 1-based everywhere in this module — it is a label, not an index. */
export const PER_PAGE_CHOICES = [15, 25, 50, 100];

/**
 * Compare two rows by a column, with a stable tiebreak.
 *
 * `undefined` and `null` always sort LAST regardless of direction. An account
 * with no password date is not "the earliest password change" — it has no
 * value at all, and letting it win the top of an ascending sort puts the least
 * informative rows where the eye lands first.
 */
function compare(a, b, get) {
  const x = get(a);
  const y = get(b);
  const xEmpty = x === null || x === undefined || x === "";
  const yEmpty = y === null || y === undefined || y === "";
  if (xEmpty && yEmpty) return 0;
  if (xEmpty) return 1;
  if (yEmpty) return -1;
  if (typeof x === "number" && typeof y === "number") return x - y;
  return String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
}

/**
 * @param {Array<object>} rows
 * @param {{ key: string, dir: 'asc'|'desc' }|null} sort
 * @param {Record<string, (row: object) => unknown>} accessors
 */
export function sortRows(rows, sort, accessors) {
  const list = [...(rows ?? [])];
  if (!sort?.key) return list;
  const get = accessors?.[sort.key];
  if (!get) return list;
  // The empties-last rule must survive `desc`, so the direction is applied to
  // the comparison and not by reversing the finished array.
  const sign = sort.dir === "desc" ? -1 : 1;
  return list.sort((a, b) => {
    const x = get(a), y = get(b);
    const xEmpty = x === null || x === undefined || x === "";
    const yEmpty = y === null || y === undefined || y === "";
    if (xEmpty !== yEmpty) return xEmpty ? 1 : -1;
    return sign * compare(a, b, get);
  });
}

/** The next sort state for a header click: asc → desc → off. */
export function nextSort(current, key) {
  if (current?.key !== key) return { key, dir: "asc" };
  if (current.dir === "asc") return { key, dir: "desc" };
  return null;
}

/**
 * One page of rows, plus everything the footer has to say.
 *
 * `page` is CLAMPED rather than trusted. Filtering a 380-row roster down to 12
 * while sitting on page 20 is the ordinary case, not an edge case, and the
 * honest answer is the last page that exists — not an empty table under a
 * pager insisting there are more.
 */
export function paginate(rows, page, perPage) {
  const total = (rows ?? []).length;
  const size = perPage > 0 ? perPage : PER_PAGE_CHOICES[0];
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * size;
  const slice = (rows ?? []).slice(start, start + size);
  return {
    slice,
    page: current,
    pageCount,
    total,
    // 1-based inclusive, and 0–0 on an empty roster rather than 1–0.
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + size, total),
  };
}

/**
 * The pager's buttons: first, last, a window around the current page, and
 * `null` wherever a gap was elided.
 *
 * Returns numbers and nulls rather than rendered labels so the caller owns the
 * ellipsis glyph, and so a test can assert the SHAPE without matching strings.
 */
export function pageWindow(page, pageCount, span = 1) {
  if (pageCount <= 1) return [1];
  const keep = new Set([1, pageCount]);
  for (let p = page - span; p <= page + span; p++) {
    if (p >= 1 && p <= pageCount) keep.add(p);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out = [];
  let previous = 0;
  for (const p of sorted) {
    if (previous) {
      // A gap of exactly one page is printed, not elided: an ellipsis standing
      // in for a single number is wider than the number it replaced, and it
      // costs the reader a click to discover there was nothing behind it.
      if (p - previous === 2) out.push(previous + 1);
      else if (p - previous > 2) out.push(null);
    }
    out.push(p);
    previous = p;
  }
  return out;
}

/**
 * Whether the header checkbox is off, indeterminate, or on.
 *
 * Measured against the rows ON SCREEN, not the whole roster. "Select all" on a
 * paged table means the page — claiming to have selected 380 rows when 15 are
 * visible is how somebody suspends an organisation by accident.
 */
export function selectionState(selected, visibleIds) {
  const ids = visibleIds ?? [];
  if (ids.length === 0) return "none";
  let hit = 0;
  for (const id of ids) if (selected?.has(id)) hit++;
  if (hit === 0) return "none";
  return hit === ids.length ? "all" : "some";
}

/** Toggle one id, returning a NEW Set — never mutating the one in state. */
export function toggleSelected(selected, id) {
  const next = new Set(selected ?? []);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Select or clear every visible row, leaving off-screen selections alone. */
export function toggleAllVisible(selected, visibleIds) {
  const next = new Set(selected ?? []);
  const ids = visibleIds ?? [];
  if (selectionState(next, ids) === "all") for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  return next;
}

/**
 * Drop selections that are no longer on the filtered list.
 *
 * Without this, narrowing the roster and then hitting a bulk action operates
 * on people the administrator can no longer see — the selection outlives the
 * evidence for it.
 */
export function pruneSelection(selected, availableIds) {
  const available = new Set(availableIds ?? []);
  const next = new Set();
  for (const id of selected ?? []) if (available.has(id)) next.add(id);
  return next;
}
