// Route traffic conditions per vehicle/fleet.
//
// Conditions are deterministic pseudo-traffic seeded from the vehicle id, but
// every route NAME comes from the vehicle's live journey leg (server sim), so
// the card only ever mentions places the fleet actually drives.

const SEVERITY = ["clear", "moderate", "heavy"];

const HIGHLIGHT_TEMPLATES = [
  (loc) => `Congestion reported near ${loc}`,
  (loc) => `Roadworks slowing traffic near ${loc}`,
  (loc) => `Accident reported on route near ${loc}`,
  (loc) => `Heavy trucks backed up approaching ${loc}`,
  (loc) => `Police checkpoint near ${loc}`,
];

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function trafficFor({ vehicleId, departure, destination } = {}) {
  const seed = hashString(vehicleId || "unknown");

  const condition = SEVERITY[seed % 3];
  const delayMin = condition === "clear" ? 0 : condition === "moderate" ? 5 + (seed % 12) : 18 + (seed % 25);

  const highlightCount = condition === "clear" ? 0 : condition === "moderate" ? 1 : 2;
  const locations = [departure, destination].filter(Boolean);

  const highlights = Array.from({ length: highlightCount }, (_, i) => {
    const loc = locations[i % locations.length] || "your route";
    const template = HIGHLIGHT_TEMPLATES[(seed + i * 7) % HIGHLIGHT_TEMPLATES.length];
    const severity = i === 0 && condition === "heavy" ? "heavy" : "moderate";
    return { severity, text: template(loc) };
  });

  return { condition, delayMin, highlights };
}

export async function getTrafficHighlights(args = {}) {
  return trafficFor(args);
}

// Vehicles currently ON the road — same phase buckets the header uses.
const ENROUTE = /^(TO_FARM|TO_INDUSTRY|TO_DEPOT|TO_PARKING|TO_GARAGE|FROM_GARAGE)$/;

/** Fleet-wide summary from the LIVE fleet (useFleetLiveShared vehicles). */
export function summarizeFleetTraffic(vehicles = []) {
  const active = vehicles.filter(
    (v) => ENROUTE.test(v.phase ?? "") && v.departure && v.destination
  );

  const perVehicle = active.map((v) => ({
    vehicle: v,
    traffic: trafficFor({ vehicleId: v.id, departure: v.departure, destination: v.destination }),
  }));

  const delayed = perVehicle.filter((p) => p.traffic.condition !== "clear");
  const worst = [...delayed]
    .sort((a, b) => b.traffic.delayMin - a.traffic.delayMin)
    .slice(0, 3)
    .map((p) => ({
      severity: p.traffic.condition,
      text: `${p.vehicle.id} - ${p.traffic.highlights[0]?.text || `+${p.traffic.delayMin} min delay`}`,
    }));

  return {
    activeRoutes: active.length,
    delayedRoutes: delayed.length,
    highlights: worst,
  };
}
