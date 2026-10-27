/**
 * Remembering where somebody was.
 *
 * Two properties carry the weight. A reload must come back to the same screen
 * — that is the whole point — and a storage that throws must cost a tab rather
 * than the app, because these run in useState initialisers above every error
 * boundary.
 *
 * `dash` runs vitest with `environment: 'node'`, so there is no real
 * localStorage or sessionStorage here; each test installs the one it needs.
 * That is a feature, not a workaround — it is the only way to exercise the
 * throwing storage that the try/catch exists for.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  restoreChoice, persistChoice, restoreOverlay, persistOverlay,
} from "./navMemory";

/** A working storage, backed by a plain object the test can read. */
function fakeStore(seed = {}) {
  const map = { ...seed };
  return {
    map,
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
  };
}

/** The Safari-private-browsing case: present, and throws on every access. */
const hostileStore = {
  getItem() { throw new DOMException("denied"); },
  setItem() { throw new DOMException("denied"); },
};

const install = (which, store) => { globalThis[which] = store; };

afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});

describe("restoreChoice", () => {
  it("returns the saved screen, which is the point of the whole module", () => {
    install("localStorage", fakeStore({ "ft-desktop-tab": "drivers" }));
    expect(restoreChoice("ft-desktop-tab", ["fleet", "drivers"], "fleet")).toBe("drivers");
  });

  it("falls back when the stored key is not one this build has", () => {
    // A tab that was renamed or removed between deploys. Reaching a `find`
    // with it returned undefined, and reading .permission off that took the
    // whole app down — above every ErrorBoundary.
    install("localStorage", fakeStore({ "ft-desktop-tab": "users" }));
    expect(restoreChoice("ft-desktop-tab", ["fleet", "drivers"], "fleet")).toBe("fleet");
  });

  it("falls back when nothing has ever been saved", () => {
    install("localStorage", fakeStore());
    expect(restoreChoice("ft-desktop-tab", ["fleet"], "fleet")).toBe("fleet");
  });

  it("falls back rather than throwing when storage refuses to be read", () => {
    install("localStorage", hostileStore);
    expect(() => restoreChoice("ft-desktop-tab", ["fleet"], "fleet")).not.toThrow();
    expect(restoreChoice("ft-desktop-tab", ["fleet"], "fleet")).toBe("fleet");
  });
});

describe("persistChoice", () => {
  it("writes the choice so the next load can find it", () => {
    const store = fakeStore();
    install("localStorage", store);
    persistChoice("ft-sensor-tab", "malfunction");
    expect(store.map["ft-sensor-tab"]).toBe("malfunction");
    expect(restoreChoice("ft-sensor-tab", ["probes", "malfunction"], "probes"))
      .toBe("malfunction");
  });

  it("does not throw when storage refuses to hold it", () => {
    install("localStorage", hostileStore);
    expect(() => persistChoice("ft-sensor-tab", "probes")).not.toThrow();
  });
});

describe("restoreOverlay / persistOverlay", () => {
  it("brings an open page back, which is the reported bug", () => {
    const store = fakeStore();
    install("sessionStorage", store);
    persistOverlay("ft-user-admin-open", true);
    expect(restoreOverlay("ft-user-admin-open")).toBe(true);
  });

  /**
   * The bug a naive fix introduces. Writing only on open leaves a "1" nothing
   * ever clears, and the page reopens on every reload for the rest of the
   * session — worse than never remembering it at all, because there is then no
   * way to get off it.
   */
  it("forgets a page that was closed", () => {
    const store = fakeStore();
    install("sessionStorage", store);
    persistOverlay("ft-account-open", true);
    persistOverlay("ft-account-open", false);
    expect(restoreOverlay("ft-account-open")).toBe(false);
  });

  it("reads closed for a tab that has never opened it", () => {
    install("sessionStorage", fakeStore());
    expect(restoreOverlay("ft-account-open")).toBe(false);
  });

  /**
   * The lifetime that makes this safe to turn on at all. These live in
   * sessionStorage, so a brand-new tab — tomorrow's cold start — sees nothing,
   * and "coming back tomorrow lands on the fleet, not on your own settings"
   * still holds. A localStorage value written by some other tab must not be
   * what answers.
   */
  it("does not read a durable value left in localStorage", () => {
    install("localStorage", fakeStore({ "ft-account-open": "1" }));
    install("sessionStorage", fakeStore());
    expect(restoreOverlay("ft-account-open")).toBe(false);
  });

  it("reads closed rather than throwing when storage refuses to be read", () => {
    install("sessionStorage", hostileStore);
    expect(() => restoreOverlay("ft-account-open")).not.toThrow();
    expect(restoreOverlay("ft-account-open")).toBe(false);
  });

  it("does not throw when storage refuses to hold it", () => {
    install("sessionStorage", hostileStore);
    expect(() => persistOverlay("ft-account-open", true)).not.toThrow();
  });
});
