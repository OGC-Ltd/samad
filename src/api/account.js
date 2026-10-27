/**
 * Self-service account calls — the app's first mutations.
 *
 * Every other module under src/api/ is a read. These follow the same
 * conventions anyway: one exported async function per endpoint, `res.data`
 * unwrapped here so callers never see the envelope, and ApiError left to
 * propagate so the form can read `err.body.errors` through lib/formErrors.
 *
 * Note the paths are /api/v1/account/*, NOT /api/v1/auth/*. services/api.js
 * excludes /api/v1/auth/ from the 401 refresh-and-replay, so an account call
 * mounted there would hard-fail on an access token that aged out while the
 * dialog was open instead of transparently refreshing.
 */

import { apiFetch, setAccessToken } from "../services/api";

/** Rename yourself. Returns the updated user for the caller to store. */
export async function updateDisplayName(fullName) {
  const res = await apiFetch("/api/v1/account/profile", {
    method: "PATCH",
    body: JSON.stringify({ fullName }),
  });
  return res.data?.user ?? null;
}

/**
 * Change your own password.
 *
 * The server revokes every session — including this one — and immediately
 * mints a replacement for this device. Applying that token here is what keeps
 * the current tab signed in; without it the very next request 401s.
 */
export async function changePassword(currentPassword, newPassword) {
  const res = await apiFetch("/api/v1/account/password", {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (res.data?.accessToken) setAccessToken(res.data.accessToken);
  return res.data;
}

/**
 * Ask for a reset link.
 *
 * Always resolves the same way whatever the address is — the server refuses to
 * say whether an account exists, so there is nothing here to branch on.
 */
export async function requestPasswordReset(email) {
  const res = await apiFetch("/api/v1/account/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return res.data ?? { requested: true };
}

/** What a set-password link is for, before asking for a password. */
export async function verifySetupToken(token) {
  const res = await apiFetch(`/api/v1/account/setup/${encodeURIComponent(token)}`);
  return res.data ?? { valid: false };
}

/** Set the password a link was issued for. Signs the person in on success. */
export async function completeSetup(token, password) {
  const res = await apiFetch("/api/v1/account/setup", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
  if (res.data?.accessToken) setAccessToken(res.data.accessToken);
  return res.data;
}

/** Everything the account page needs about the person, in one call. */
export async function getAccountProfile() {
  const res = await apiFetch("/api/v1/account/profile");
  return res.data ?? null;
}

/** The devices signed in, one row per device rather than per token. */
export async function listSessions() {
  const res = await apiFetch("/api/v1/account/sessions");
  return res.data?.sessions ?? [];
}

/** Sign one device out. */
export async function revokeSession(sessionId) {
  const res = await apiFetch(`/api/v1/account/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  return res.data;
}

/**
 * Sign out everywhere, including here.
 *
 * The server clears the cookies and mints no replacement, so the caller is
 * signed out too — that is the point of the button, and pretending otherwise
 * would make it a lie.
 */
export async function revokeAllSessions() {
  const res = await apiFetch("/api/v1/account/sessions/revoke-all", { method: "POST" });
  return res.data;
}

/**
 * The first-time tour has been shown (lib/productTour). Kept on the account so
 * the next machine this person signs in on does not show it again. Returns the
 * version the account now holds.
 */
export async function recordTourSeen(version) {
  const res = await apiFetch("/api/v1/account/tour", {
    method: "POST",
    body: JSON.stringify({ version }),
  });
  return res.data?.tourSeenVersion ?? null;
}
