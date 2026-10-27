// A one-shot handoff from the vehicle panel to the Drivers page: "open this
// driver". Kept in sessionStorage so it survives the tab switch (the Drivers
// screen mounts after the click) and is cleared as soon as it's used.
const KEY = 'ft-open-driver';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function requestOpenDriver(name) {
  try { sessionStorage.setItem(KEY, norm(name)); } catch { /* storage off */ }
}

/** The pending driver name (normalised), or null. Does not clear it. */
export function pendingDriver() {
  try { return sessionStorage.getItem(KEY) || null; } catch { return null; }
}

export function clearPendingDriver() {
  try { sessionStorage.removeItem(KEY); } catch { /* storage off */ }
}

export const driverNameMatches = (a, b) => norm(a) === norm(b);
