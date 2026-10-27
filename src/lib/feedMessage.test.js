import { describe, it, expect } from "vitest";
import { formatFeedText, feedPlainText } from "./feedMessage";

/* Every `raw` string below was read off the live notification store on
   2026-09-14 (Mufindi, Sukari and Menengai), not invented — the point of the
   module is that it handles the sentences the server actually writes. */

const body = (raw) => formatFeedText(raw).body;

describe("formatFeedText · noise", () => {
  it("drops the provider's account prefix, punctuated either way", () => {
    expect(body("MUFINDI: FTT 02 left Factory site Location."))
      .toBe("FTT 02 left Factory site Location.");
    expect(body("FUEL PROBE: TR - RAIMDF - TRACTOR 02 — has never reported a fuel level in 30 days of telemetry. Needs a workshop visit."))
      .toBe("TRACTOR 02 has never reported a fuel level in 30 days of telemetry. It needs a workshop visit.");
  });

  it("lifts the severity word out of the sentence", () => {
    expect(formatFeedText("RESTRICTED: MUFINDI: LMV 05 entered Main river malagarasi3 — a keep-out zone."))
      .toEqual({ badge: "RESTRICTED", body: "LMV 05 entered Main river malagarasi3, a restricted zone." });
    expect(formatFeedText("POSSIBLE THEFT: KCC 386Z — 18.4 L drawn off while parked at Mangelete.").badge)
      .toBe("POSSIBLE THEFT");
  });

  it("leaves a severity word it does not know IN the sentence", () => {
    // The failure that matters: an unlisted headline must survive unbadged
    // rather than be read as an account name and deleted.
    const { badge, body: b } = formatFeedText("SIPHON: KCC 386Z drew off 18.4 L.");
    expect(badge).toBeNull();
    expect(b).toBe("SIPHON: KCC 386Z drew off 18.4 L.");
  });

  it("cuts the placeholders the server writes when it has no answer", () => {
    expect(formatFeedText("ALERT: MUFINDI: LMV 10 · Unassigned detected at 95 km/h en route to destination. Speed limit 80 km/h."))
      .toEqual({ badge: "ALERT", body: "LMV 10 was recorded at 95 km/h. The speed limit is 80 km/h." });
  });

  it("title-cases a shouted name and lets the estate's own labels alone", () => {
    expect(body("MUFINDI: WB 02 arrived at FARM #215, near VES 149 (210 m)."))
      .toBe("WB 02 arrived at FARM #215, near VES 149 (210 m).");
    expect(body("KDL 713E cleared the gate to OPAPO 3 min after sign-out."))
      .toBe("KDL 713E cleared the gate to OPAPO 3 minutes after signing out.");
  });

  it("survives a missing text", () => {
    expect(formatFeedText(null)).toEqual({ badge: null, body: "" });
    expect(formatFeedText(undefined).body).toBe("");
  });
});

describe("formatFeedText · grammar", () => {
  /* The rule the whole table serves: nothing reaches the panel carrying an em
     dash, and nothing reaches it as a fragment. */

  it("drops the clause the dash was carrying, and keeps the crossing", () => {
    expect(body("MUFINDI: MTR 19 arrived at Nursery A — inside FARM #215."))
      .toBe("MTR 19 arrived at Nursery A.");
    expect(body("MUFINDI: 014 arrived at Logistic centre1 — inside Nursery A, FARM #215."))
      .toBe("014 arrived at Logistic centre1.");
    // The nesting can be a restatement — this is the pair that settled it.
    expect(body("KDM 337M arrived at Sukari Indurstries Factory — inside Sukari industries."))
      .toBe("KDM 337M arrived at Sukari Indurstries Factory.");
    // What comes AFTER the clause is not part of it: the nearest sample point
    // is the one thing in the sentence that helps you find the vehicle.
    expect(body("MUFINDI: WB 02 arrived at Nursery B — inside FARM #215, near VES-82 (1.3 km)."))
      .toBe("WB 02 arrived at Nursery B, near VES-82 (1.3 km).");
  });

  it("joins a departure to where the unit ended up", () => {
    expect(body("MUFINDI - FTT 13 left Nursery - B — now in FARM #215."))
      .toBe("FTT 13 left Nursery B and is now in FARM #215.");
  });

  it("completes the fuel fragments", () => {
    expect(body("MUFINDI: DZ 14 refuelled 20.9 L at Mukinka, Kasulu DC. Tank now 340.4 L."))
      .toBe("DZ 14 refuelled 20.9 L at Mukinka, Kasulu DC. The tank now holds 340.4 L.");
    expect(body("FUEL RATE: MUFINDI - EX 22 — 22.1 L at 60 L/h, above what this machine is measured to burn at Kabuga. Tank now 244.3 L. 15th flagged event on this unit in 30 days — 441.9 L in total (before this: 23.1 L, 27.4 L, 27 L)."))
      .toBe(
        "EX 22 recorded a drop of 22.1 L at 60 L/h, above what this machine is measured to burn at Kabuga. " +
        "The tank now holds 244.3 L. " +
        "This is the 15th flagged event on this unit in 30 days, 441.9 L in total; the previous drops were 23.1 L, 27.4 L and 27 L."
      );
  });

  it("gives the dead probe's last reading a sentence", () => {
    expect(body("FUEL PROBE: KDL 710E — no reading for 5 days (last read 175.4 L on 2026-09-09). Needs a workshop visit."))
      .toBe("KDL 710E has had no reading for 5 days, the last being 175.4 L on 2026-09-09. It needs a workshop visit.");
  });

  it("repairs the yard, sales and overdue lines", () => {
    expect(body("KCP 136P · Dickson Kiplagat signed out to Raiply — left the premises."))
      .toBe("KCP 136P · Dickson Kiplagat signed out to Raiply and left the premises.");
    expect(body("KCP 136P · Duncan Mwangi signed back in at Naitiri — sales run bound for Raiply complete."))
      .toBe("KCP 136P · Duncan Mwangi signed back in at Naitiri; the sales run to Raiply is complete.");
    expect(body("KDL 206X · JACOB OTIENO OREGE is clear of the yard to OYANI — departure time not observed (no fix at the gate)."))
      .toBe("KDL 206X · Jacob Otieno Orege is clear of the yard, bound for OYANI. The departure time was not observed, because there was no fix at the gate.");
    expect(body("Tractor KTCC 286G (driver MOSES ATEMBA MANYASA) dispatched to PAP NDEGE is overdue — out for 24 hours with no return."))
      .toBe("Tractor KTCC 286G · Moses Atemba Manyasa was dispatched to Pap Ndege and is overdue, having been out for 24 hours with no return.");
  });

  it("makes the driver-swap line a sentence and stops it", () => {
    expect(body("Tractor KTCC 958G dispatched with Cornelius Shivambo instead of its assigned driver EVANS OCHIENG OKEYO by Samuel Kiprop. Reason: SICK"))
      .toBe("Tractor KTCC 958G was dispatched with Cornelius Shivambo in place of its assigned driver Evans Ochieng Okeyo, authorised by Samuel Kiprop. Reason: SICK.");
  });

  it("demotes a dash no rule claimed rather than rendering it", () => {
    // A shape this build has not seen: still grammatical, still complete.
    expect(body("KDL 713E reached the weighbridge — queue of four ahead."))
      .toBe("KDL 713E reached the weighbridge, queue of four ahead.");
    expect(body("KDL 713E reached the weighbridge — Queue of four ahead."))
      .toBe("KDL 713E reached the weighbridge. Queue of four ahead.");
  });

  it("names the driver on a line the emitter left without one", () => {
    const item = { plate: "MUFINDI: FTT 02", driver: "CALVINE OTIENO OMOLLO" };
    expect(formatFeedText("MUFINDI: FTT 02 arrived at Factory site Location.", item).body)
      .toBe("FTT 02 · Calvine Otieno Omollo arrived at Factory site Location.");
  });

  it("does not second-guess a driver the emitter DID name", () => {
    // That name was resolved at the moment of the event; this one is only who
    // is on the unit now.
    const item = { plate: "KCP 136P", driver: "Someone Else" };
    expect(formatFeedText("KCP 136P · Dickson Kiplagat returned to the yard.", item).body)
      .toBe("KCP 136P · Dickson Kiplagat returned to the yard.");
  });

  it("names nobody when there is nobody to name", () => {
    const raw = "MUFINDI: FTT 02 arrived at Factory site Location.";
    expect(formatFeedText(raw, { plate: "MUFINDI: FTT 02", driver: null }).body)
      .toBe("FTT 02 arrived at Factory site Location.");
    // An org-level line has no unit to hang a driver on.
    expect(formatFeedText(raw, { plate: null, driver: "A Driver" }).body)
      .toBe("FTT 02 arrived at Factory site Location.");
  });

  it("leaves no em dash anywhere in the corpus", () => {
    const corpus = [
      "MUFINDI: LMV 10 arrived at Nursery A — inside FARM #215.",
      "MUFINDI - FTT 13 left Nursery - B — now in FARM #215.",
      "RESTRICTED: MUFINDI: DB 03 entered DRAINS4 — a keep-out zone.",
      "FUEL PROBE: KCP 136P — has never reported a fuel level in 30 days of telemetry. Needs a workshop visit.",
      "FUEL DOWN: KCC 386Z — 18.4 L, more than the distance driven accounts for at Mombasa Road. Tank now 187.1 L.",
      "CRITICAL: KBP 789L · F. Mwangi — sudden fuel level drop detected near Malindi. Possible theft.",
      "KCP 136P · Maxwell Masinde signed out at Naitiri with 29.0t (580 × 50 kg bags) bound for RaiPly — left the premises.",
    ];
    for (const raw of corpus) {
      const out = feedPlainText(raw);
      expect(out, raw).not.toMatch(/[—–]/);
      expect(out, raw).toMatch(/[.!?)]$/);
    }
  });
});

describe("feedPlainText", () => {
  it("keeps the badge in the line where there is nothing to render it with", () => {
    expect(feedPlainText("ALERT: MUFINDI: LMV 10 · Unassigned detected at 95 km/h en route to destination. Speed limit 80 km/h."))
      .toBe("ALERT: LMV 10 was recorded at 95 km/h. The speed limit is 80 km/h.");
  });
});

describe("formatFeedText · the shapes the guard found", () => {
  /* Added after the dev-time guard announced them from the live SSE stream —
     which is the loop the guard exists to close. */

  it("names the length of the trip a gate arrival ends", () => {
    expect(body("KTCC 840B · Evance Ochieng Otieno arrived at the gate from ODIELO — out 10.5 h."))
      .toBe("KTCC 840B · Evance Ochieng Otieno arrived at the gate from ODIELO, having been out for 10.5 h.");
    expect(body("KTCC 871B · Abraham Kakai Weseme arrived at the gate from Kwoyo Valley — out 20 min."))
      .toBe("KTCC 871B · Abraham Kakai Weseme arrived at the gate from Kwoyo Valley, having been out for 20 min.");
  });

  it("finishes the dispatch lifecycle's telegraphic tails", () => {
    expect(body("KBU 123A · T. Ochieng arrived at Thika at 07:12. Loading raw sugarcane."))
      .toBe("KBU 123A · T. Ochieng arrived at Thika at 07:12. It is loading raw sugarcane.");
    expect(body("KBU 123A · T. Ochieng loaded 38.0t raw sugar cane at Thika — hauling to Mombasa Port. ETA 14:30."))
      .toBe("KBU 123A · T. Ochieng loaded 38.0t raw sugar cane at Thika and is hauling to Mombasa Port. The estimated arrival is 14:30.");
    expect(body("KBU 123A · T. Ochieng arrived back at Thika at 19:40. Trip complete."))
      .toBe("KBU 123A · T. Ochieng arrived back at Thika at 19:40. The trip is complete.");
    expect(body("KBU 123A · T. Ochieng redirected to Garage 2 — scheduled service due."))
      .toBe("KBU 123A · T. Ochieng redirected to Garage 2, where a scheduled service is due.");
  });
});

describe("formatFeedText · the server's own repaired wording", () => {
  /* fleet-server's templates were fixed on 2026-09-15 to emit these sentences
     directly (zone-presence, feed-events, yard-departure, fuel-adjudication,
     probe health, the factory-gate feed). This module still has to run — the
     stored history is years of the OLD wording, and the provider-authored
     alerts are not ours to rewrite — so the rules must pass the new text
     through untouched rather than repairing what is already repaired. */

  const emitted = [
    "MUFINDI: EX 24 arrived at Workshop A, near VES 143 (0 m).",
    "MUFINDI: EX 24 left Workshop A and is now in FARM #215.",
    "RESTRICTED: MUFINDI: EX 24 entered DRAINS3, a restricted zone.",
    "KDE 140E refuelled 67.8 L at Nakuru, Nakuru-Kisumu. The tank now holds 100.2 L.",
    "POSSIBLE THEFT: KDL 182X recorded a drop of 40 L, drawn off while parked at Nyalulanga. The tank now holds 160 L.",
    "FUEL RATE: EX 22 recorded a drop of 22.1 L at 60 L/h, above what this machine is measured to burn at Kabuga. The tank now holds 244.3 L. This is the 15th flagged event on this unit in 30 days, 441.9 L in total; the previous drops were 23.1 L, 27.4 L and 27 L.",
    "FUEL PROBE: KDL 710E has had no reading for 5 days, the last being 175.4 L on 2026-09-09. It needs a workshop visit.",
    "FUEL PROBE: KCP 136P has never reported a fuel level in 30 days of telemetry. It needs a workshop visit.",
    "KTCC 870B · Augustine Owino Nyamwok cleared the gate to kwoyo u k, 27 minutes after signing out.",
    "KTCC 870B · Augustine Owino Nyamwok is clear of the yard bound for kwoyo u k. The departure time was not observed, because there was no fix at the gate.",
    "KTCC 840B · Evance Ochieng Otieno arrived at the gate from ODIELO, having been out for 10.5 h.",
    "KCP 134P · Duncan Mwangi signed out at Naitiri with 29.0t (580 × 50 kg bags) bound for Raiply and left the premises.",
    "KCP 134P · Duncan Mwangi signed back in at Naitiri; the sales run bound for Raiply is complete.",
    "ALERT: LMV 10 was recorded at 95 km/h. The speed limit is 80 km/h.",
    "CRITICAL: KBP 789L · F. Mwangi recorded a sudden fuel level drop near Malindi. This may be theft.",
    "KBU 123A · T. Ochieng arrived at Thika at 07:12 and is loading raw sugarcane.",
    "KBU 123A · T. Ochieng loaded 38.0t raw sugar cane at Thika and is hauling to Mombasa Port. The estimated arrival is 14:30.",
    "KBU 123A · T. Ochieng arrived back at Thika at 19:40. The trip is complete.",
    "KBU 123A · T. Ochieng was redirected to Garage 2, where a scheduled service is due.",
  ];

  it("changes nothing but the account prefix and the badge", () => {
    for (const raw of emitted) {
      // What the panel would show, minus the two things this module is still
      // wanted for on a freshly-emitted line.
      const expected = raw.replace(/^(ALERT|CRITICAL|RESTRICTED|POSSIBLE THEFT|FUEL RATE|FUEL DOWN|FUEL PROBE): /, "")
                          .replace(/^MUFINDI: /, "");
      expect(formatFeedText(raw).body, raw).toBe(expected);
    }
  });
});
