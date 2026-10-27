// Fetch hook with loading/error/retry state, and optional polling — a thin
// layer over TanStack Query (store/queryClient) that keeps the shape every
// card and screen was written against.
//
// Pass options.cacheKey to get stale-while-revalidate across reloads: the last
// successful response is kept in localStorage and seeds the query on mount, so
// a reload paints instantly with last-known data while the fresh request runs.
// Within a session the query cache does the same job for every call, and two
// cards asking for the same cacheKey share one request.
//
// A revalidation failure keeps showing the data already on screen instead of
// an error: `error` is only reported when there is nothing to show.

import { useCallback, useId, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readCache, writeCache } from "../services/cache";

/**
 * @param options.keepPreviousData  On a deps/key change with nothing cached for
 *   the NEW key, keep showing the old key's data instead of blanking to null.
 *
 *   Off by default. The Analytics page turns it on because its filter changes
 *   six keys at once: every card emptied the moment a vehicle type was picked
 *   and stayed empty until the slowest request landed, which read as the page
 *   hanging rather than as it working.
 *
 *   The returned `stale` flag says the visible data belongs to a PREVIOUS
 *   selection. A caller that opts in must show that — figures from the whole
 *   fleet sitting silently under a heading that names one machine family is a
 *   worse failure than the blank was.
 */
export function useApiData(
  fetchFn, deps = [], { cacheKey = null, pollMs = 0, keepPreviousData = false } = {},
) {
  const queryClient = useQueryClient();
  // Without a cacheKey nothing says two calls ask the same question — the
  // fetch functions are anonymous — so each call site keeps its own entry.
  const instance = useId();
  const queryKey = cacheKey ? ["api", cacheKey, ...deps] : ["api", instance, ...deps];

  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const result = (await fetchFnRef.current()) ?? null;
      if (cacheKey && result != null) writeCache(cacheKey, result);
      return result;
    },
    // Last session's answer, marked as old so it is refetched straight away.
    initialData: () => (cacheKey ? readCache(cacheKey) ?? undefined : undefined),
    initialDataUpdatedAt: 0,
    ...(keepPreviousData && { placeholderData: (previous) => previous }),
    // A polled figure is never fresh for long, and a tab coming back from an
    // hour hidden is showing an hour-old number: refresh it on return. (Spread
    // in, not passed as undefined — an explicit undefined would override the
    // client's default freshness window.)
    ...(pollMs > 0 && {
      staleTime: 0,
      refetchInterval: pollMs,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    }),
  });

  // The last data shown, so a keepPreviousData caller still has the old
  // figures after the new key's request FAILS (the query has none to give).
  const shownRef = useRef(null);
  if (query.data !== undefined) shownRef.current = query.data;
  const data = query.data !== undefined ? query.data : (keepPreviousData ? shownRef.current : null);

  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;

  /** Re-ask the same question. Whatever is on screen stays until the answer lands. */
  const retry = useCallback(() => { queryClient.refetchQueries({ queryKey: keyRef.current, exact: true }); }, [queryClient]);

  /**
   * Refresh in place: same request, no spinner, and a failure leaves whatever
   * is on screen alone.
   */
  const revalidate = useCallback(() => {
    queryClient.refetchQueries({ queryKey: keyRef.current, exact: true }).catch((err) => {
      console.warn("[useApiData] refresh failed, keeping last good data:", err);
    });
  }, [queryClient]);

  /**
   * Apply a change the caller already knows the answer to — to the query AND to
   * the localStorage copy, in one step. A row deleted is a row gone from the
   * list; nothing about the server's next answer is needed to know that, and
   * writing the stored copy means a failed refresh afterwards cannot bring the
   * deleted row back on the next reload. Pair it with `revalidate()`.
   */
  const mutate = useCallback((updater) => {
    const next = queryClient.setQueryData(keyRef.current, (current) => (
      typeof updater === "function" ? updater(current ?? null) : updater
    ));
    if (cacheKey && next != null) writeCache(cacheKey, next);
    return next;
  }, [queryClient, cacheKey]);

  const hasData = data != null;
  return {
    data,
    // Nothing to show yet and a request on its way — or, for a caller keeping
    // the previous selection's figures, the new selection still loading.
    loading: (!hasData && query.isFetching) || query.isPending || (query.isPlaceholderData && query.isFetching),
    // A failed refresh under this key's own data stays quiet; a failure with
    // nothing of this key's to show is reported.
    error: query.data !== undefined && !query.isPlaceholderData ? null : (query.error ?? null),
    retry,
    revalidate,
    mutate,
    // True while the figures on screen belong to a previous selection. Once the
    // new selection's request has settled — even by failing — they are no
    // longer "on their way", and `error` is what the caller should show.
    stale: keepPreviousData && query.isPlaceholderData && query.isFetching,
  };
}
