/**
 * Names as they should be read, not as they arrive.
 *
 * Two feeds into this app shout. The weighbridge provider sends centre names
 * in capitals -- "OPAPO", "NAITIRI", "WESTERN MILL" -- and of the nine site
 * surveys the map draws, Molo's was traced in them too ("MOLO RIVER"). Both
 * end up in the same places: a 260px sidebar rail, and a hover card the width
 * of a few words. Capitals at a matched font size do not read as a matched
 * size; they read as the loudest thing on the panel.
 *
 * Its own module because it is not about weighbridges and not about site
 * plans -- it is about the difference between what a record stores and what a
 * person should be shown, and both of those callers needed it.
 */

/**
 * A place's name, spoken rather than shouted.
 *
 * The provider sends these in capitals — "OPAPO", "NAITIRI", "WESTERN MILL".
 * That is right on the Weighbridges screen, where the name is a column heading
 * over its own figures, and it is what a ticket and a CSV have to match. In the
 * sidebar it is wrong: the scales sit in a 260px rail directly under rows
 * reading "Show on the map" and "Stopped in transit", at the SAME 12.5px, and
 * capitals at a matched size do not read as a matched size. They read as the
 * loudest thing in the panel.
 *
 * Display only. `buildBoard` keeps the provider's spelling untouched, which is
 * why its tests still assert "WESTERN MILL".
 *
 * A word is only lowered when it is entirely capitals, so a name that already
 * arrives in mixed case is left exactly as it came. Digits are never inside a
 * match, so a bridge number or a code beside the name survives whole.
 */
export function spokenSiteName(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[A-Za-z][A-Za-z'’]*/g, (w) => (
    w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w
  ));
}
