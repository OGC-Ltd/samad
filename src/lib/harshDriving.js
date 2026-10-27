// Harsh acceleration and harsh braking on the vehicle panel's Safety tab
// (operator, 2026-10-21: "they need to be under warning and captured and also
// listed under safety"). The server records each one the tracker reports as a
// warning alert (fleet-server harsh-driving.worker); here they are read back
// out of the unit's feed for the day.

/** The alert types the server writes, and what each is called. */
export const HARSH_WORD = {
  HARSH_ACCELERATION: "Harsh acceleration",
  HARSH_BRAKING: "Harsh braking",
};
export const HARSH_TYPES = Object.keys(HARSH_WORD);

/**
 * The day's events, newest first, from feed items of any source (the stored
 * day and the live feed together): one per id, this unit's only.
 *
 * `where` is the sentence after the unit's name — "at FARM#212 38 km/h" — and
 * `force` the m/s² the tracker gave, both as the server wrote them.
 */
export function harshEvents(items, vehicleId) {
  const seen = new Set();
  const out = [];
  for (const it of items ?? []) {
    if (!HARSH_WORD[it?.alertType] || seen.has(it.id)) continue;
    if (vehicleId && it.vehicleId && it.vehicleId !== vehicleId) continue;
    const t = Date.parse(it.ts);
    if (!Number.isFinite(t)) continue;
    seen.add(it.id);
    // "Harsh braking — FT 13 at FARM#212 38 km/h (3.1 m/s²)"
    let rest = String(it.text ?? "").replace(/^[^—]*—\s*/, "");
    if (it.plate && rest.startsWith(it.plate)) rest = rest.slice(it.plate.length);
    const force = /\(([\d.]+)\s*m\/s²\)/.exec(rest);
    rest = rest.replace(/\s*\([\d.]+\s*m\/s²\)/, "").trim();
    out.push({
      id: it.id,
      t,
      type: it.alertType,
      title: HARSH_WORD[it.alertType],
      where: rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : null,
      force: force ? Number(force[1]) : null,
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

/** "2 harsh brakes · 1 harsh acceleration", or null for none. */
export function harshCountWords(events) {
  const n = (type) => events.filter((e) => e.type === type).length;
  const brakes = n("HARSH_BRAKING");
  const accels = n("HARSH_ACCELERATION");
  const parts = [];
  if (brakes) parts.push(`${brakes} harsh brake${brakes === 1 ? "" : "s"}`);
  if (accels) parts.push(`${accels} harsh acceleration${accels === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : null;
}
