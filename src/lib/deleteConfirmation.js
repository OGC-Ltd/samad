/**
 * The typed confirmation that arms a permanent delete.
 *
 * ## Why there is a phrase at all
 *
 * Every other control on the roster is a change you can make twice. This one
 * destroys a row, so it asks for something a misplaced click cannot produce.
 *
 * ## Why it is the EMAIL
 *
 * It identifies the account: it is what they sign in with, it is unique across
 * the whole platform, and it is printed under every name in the table. Two
 * colleagues can share a display name; they cannot share an address. The full
 * name is the fallback for accounts that have none — those are the ones a
 * mistake would be least visible on, so they get a phrase rather than a bare
 * "yes".
 *
 * ## Why the match is loose, and why that is not a weakened guard
 *
 * The first cut compared the trimmed strings exactly, which made the control
 * read as broken: an administrator typing a colleague's address the way they
 * write it — `Analyst-2@OGC-Monitoring.com` — got a dead button and nothing on
 * screen saying why. That is not a safety property, it is a typing test, and
 * the two are easy to confuse.
 *
 * The guard is "prove you know WHICH account this is". Case does not carry
 * that: the local part of an address is case-sensitive by RFC 5321 and case-
 * insensitive at every mail provider anybody here uses, and no two accounts in
 * this system differ only in case — `email` is `@unique` on a column the
 * server lower-cases on the way in. Neither does the amount of whitespace
 * between words in a name. So both are normalised away, and what is still
 * required is the whole address, spelled correctly, in full.
 */

/** The string an administrator has to reproduce for this person. */
export function confirmPhraseFor(user) {
  return String(user?.email ?? user?.fullName ?? "").trim();
}

/** Ends trimmed, inner runs of whitespace collapsed, case dropped. */
const normalise = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Does what was typed name this account?
 *
 * An empty phrase never matches. That case means a person with neither an
 * email nor a name, which the roster should not be able to produce — but if it
 * ever did, an empty box must not arm the button.
 */
export function confirmMatches(typed, phrase) {
  const wanted = normalise(phrase);
  if (!wanted) return false;
  return normalise(typed) === wanted;
}

/**
 * What to tell the reader about the box, right now.
 *
 * A disabled button beside a filled-in field, with nothing saying why, is the
 * failure this returns the fix for — it reads as a broken control rather than
 * as one waiting for something. Three states, and the middle one is the whole
 * point: "keep going" is different from "wrong".
 *
 * @returns {'empty'|'partial'|'match'}
 */
export function confirmState(typed, phrase) {
  if (confirmMatches(typed, phrase)) return "match";
  if (!String(typed ?? "").trim()) return "empty";
  return "partial";
}

/* ─────────────────────── who has to type it out ─────────────────────────── */

/**
 * The permissions the organisation's `admin` role carries over the user table.
 *
 * All four together, because the point is to recognise an ADMINISTRATOR rather
 * than anybody who happens to hold the delete bit. The roles table lets an
 * operator add roles by hand — the picker deliberately offers whatever the
 * table holds — so a role granting `user:delete` alone is a thing that can
 * exist, and it is not the role this bypass is for.
 */
export const ADMIN_USER_PERMISSIONS = [
  "user:create", "user:update", "user:delete", "user:assign_role",
];

/**
 * May this account delete without typing the address out?
 *
 * Yes for a platform administrator, and yes for an organisation's System
 * Administrator. Those are the two the operator named, and between them they
 * are almost everybody who can reach this control: `user:delete` is held by
 * exactly those two roles in the catalogue, so in practice the typed step is
 * now the exception rather than the rule.
 *
 * It is kept rather than deleted because it is not unreachable. A role assembled
 * by hand in the roles table — which this product supports and the picker
 * deliberately surfaces — can carry `user:delete` without the rest of the user
 * administration set, and whoever holds that is not the person this bypass was
 * written for.
 *
 * What is NOT weakened by any of this: the delete is still two deliberate
 * clicks with a paragraph between them saying the row leaves storage, and the
 * server still refuses to destroy you, a guest of this organisation, or anybody
 * carrying operations history. Those are the guards that hold when a hand is
 * moving faster than a head, and the typed address never was.
 */
export function skipsTypedConfirmation({ isPlatform, can }) {
  if (isPlatform) return true;
  if (typeof can !== "function") return false;
  return ADMIN_USER_PERMISSIONS.every((slug) => can(slug));
}
