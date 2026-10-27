/**
 * The weighbridge hover card.
 *
 * What these pin is what the card SAYS, not how it looks: that a weight the
 * provider did not send is rendered as its absence rather than as a zero or an
 * omission, that a transfer's two legs are told apart, and that the link to the
 * unit exists only when there is a unit to link to. Every one of those would
 * still render if it were wrong.
 */

import { describe, it, expect } from "vitest";
import {
  weighbridgeCard, bridgeTitle, ticketKind, stageLabel, stamp, ago, t,
} from "./weighbridgeCard";

const bridge = (over = {}) => ({
  id: "wb-1", centerCode: 101, centerName: "FACTORY", bridgeNo: 1,
  label: "Bridge 1",
  lat: -0.822727, lng: 34.383195, spreadM: 17, samples: 135,
  last: {
    token: "1234567890123", category: "CANE_DELIVERY", stage: "gross",
    atFactoryLeg: false, at: "2026-09-12T14:51:00.000Z",
    vehicleNo: "KDL 709E", vehiclePlate: "KDL709E", vehicleId: "veh_1",
    driverName: "TAISHON OTIENO OBONYO", operator: "WBF",
    grossWeightKg: 46620, tareWeightKg: 21020, netWeightKg: 25600,
    productName: null,
  },
  ...over,
});

const NOW = new Date("2026-09-13T09:00:00.000Z").getTime();

describe("formatting", () => {
  it("prints kilograms as tonnes to two places", () => {
    // These scales resolve to 20 kg. A third digit is precision the machine
    // does not have.
    expect(t(25600)).toBe("25.60 t");
    expect(t(null)).toBe("-");
  });

  it("stamps a weighing on the fleet's clock, not the reader's", () => {
    // 14:51 UTC is 17:51 in Nairobi, which is what the ticket says. The TIME is
    // what this pins; the month abbreviation is the runtime's ("Sep" in a
    // browser, "Sept" under Node's ICU) and asserting it would pin the engine
    // rather than the behaviour.
    const out = stamp("2026-09-12T14:51:00.000Z");
    expect(out).toMatch(/^12 Sept?, 17:51$/);
  });

  it("says how stale a scale's last ticket is in the coarsest true unit", () => {
    expect(ago("2026-09-13T08:30:00.000Z", NOW)).toBe("30 min ago");
    expect(ago("2026-09-13T04:00:00.000Z", NOW)).toBe("5 h ago");
    expect(ago("2026-09-11T09:00:00.000Z", NOW)).toBe("2 days ago");
    expect(ago("2026-09-12T09:00:00.000Z", NOW)).toBe("1 day ago");
  });

  it("reads a future stamp as now rather than as negative time", () => {
    // The scale's clock and ours are not the same clock. "in -3 minutes" is
    // not a thing to show an operator.
    expect(ago("2026-09-13T09:05:00.000Z", NOW)).toBe("just now");
  });

  it("names a scale by its centre and its own number", () => {
    // Bridge numbers are global, so the number identifies the scale and the
    // centre places it.
    expect(bridgeTitle(bridge())).toBe("FACTORY · Bridge 1");
  });

  it("names an unnumbered scale by where it stands", () => {
    // Kabras' two were measured from the traffic; the mill's software does not
    // number them, and "Bridge null" is what composing one here would print.
    expect(bridgeTitle(bridge({
      centerName: "KABRAS", bridgeNo: null, label: "West scale",
    }))).toBe("KABRAS · West scale");
  });

  it("still composes a title for a payload written before labels", () => {
    const { label, ...old } = bridge();
    expect(label).toBe("Bridge 1");
    expect(bridgeTitle(old)).toBe("FACTORY · Bridge 1");
  });
});

describe("ticket kind", () => {
  it("tells a delivery from a transfer", () => {
    expect(ticketKind(bridge().last)).toBe("Delivery");
  });

  it("tells a transfer's two legs apart", () => {
    // A transfer is weighed at the outstation and again at the factory. Those
    // are different events on different scales, and the card must not blur them.
    const out = { category: "CANE_TRANSFER", atFactoryLeg: false };
    const fac = { category: "CANE_TRANSFER", atFactoryLeg: true };
    expect(ticketKind(out)).toBe("Transfer · outstation");
    expect(ticketKind(fac)).toBe("Transfer · factory leg");
  });

  it("says which crossing this scale took", () => {
    // A scale that has weighed nothing but empties is not idle, and the card
    // has to be able to say "Empty" rather than imply a loaded weighing.
    expect(stageLabel({ stage: "gross" })).toBe("Loaded");
    expect(stageLabel({ stage: "tare" })).toBe("Empty");
  });
});

describe("weighbridgeCard", () => {
  it("leads with net and shows the working underneath", () => {
    const html = weighbridgeCard(bridge(), NOW);
    expect(html).toContain("25.60 t");     // net, the headline
    expect(html).toContain("46.62 t");     // gross
    expect(html).toContain("21.02 t");     // tare
  });

  it("renders a missing product as stated-absent, not as nothing", () => {
    // Null on every delivery row the integration has seen. A card that dropped
    // the row would have an operator assume nobody asked.
    const html = weighbridgeCard(bridge(), NOW);
    expect(html).toContain("Product");
    expect(html).toContain("not stated");
  });

  it("prints a product when the provider sends one", () => {
    const html = weighbridgeCard(bridge({
      last: { ...bridge().last, productName: "Raw Sugarcane" },
    }), NOW);
    expect(html).toContain("Raw Sugarcane");
    expect(html).not.toContain("not stated");
  });

  it("offers the backlink only when the plate resolves to a tracked unit", () => {
    const linked = weighbridgeCard(bridge(), NOW);
    expect(linked).toContain('data-wb-focus="veh_1"');

    // Most of this traffic is contractors' lorries with no tracker. A link
    // rendered anyway would be dead more often than live.
    const loose = weighbridgeCard(bridge({
      last: { ...bridge().last, vehicleId: null },
    }), NOW);
    expect(loose).not.toContain("data-wb-focus");
    expect(loose).toContain("not tracked");
    expect(loose).toContain("KDL 709E");
  });

  it("says a quiet scale is quiet rather than rendering a blank card", () => {
    const html = weighbridgeCard(bridge({ last: null }), NOW);
    expect(html).toContain("FACTORY · Bridge 1");
    expect(html).toContain("No weighing recorded here in the last 30 days");
    expect(html).not.toContain("data-wb-focus");
  });

  it("escapes provider text rather than pasting it into the card", () => {
    // Plates and driver names are operator-typed upstream and land in an
    // InfoWindow's innerHTML. This is the one place that can stop a stray
    // angle bracket from becoming markup.
    const html = weighbridgeCard(bridge({
      last: { ...bridge().last, vehicleId: null, vehicleNo: '<img src=x onerror=1>' },
    }), NOW);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("a scale with nothing to show", () => {
  it("says a reporting scale has simply been quiet", () => {
    const html = weighbridgeCard(bridge({ last: null }), NOW);
    expect(html).toContain("last 30 days");
    expect(html).toContain(">Quiet<");
  });

  it("says an unmetered scale will never have a ticket", () => {
    // Promising "the last 30 days" on a scale that sends us nothing would have
    // an operator come back tomorrow to look again.
    const html = weighbridgeCard(bridge({
      centerName: "KABRAS", bridgeNo: null, label: "West scale", last: null,
    }), NOW);
    expect(html).not.toContain("last 30 days");
    expect(html).toContain("no tickets");
    expect(html).toContain(">No feed<");
  });
});

describe("reading order", () => {
  // The card is read top to bottom by someone who already knows which pin they
  // clicked: place, then the lorry, then the number, then the working. The
  // previous version put the ticket's kind, its crossing and its time as three
  // rows in among the weights, so five unlike things shared one list.
  const at = (html, needle) => html.indexOf(needle);

  it("runs place → subject → measure → working → when", () => {
    const html = weighbridgeCard(bridge(), NOW);
    expect(at(html, "FACTORY · Bridge 1")).toBeLessThan(at(html, "KDL 709E"));
    expect(at(html, "KDL 709E")).toBeLessThan(at(html, "25.60 t"));
    expect(at(html, "25.60 t")).toBeLessThan(at(html, "Gross"));
    expect(at(html, "Gross")).toBeLessThan(at(html, "12 Sep"));
  });

  it("puts the ticket kind in the head, not in among the weights", () => {
    // It describes the whole card, so it is a chip you glance at rather than a
    // row you read in sequence with three weights.
    const html = weighbridgeCard(bridge(), NOW);
    expect(at(html, "Delivery")).toBeLessThan(at(html, "mapcard__subject"));
    expect(html).not.toContain(">Ticket<");
  });

  it("marks up the weights as a definition list", () => {
    // The pairs are pairs in the markup as well as on the screen — the label
    // and its figure are a <dt>/<dd>, not two spans that happen to be adjacent.
    const html = weighbridgeCard(bridge(), NOW);
    expect(html).toContain("<dl class=\"mapcard__rows\"");
    expect(html).toContain("<dt class=\"mapcard__k\">Gross</dt>");
  });

  it("wears the shared card class, not one of its own", () => {
    // Three overlays on one map should not be three opinions about what a card
    // looks like. The site plan's cards carry the same block.
    expect(weighbridgeCard(bridge(), NOW)).toContain('class="mapcard mapcard--wb"');
    expect(weighbridgeCard(bridge({ last: null }), NOW)).toContain("mapcard--wb");
  });
});
