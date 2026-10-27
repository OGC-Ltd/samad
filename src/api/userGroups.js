import { apiFetch } from "../services/api";

const base = (orgId) =>
  `/api/v1/organisations/${encodeURIComponent(orgId)}/user-groups`;

export async function listUserGroups(orgId) {
  if (!orgId) return [];
  const res = await apiFetch(base(orgId));
  return res.data ?? [];
}

export async function createUserGroup(orgId, { name, description, organisationIds }) {
  const res = await apiFetch(base(orgId), {
    method: "POST",
    body: JSON.stringify({
      name,
      description: description || null,
      ...(organisationIds ? { organisationIds } : {}),
    }),
  });
  return res.data;
}

export async function updateUserGroup(orgId, groupId, { name, description, organisationIds }) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name,
      description: description || null,
      ...(organisationIds ? { organisationIds } : {}),
    }),
  });
  return res.data;
}

export async function deleteUserGroup(orgId, groupId) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
  });
  return res.data;
}

export async function addUserToGroup(orgId, groupId, userId) {
  const res = await apiFetch(
    `${base(orgId)}/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`,
    { method: "PUT" },
  );
  return res.data;
}

export async function removeUserFromGroup(orgId, groupId, userId) {
  const res = await apiFetch(
    `${base(orgId)}/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  return res.data;
}
