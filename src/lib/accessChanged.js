// This account's access changed: a role, a membership or its status.
//
// The server says so on the live stream (`access_changed`, sent when an
// administrator edits the account), and AuthProvider answers by reading
// /auth/me again, so menus and screens follow the new role at once instead of
// at the next sign-in (operator, 2026-10-27).

export const ACCESS_CHANGED = "ft-access-changed";

export function accessChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ACCESS_CHANGED));
}
