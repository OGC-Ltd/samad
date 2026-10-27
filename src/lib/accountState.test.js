import { describe, it, expect } from "vitest";
import { accountState } from "./accountState";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-06T12:00:00Z");

const invited = (over = {}) => ({
  status: "ACTIVE",
  passwordTokens: [{
    consumedAt: null,
    revokedAt: null,
    expiresAt: new Date(NOW + 24 * HOUR).toISOString(),
    ...over,
  }],
});

describe("accountState", () => {
  it("separates the two accounts that both read ACTIVE", () => {
    // The distinction the roster exists to make: one of these people is using
    // the dashboard, the other has never been able to sign in.
    expect(accountState(invited({ consumedAt: new Date(NOW - HOUR).toISOString() }), NOW).key).toBe("active");
    expect(accountState(invited(), NOW).key).toBe("pending");
  });

  it("reports an account with no invitation as active", () => {
    // The seeded Super Admin: a password without an invitation. The only other
    // way into this roster is having been invited, so no token means they can
    // already sign in.
    expect(accountState({ status: "ACTIVE", passwordTokens: [] }, NOW).key).toBe("active");
    expect(accountState({ status: "ACTIVE" }, NOW).key).toBe("active");
  });

  it("lets suspension outrank a pending invitation", () => {
    const state = accountState({ ...invited(), status: "SUSPENDED" }, NOW);
    expect(state.key).toBe("suspended");
  });

  it("calls out an invitation that has run out", () => {
    // Not merely pending: nobody is coming, and no one will be told unless
    // this says so.
    const stale = invited({ expiresAt: new Date(NOW - HOUR).toISOString() });
    expect(accountState(stale, NOW).key).toBe("expired");
  });

  it("treats the expiry moment itself as still live", () => {
    const exact = invited({ expiresAt: new Date(NOW).toISOString() });
    expect(accountState(exact, NOW).key).toBe("pending");
  });

  it("calls a revoked invitation replaced, not expired", () => {
    // Only the newest token is fetched, so a revoked one here means the newest
    // link is dead — a different situation from one that simply aged out.
    expect(accountState(invited({ revokedAt: new Date(NOW).toISOString() }), NOW).label)
      .toBe("Invitation replaced");
  });

  it("consumed beats revoked and expired, they got in", () => {
    const messy = invited({
      consumedAt: new Date(NOW - 2 * HOUR).toISOString(),
      revokedAt: new Date(NOW - HOUR).toISOString(),
      expiresAt: new Date(NOW - HOUR).toISOString(),
    });
    expect(accountState(messy, NOW).key).toBe("active");
  });

  /**
   * The bug that put a real, signed-in account in the pending column.
   *
   * Issac Mwasaha, live on the box: status ACTIVE, a password set that morning,
   * one consumed RESET — and a newest INVITE still unconsumed, unrevoked and
   * in date, because minting a reset does not revoke an invite. The roster
   * looked only at the invite and called him pending activation.
   *
   * It is the ordinary consequence of an invite link that fails: you stop
   * trying it and press "forgot password" instead.
   */
  it("calls an account active when it set a password from a RESET, invite still live", () => {
    const viaReset = { ...invited(), passwordChangeCount: 1 };
    expect(accountState(viaReset, NOW).key).toBe("active");
  });

  it("does not let a password change rescue a SUSPENDED account", () => {
    // Suspension is the fact an administrator has to act on, and it outranks
    // every other piece of evidence in this function.
    const suspended = { ...invited(), status: "SUSPENDED", passwordChangeCount: 3 };
    expect(accountState(suspended, NOW).key).toBe("suspended");
  });

  it("still reports a genuinely pending account as pending", () => {
    // The direction that keeps the new rule safe: somebody who has never set a
    // password has a count of zero by construction, so this can only ever turn
    // pending into active and never the reverse.
    expect(accountState({ ...invited(), passwordChangeCount: 0 }, NOW).key).toBe("pending");
    expect(accountState(invited(), NOW).key).toBe("pending");
  });

  it("beats an expired invitation too, having a password is not undone by one ageing out", () => {
    const stale = { ...invited({ expiresAt: new Date(NOW - HOUR).toISOString() }), passwordChangeCount: 2 };
    expect(accountState(stale, NOW).key).toBe("active");
  });

  it("survives a malformed expiry rather than reporting expired", () => {
    // A date the server never sends, but "unparseable" must not be allowed to
    // read as "this person cannot get in".
    expect(accountState(invited({ expiresAt: "not-a-date" }), NOW).key).toBe("pending");
  });
});
