export function displayGroupText(value = "") {
  return String(value).replace(/\s+—\s+/g, " ");
}

/**
 * The custom organisations already set up through user groups, once each by
 * name (without case), with a logo where one of its groups has one and the
 * groups that carry it.
 */
export function groupOrganisations(groups) {
  const byName = new Map();
  for (const g of groups ?? []) {
    const name = g.organisation?.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const held = byName.get(key) ?? { name, logoUrl: null, groupIds: [], groupNames: [] };
    held.logoUrl ??= g.organisation.logoUrl ?? null;
    held.groupIds.push(g.id);
    held.groupNames.push(g.name);
    byName.set(key, held);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
