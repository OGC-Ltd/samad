import { apiFetch } from "../services/api";

const base = (orgId) =>
  `/api/v1/organisations/${encodeURIComponent(orgId)}/user-groups`;

export async function listUserGroups(orgId) {
  if (!orgId) return [];
  const res = await apiFetch(base(orgId));
  return res.data ?? [];
}

export async function createUserGroup(orgId, { name, description, organisationIds, organisationName }) {
  const res = await apiFetch(base(orgId), {
    method: "POST",
    body: JSON.stringify({
      name,
      description: description || null,
      ...(organisationIds ? { organisationIds } : {}),
      // The group's own organisation ("" = Samad's); left out, unchanged.
      ...(organisationName !== undefined ? { organisationName } : {}),
    }),
  });
  return res.data;
}

export async function updateUserGroup(orgId, groupId, { name, description, organisationIds, organisationName }) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name,
      description: description || null,
      ...(organisationIds ? { organisationIds } : {}),
      // The group's own organisation ("" = Samad's); left out, unchanged.
      ...(organisationName !== undefined ? { organisationName } : {}),
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

/** The group's own organisation logo: the image file itself as the body. */
export async function uploadGroupLogo(orgId, groupId, file) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(groupId)}/logo`, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  return res.data;
}

export async function removeGroupLogo(orgId, groupId) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(groupId)}/logo`, {
    method: "DELETE",
  });
  return res.data;
}
