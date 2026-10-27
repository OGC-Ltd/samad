import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("../services/api", () => ({ apiFetch }));

const { assignRepairItem } = await import("./repairs");

beforeEach(() => { apiFetch.mockReset(); });

describe("assignRepairItem", () => {
  it("sends the selected technician id exactly and does not invoke automatic triage", async () => {
    apiFetch.mockResolvedValue({ data: { assignedTo: { id: "tech-elisha-konde", fullName: "Elisha Konde" } } });

    await assignRepairItem({
      orgId: "org-1",
      itemId: "repair-1",
      technicianId: "tech-elisha-konde",
    });

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/v1/organisations/org-1/repairs/items/repair-1/assign",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ technicianId: "tech-elisha-konde" }),
      }),
    );
  });
});
