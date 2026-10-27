/**
 * Contact details, masked for a screen that is usually on display.
 *
 * The roster is the one page in this dashboard that puts a column of real
 * email addresses and real phone numbers of real staff on screen, and it is
 * opened in exactly the places where a screen is not private: a control room
 * with a wall display, a laptop on a shared desk, a screenshot pasted into a
 * ticket. An administrator scrolling to find one person should not broadcast
 * the other thirty-nine.
 *
 * So the columns show enough to RECOGNISE a value you already hold and not
 * enough to harvest one you do not, and the real value is one click away. The
 * mask is display-only: search still matches the full address, the CSV export
 * still carries it, and the profile panel — which you open on purpose, one
 * person at a time — shows it in full.
 *
 * Pure functions in their own module because `new-ui` runs vitest with
 * `environment: 'node'` and no jsdom; this is the part that can be pinned by
 * a test.
 */

/** U+2022. Not an asterisk: asterisks read as a password field, and these are
 *  not secrets being typed — they are facts being withheld. */
const DOT = "\u2022";

/**
 * `operations4@ogc-monitoring.com` → `o\u2022\u2022\u2022@ogc-monitoring.com`.
 *
 * The domain survives, because in a multi-tenant fleet it is the half that
 * tells an admin WHICH organisation an address belongs to — the thing they
 * are scanning the column for — while being a fact they already know. The
 * local part is the half that identifies a person, so it goes.
 *
 * Always three dots, never the true length: a mask that counts the characters
 * it hides hands back the length of what it hid.
 *
 * @param {string|null|undefined} value
 * @returns {string} masked address, or "" when there is nothing to mask
 */
export function maskEmail(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const at = raw.lastIndexOf("@");
  // No "@" at all, or nothing in front of it: not an address this function can
  // reason about, so mask the whole thing rather than guess at its shape.
  if (at < 1) return DOT.repeat(3);

  return raw[0] + DOT.repeat(3) + raw.slice(at);
}

/**
 * `+254 712 345 678` → `\u2022\u2022\u2022 \u2022\u2022\u2022 678`.
 *
 * The last three digits and nothing else. The country code is deliberately
 * not kept: it is one to three digits depending on the country, and a mask
 * that has to guess where the prefix ends is a mask that sometimes leaks a
 * digit it meant to hide. Three digits is enough to confirm "yes, that is the
 * number I have" and useless for dialling.
 *
 * @param {string|null|undefined} value
 * @returns {string} masked number, or "" when there is nothing to mask
 */
export function maskPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  // Too short to give three digits away and still be a mask.
  if (digits.length <= 4) return `${DOT.repeat(3)} ${DOT.repeat(3)}`;
  return `${DOT.repeat(3)} ${DOT.repeat(3)} ${digits.slice(-3)}`;
}
