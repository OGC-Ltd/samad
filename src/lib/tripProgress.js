// Where a dispatched vehicle is along its round trip, recomputed from the LIVE
// position.
//
// The server sends the trip with its geometry already worked out, but from the
// snapshot's fix — which is up to a warm-cache sweep old. The SSE stream then
// moves the vehicle without re-sending the trip, so a bar drawn from the
// server's numbers alone would sit still while the truck visibly drove across
// the map. The two anchors it needs (the yard and the destination) are constant
// for the run and ride along on the payload, so the ratio can be redone here on
// every frame.
//
// This deliberately mirrors the server's lib/dispatch-trip.ts and must stay in
// step with it. The split is not arbitrary: everything requiring HISTORY stays
// there (`arrived` needs every fix since dispatch), and only the part that is a
// function of the current point is repeated here.

const R_EARTH_M = 6371000;

export function haversineM(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(h));
}

/** The plant is a compound, not a point — see the server's YARD_RADIUS_M. */
const YARD_RADIUS_M = 800;

const arrivalRadiusM = (spreadM) => Math.min(Math.max((spreadM ?? 0) * 2, 800), 3000);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * @param {object|null} trip  the snapshot's `trip` object
 * @param {number|null} lat   live latitude
 * @param {number|null} lng   live longitude
 * @returns {object|null} the trip with `percent`, `leg`, `fromYardM`,
 *   `toDestinationM` recomputed, or the trip unchanged when there is nothing
 *   live to recompute from.
 */
export function liveTrip(trip, lat, lng) {
  if (!trip) return null;
  // No fix since the dispatch was raised: the server said so from history, and
  // a current position cannot overturn it — the vehicle's newest fix may well
  // predate the dispatch entirely. 20 of 52 open runs are in this state.
  if (trip.leg === "no-fix") return trip;
  if (lat == null || lng == null) return trip;

  const here = { lat, lng };
  const yard = trip.yardLat != null && trip.yardLng != null
    ? { lat: trip.yardLat, lng: trip.yardLng } : null;
  const dest = trip.destinationLat != null && trip.destinationLng != null
    ? { lat: trip.destinationLat, lng: trip.destinationLng } : null;

  const fromYardM = yard ? Math.round(haversineM(yard, here)) : null;
  const toDestinationM = dest ? Math.round(haversineM(dest, here)) : null;

  const atYard = fromYardM != null && fromYardM <= YARD_RADIUS_M;
  const atDest = toDestinationM != null && toDestinationM <= arrivalRadiusM(trip.destinationSpreadM);
  // `arrivedAt` is the server's, from every fix since dispatch — a vehicle on
  // its way home retraces the outbound road, so distance alone cannot tell the
  // two legs apart.
  const arrived = trip.arrivedAt != null || atDest;

  let leg;
  if (atDest)       leg = "at-destination";
  else if (arrived) leg = atYard ? "back" : "returning";
  else if (atYard)  leg = "at-yard";
  else              leg = "outbound";

  const legM = trip.legM;
  const percent = (legM == null || legM === 0 || fromYardM == null)
    ? null
    : (leg === "at-yard" || leg === "outbound")
      ? Math.round(clamp01(fromYardM / legM) * 50)
      : leg === "at-destination"
        ? 50
        : 50 + Math.round(clamp01(1 - fromYardM / legM) * 50);

  return { ...trip, fromYardM, toDestinationM, leg, percent };
}

/**
 * Has the load come off?
 *
 * A trip is CLOSED by the sign-in, but the bed is emptied long before that — a
 * sales run tips its sugar at the customer and drives home with nothing on it,
 * and on the Naitiri route that gap is the whole return leg plus however long
 * the paperwork takes. So this is not the sign-in.
 *
 * ## It is the EXIT from the zone, not the entry
 *
 * Arriving is not offloading. A truck that has just rolled through the Raiply
 * gate is standing in the yard with 29 t of sugar still on the bed, waiting its
 * turn at the bay — and the operator asking "what is on that truck" while it
 * sits there wants to be told "processed sugar", not "empty". Emptying it on
 * arrival wrote the load off at the moment the wheels crossed the line, which
 * on this route is up to an hour before a bag comes off.
 *
 * So the load comes off when the unit has been inside the zone AND has left it
 * again. That pair is exactly `returning` and `back`: `tripGeometry` reaches
 * neither except through `arrived`, which is the first fix recorded INSIDE the
 * arrival radius since dispatch, and it reaches them only while the current
 * position is outside it. Entry alone is `at-destination`, and `at-destination`
 * is now a laden state.
 *
 * Nothing here can be fooled by a unit that merely drove past: `arrived` is
 * durable and history-derived (the server's dispatch.repository computes it
 * from every fix since the dispatch clock), so a truck 40 km down the road that
 * never went in is still `outbound` and still loaded.
 *
 * It does mean a unit that tips its load and then parks inside the perimeter
 * overnight reads as laden until it pulls out. That is the honest answer: the
 * only evidence this system has of the bags moving is the truck leaving without
 * them, and there is no weighbridge at the far end to say otherwise.
 *
 * The server decides this too, and for the same reason it decides `percent`:
 * that answer comes from the snapshot's fix and is up to a cache sweep old,
 * while this one is recomputed from the live position — so the bed empties as
 * the truck crosses back out of the gate rather than a minute afterwards.
 */
export function hasDelivered(trip) {
  return trip != null
    && (trip.leg === "returning" || trip.leg === "back");
}

/**
 * Is this run home but not yet closed?
 *
 * A TRIP IS COMPLETED BY THE SIGN-IN. The guard signs the unit back in, the
 * provider records a return, and the row leaves the open set — so a completed
 * run never reaches this card at all, and nothing shown here is ever finished.
 * `back` therefore means "standing at the gate with the paperwork outstanding",
 * which is a state somebody has to act on, and it must not be dressed as an
 * arrival tick.
 *
 * Only claimed for a run whose departure was a sign-out, because that is the
 * lifecycle we know a guard closes by hand (see the server's
 * `departureIsSignOut`). A cane dispatch is closed by the provider recording a
 * return, which is not a person at a gate, so it keeps the plainer wording.
 */
export function awaitingSignIn(trip) {
  return trip?.leg === "back" && trip.departureIsSignOut === true;
}

/** The leg in the operator's words, refined by how this run will be closed. */
export function legLabel(trip) {
  if (!trip) return null;
  if (awaitingSignIn(trip)) return "Back, awaiting sign-in";
  return LEG_LABEL[trip.leg] ?? trip.leg;
}

/** Operator-facing wording for a leg. */
export const LEG_LABEL = {
  "no-fix":         "No fix since dispatch",
  "at-yard":        "At the yard",
  "outbound":       "Outbound",
  "at-destination": "At destination",
  "returning":      "Returning",
  "back":           "Back at the yard",
};

// coveredKm() was here: percent × the round-trip length, i.e. how far along the
// run the vehicle is as a distance. It is deleted rather than left unused
// because it was being rendered as "27.8 / 51.4 km round trip", which reads as
// distance TRAVELLED and is a different number — a unit that reached its
// destination yesterday is half way round having driven nothing today, and the
// vehicle brief said 0.2 km beside a card saying 27.8 km. Distance driven now
// comes from the server as `trip.distanceTodayKm`, measured through the
// vehicle's own fixes, and the bar's caption states a percentage instead.

export function roundTripKm(trip) {
  if (!trip || trip.legM == null) return null;
  return +((trip.legM * 2) / 1000).toFixed(1);
}

/**
 * Below this the vehicle is not making progress and an ETA is a division by
 * almost zero.
 *
 * 5 km/h rather than 0: a tracker reports a stationary truck as 1-3 km/h on
 * GPS scatter alone, and at 2 km/h the 40 km still to run computes as twenty
 * hours away — a number that is arithmetically correct, wrong by a factor of
 * twenty, and indistinguishable on screen from a real one.
 */
const MOVING_KMH = 5;

/**
 * How far there is still to go, and when it arrives at the current speed.
 *
 * ## It is a straight line, and it says so
 *
 * `toDestinationM` is great-circle, because that is the only distance this
 * system has: a road route needs a routing provider, and the one thing worse
 * than a straight-line ETA is a road-shaped one that was never routed. Real
 * road distance on the Naitiri to Raiply run is longer than the 49.9 km
 * straight line, so this ETA is optimistic by whatever the road winds — which
 * is why the caller renders the distance beside it rather than the clock alone.
 *
 * ## Speed is instantaneous, so the floor matters more than the maths
 *
 * There is no smoothing here and deliberately no state: this is called from a
 * hover card that mounts and unmounts under the pointer, so any trailing window
 * it kept would be empty exactly when it was first looked at. Instead a vehicle
 * below MOVING_KMH gets a distance and no clock — "38 km to go, stopped" is
 * both true and useful, where "38 km to go, arriving 06:14 tomorrow" is
 * neither.
 *
 * ## Which end it is counting down to
 *
 * The far end while outbound, the yard while returning. A dispatch is a round
 * trip and a driver heading home is not "18 km from Raiply", he is forty
 * minutes from the gate.
 *
 * @param {object|null} trip     a trip from liveTrip()
 * @param {number|null} speedKmh the vehicle's current speed
 * @returns {{remainingKm: number, towards: 'destination'|'yard',
 *            minutes: number|null, etaMs: number|null, moving: boolean}|null}
 *   null when there is no distance to count down — no geometry, or the run is
 *   at one of its two ends and therefore has arrived at something.
 */
export function tripEta(trip, speedKmh, now = Date.now()) {
  if (!trip) return null;
  const towards = (trip.leg === "returning") ? "yard"
                : (trip.leg === "outbound" || trip.leg === "at-yard") ? "destination"
                : null;
  // 'at-destination' and 'back' are arrivals, and 'no-fix' has no position to
  // measure from. None of the three has a distance still to run.
  if (towards === null) return null;

  const remainingM = towards === "yard" ? trip.fromYardM : trip.toDestinationM;
  if (remainingM == null) return null;

  const moving = Number.isFinite(speedKmh) && speedKmh >= MOVING_KMH;
  const minutes = moving ? Math.round((remainingM / 1000) / speedKmh * 60) : null;

  return {
    remainingKm: Math.round(remainingM / 100) / 10,
    towards,
    minutes,
    etaMs: minutes == null ? null : now + minutes * 60_000,
    moving,
  };
}

/**
 * "1 h 12 m", "48 m". Never "0 h 48 m" and never a decimal hour.
 *
 * Minutes alone stop reading as a duration somewhere past about ninety of them
 * — "212 m" is a number you have to convert before you can act on it, and the
 * whole point of this figure is that it is glanceable.
 */
export function fmtDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}
