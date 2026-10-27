// A new fuel theft alert shakes the Alerts button in red (operator,
// 2026-10-13: "each time we have a fuel theft case let the alerts button
// shake in red") until the Alerts page is opened.
//
// "New" is read off the badge's own count (useAlertSummary `fuel`: open fuel
// alerts this person has not read, every organisation they hold): it rose
// since this person last saw it. The last count seen is kept per account in
// the browser, so a theft that arrived while the app was closed still rings
// once on the next visit; the first visit ever only sets the mark. Reading or
// deciding alerts lowers the count, so the next theft rises above it again.
//
// One alarm for the page, shared by every Alerts button (sidebar, icon rail,
// phone header), so two buttons noting the same count ring once, together.

import { useEffect, useSyncExternalStore } from "react";
import { useAuth } from "../context/AuthContext";

const keyOf = (userId) => `ft-alerts-fuel-seen:${userId}`;
const seenHere = new Map(); // userId -> count, when storage is unavailable

let ringing = false;
const listeners = new Set();
function setRinging(v) {
  if (ringing === v) return;
  ringing = v;
  for (const fn of listeners) fn();
}

function lastSeen(userId) {
  try {
    const v = localStorage.getItem(keyOf(userId));
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  } catch { /* private window: this tab's memory only */ }
  return seenHere.get(userId) ?? null;
}

function keepSeen(userId, n) {
  seenHere.set(userId, n);
  try { localStorage.setItem(keyOf(userId), String(n)); } catch { /* as above */ }
}

/** The badge's fuel count, as it arrives: rings when it rose. */
export function noteFuelCount(userId, n) {
  if (!userId || !Number.isFinite(n)) return;
  const seen = lastSeen(userId);
  if (seen != null && n > seen) setRinging(true);
  keepSeen(userId, n);
}

/** The Alerts page is open: the alarm has been heard. */
export function hushFuelAlarm() {
  setRinging(false);
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
/** Whether the alarm is ringing now. */
export const isFuelAlarmRinging = () => ringing;

/** True while a new fuel theft alert waits to be looked at. */
export function useFuelAlarm(summary) {
  const { user } = useAuth();
  const userId = user?.id;
  const fuel = summary?.fuel;
  useEffect(() => { noteFuelCount(userId, fuel); }, [userId, fuel]);
  return useSyncExternalStore(subscribe, isFuelAlarmRinging, isFuelAlarmRinging);
}

/** Test seam. */
export function resetFuelAlarm() {
  ringing = false;
  seenHere.clear();
}
