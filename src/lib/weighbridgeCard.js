/**
 * The weighbridge hover card.
 *
 * What a scale last did, in the smallest thing that can carry it: the lorry,
 * the three weights, what the load was, whether the ticket was a delivery or a
 * transfer, and when.
 *
 * Built here rather than inside the map effect because every decision in it is
 * about MEANING rather than about markers — that a missing product is rendered
 * as its absence and never as a guess, that a tare-only scale is not idle, that
 * the two legs of a transfer are different events — and those should be pinned
 * by a test, not buried in a 5,000-line component.
 *
 * ## Reading order, top to bottom
 *
 * Place, subject, measure, circumstance. The scale names itself; the lorry it
 * weighed comes next, because that is what an operator opened the card to find;
 * the net is the one number the conversation is about; the working and the
 * conditions sit under it. The earlier version scattered the ticket's kind, its
 * crossing and its time as three rows in among the weights, so the eye had to
 * sort five unlike things into groups before it could read any of them.
 *
 * ## Net is the headline, and the other two are the working
 *
 * Net is what the farmer is paid on, and it is the provider's own subtraction
 * rather than ours (it agreed with gross - tare on all 729 rows measured
 * 2026-09-10, which is a reason to print theirs, not a reason to recompute it).
 * Gross and tare sit under it small, because the question a dispute starts with
 * is "which crossing was wrong".
 *
 * ## An absent product is a fact about the feed
 *
 * `productName` is null on every delivery row the integration has seen — the
 * columns exist upstream and are not being filled. So the row renders as "not
 * stated" rather than being hidden: a card that silently omits the field would
 * have an operator assume nobody asked, when the truth is the provider is not
 * answering.
 *
 * The markup is the shared `.mapcard` block, which the site plan's own cards
 * use too: three overlays on one map should not be three opinions about what a
 * card looks like.
 */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const FLEET_TZ = "Africa/Nairobi";

/** Kilograms as tonnes, the unit a weighbridge conversation uses. Two decimals
 *  — these scales resolve to 20 kg, so a third digit is precision the machine
 *  does not have. Matches `tonnes` in api/weighments so one load cannot be
 *  rounded two ways across the two surfaces. */
export const t = (kg) => (kg == null ? "-" : `${(kg / 1000).toFixed(2)} t`);

/** "12 Sep, 17:51" in the fleet's timezone. The year is dropped: a scale's last
 *  ticket is days old at worst, and the card is short. */
export function stamp(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: FLEET_TZ, day: "numeric", month: "short",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: FLEET_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return `${date}, ${time}`;
}

/** How long ago, in the coarsest unit that is still true. A scale's freshness
 *  is the first thing to read: "3 days ago" and "8 minutes ago" are different
 *  claims about whether this yard is working. */
export function ago(iso, now = Date.now()) {
  if (!iso) return null;
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 0)  return "just now";       // clock skew, not a future weighing
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** The scale's name as an operator says it: the centre, then which of its
 *  scales. The second half comes from the server as `label`, because not every
 *  scale has a number to compose one from — Kabras' two were measured from the
 *  traffic and the mill's software does not number them, so they are named for
 *  where they stand. The fallback keeps a payload written before `label`
 *  existed rendering the same string it always did. */
export const bridgeTitle = (b) =>
  `${b.centerName} · ${b.label ?? `Bridge ${b.bridgeNo}`}`;

/** Delivery or transfer, and which leg of a transfer this weighing was. */
export function ticketKind(last) {
  if (last.category === "CANE_TRANSFER") {
    return last.atFactoryLeg ? "Transfer · factory leg" : "Transfer · outstation";
  }
  return "Delivery";
}

/** Which crossing this scale took: loaded, or empty. */
export const stageLabel = (last) => (last.stage === "gross" ? "Loaded" : "Empty");

/** One row of the definition list. `v` arrives already escaped by its caller,
 *  which is what lets a value carry markup of its own — the absent-product
 *  span is the only one that does. */
const row = (k, v) =>
  `<div class="mapcard__row"><dt class="mapcard__k">${esc(k)}</dt>` +
  `<dd class="mapcard__v">${v}</dd></div>`;

/**
 * The card, as an HTML string for a Google Maps InfoWindow.
 *
 * A string because that is what an InfoWindow takes. The one interactive part —
 * the link to the unit — is marked with `data-wb-focus` carrying the vehicle
 * id, and the map wires it on `domready`: an inline `onclick` would have to
 * reach a global, and this keeps the handler in the component that owns the
 * camera.
 *
 * @param {object} bridge  one row from /weighments/bridges
 * @param {number} [now]   injectable clock, so `ago` is testable
 */
export function weighbridgeCard(bridge, now = Date.now()) {
  const last = bridge.last;

  // The ticket's kind describes the whole card, so it rides in the head as a
  // chip rather than sitting in the middle of the weights as a row.
  // "Quiet" is a claim about a scale that reports. One that does not is not
  // quiet, it is unmetered, and the chip is the first thing read.
  const kindChip = last
    ? `<span class="mapcard__chip mapcard__chip--${
         last.category === "CANE_TRANSFER" ? "transfer" : "delivery"
       }">${esc(ticketKind(last))}</span>`
    : `<span class="mapcard__chip mapcard__chip--quiet">${
         bridge.bridgeNo == null ? "No feed" : "Quiet"
       }</span>`;

  const head =
    `<header class="mapcard__head">` +
      `<h3 class="mapcard__title">${esc(bridgeTitle(bridge))}</h3>` +
      kindChip +
    `</header>`;

  if (!last) {
    // A scale with nothing to show is not a broken marker, and the card has to
    // say WHICH kind of nothing it is. A quiet scale is one that reports and
    // has not weighed lately; a scale with no bridge number does not report at
    // all and never will, so promising "the last 30 days" would have an
    // operator come back tomorrow to look again.
    const why = bridge.bridgeNo == null
      ? "This scale sends us no tickets. Its position was measured from the " +
        "traffic that uses it."
      : "No weighing recorded here in the last 30 days.";
    return (
      `<article class="mapcard mapcard--wb">${head}` +
      `<p class="mapcard__empty">${esc(why)}</p>` +
      `</article>`
    );
  }

  // The link only exists when the plate resolves to a unit we track. Most of
  // this traffic is contractors' lorries and farmers' tractors with no tracker,
  // so a link rendered unconditionally would be dead more often than not.
  const vehicle = last.vehicleId
    ? `<button type="button" class="mapcard__link" data-wb-focus="${esc(last.vehicleId)}">` +
        `<span class="mapcard__plate">${esc(last.vehicleNo)}</span>` +
        `<span class="mapcard__chev" aria-hidden="true">&rsaquo;</span></button>`
    : `<span class="mapcard__plate mapcard__plate--loose">${esc(last.vehicleNo)}` +
        `<span class="mapcard__muted">not tracked</span></span>`;

  return (
    `<article class="mapcard mapcard--wb">` +
      head +
      `<div class="mapcard__subject">${vehicle}</div>` +
      `<p class="mapcard__figure">` +
        `<span class="mapcard__fig">${esc(t(last.netWeightKg))}</span>` +
        `<span class="mapcard__figk">net &middot; ${esc(stageLabel(last).toLowerCase())} crossing</span>` +
      `</p>` +
      `<dl class="mapcard__rows">` +
        row("Gross", esc(t(last.grossWeightKg))) +
        row("Tare",  esc(t(last.tareWeightKg))) +
        row("Product", last.productName
          ? esc(last.productName)
          : `<span class="mapcard__absent">not stated</span>`) +
      `</dl>` +
      `<footer class="mapcard__foot">` +
        `<span>${esc(stamp(last.at))}</span>` +
        `<span class="mapcard__muted">${esc(ago(last.at, now))}</span>` +
      `</footer>` +
    `</article>`
  );
}
