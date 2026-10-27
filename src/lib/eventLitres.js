/**
 * The volume a playback event moved, in millilitres, from whichever field
 * carries it.
 *
 * `ml` is the number the server was taught to send for exactly this. It is NOT
 * there on every deployment — the field is newer than the events themselves —
 * and against a server without it the pin rendered "?L", which is the worst of
 * the three possible answers: it looks like the fuel figure is unknown when the
 * figure is right there in `detail`.
 *
 * So `detail` is the fallback. Every server formatter writes a volume as
 * "<number> L" WITH the space — "120.0 L · probe saw 118.0 L" — and the space
 * is what this match requires. Without it, a feed line like "KTCC 453L
 * refuelled 120 L" read the plate's "453L" as the volume and the route showed
 * +453L (issue #47). A Kenyan plate never has a space between its digits and
 * its letter, so it can no longer match.
 */
export function eventMl(ev) {
  if (Number.isFinite(ev?.ml)) return ev.ml;
  const m = /(?:^|[^\w.])(\d+(?:\.\d+)?)\s+L\b/.exec(ev?.detail ?? "");
  return m ? Math.round(parseFloat(m[1]) * 1000) : null;
}
