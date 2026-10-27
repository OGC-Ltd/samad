// How fresh a unit's last fix is, in the two forms a list needs: a tier for
// the glyph and a label for the reader.
//
// ## Why this is not darkAgeLabel
//
// vehicleMap's darkAgeLabel exists to caption a marker the map has already
// decided is DARK — a unit silent for a day or more — so it starts at hours
// and never says anything smaller. Ask it about a unit that reported ninety
// seconds ago and it answers "0h", which reads as a fault rather than as the
// freshest possible answer.
//
// A recency column has the opposite problem: most rows in it are fresh, and
// the interesting distinction is between "this second" and "twenty minutes
// ago". So this counts from the other end.
//
// ## Three tiers, and where the boundaries come from
//
// Neither boundary is invented here:
//
//   live     under 15 minutes. The window the fleet's own connection logic
//            treats as current, and roughly three telemetry cycles — a unit
//            quiet that long is quiet by accident, not by design.
//   delayed  under DARK_AFTER_MS (24 h), vehicleMap's own line for "the map
//            should stop asserting this is live".
//   dark     past it, or no timestamp at all.
//
// The tier drives a glyph; the label always states the actual age beside it.
// A colour on its own would be asking the reader to remember a legend, and a
// label on its own reads as a number with no verdict attached.

import { DARK_AFTER_MS } from "./vehicleMap";

export const LIVE_WITHIN_MS = 15 * 60_000;

/** ms since this vehicle's last fix, or null if it carries no timestamp. */
export function fixAgeMs(vehicle, now = Date.now()) {
  const ms = vehicle?.capturedAtMs
    ?? (vehicle?.capturedAt ? Date.parse(vehicle.capturedAt) : null);
  if (!Number.isFinite(ms)) return null;
  // A fix stamped in the future is a clock disagreement, not a fresh fix.
  // Clamped to 0 so it reads as "now" rather than as a negative age.
  return Math.max(0, now - ms);
}

/** @returns {"live"|"delayed"|"dark"|"unknown"} */
export function fixRecencyTier(vehicle, now = Date.now()) {
  const age = fixAgeMs(vehicle, now);
  if (age == null) return "unknown";
  if (age < LIVE_WITHIN_MS) return "live";
  if (age < DARK_AFTER_MS)  return "delayed";
  return "dark";
}

/**
 * The age, in the shortest form that is still true.
 *
 * Rounds DOWN throughout. A fix 119 seconds old is "1m", never "2m": the
 * reader is deciding whether to trust a position, and a recency claim that
 * overstates the wait is the one direction that cannot be allowed.
 */
export function fixAgeLabel(vehicle, now = Date.now()) {
  const age = fixAgeMs(vehicle, now);
  if (age == null) return "-";
  const mins = Math.floor(age / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`;
}

/** The full sentence, for assistive tech — the glyph alone cannot say this. */
export const RECENCY_LABEL = {
  live:    "Reported in the last 15 minutes",
  delayed: "Last reported over 15 minutes ago",
  dark:    "Silent for over a day",
  unknown: "No fix timestamp",
};
