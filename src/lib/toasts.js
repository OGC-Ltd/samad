// The pop-up queue. Last in, first out, as raitrack's: the newest card sits
// in front and is the only one drawn; the rest wait behind it and the next
// newest comes forward when the front one is closed.
//
// Unlike raitrack, a Samad card stays until someone closes it (operator,
// 2026-11-23: "they stay there until one closes them"): there is no timer.
// So the stack says how many wait behind the front one, and can close them
// all at once (components/shared/ToastStack).
//
// The server makes every card (server/popups.go) and sends it down the live
// stream (hooks/useFleetLive, `toast` frames); this only queues them.
// Pure: no React, no network, no timers.

/** Beyond this many behind the front, the oldest are dropped: the Alerts page lists them all anyway. */
export const MAX_BEHIND = 30;
/** Ids already seen, so a stream replay or a second frame does not show one twice. */
const SEEN_MAX = 500;

let entries = [];          // oldest first, the front last
const seen = new Set();
let snapshot = { front: null, behind: 0 };
const listeners = new Set();

function emit() {
  snapshot = { front: entries[entries.length - 1] ?? null, behind: Math.max(0, entries.length - 1) };
  for (const l of listeners) l();
}

/** Queue a card from the server, in front of the rest. Returns false when it was seen already. */
export function addToast(toast) {
  if (!toast?.id || seen.has(toast.id)) return false;
  seen.add(toast.id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  entries.push(toast);
  const over = entries.length - 1 - MAX_BEHIND;
  if (over > 0) entries.splice(0, over);
  emit();
  return true;
}

/** Close one card; the next newest comes forward. */
export function dismissToast(id) {
  const i = entries.findIndex((t) => t.id === id);
  if (i < 0) return;
  entries.splice(i, 1);
  emit();
}

/** Close every card. */
export function dismissAllToasts() {
  if (!entries.length) return;
  entries = [];
  emit();
}

export const toastsSnapshot = () => snapshot;
export function subscribeToasts(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** For tests: forget everything. */
export function resetToasts() {
  entries = [];
  seen.clear();
  emit();
}
