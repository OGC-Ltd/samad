// One pager for every table in the app: Prev · Page n of N · a–b of N · Next
// (operator, 2026-10-12: "the pagination should be consistent across all
// pages"). Fifteen rows a page unless a table says otherwise.
//
// The Drivers roster's and the Weighbridges grid's pager (operator, 2026-10-03:
// "add pagination for probes, fuel FSL, speed, malfunctions and repair"), so
// every list on these pages turns the same way. Paging is an in-memory slice
// of the rows the table already holds — exports still take every row.

import { useEffect, useState } from "react";
// The pager's styles live with the Sensor Monitor's; imported here so a
// screen outside it (User accounts, the halted-units window) gets them too.
import "./SensorPanel.scss";

/** Rows to a page, the roster's step. */
export const PAGE_STEP = 15;

/**
 * Slice `rows` into pages.
 *
 * `resetKey` is whatever makes it a NEW list (a filter, a search, a day): when
 * it changes the pager goes back to page one. A list that merely shrinks under
 * the reader — a live refresh, a sign-off — keeps its place, clamped to the
 * last page that still exists.
 */
export function usePager(rows, resetKey, step = PAGE_STEP) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [resetKey]);
  const total = rows?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / step));
  const at = Math.min(page, pageCount - 1);
  const start = at * step;
  return {
    pageRows: (rows ?? []).slice(start, start + step),
    page: at,
    pageCount,
    total,
    from: total ? start + 1 : 0,
    to: Math.min(start + step, total),
    setPage,
  };
}

/**
 * For rows the server sends a batch at a time: the whole reads "of 50+" while
 * there are more to read. The caller reads the next batch when its last page
 * is reached, so Next goes on working; there is no "Load more" button.
 */
export const withMore = (pager, more) => (more ? { ...pager, total: `${pager.total}+` } : pager);

/** The bar. Renders nothing when everything fits on one page. */
export default function TablePager({ pager, label = "Table pages" }) {
  const { page, pageCount, total, from, to, setPage } = pager;
  if (pageCount <= 1) return null;
  return (
    <nav data-tour="page-pager" className="sp4-tpager" aria-label={label}>
      <button type="button" className="sp4-tpager__btn"
              disabled={page === 0} onClick={() => setPage(Math.max(0, page - 1))}>
        ← Prev
      </button>
      <span className="sp4-tpager__info" aria-live="polite">
        Page {page + 1} of {pageCount}
        <span className="sp4-tpager__range"> · {from}–{to} of {total}</span>
      </span>
      <button type="button" className="sp4-tpager__btn"
              disabled={page >= pageCount - 1} onClick={() => setPage(Math.min(pageCount - 1, page + 1))}>
        Next →
      </button>
    </nav>
  );
}
