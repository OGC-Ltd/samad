// Mock vehicle maintenance records.



const MAINTENANCE_RECORDS = [
  { vehicleId: "KBU 123A", companyId: "sukari", lastServiceDate: "2026-05-15", lastServiceTask: "Battery health check", nextServiceDue: "2026-08-13", status: "ok", odometerKm: 156445, issues: [] },
  { vehicleId: "KDA 456B", companyId: "sukari", lastServiceDate: "2026-03-31", lastServiceTask: "Air filter replacement", nextServiceDue: "2026-06-29", status: "overdue", odometerKm: 86407, issues: [] },
  { vehicleId: "KBG 234D", companyId: "sukari", lastServiceDate: "2026-04-28", lastServiceTask: "Air filter replacement", nextServiceDue: "2026-07-27", status: "ok", odometerKm: 62673, issues: [] },
  { vehicleId: "KDC 890F", companyId: "sukari", lastServiceDate: "2026-05-26", lastServiceTask: "Exhaust system check", nextServiceDue: "2026-08-09", status: "ok", odometerKm: 179215, issues: [] },
  { vehicleId: "KDF 123J", companyId: "sukari", lastServiceDate: "2026-04-28", lastServiceTask: "Clutch inspection", nextServiceDue: "2026-07-27", status: "ok", odometerKm: 156749, issues: [] },
  { vehicleId: "KBP 789L", companyId: "sukari", lastServiceDate: "2026-04-16", lastServiceTask: "Engine oil & filter change", nextServiceDue: "2026-07-15", status: "ok", odometerKm: 201349, issues: [] },
  { vehicleId: "KBV 012M", companyId: "sukari", lastServiceDate: "2026-04-04", lastServiceTask: "Wheel alignment", nextServiceDue: "2026-06-18", status: "overdue", odometerKm: 53610, issues: ["Coolant level slightly below minimum"] },
  { vehicleId: "KBW 678P", companyId: "sukari", lastServiceDate: "2026-06-17", lastServiceTask: "Air filter replacement", nextServiceDue: "2026-09-15", status: "ok", odometerKm: 123535, issues: [] },
  { vehicleId: "KDE 234R", companyId: "sukari", lastServiceDate: "2026-05-02", lastServiceTask: "Full service (10,000 km)", nextServiceDue: "2026-07-31", status: "ok", odometerKm: 174085, issues: [] },
  { vehicleId: "KDD 890T", companyId: "sukari", lastServiceDate: "2026-04-27", lastServiceTask: "Clutch inspection", nextServiceDue: "2026-07-26", status: "ok", odometerKm: 39204, issues: [] },
  { vehicleId: "KDJ 789W", companyId: "sukari", lastServiceDate: "2026-06-11", lastServiceTask: "Battery health check", nextServiceDue: "2026-09-09", status: "ok", odometerKm: 144634, issues: [] },
  { vehicleId: "KDH 901M", companyId: "sukari", lastServiceDate: "2026-02-20", lastServiceTask: "Battery health check", nextServiceDue: "2026-05-06", status: "overdue", odometerKm: 104583, issues: ["Coolant level slightly below minimum"] },
  { vehicleId: "KCA 112X", companyId: "sukari", lastServiceDate: "2026-05-28", lastServiceTask: "Brake pad inspection", nextServiceDue: "2026-08-11", status: "ok", odometerKm: 185624, issues: [] },
  { vehicleId: "KBZ 334Y", companyId: "sukari", lastServiceDate: "2026-05-19", lastServiceTask: "Brake pad inspection", nextServiceDue: "2026-08-17", status: "ok", odometerKm: 139322, issues: [] },
  { vehicleId: "KDD 567Z", companyId: "sukari", lastServiceDate: "2026-03-09", lastServiceTask: "Air filter replacement", nextServiceDue: "2026-05-23", status: "overdue", odometerKm: 93968, issues: ["Slight brake pad wear on rear axle"] },
  { vehicleId: "KDE 901A", companyId: "sukari", lastServiceDate: "2026-05-21", lastServiceTask: "Brake pad inspection", nextServiceDue: "2026-08-19", status: "ok", odometerKm: 148045, issues: [] },
  { vehicleId: "KDF 230B", companyId: "sukari", lastServiceDate: "2026-05-05", lastServiceTask: "Suspension check", nextServiceDue: "2026-08-03", status: "ok", odometerKm: 108720, issues: [] },
  { vehicleId: "KDC 445C", companyId: "sukari", lastServiceDate: "2026-06-11", lastServiceTask: "Gearbox oil change", nextServiceDue: "2026-09-09", status: "ok", odometerKm: 41971, issues: [] },
  { vehicleId: "KDH 778D", companyId: "sukari", lastServiceDate: "2026-04-14", lastServiceTask: "Engine oil & filter change", nextServiceDue: "2026-06-28", status: "overdue", odometerKm: 73283, issues: ["Slight brake pad wear on rear axle"] },
];

export default MAINTENANCE_RECORDS;
