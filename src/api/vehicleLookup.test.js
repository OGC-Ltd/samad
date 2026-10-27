// The cross-organisation unit lookup, on the client side.
//
// The whole value of this call is that it answers a question the operator
// cannot answer themselves — "which of my companies is this unit in" — so the
// two ways it can quietly lie are worth pinning: a hit whose organisation this
// dashboard has no company for would offer a switch to nowhere, and a short
// query would ask the server to match half a fleet.

import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("../services/api", () => ({ apiFetch: (...args) => apiFetch(...args) }));

const { lookupUnits, MIN_LOOKUP_CHARS } = await import("./vehicleLookup");

const hit = (over = {}) => ({
  vehicleId: "ckv1", plate: "KDM 337M", name: "KDM 337M", type: "TRUCK",
  orgId: "org_1", orgCode: "SAMAD", orgName: "Samad Resources", ...over,
});

beforeEach(() => { apiFetch.mockReset(); });

describe("lookupUnits", () => {
  it("names the company each unit belongs to", async () => {
    apiFetch.mockResolvedValue({ data: [hit()] });
    const [found] = await lookupUnits("KDM 337M");
    expect(found.companyId).toBe("samad");
    expect(found.plate).toBe("KDM 337M");
  });

  it("matches the organisation code whatever its case", async () => {
    apiFetch.mockResolvedValue({ data: [hit({ orgCode: "samad" })] });
    expect((await lookupUnits("KDM"))[0].companyId).toBe("samad");
  });

  it("drops a hit in an organisation this dashboard cannot open", async () => {
    // A tenant seeded on the server but absent from companyData: there is
    // nowhere to switch to, so offering it would be an answer that cannot be
    // acted on.
    apiFetch.mockResolvedValue({ data: [hit({ orgCode: "SOMEWHERE_NEW" }), hit()] });
    const found = await lookupUnits("KDM");
    expect(found).toHaveLength(1);
    expect(found[0].companyId).toBe("samad");
  });

  it("does not ask the server about a one-character query", async () => {
    expect(await lookupUnits("K")).toEqual([]);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(MIN_LOOKUP_CHARS).toBe(2);
  });

  it("encodes the query, so a plate with a space stays one term", async () => {
    apiFetch.mockResolvedValue({ data: [] });
    await lookupUnits("  KDM 337M  ");
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/v1/vehicle-lookup?q=KDM%20337M",
      expect.anything(),
    );
  });

  it("survives a response with no rows in it", async () => {
    apiFetch.mockResolvedValue({});
    expect(await lookupUnits("KDM")).toEqual([]);
  });
});
