

// Vehicle list, search, drivers, cargo groups.

import VEHICLES from "../data/vehicleData";

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function byCompany(companyId) {
  return companyId ? VEHICLES.filter((v) => v.companyId === companyId) : VEHICLES;
}

export async function getVehicles({ companyId } = {}) {
  return byCompany(companyId);
}

export async function getVehicleById(id) {
  return VEHICLES.find((v) => v.id === id);
}

export async function searchVehicles(query, { companyId } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return byCompany(companyId).filter(
    (v) =>
      v.id.toLowerCase().includes(q) ||
      v.driver.toLowerCase().includes(q)
  );
}

export async function getFleetStatusCounts({ companyId } = {}) {
  const counts = { ok: 0, warning: 0, critical: 0, offline: 0 };
  byCompany(companyId).forEach((v) => {
    if (v.status === "ok") counts.ok += 1;
    else if (v.status === "speeding") counts.warning += 1;
    else if (v.status === "theft") counts.critical += 1;
    else if (v.status === "parked") counts.offline += 1;
  });
  return counts;
}

export async function getCargoGroups({ companyId } = {}) {
  const groups = {};
  byCompany(companyId).forEach((v) => {
    const key = slugify(v.cargo);
    if (!groups[key]) {
      groups[key] = { id: key, cargoName: v.cargo, totalTonnage: 0, vehicles: [] };
    }
    groups[key].totalTonnage += v.weight;
    groups[key].vehicles.push({
      plate: v.id,
      driver: v.driver,
      tonnage: v.weight,
    });
  });
  return Object.values(groups);
}

export async function getDrivers({ companyId } = {}) {
  return byCompany(companyId).map((v) => ({
    id: v.id,

    name: v.driver,
    vehicleId: v.id,
    status: v.status,
    cargo: v.cargo,
    location: v.location,
  }));
}

export async function searchDrivers(query, { companyId } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const drivers = await getDrivers({ companyId });
  return drivers.filter(
    (d) =>
      d.name.toLowerCase().includes(q) ||
      d.vehicleId.toLowerCase().includes(q)
  );
}
