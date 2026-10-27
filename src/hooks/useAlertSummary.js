// The Alerts badge: open alerts this person has not read, over the page's
// default week, across every organisation this account holds. One query
// shared by every badge (sidebar, phone menu), polled each minute; the server
// holds the count a minute too.
// Dropped with every other query on sign-out (AuthContext).

import { useQuery } from "@tanstack/react-query";
import { fetchAlertSummary } from "../api/alerts";

export const ALERT_SUMMARY_KEY = ["alerts", "summary"];

export function useAlertSummary(enabled = true) {
  const { data } = useQuery({
    queryKey: ALERT_SUMMARY_KEY,
    queryFn: fetchAlertSummary,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  return data ?? null;
}

/** "99+" past two digits: a badge is a prompt, not a ledger. */
export const badgeText = (n) => (n > 99 ? "99+" : String(n));
