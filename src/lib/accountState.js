/**
 * What state is a dashboard account actually in?
 *
 * `status` alone answers only one of the three questions an administrator has,
 * because ACTIVE covers two opposite situations: somebody using the dashboard
 * every day, and somebody who was invited last month, never opened the link,
 * and has never been able to sign in at all. Those look identical in the
 * column the database provides, and telling them apart is the whole reason the
 * roster exists.
 *
 * The roster deliberately never carries a password hash — an admin screen has
 * no business holding one, even in memory — so activation is read from two
 * pieces of evidence the server writes in the SAME TRANSACTION as the hash:
 * the invitation being consumed, and `passwordChangeCount`.
 *
 * ## Why both, and not the invitation alone
 *
 * The invitation alone was the original design, and it was wrong. It assumed
 * "invitation consumed" and "has a password" were the same fact. They are not:
 * a password can also be set from a RESET link, and minting a reset does not
 * touch a live invite — `mintPasswordToken` only revokes tokens of the same
 * purpose. So somebody who gave up on their invite, used "forgot password",
 * set a password and signed in came back to the roster still reading "Pending
 * activation", with a live unconsumed invite sitting behind it.
 *
 * That was not hypothetical and it was not rare — it is what an invited user
 * does when the invite link fails, which is precisely what the setup routes'
 * rate limit was making it do.
 *
 * `passwordChangeCount` is the fact underneath both routes. Every path that
 * stores a hash increments it, so it cannot disagree with the hash, and it is
 * already on the roster payload for the password-age column.
 *
 * The two are OR'd, which can only ever turn "pending" into "active" and never
 * the reverse. That direction is safe by construction: an account that really
 * is pending has never had a password set, so its count is zero.
 *
 * An account with no invitation at all is one that could already sign in
 * without being invited. In this deployment that is the seeded Super Admin,
 * which is exactly why it is treated as Active rather than as unknown.
 *
 * Extracted from UserAdminPanel so it can be tested: `dash` runs vitest with
 * `environment: 'node'` and no jsdom, so a pure function is the only part of
 * this logic that can be pinned by a test.
 */

/** @typedef {{ key: 'active'|'pending'|'suspended'|'expired', label: string }} AccountState */

/**
 * @param {{ status?: string, passwordChangeCount?: number, passwordTokens?: Array<{ consumedAt?: string|null, revokedAt?: string|null, expiresAt?: string|null }> }} user
 * @param {number} [now] epoch ms, injectable so the expiry boundary is testable
 * @returns {AccountState}
 */
export function accountState(user, now = Date.now()) {
  // Suspended outranks everything. Somebody suspended mid-invitation is
  // suspended: that is the fact an administrator has to act on.
  if (user?.status === "SUSPENDED") return { key: "suspended", label: "Suspended" };

  // Has a password, however they came by it — an invitation they consumed, a
  // reset link they used instead, or a change they made since. Checked BEFORE
  // the invitation, because a live invite behind an account that already has a
  // password says nothing about the account; it is a link nobody needs.
  if ((user?.passwordChangeCount ?? 0) > 0) return { key: "active", label: "Active" };

  const invite = user?.passwordTokens?.[0];
  if (!invite || invite.consumedAt) return { key: "active", label: "Active" };

  // Revoked means a NEWER invitation replaced this one. Only the newest token
  // is fetched, so seeing a revoked one here means the newest is revoked —
  // there is no live link and nobody is coming.
  if (invite.revokedAt) return { key: "expired", label: "Invitation replaced" };

  const expiresAt = invite.expiresAt ? new Date(invite.expiresAt).getTime() : null;
  if (expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt < now) {
    return { key: "expired", label: "Invitation expired" };
  }

  return { key: "pending", label: "Pending activation" };
}
