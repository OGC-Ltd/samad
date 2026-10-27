/**
 * The DISTINCT roles an account holds, across every organisation.
 *
 * ## The bug this exists to stop
 *
 * The account page reported roles by counting memberships. Somebody made
 * System Administrator in four organisations read as "4 Roles", beside a chip
 * row spelling the same two words four times:
 *
 *     [Platform Administrator, System Administrator, System Administrator, …]
 *
 * That is the number of ASSIGNMENTS, which is a real fact but not the one the
 * label claims. A person with one job does not acquire three more by being
 * given it at three more sites.
 *
 * ## Why the key is the NAME and not the slug
 *
 * Slug was the obvious key and it does not work. A Role row on this server
 * belongs to ONE organisation — account.service.ts selects `organisationId`
 * and buckets roles by it — so "System Administrator" at four sites is four
 * rows, and nothing constrains those rows to spell their slug identically.
 * Keying on slug merged nothing and left the duplicates on screen.
 *
 * The rule that actually holds is about the words the reader sees: two chips
 * reading "System Administrator" are one role, however the database spells it
 * underneath. Case and surrounding whitespace are normalised out of the key;
 * the first spelling encountered is the one displayed.
 *
 * ## Platform roles win
 *
 * A platform role has `organisationId` NULL and applies everywhere, which is a
 * strictly larger claim than holding the same-named role at one site. When
 * both exist the entry is marked `platform: true`, so the chip can say "applies
 * in every organisation" rather than naming a subset of them.
 *
 * `orgs` carries the organisations each role was found in — the fact the old
 * per-membership count was standing in for, kept as something a tooltip can
 * show instead of a number that misreads as a total.
 *
 * Pure and in lib/ because vitest here runs `environment: 'node'` with no
 * jsdom: a pure function is the only part of this that a test can pin.
 */

/** @typedef {{ slug?: string, name: string, assignedAt?: string }} Role */
/** @typedef {Role & { key: string, platform: boolean, orgs: string[] }} HeldRole */

/** The identity of a role, for the reader: its name, case- and space-insensitive. */
function keyOf(role) {
  return String(role?.name ?? role?.slug ?? "").trim().toLowerCase();
}

/**
 * @param {{ organisations?: Array<{ name?: string, roles?: Role[] }>, platformRoles?: Role[] }} access
 * @returns {HeldRole[]} platform roles first, then org roles in the order met
 */
export function uniqueRoles(access) {
  const byKey = new Map();

  for (const role of access?.platformRoles ?? []) {
    const key = keyOf(role);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { ...role, key, platform: true, orgs: [] });
  }

  for (const org of access?.organisations ?? []) {
    for (const role of org?.roles ?? []) {
      const key = keyOf(role);
      if (!key) continue;
      const held = byKey.get(key);
      if (held) {
        // Recorded once per organisation. The same role granted twice at one
        // site is still one place it is held, and listing it twice in a
        // tooltip would reintroduce the counting bug one level down.
        if (org.name && !held.orgs.includes(org.name)) held.orgs.push(org.name);
      } else {
        byKey.set(key, { ...role, key, platform: false, orgs: org.name ? [org.name] : [] });
      }
    }
  }

  return [...byKey.values()];
}

/** The same de-duplication as a display string: "Platform Administrator, System Administrator". */
export function roleNames(roles) {
  return [
    ...new Map((roles ?? []).map((r) => [keyOf(r), r.name])).values(),
  ].filter(Boolean).join(", ");
}
