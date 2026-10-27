// The weighbridge page's labels.
//
// Small functions, but each one is a claim the page makes in front of somebody
// settling a dispute about a load, so the edges are pinned: an absent weight
// must not read as zero, a first ticket must not read as an instant
// turnaround, and a stamp from another day must not read as a bare clock time
// beside today's.

import { describe, it, expect, vi } from "vitest";
import { tonnes, kilos, gapLabel, clockLabel, stampLabel } from "./weighments";

describe("weights", () => {
  it("shows tonnes to the precision the scale actually has", () => {
    // These bridges resolve to 20 kg; a third decimal would be precision the
    // machine does not have.
    expect(tonnes(26800)).toBe("26.80 t");
    expect(tonnes(6160)).toBe("6.16 t");
  });

  it("prints kilograms the way the ticket does", () => {
    expect(kilos(12180)).toBe("12,180 kg");
  });

  it("says nothing rather than zero when a weight is missing", () => {
    // A ticket half-finished — weighed in, not yet out — is normal. Rendering
    // that as "0 kg" would put an empty lorry on the record.
    expect(kilos(null)).toBe("-");
    expect(tonnes(null)).toBe("-");
    expect(kilos(undefined)).toBe("-");
  });
});

describe("gaps", () => {
  it("reads a turnaround the way the yard says it", () => {
    expect(gapLabel(3.5 * 3_600_000)).toBe("3h 30m");
    expect(gapLabel(18 * 60_000)).toBe("18m");
    // Zero-padded minutes, so the column lines up under itself.
    expect(gapLabel(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m");
  });

  it("distinguishes no gap from a short one", () => {
    // null is "there was no previous weighment" — the lorry's first of the
    // day. It must not collapse into the same label as a quick turnaround.
    expect(gapLabel(null)).toBe("-");
    expect(gapLabel(20_000)).toBe("under a minute");
  });
});

describe("stamps", () => {
  it("shows a clock for a weighing on the day being viewed", () => {
    const at = new Date(2026, 8, 9, 11, 38).toISOString();
    expect(clockLabel(at)).toBe("11:38");
    expect(stampLabel(at, "2026-09-09")).toBe("11:38");
  });

  it("carries the date when the weighing was NOT on that day", () => {
    // A tare taken the night before is common — 50 of 729 tickets measured
    // straddled midnight — and a bare "23:41" beside today's gross reads as a
    // two-minute turnaround rather than a fourteen-hour one.
    const at = new Date(2026, 8, 7, 0, 28).toISOString();
    expect(stampLabel(at, "2026-09-09")).toBe("07/09 00:28");
  });

  it("has an answer for a weighing that never happened", () => {
    expect(clockLabel(null)).toBe("-");
    expect(stampLabel(null, "2026-09-09")).toBe("-");
  });
});

/* The analytics read speaks COMPANIES, not organisations.
 *
 * Pinned because getting this wrong is silent. The analytics screen holds a
 * fleettrack slug; the server keys organisations by cuid. Handing the slug
 * over raises nothing — the server matches no row against it and answers a
 * perfectly well-formed window in which every day is uncaptured, which the
 * card then correctly withholds itself for. A working card and a card fed the
 * wrong identifier look identical from the outside, so the identifier itself
 * is what has to be asserted.
 */
describe("the analytics read resolves the company", () => {
  it("sends the resolved org cuid, not the company slug", async () => {
    vi.resetModules();
    const seen = [];
    vi.doMock("../services/api", () => ({
      apiFetch: (url) => { seen.push(url); return Promise.resolve({ data: {} }); },
    }));
    vi.doMock("./org", () => ({
      resolveOrgId: (companyId) =>
        Promise.resolve(companyId === "sukari" ? "cmr6da1bp0000vzizby6z0dzw" : null),
    }));
    const { getWeighmentAnalytics } = await import("./weighments");

    await getWeighmentAnalytics({ companyId: "sukari", days: 14 });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/organisations/cmr6da1bp0000vzizby6z0dzw/weighments/analytics");
    // The negative half, and the one that actually fails on the old code.
    expect(seen[0]).not.toContain("/organisations/sukari/");
  });

  it("asks nothing at all for a company with no organisation behind it", async () => {
    vi.resetModules();
    const seen = [];
    vi.doMock("../services/api", () => ({
      apiFetch: (url) => { seen.push(url); return Promise.resolve({ data: {} }); },
    }));
    vi.doMock("./org", () => ({ resolveOrgId: () => Promise.resolve(null) }));
    const { getWeighmentAnalytics } = await import("./weighments");

    expect(await getWeighmentAnalytics({ companyId: "nowhere", days: 14 })).toBe(null);
    expect(seen).toHaveLength(0);
  });
});
