// The toast queue. Last in, first out (operator, 12 Nov 2026): the newest
// toast sits in front and is the only one drawn; the rest wait behind it,
// unseen, and the next newest comes forward when the front one is closed or
// runs out. Nothing shows that others are waiting.
//
// Taken from raitrack (2026-11-23). The server makes every toast
// (server/popups.go) and sends it down the live stream (hooks/useFleetLive,
// `toast` frames); this only queues and times them. Only the front toast's clock runs: it leaves LIFE_MS after it
// came forward, and one pushed back by a newer toast gets its full LIFE_MS
// again when it returns. While a pointer rests on the toast the clock stands
// still, so Copy or Open can be reached.
//
// Pure apart from timers: no React, no network.

export const LIFE_MS = 8_000;
/** Beyond this many behind the front, the oldest are dropped: a flood is not worth replaying. */
export const MAX_BEHIND = 30;
/** Ids already seen, so a stream replay or a second frame does not show one twice. */
const SEEN_MAX = 500;

let entries = [];          // oldest first, the front last: { toast, left, startedAt, timer }
let paused = false;
const seen = new Set();
let snapshot = { front: null, behind: 0 };
const listeners = new Set();

const frontEntry = () => entries[entries.length - 1] ?? null;

function emit() {
  snapshot = { front: frontEntry()?.toast ?? null, behind: Math.max(0, entries.length - 1) };
  for (const l of listeners) l();
}

function stop(e) {
  clearTimeout(e.timer);
  e.timer = null;
}

/** Run the front toast's clock, if it is not running and nothing holds it. */
function runFront() {
  const e = frontEntry();
  if (!e || e.timer || paused) return;
  e.startedAt = Date.now();
  e.timer = setTimeout(() => dismissToast(e.toast.id), e.left);
}

/** Queue a toast from the server, in front of the rest. Returns false when it was seen already. */
export function addToast(toast) {
  if (!toast?.id || seen.has(toast.id)) return false;
  seen.add(toast.id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  const prev = frontEntry();
  if (prev) { stop(prev); prev.left = LIFE_MS; }
  entries.push({ toast, left: LIFE_MS, startedAt: null, timer: null });
  const over = entries.length - 1 - MAX_BEHIND;
  if (over > 0) entries.splice(0, over);
  runFront();
  emit();
  return true;
}

export function dismissToast(id) {
  const i = entries.findIndex((e) => e.toast.id === id);
  if (i < 0) return;
  stop(entries[i]);
  entries.splice(i, 1);
  runFront();
  emit();
}

/** Hold the front toast's clock (pointer on it), or let it run again. */
export function pauseToasts(on) {
  if (on === paused) return;
  paused = on;
  const e = frontEntry();
  if (on) {
    if (!e?.timer) return;
    stop(e);
    e.left = Math.max(400, e.left - (Date.now() - e.startedAt));
  } else {
    runFront();
  }
}

export const toastsSnapshot = () => snapshot;
export function subscribeToasts(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** For tests: forget everything. */
export function resetToasts() {
  for (const e of entries) clearTimeout(e.timer);
  entries = [];
  paused = false;
  seen.clear();
  emit();
}
