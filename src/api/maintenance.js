

// Vehicle maintenance records and summary.

import MAINTENANCE_RECORDS from "../data/maintenanceData";
import VEHICLES from "../data/vehicleData";

function withVehicleInfo(record) {
  const vehicle = VEHICLES.find((v) => v.id === record.vehicleId);
  return {
    ...record,
    driver: vehicle?.driver ?? "Unassigned",
    cargo: vehicle?.cargo ?? "-",
  };
}

export async function getMaintenanceRecords({ companyId } = {}) {

  const STATUS_ORDER = { overdue: 0, "due-soon": 1, ok: 2 };
  const list = companyId
    ? MAINTENANCE_RECORDS.filter((r) => r.companyId === companyId)
    : MAINTENANCE_RECORDS;

  return list
    .map(withVehicleInfo)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

export async function getMaintenanceSummary({ companyId } = {}) {
  const list = companyId
    ? MAINTENANCE_RECORDS.filter((r) => r.companyId === companyId)
    : MAINTENANCE_RECORDS;

  const counts = { ok: 0, dueSoon: 0, overdue: 0 };
  list.forEach((r) => {
    if (r.status === "ok") counts.ok += 1;
    else if (r.status === "due-soon") counts.dueSoon += 1;
    else if (r.status === "overdue") counts.overdue += 1;
  });
  return counts;
}
