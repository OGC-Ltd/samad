// The one TanStack Query client: every request the app makes to the server
// lives in its cache, keyed by what was asked for.
//
// The defaults match what hooks/useApiData did by hand before it sat on top of
// this: one retry (an error screen after one failed retry, not after three
// backed-off ones), no refetch just because the window took focus (polled
// queries opt back in), and a short freshness window so remounting a card a
// few seconds later reuses the answer instead of asking again.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
