// A request for the Alerts page to show one list, from outside it (a pop-up's
// Open, components/shared/ToastStack). The page may not be mounted yet when
// Open is pressed, so the request waits here until the page takes it.

let pending = null;
const listeners = new Set();

/** @param {{ kind: string, alarm?: string }} view */
export function requestAlertsView(view) {
  pending = { kind: view?.kind ?? 'all', alarm: view?.alarm ?? '', at: Date.now() };
  for (const l of listeners) l();
}

/** The waiting request, handed over once. */
export function takeAlertsRequest() {
  const r = pending;
  pending = null;
  return r;
}

export function onAlertsRequest(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}
