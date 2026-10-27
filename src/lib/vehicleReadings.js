/* What the trackers actually report, and nothing else.
 *
 * This replaces lib/maintenanceSchedule.js, which graded every vehicle against
 * a hardcoded catalogue of service intervals — oil every 5,000 km, tyres every
 * 8,000, and so on — and rendered the result as "Health 62%", "Overdue",
 * "1,240 km to service". None of that was measured. It was:
 *
 *     (odometerKm - maintenanceResetOdoKm) % <an interval someone invented>
 *
 * and in live production `maintenanceResetOdoKm` is 0 for all 224 vehicles
 * (the field came from the retired simulator's `_sim.maintenance` block),
 * `nextServiceOdoKm` is null for all 224, and `inMaintenance` is false for all
 * 224. So the modulo ran against a reset point that does not exist, over
 * intervals nobody supplied, and presented the output as fact. There is no
 * maintenance system feeding this platform — `vehicle_garage_visits` has 0
 * rows — so no service state can be known at all.
 *
 * What CAN be known comes from the Wialon unit: its own mileage counter, its
 * engine-hours counter, a calibrated fuel probe where one is fitted, and when
 * it last reported. Coverage is partial and that is shown rather than hidden,
 * so "—" is a real and common answer here.
 *
 * But partial against WHAT was itself getting the answer wrong. The odometer
 * used to read "57% of the fleet", which sounds like half the trackers are
 * broken; it is 280 of the 284 vehicles that HAVE a tracker — 99% — against a
 * registry of 597 whose other 313 rows have no unit bound and never could
 * report. Every ratio here is measured against `denominator`, the trackable
 * count, for that reason. See readingCoverage.
 */

/** A unit is considered offline once it has been silent this long. */
const REPORTING_WINDOW_MS = 60 * 60_000

/**
 * A fuel percentage is only meaningful if the probe is calibrated against the
 * tank it is in. Allow a little headroom over 100 (a brimmed tank genuinely
 * reads slightly over on some probes) and reject the rest as uncalibrated.
 */
const MAX_PLAUSIBLE_FUEL_PCT = 110

function plausiblePct(pct) {
  if (pct == null || !Number.isFinite(pct)) return null
  if (pct < 0 || pct > MAX_PLAUSIBLE_FUEL_PCT) return null
  return Math.round(pct)
}

/**
 * Sensor readings for one snapshot vehicle. Every field is either a real
 * measurement or null — never a default, never derived from an assumption.
 */
export function vehicleReadings(vehicle) {
  // NOTE: these are the field names lib/vehicleMap produces, NOT the raw API
  // ones. The snapshot's `capturedAt` / `fuelLevelMl` / `tankCapacityLitres`
  // become `capturedAtMs` / `fuelLitres` / `tankCapacityL` on the way through.
  const lastReportedAt = Number.isFinite(vehicle?.capturedAtMs) ? vehicle.capturedAtMs : null

  const tankLitres = vehicle?.tankCapacityL ?? null
  const fuelLitres = Number.isFinite(vehicle?.fuelLitres) ? vehicle.fuelLitres : null

  return {
    // Wialon's own total-mileage counter (`cnm_km`). Not a trip distance.
    odometerKm: Number.isFinite(vehicle?.odometerKm) ? vehicle.odometerKm : null,
    // Engine-hours counter (`cneh`) — the better wear proxy for plant and
    // tractors, which work hard without travelling far.
    engineHours: Number.isFinite(vehicle?.engineHours) ? vehicle.engineHours : null,
    // Calibrated probe reading, null where the unit has no probe or no
    // calibration table. Never a raw ADC value.
    fuelLitres,
    // Percentage of tank. Server-computed when it sent one, else derived.
    //
    // Suppressed when it comes out physically impossible: KASULU has units
    // reporting 7,184 L against a 540 L tank — 1,330% — because the probe has
    // no valid calibration table for that vehicle. A percentage is a DERIVED
    // figure, and when its inputs contradict each other the honest answer is
    // that we do not have one. The raw litres the probe reported are still
    // shown beside it, so nothing is hidden; only the bogus derivation goes.
    fuelPct: plausiblePct(
      Number.isFinite(vehicle?.fuelLevel)
        ? vehicle.fuelLevel
        : (fuelLitres != null && tankLitres ? (fuelLitres / tankLitres) * 100 : null),
    ),
    // The probe is fitted and transmitting, but reporting a hardware fault
    // rather than a level — contamination, a short, water in the tank. Without
    // this, a broken probe and a vehicle with no probe at all are the same
    // empty cell, and only one of them is a job for the workshop. The server
    // reads it off the unit's own sensor config; see wialon.sensors.
    fuelProbeFault: vehicle?.fuelProbeFault === true,
    lastReportedAt,
    isReporting: lastReportedAt != null && Date.now() - lastReportedAt < REPORTING_WINDOW_MS,
    // Does the PROVIDER know this unit at all?
    //
    // `connectionOnline` is Wialon's own verdict and it is TRI-state: true and
    // false both mean "there is a unit and here is its state", null means there
    // is no unit — which is exactly what a vehicle with no tracker bound looks
    // like. 314 of SUKARI's 598 rows are in that third state, and they can
    // never report anything: no odometer, no fuel, no fix, ever.
    //
    // They are counted apart from the fleet for the same reason
    // `fuelUncalibrated` is counted apart from "no sensor" — the fix for a
    // silent tracker is to chase the tracker, the fix for a vehicle with no
    // tracker is to fit one, and folding them together hides the second job
    // while making the first look enormous.
    hasTracker: vehicle?.connectionOnline != null,
    // vehicleMap flattens the boolean to an 'on' | 'off' string.
    engineOn: vehicle?.engine === 'on' ? true : vehicle?.engine === 'off' ? false : null,
  }
}

/**
 * Fleet-wide sensor COVERAGE — how many units report each channel.
 *
 * This is what replaced the Overdue / Due Soon / Monitor / Good tally. Those
 * counts asserted a service state nothing measured; this counts what is
 * actually being received, which is both true and operationally useful — a
 * unit that stopped reporting its odometer is a real problem worth seeing.
 */
export function readingCoverage(vehicles) {
  const out = {
    total: 0, tracked: 0, untracked: 0,
    odometer: 0, engineHours: 0, fuel: 0, reporting: 0,
    fuelUncalibrated: 0,
  }
  for (const v of vehicles ?? []) {
    const r = vehicleReadings(v)
    out.total++
    if (r.hasTracker) out.tracked++; else out.untracked++
    if (r.odometerKm != null)  out.odometer++
    if (r.engineHours != null) out.engineHours++
    if (r.isReporting)         out.reporting++
    if (hasWorkingFuelSensor(r))      out.fuel++
    else if (r.fuelLitres != null)    out.fuelUncalibrated++
  }
  // What every channel above is measured AGAINST.
  //
  // Not `total`. A vehicle with no tracker cannot report an odometer, so
  // counting it in the denominator does not describe a coverage gap — it
  // dilutes a real figure with rows the provider has never heard of. On SUKARI
  // that was the difference between "171 / 598 (29%)" and "171 / 284 (61%)":
  // the same measurement, reading as a crisis or as normal depending purely on
  // whether 314 phantom rows were in the divisor.
  //
  // Falls back to `total` when NOTHING carries a verdict, which is the
  // API-only/poller-off case (see lib/vehicleMap isOnline) — there we have no
  // basis to call any row untracked, and a zero divisor would render NaN%.
  out.denominator = out.tracked || out.total
  return out
}

/**
 * Does this unit have a fuel sensor we can actually USE?
 *
 * Two conditions, and the second is not pedantry. A probe can report a volume
 * while having no valid calibration table for the tank it is in — KASULU has
 * units reporting 7,184 L against a 540 L tank. Those are wired up but their
 * output is not usable, so they are counted separately (`fuelUncalibrated`)
 * rather than being folded into either "has a sensor" or "has none": the fix
 * for a missing probe is to fit one, the fix for an uncalibrated probe is to
 * calibrate it, and conflating the two hides the second job entirely.
 */
export function hasWorkingFuelSensor(readings) {
  return readings?.fuelLitres != null && readings?.fuelPct != null
}

// ── formatting ──────────────────────────────────────────────────────────────
// One em dash, used everywhere a channel is not reported, so "no reading" is
// visually distinct from a real zero.

export const NO_READING = '-'

export function formatKm(km) {
  return km == null ? NO_READING : `${Math.round(km).toLocaleString()} km`
}

export function formatHours(h) {
  return h == null ? NO_READING : `${Math.round(h).toLocaleString()} h`
}

export function formatLitres(l) {
  return l == null ? NO_READING : `${l.toFixed(1)} L`
}

export function formatPct(p) {
  return p == null ? NO_READING : `${p}%`
}

/** "4 min ago" / "2 h ago" — or NO_READING when the unit has never reported. */
export function formatSince(ms) {
  if (ms == null) return NO_READING
  const delta = Date.now() - ms
  if (delta < 60_000) return 'just now'
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  return `${Math.floor(hrs / 24)} d ago`
}
