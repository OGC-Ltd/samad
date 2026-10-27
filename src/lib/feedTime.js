// Feed item timestamps — formatted from the event's ISO `ts` in the BROWSER's
// timezone. The server-rendered `time` string is minted with getHours() on the
// server, so a deployment in UTC stamps every event 3 h behind Nairobi wall
// time; it survives only as the fallback for old buffered items without `ts`.

function parse(item) {
  if (!item?.ts) return null;
  const d = new Date(item.ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");

/** "14:22" — the event's wall clock. */
export function feedClock(item) {
  const d = parse(item);
  if (d) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return item?.time ?? "";
}

/**
 * "03 Aug" — the event's DATE.
 *
 * The feed carries a hundred items of replayed history per vehicle and the
 * fleet stream runs for days, so a column of bare clock times says "01:50"
 * without saying which night. Returns "" for a legacy item with no parseable
 * `ts`, which is the only case where the date genuinely is not known.
 */
export function feedDate(item) {
  const d = parse(item);
  if (!d) return "";
  return `${pad(d.getDate())} ${d.toLocaleDateString(undefined, { month: "short" })}`;
}

/** "03 Aug 14:22" — both, for one-line contexts like the share message. */
export function feedStamp(item) {
  const date = feedDate(item);
  const clock = feedClock(item);
  return date ? `${date} ${clock}` : clock;
}
