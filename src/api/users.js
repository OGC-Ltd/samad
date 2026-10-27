/**
 * Organisation user administration.
 *
 * Every call is org-scoped by path, and `orgId` is always an explicit argument
 * resolved by the caller from `usePermissions().orgId` — the same contract the
 * read-only modules use. Nothing here guesses the organisation, because an
 * admin who has switched company must be administering the company they are
 * looking at.
 *
 * Errors propagate as ApiError so the form can read `err.body.errors` through
 * lib/formErrors.
 */

import { apiFetch } from "../services/api";

const base = (orgId) => `/api/v1/organisations/${encodeURIComponent(orgId)}/users`;

/**
 * The organisation's SYSTEM users — people who can sign in, or who have been
 * invited to.
 *
 * `access=system` matters more than it looks: the organisation holds 553
 * person rows and 549 of them are driver records synced from the operations
 * registry. They have never had a password and were never invited, so a roster
 * of "who can get into the dashboard" that listed them would be one real row
 * in five hundred.
 */
export async function listOrgUsers(orgId, { page = 1, limit = 100, access = "system" } = {}) {
  if (!orgId) return { users: [], total: 0 };
  const res = await apiFetch(`${base(orgId)}?page=${page}&limit=${limit}&access=${access}`);
  return { users: res.data ?? [], total: res.meta?.total ?? (res.data?.length ?? 0) };
}

/**
 * The rosters of SEVERAL organisations, merged into one list.
 *
 * ## Why a row carries its organisation
 *
 * Every write in this module is addressed to an organisation by path, so a row
 * that has been lifted out of its roster and dropped into a combined list has
 * lost the one thing its Delete button needs. Each row therefore carries
 * `scopeOrgId` — the organisation it was READ from, which is the organisation
 * its actions must be sent to.
 *
 * It is deliberately not `user.organisationId`. That field is who EMPLOYS the
 * person and it does not move when they are granted a second tenant, so a
 * contractor employed by A and granted B appears on B's roster with
 * `organisationId: 'A'`. Addressing their B roles to A would edit the wrong
 * membership, or 404.
 *
 * ## The same person is ONE row
 *
 * This was the other way round and it was wrong. Somebody who belongs to A and
 * B came back as two rows carrying the same name, the same address, the same
 * phone number and the same status, differing only in which organisation they
 * were read from — a roster of twelve people that printed twenty-two lines,
 * where the thing an administrator is scanning for (a person) had no single
 * place to be.
 *
 * The defence for the split was that suspending somebody in A is not
 * suspending them in B. That is not true of this server: `status` lives on the
 * USER row, so a suspension is the person, everywhere. What genuinely differs
 * per organisation is the role grant, and roles are merged onto the one row
 * as a set.
 *
 * Each row therefore carries:
 *   • `scopeOrgIds` — every organisation in this read that holds them, in
 *     the order they were asked for. This is the Organisation cell.
 *   • `scopeOrgId` — ONE of those, the address for any request made about
 *     the row. Their employing organisation when that is among them, because
 *     it is the one the server resolves identity edits against; otherwise the
 *     first that holds them.
 *   • `userRoles` — the union across those organisations, deduplicated,
 *     since a grant table can and does carry the same role twice.
 *
 * Deduplicating also covers a smaller fault that used to reach the screen: a
 * single organisation's list returning one person more than once.
 *
 * ## One slow tenant must not blank the others
 *
 * Fetches run in parallel and each one's failure is caught on its own, so a
 * roster that 403s or times out costs its own rows and nothing else. The
 * failures come back named, because a combined list that is quietly short is
 * worse than one that says which organisation is missing.
 */
export async function listUsersAcrossOrgs(orgIds, { access = "system", limit = 100 } = {}) {
  const ids = [...new Set((orgIds ?? []).filter(Boolean))];
  if (ids.length === 0) return { users: [], total: 0, failures: [] };

  const settled = await Promise.all(ids.map(async (id) => {
    try {
      const { users } = await listOrgUsers(id, { limit, access });
      return { id, users };
    } catch (err) {
      return { id, users: [], error: err };
    }
  }));

  /* Merged in the order the organisations were asked for, so the list is
     stable between reads: the first organisation that holds somebody is the
     one whose copy of their details is kept. The copies do not disagree —
     they are the same row of the same table — apart from the role grants,
     which are unioned below. */
  const byUser = new Map();
  for (const { id, users: rows } of settled) {
    for (const row of rows) {
      const held = byUser.get(row.id);
      if (!held) {
        byUser.set(row.id, {
          ...row,
          // Through the merge even when there is nothing to merge with: one
          // organisation's own list can carry the same grant twice.
          userRoles: mergeRoleGrants([], row.userRoles),
          scopeOrgId: id,
          scopeOrgIds: [id],
        });
        continue;
      }
      if (!held.scopeOrgIds.includes(id)) held.scopeOrgIds.push(id);
      held.userRoles = mergeRoleGrants(held.userRoles, row.userRoles);
    }
  }

  const users = [...byUser.values()].map((u) => (
    /* Their employer, when this read reaches it. Identity edits are resolved
       by the server against `organisationId`, so addressing the row there is
       the difference between a PATCH that lands and one that 404s. */
    u.organisationId && u.scopeOrgIds.includes(u.organisationId)
      ? { ...u, scopeOrgId: u.organisationId }
      : u
  ));
  return {
    users,
    total: users.length,
    failures: settled.filter((r) => r.error).map((r) => ({ orgId: r.id, error: r.error })),
  };
}

/**
 * Two organisations' copies of one person's grants, said once each.
 *
 * Keyed on the ROLE id rather than the grant id: the same role reached through
 * two organisations' lists is two grant rows, and a person does not hold a
 * role twice.
 */
function mergeRoleGrants(a = [], b = []) {
  const out = [...a];
  const seen = new Set(out.map((ur) => ur.role?.id ?? ur.roleId ?? ur.id));
  for (const ur of b) {
    const key = ur.role?.id ?? ur.roleId ?? ur.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ur);
  }
  return out;
}

/** The roles this organisation can hand out. Platform roles are never among them. */
export async function listAssignableRoles(orgId) {
  if (!orgId) return [];
  const res = await apiFetch(`${base(orgId)}/assignable-roles`);
  return res.data?.roles ?? [];
}

/**
 * Create a person and grant them this organisation.
 *
 * There is no password argument on purpose: an org admin invites, and the
 * person sets their own. The response carries `created` and `invite` so the
 * caller can tell "new account, invitation sent" from "existing account added
 * to your organisation" from "created, but no invitation could be sent" —
 * three outcomes that a single success message would flatten into a lie.
 */
export async function createOrgUser(
  orgId,
  { fullName, email, phone, employeeId, roleSlugs = [], memberships = [] },
) {
  const res = await apiFetch(`${base(orgId)}/provision`, {
    method: "POST",
    body: JSON.stringify({
      fullName,
      email,
      ...(phone ? { phone } : {}),
      ...(employeeId ? { employeeId } : {}),
      // Roles in the PATH organisation...
      roleSlugs,
      // ...and any other organisation, each with its own. The server re-checks
      // the caller against every one of these, so sending an organisation they
      // cannot administer earns a 403 rather than a silent partial grant.
      ...(memberships.length ? { memberships } : {}),
      sendInvite: true,
    }),
  });
  return res.data;
}

/**
 * Change a person's own details — name, phone, employee id.
 *
 * ## Against their HOME organisation, not the roster's
 *
 * `PATCH /organisations/:orgId/users/:userId` resolves the row with
 * `where: { id, organisationId: orgId }` — the home ORGANISATION COLUMN, not
 * a membership. The roster lists anybody with a live membership here too, so
 * calling this with the roster's scope organisation 404s for every visiting
 * member: the same asymmetry the delete path documents, where it measured 35
 * of 48 rows across the four live fleets.
 *
 * So the caller passes the person's own `organisationId`. The server still
 * checks the caller against THAT organisation — `requireOrgAccess` plus
 * `user:update` — which is why the panel disables these fields when the
 * administrator cannot reach the person's home.
 *
 * Email is not here because it is not in `updateUserSchema`: the server omits
 * it from the update shape deliberately, since the address is the identity an
 * invitation was issued against.
 */
export async function updateOrgUser(homeOrgId, userId, fields) {
  const body = {};
  for (const key of ["fullName", "phone", "employeeId"]) {
    if (fields[key] !== undefined) body[key] = fields[key];
  }
  const res = await apiFetch(`${base(homeOrgId)}/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return res.data?.user ?? res.data ?? null;
}

/** Send the set-password link again, invalidating the previous one. */
export async function resendInvite(orgId, userId) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(userId)}/resend-invite`, {
    method: "POST",
  });
  return res.data?.invite ?? { sent: false };
}

/** ACTIVE or SUSPENDED. Suspending also ends their sessions server-side. */
export async function setUserStatus(orgId, userId, status) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(userId)}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  return res.data?.user ?? null;
}

/** Set this person's role in every organisation they belong to, platform roles included. */
export async function setUserRole(orgId, userId, roleSlugs) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    body: JSON.stringify({ roleSlugs }),
  });
  return res.data?.memberships ?? [];
}

/**
 * Every organisation this person reaches, and the roles they hold in each.
 *
 * Not scoped to the path organisation: an administrator editing somebody needs
 * to see the whole picture, or "add them to Kabras as well" is a decision made
 * blind. The server still decides what may be CHANGED — each write is checked
 * against the organisation in its own URL.
 */
export async function listUserMemberships(orgId, userId) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(userId)}/memberships`);
  return res.data ?? [];
}

/**
 * Set what this person is in ONE organisation — adding it if they were not in
 * it before.
 *
 * `roleSlugs` is the COMPLETE set they should hold there, not an addition: the
 * server grants what is new and revokes what is missing. That is what makes
 * one call able to both add a role and take another away, and it is why the
 * caller must send the roles being kept as well as the one being added.
 *
 * `orgId` is the organisation being changed, which is NOT necessarily the one
 * being administered — adding somebody to a second site means calling this
 * with that site's id, and the server checks the caller against it.
 */
export async function setUserMembership(orgId, userId, roleSlugs) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(userId)}/memberships`, {
    method: "PUT",
    // allVehicles: the fleet scope is a separate concern with its own screen,
    // and sending a narrower one here would silently clear a restriction set
    // elsewhere.
    body: JSON.stringify({ roleSlugs, allVehicles: true, vehicleIds: [], vehicleGroupIds: [] }),
  });
  return res.data ?? [];
}

/**
 * Withdraw access to one organisation.
 *
 * Soft on the server: the membership and the roles held there are stamped
 * revoked rather than deleted, so the history of who had access to what
 * survives. The person keeps every other organisation.
 */
export async function removeUserMembership(orgId, userId) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(userId)}/memberships`, {
    method: "DELETE",
  });
  return res.data ?? [];
}

/**
 * Destroy the account. Not a status, not a flag — the row goes.
 *
 * A separate path from any soft delete rather than a parameter on one, because
 * a parameter that turns a reversible call irreversible is a mistake waiting
 * for the first person who copies a fetch out of the network tab.
 *
 * The server refuses more than it accepts, and the refusals are the useful
 * part of the response: you cannot delete yourself, you cannot delete somebody
 * whose home is another organisation (withdraw their membership here instead),
 * and you cannot delete anybody carrying operations history, because trips and
 * incidents name their driver through a nullable key and would silently lose
 * them. Each comes back as a 409 whose message names the reason and the
 * numbers, so the caller shows it rather than inventing one.
 *
 * Resolves to what was actually removed — the account, and the counts of the
 * role grants, sessions and invitations that went with it.
 */
export async function deleteOrgUserPermanently(orgId, userId) {
  const res = await apiFetch(`${base(orgId)}/${encodeURIComponent(userId)}/permanent`, {
    method: "DELETE",
  });
  return res.data ?? null;
}
