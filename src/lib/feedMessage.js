/**
 * Live Feed sentences, read for presentation.
 *
 * Every line in the feed is composed server-side (fleet-server: feed-events,
 * zone-presence, yard-departure, fuel-adjudication, probe health) and stored
 * as it was written, so the panel is reading text that is months old as well
 * as text from thirty seconds ago. This module is what stands between that
 * text and the screen.
 *
 * ## The noise, and the grammar
 *
 * FOUR KINDS OF NOISE, all of them visible on the Kasulu feed on 2026-09-14:
 *
 *  1. THE ACCOUNT PREFIX. Units are named in the provider's account, and the
 *     account puts the customer's name in front of the unit: "MUFINDI: FTT 02",
 *     "MUFINDI - FTT 13", "TR - RAIMDF - TRACTOR 02". It is the same customer
 *     on every row of a panel that is already scoped to one organisation, and
 *     it is punctuated two different ways in the same minute. Dropped.
 *
 *  2. THE SEVERITY WORD. "ALERT:", "CRITICAL:", "RESTRICTED:", "FUEL RATE:" —
 *     these are labels wearing a sentence's clothes. They come out as a badge
 *     and the sentence starts at its subject.
 *
 *  3. PLACEHOLDERS. `feed-events` falls back to the literal word "destination"
 *     when a leg has no named end, and "Unassigned" when no driver is on the
 *     unit, so the feed says "detected at 95 km/h en route to destination" and
 *     "LMV 10 · Unassigned". Neither phrase carries information; both are cut.
 *
 *  4. SHOUTING. Driver and place names arrive from the dispatch system in
 *     capitals — "JACOB OTIENO OREGE", "PAP NDEGE" — beside names from the
 *     fleet tables that are not. Title-cased so one row does not read as
 *     louder than the next.
 *
 * AND THE GRAMMAR, which is the larger half. The emitters are written in a
 * telegraphic register: an em dash carries the second half of most sentences
 * ("arrived at Nursery A — inside FARM #215", "FTT 02 entered DRAINS1 — a
 * keep-out zone"), and several clauses are not sentences at all ("Tank now
 * 340.4 L.", "Needs a workshop visit.", "Speed limit 80 km/h."). Asked for
 * 2026-09-14: a notification is a written record and reads as one, so none of
 * those shapes reaches the panel. SENTENCE_RULES below rewrites each of them,
 * and DASH_GUARD catches anything a new emitter invents.
 *
 * ## What it still will not do
 *
 * It will not invent a fact, drop one, or round a number. Every rule is a
 * deletion of something that said nothing, a capitalisation, a move into the
 * badge, or a re-joining of clauses the server had already written — the same
 * facts, in a sentence. The text it is handed is also what the PDF reports and
 * the push notifications carry, so a formatter that paraphrased would put two
 * different accounts of one event on the record.
 */

/**
 * The words that are labels, not sentence openings.
 *
 * A closed set on purpose. The account prefix (noise 1) has exactly the same
 * shape — capitals, then a colon — so anything not listed here is treated as
 * an account name and dropped; a severity word that went missing from this
 * list would be deleted rather than promoted. Kept in step with the server's
 * headline prefixes: feed-events (ALERT / CRITICAL), zone-presence
 * (RESTRICTED) and fuel-adjudication (POSSIBLE THEFT / FUEL DOWN / FUEL RATE),
 * plus fuel-probe-health (FUEL PROBE).
 */
export const FEED_BADGES = [
  "POSSIBLE THEFT",
  "CRITICAL",
  "RESTRICTED",
  "FUEL PROBE",
  "FUEL DOWN",
  "FUEL RATE",
  "ALERT",
];

/**
 * Words that must never be read as an account name.
 *
 * The guard on the paragraph above: a severity headline this build has not
 * heard of still looks exactly like "MUFINDI:" to the stripper. Listing the
 * vocabulary those headlines are built from means an unknown one survives in
 * the sentence — plain rather than badged, which is the harmless failure —
 * instead of being silently deleted.
 */
const NEVER_AN_ACCOUNT = new Set([
  "ALERT", "CRITICAL", "RESTRICTED", "POSSIBLE", "THEFT", "SIPHON",
  "FUEL", "PROBE", "RATE", "DOWN", "DRAIN", "WARNING", "URGENT", "NOTICE",
  "OVERDUE", "DANGER", "BREACH", "IDLE", "SPEEDING", "MAINTENANCE", "SERVICE",
]);

const badgeRe = new RegExp(`^(${FEED_BADGES.join("|")}):\\s*`);

/**
 * "MUFINDI: ", "MUFINDI - ", "TR - RAIMDF - ".
 *
 * Up to three capitalised tokens, each closed by a colon or a HYPHEN — never
 * an em dash, which is the punctuation the sentences themselves use ("KCP 136P
 * — has never reported a fuel level"). Digits are excluded from the token so a
 * plate can never be mistaken for an account, and the lookahead keeps the
 * match from eating the unit that follows it.
 */
const accountRe = /^((?:[A-Z][A-Z&.]{1,11}[ \t]*[:-][ \t]*){1,3})(?=[A-Z0-9])/;

/**
 * Two or more adjacent capitalised words — a shouted name.
 *
 * Two, because one is ambiguous and the ambiguous cases are the ones worth
 * leaving alone: "FARM #215", "DRAINS1", "VES 149" and "SOTA" are how the
 * estate's own features and the dispatch system's short destinations are
 * spelled, and they are not shouting. A name has at least a first and a last.
 * Digits anywhere in a word disqualify the run, which is what keeps plates
 * ("KCP 136P") and zone labels out of it.
 */
const shoutRe = /\b[A-Z][A-Z'’]{2,}(?:[ \t]+[A-Z][A-Z'’]{1,})+\b/g;

const titleWord = (w) => w.charAt(0) + w.slice(1).toLowerCase();

/** One shouted run, spoken at a normal volume. */
const deshoutRun = (run) =>
  run.split(/(\s+)/).map((w) => (w.trim() ? titleWord(w) : w)).join("");

/** Every shouted run in a string. */
const deshout = (s) => s.replace(shoutRe, deshoutRun);

/** "A, B, C" → "A, B and C" — a list read aloud rather than punctuated. */
const andList = (list) => {
  const parts = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return list.trim();
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
};

/**
 * The sentences, repaired.
 *
 * One entry per shape the emitters actually produce — every `from` below was
 * matched against text read out of the live notification store, and every
 * `to` says the same thing in a sentence. Order matters: the specific joins
 * run before the general ones, and DASH_GUARD runs after all of them.
 *
 * The rule to follow when adding to this list: the replacement may move a
 * clause, supply the verb the telegraphic form left out, or re-punctuate. It
 * may not add a fact that was not in the original or drop one that was.
 */
const SENTENCE_RULES = [
  // ── zone crossings ──────────────────────────────────────────────────────
  // "arrived at Nursery A — inside FARM #215." CUT, not rewritten.
  //
  // It was written out as a relative clause first, and the clause is what
  // showed how little it was worth: the estate's features nest, so the larger
  // one is frequently a restatement of the smaller — "arrived at Sukari
  // Indurstries Factory, which is inside Sukari industries" is the same place
  // named twice, and the sentence is longer for it. The crossing is the event;
  // what contains the place it crossed into is a question for the map, which
  // is drawing all of it. Asked for 2026-09-14.
  //
  // Terminated on what the emitter puts AFTER the list rather than on the next
  // comma or full stop: the list itself is comma-joined, the nearest sample
  // point follows it, and that point's distance is written "(0.4 km)".
  [/ — inside .+?(?= \(also entered |, near |\.$)/, ""],
  // "left Nursery A — now in FARM #215." Two things happened to one subject.
  [/ — now in (.+)\.$/, " and is now in $1."],
  // "entered DRAINS1 — a keep-out zone." An apposition, and a compound
  // adjective an operator does not need: the zone is restricted.
  [/ — an? keep-out zone/g, ", a restricted zone"],
  // The surveyor's own label for a subdivision, spaced-hyphenated in the
  // source data: "Nursery - B". The hyphen is doing nothing a space does not.
  [/([A-Za-z0-9#]) - (?=[A-Za-z0-9#])/g, "$1 "],

  // ── fuel ────────────────────────────────────────────────────────────────
  // "EX 22 — 22.1 L at 60 L/h, above what this machine is measured to burn."
  // The dash stands in for the verb. The event is a measured drop in the tank,
  // which is the one word that covers a burn, a drain and a siphon alike.
  [/^(.+?) — (?=[\d.,]+ L\b)/, "$1 recorded a drop of "],
  [/ L drawn off while parked/g, " L, drawn off while parked"],
  [/ while stationary, nothing driven/g, " while stationary, with nothing driven"],
  // "Tank now 340.4 L." — a label, not a sentence.
  [/\bTank now ([\d.,]+ L)\./g, "The tank now holds $1."],
  // "15th flagged event on this unit in 30 days — 441.9 L in total (before
  // this: 23.1 L, 27.4 L, 27 L)." A fragment, then a dash, then a parenthesis.
  [
    /\b(\d+)(st|nd|rd|th) (flagged event|possible theft) on this unit in (\d+) days — (.+?) in total(?: \(before this: ([^)]+)\))?\./g,
    (_m, n, ord, what, days, total, before) =>
      `This is the ${n}${ord} ${what} on this unit in ${days} days, ${total} in total` +
      (before ? `; the previous drops were ${andList(before)}.` : "."),
  ],
  // "KCC 386Z — sudden fuel level drop detected near Malindi. Possible theft."
  [/ — sudden fuel level drop detected near /g, " recorded a sudden fuel level drop near "],
  [/\bPossible theft\.\s*$/g, "This may be theft."],

  // ── probes ──────────────────────────────────────────────────────────────
  // "TRACTOR 02 — has never reported a fuel level": the dash sits between a
  // subject and its own verb and does nothing at all.
  [/ — (?=(?:has|had|is|was|will|can|does|reported)\b)/g, " "],
  // "KDL 710E — no reading for 5 days (last read 175.4 L on 2026-09-09)."
  [
    / — no reading for (.+?) \(last read (.+?)\)/g,
    " has had no reading for $1, the last being $2",
  ],
  [/\bNeeds a workshop visit\./g, "It needs a workshop visit."],

  // ── the yard, dispatch and sales ────────────────────────────────────────
  [/ — left the premises\./g, " and left the premises."],
  [/ — sales run bound for (.+?) complete\./g, "; the sales run to $1 is complete."],
  [
    / — departure time not observed \(no fix at the gate\)\./g,
    ". The departure time was not observed, because there was no fix at the gate.",
  ],
  [/ is clear of the yard to /g, " is clear of the yard, bound for "],
  [/(\d+) min after sign-out\b/g, "$1 minutes after signing out"],
  // "arrived at the gate from ODIELO — out 10.5 h." The dash is carrying the
  // length of the trip the unit has just finished.
  [/ — out ([\d.]+ (?:h|min))\./g, ", having been out for $1."],

  // ── the dispatch lifecycle (feed-events) ────────────────────────────────
  [/ — hauling to /g, " and is hauling to "],
  [/ — returning to /g, " and is returning to "],
  [/ — scheduled service due\./g, ", where a scheduled service is due."],
  // The telegraphic tails that follow an arrival sentence. Each is the second
  // half of a report written as a label.
  [/\. Loading raw sugarcane\./g, ". It is loading raw sugarcane."],
  [/\. Offloading (.+?)\./g, ". It is offloading $1."],
  [/\. Trip complete\./g, ". The trip is complete."],
  [/\. Driver rest stop before the return leg\./g, ". The driver is resting before the return leg."],
  [/\. Returning to base\./g, ". It is returning to base."],
  [/\. Cargo: (.+?)\./g, ". It is carrying $1."],
  [/\bETA (\d{1,2}:\d{2})\./g, "The estimated arrival is $1."],
  // "Tractor KTCC 286G · Moses Atemba Manyasa dispatched to PAP NDEGE is
  // overdue — out for 24 hours with no return."
  [
    /^Tractor (.+?) dispatched to (.+?) is overdue — out for (.+?) with no return\./,
    "Tractor $1 was dispatched to $2 and is overdue, having been out for $3 with no return.",
  ],
  // "Tractor KTCC 958G dispatched with X instead of its assigned driver Y by Z."
  [/^Tractor (.+?) dispatched with /, "Tractor $1 was dispatched with "],
  [/ instead of its assigned driver /g, " in place of its assigned driver "],
  [/ by ([^.]+)\. Reason: (.+?)\.?$/, ", authorised by $1. Reason: $2."],

  // ── overspeeding ────────────────────────────────────────────────────────
  [/ detected at (\d+) km\/h/g, " was recorded at $1 km/h"],
  [/\bSpeed limit (\d+) km\/h\./g, "The speed limit is $1 km/h."],
];

/**
 * The last resort, and the reason the rules above can be incomplete without
 * being unsafe.
 *
 * A dash that no rule claimed is a shape this build has not seen — a new
 * emitter, or an old one reworded. Rendering it would put back exactly what
 * was asked to be removed, and dropping the notification would lose a real
 * event over a punctuation mark, so it is demoted to the weakest join that is
 * always grammatical: a comma before a lower-case clause, a full stop before
 * a capital one. In development it also says so, because the right home for
 * the sentence is a rule up there, not this.
 */
const announced = new Set();
function dashGuard(body) {
  if (!/[—–]/.test(body)) return body;
  if (import.meta.env?.DEV && !announced.has(body)) {
    announced.add(body);
    // eslint-disable-next-line no-console
    console.warn("[feed] no sentence rule for this shape:", body);
  }
  return body
    .replace(/\s*[—–]\s*(?=[A-Z])/g, ". ")
    .replace(/\s*[—–]\s*/g, ", ");
}

/**
 * Name the unit's driver, where the sentence does not already.
 *
 * Most emitters write `PLATE · Driver` when they know who is on the unit, and
 * where one has, it is left alone: that name was resolved at the moment of the
 * event and is the better answer. The ones that do not are the zone crossings
 * and the gate lines, which are published off telemetry and never look a
 * driver up — so on Sukari, where 233 of 597 units carry an assignment, the
 * feed named nobody.
 *
 * The caveat, which is why this is a separate step and not a rule: the name
 * here is the driver assigned to that unit NOW, and a crossing from this
 * morning may have been someone else's. The panel is a day of activity and an
 * assignment rarely turns over inside one, but a line that was emitted with a
 * driver in it always wins over this.
 */
function nameDriver(body, plate, driver) {
  if (!driver || !plate || body.includes(" · ")) return body;
  const unit = plate.replace(accountRe, "").trim();
  if (!unit) return body;
  const who = `${unit} · ${deshout(driver)}`;
  if (body.startsWith(unit + " ")) return who + body.slice(unit.length);
  return body;
}

/**
 * The parts of one feed line: the badge, if it has one, and the sentence.
 *
 * @param {string|null|undefined} text the stored notification text
 * @param {object} [item] the feed item's own fields — `plate` and the
 *   `driver` resolved from the live fleet, for nameDriver above
 * @returns {{ badge: string|null, body: string }}
 */
export function formatFeedText(text, { plate = null, driver = null } = {}) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return { badge: null, body: "" };

  let body = raw;
  let badge = null;

  const badged = badgeRe.exec(body);
  if (badged) {
    badge = badged[1];
    body = body.slice(badged[0].length);
  }

  const account = accountRe.exec(body);
  if (account) {
    const tokens = account[1].split(/[:-]/).map((t) => t.trim()).filter(Boolean);
    if (!tokens.some((t) => NEVER_AN_ACCOUNT.has(t))) body = body.slice(account[1].length);
  }

  body = body
    // The dispatch system's own parenthetical, turned into the "plate · driver"
    // form every other emitter already uses. Same two facts, one punctuation.
    .replace(/\s*\(driver ([^)]+)\)/g, " · $1")
    // No driver on the unit. "LMV 10 · Unassigned was recorded at 95 km/h" is
    // the same sentence as "LMV 10 was recorded at 95 km/h", one word longer.
    .replace(/\s+·\s+Unassigned\b/g, "")
    // The unnamed leg. `feed-events` writes the literal word when it has no
    // place to name, so these phrases assert a destination and then decline to
    // say it.
    .replace(/\s+en route to destination\b/g, "")
    .replace(/\s+bound for destination\b/g, "")
    .replace(/\s+to destination\b/g, "")
    .replace(shoutRe, deshoutRun);

  for (const [from, to] of SENTENCE_RULES) body = body.replace(from, to);
  body = dashGuard(body);
  body = nameDriver(body, plate, driver);

  body = body
    // Tidy after the cuts: a removed clause can leave a doubled space or
    // strand its own punctuation, and a rewritten tail can arrive unstopped.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  if (body && !/[.!?)]$/.test(body)) body += ".";

  return { badge, body };
}

/**
 * The same line as one string — for the places a feed item leaves the panel.
 *
 * The badge is re-joined with its colon: a WhatsApp message and a search index
 * are plain text, and the word is part of the record there.
 */
export function feedPlainText(text, item) {
  const { badge, body } = formatFeedText(text, item);
  return badge ? `${badge}: ${body}` : body;
}
