// What makes a fuel alert, for the three places that show one: the fuel
// alerts list (FuelAlertsMenu), the incident window (MapOverlay) and the
// sidebar's Fleets > Fuel branch.
//
// Theft cases only (operator, 2026-09-27: "the fuel alert captures only theft
// cases and all other cases go into the daily summary"). The server already
// sends only those as a unit's open incident; this holds the line for anything
// else that still arrives, so no view mixes the two. Whether an incident may be
// called a theft is the server's call (`mayUseTheftWording`), never re-derived.

/** How sure the server must be that a case was a theft before it reads CONFIRMED — the operator's 80%. */
export const CONFIRMED_THEFT_CONFIDENCE = 0.8;

/** An incident the server lets us call a possible theft. */
export const isTheftIncident = (incident) => incident?.mayUseTheftWording === true;

/** A unit whose open fuel incident is a possible theft. */
export const isTheftAlert = (v) => isTheftIncident(v?.fuelIncident);

/** A theft case the server is at least 80% sure of. */
export const isConfirmedTheft = (incident) =>
  incident?.mayUseTheftWording === true && (incident.confidence ?? 0) >= CONFIRMED_THEFT_CONFIDENCE;
