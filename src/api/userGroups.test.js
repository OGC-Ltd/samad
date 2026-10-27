import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("../services/api", () => ({ apiFetch: (...args) => apiFetch(...args) }));

const {
  listUserGroups, createUserGroup, updateUserGroup, deleteUserGroup,
  addUserToGroup, removeUserFromGroup,
} = await import("./userGroups");

beforeEach(() => apiFetch.mockReset());

describe("user group API", () => {
  it("lists groups from the selected organisation", async () => {
    apiFetch.mockResolvedValue({ data: [{ id: "grp-1", name: "Dispatch" }] });

    await expect(listUserGroups("org/a")).resolves.toEqual([
      { id: "grp-1", name: "Dispatch" },
    ]);
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/organisations/org%2Fa/user-groups");
  });

  it("creates and updates groups with the supported fields", async () => {
    apiFetch.mockResolvedValue({ data: { id: "grp-1" } });
    await createUserGroup("org-1", { name: "Dispatch", description: "" });
    await updateUserGroup("org-1", "grp-1", { name: "Night dispatch", description: null });

    expect(apiFetch.mock.calls[0]).toEqual([
      "/api/v1/organisations/org-1/user-groups",
      { method: "POST", body: JSON.stringify({ name: "Dispatch", description: null }) },
    ]);
    expect(apiFetch.mock.calls[1]).toEqual([
      "/api/v1/organisations/org-1/user-groups/grp-1",
      { method: "PATCH", body: JSON.stringify({ name: "Night dispatch", description: null }) },
    ]);
  });

  it("sends selected organisations when creating or updating a group", async () => {
    apiFetch.mockResolvedValue({ data: { id: "grp-1" } });
    const organisationIds = ["org-1", "org-2", "org-3"];

    await createUserGroup("org-1", {
      name: "Dispatch", description: "Shared roster", organisationIds,
    });
    await updateUserGroup("org-1", "grp-1", {
      name: "Night dispatch", description: "Shared night roster", organisationIds,
    });

    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({
      name: "Dispatch", description: "Shared roster", organisationIds,
    });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({
      name: "Night dispatch", description: "Shared night roster", organisationIds,
    });
  });

  it("adds and removes one membership without replacing other group assignments", async () => {
    apiFetch.mockResolvedValue({ data: { userId: "user-1", groupId: "group/1" } });
    await addUserToGroup("org-1", "group/1", "user/1");
    await removeUserFromGroup("org-1", "group/1", "user/1");

    expect(apiFetch.mock.calls[0]).toEqual([
      "/api/v1/organisations/org-1/user-groups/group%2F1/users/user%2F1",
      { method: "PUT" },
    ]);
    expect(apiFetch.mock.calls[1]).toEqual([
      "/api/v1/organisations/org-1/user-groups/group%2F1/users/user%2F1",
      { method: "DELETE" },
    ]);
  });

  it("does not call the API to list groups without an organisation", async () => {
    await expect(listUserGroups(null)).resolves.toEqual([]);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("deletes a group in its organisation", async () => {
    apiFetch.mockResolvedValue({ data: { id: "grp-1", removed: true } });
    await deleteUserGroup("org-1", "grp-1");
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/v1/organisations/org-1/user-groups/grp-1",
      { method: "DELETE" },
    );
  });
});
