/**
 * The rules behind the sign-in screen's figure.
 *
 * All of these are about the three moments the number is looked at — first
 * render, page refresh, and a tab left idling — because that is where it used
 * to show something other than the current platform-wide sum.
 */

import { describe, it, expect } from "vitest";
import {
  PULSE_TTL_MS, PULSE_MAX_AGE_MS,
  isPulse, pulseAgeMs, isFresh, usablePulse, nextPollDelay, mergePulse,
} from "./fleetPulse";

const NOW = Date.parse("2026-09-14T09:00:00.000Z");

/** A response shaped like the server's, stamped `ageMs` ago. */
const at = (ageMs, over = {}) => ({
  total: 1545,
  inTransit: 60,
  share: 4,
  asOf: new Date(NOW - ageMs).toISOString(),
  ...over,
});

describe("what counts as a pulse", () => {
  it("accepts the server's shape", () => {
    expect(isPulse(at(0))).toBe(true);
  });

  it("rejects one missing the share the card renders", () => {
    // This is the payload that used to get through and print "undefined%".
    const { share, ...withoutShare } = at(0);
    expect(share).toBe(4);
    expect(isPulse(withoutShare)).toBe(false);
  });

  it("rejects a count that is not a number", () => {
    expect(isPulse(at(0, { inTransit: "60" }))).toBe(false);
    expect(isPulse(at(0, { total: null }))).toBe(false);
    expect(isPulse(at(0, { inTransit: NaN }))).toBe(false);
  });

  it("rejects a stamp that cannot be read", () => {
    expect(isPulse(at(0, { asOf: "soon" }))).toBe(false);
    expect(isPulse(at(0, { asOf: 1757840400000 }))).toBe(false);
  });

  it("rejects nothing at all", () => {
    for (const v of [null, undefined, 0, "", [], "nope"]) expect(isPulse(v)).toBe(false);
  });

  it("accepts a genuinely idle platform", () => {
    // Zero in transit is a reading, not a missing value, and it must survive
    // every falsy-check on the way to the screen.
    expect(isPulse(at(0, { inTransit: 0, share: 0 }))).toBe(true);
    expect(usablePulse(at(0, { inTransit: 0, share: 0 }), NOW)).not.toBeNull();
  });
});

describe("a figure kept between page loads", () => {
  it("paints a recent one on first render", () => {
    expect(usablePulse(at(20_000), NOW)).not.toBeNull();
  });

  it("drops one too old to still be true", () => {
    expect(usablePulse(at(PULSE_MAX_AGE_MS + 1), NOW)).toBeNull();
  });

  it("keeps one right on the limit", () => {
    expect(usablePulse(at(PULSE_MAX_AGE_MS), NOW)).not.toBeNull();
  });

  it("drops a blob from an older build rather than painting it", () => {
    expect(usablePulse({ inTransit: 60, total: 1545 }, NOW)).toBeNull();
    expect(usablePulse("null", NOW)).toBeNull();
  });

  it("treats a stamp in the future as fresh, not as ancient", () => {
    // The stamp is the server's clock and the comparison is this device's. A
    // device running slow must not read the future as a large positive age.
    expect(pulseAgeMs(at(-60_000), NOW)).toBeLessThan(0);
    expect(isFresh(at(-60_000), NOW)).toBe(true);
  });
});

describe("when to ask again", () => {
  it("aims at the moment the server lets go of this value", () => {
    // Stamped 10s ago, so the server's own window has 20s left on it.
    const wait = nextPollDelay(at(10_000), NOW);
    expect(wait).toBeGreaterThan(20_000);
    expect(wait).toBeLessThanOrEqual(21_000);
  });

  it("puts two devices that opened apart onto the same instant", () => {
    // The same figure — one `asOf`, because the server's cache handed both
    // devices the identical value — evaluated on two devices that opened 23
    // seconds apart. Both aim at the same recompute, so they pick up the next
    // figure together. A fixed interval counted from page-load left them that
    // same 23 seconds apart indefinitely, which is what made two screens in
    // one room disagree.
    const shared = at(0);
    const openedEarly = NOW + 2_000;
    const openedLate  = NOW + 25_000;
    expect(openedEarly + nextPollDelay(shared, openedEarly))
      .toBe(openedLate + nextPollDelay(shared, openedLate));
  });

  it("does not wait longer than the window itself", () => {
    // A device whose clock is hours behind the server's.
    expect(nextPollDelay(at(-6 * 3_600_000), NOW)).toBe(PULSE_TTL_MS);
  });

  it("does not hammer when the value is already expired", () => {
    expect(nextPollDelay(at(PULSE_TTL_MS + 5_000), NOW)).toBe(1_000);
    expect(nextPollDelay(at(6 * 3_600_000), NOW)).toBe(1_000);
  });

  it("falls back to the plain window after a failed read", () => {
    expect(nextPollDelay(null)).toBe(PULSE_TTL_MS);
  });
});

describe("holding a figure through failure", () => {
  it("takes a fresh answer", () => {
    const next = at(0, { inTransit: 61 });
    expect(mergePulse(at(10_000), next, NOW)).toBe(next);
  });

  it("keeps the last good figure through one failed poll", () => {
    const prev = at(10_000);
    expect(mergePulse(prev, null, NOW)).toBe(prev);
  });

  it("lets it go once failures have run long enough to make it stale", () => {
    // The tab left open overnight against a server that stopped answering.
    // The old rule — only ever replace a number with a number — left last
    // night's traffic on screen presented as live.
    expect(mergePulse(at(PULSE_MAX_AGE_MS + 60_000), null, NOW)).toBeNull();
  });

  it("does not resurrect a stale figure when the answer is malformed", () => {
    expect(mergePulse(at(PULSE_MAX_AGE_MS + 1), { total: 1 }, NOW)).toBeNull();
  });

  it("survives having nothing to start from", () => {
    expect(mergePulse(null, null, NOW)).toBeNull();
  });
});
