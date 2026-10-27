// One unit's fuel for one fleet day, as a ledger an operator can check.
//
// Replaces the fuel incident window's "Record / Movement / Came back / Rule"
// rows, which described how the verdict was reached and left the reader to
// work out what the day actually looked like. This answers that directly:
//
//   opening level + refuelled − closing level = fuel used, by the tank
//   engine hours × the unit's own burn rate  = what the engine should use
//   the difference                            = what the engine does not explain
//
// then says in words what that means for the case (dayAssessment), and lists
// the day's events in order, the one being looked at marked.
//
// ## Why the events are listed and not added up
//
// Flagged events overlap and re-measure the same fall. MUFINDI - DZ 20 on
// 2026-09-25 had four in an hour, one of them an undulation where the fuel
// never left, and their volumes summed to 95.7 L against a tank that fell
// 58.2 L. A total built from them would be a number nothing measured. The tank
// ledger above them is the arithmetic; the events are when and what.

/** Fleet days are Kenyan (EAT, UTC+3, no DST), as the server buckets them. */
const FLEET_OFFSET_MS = 3 * 3_600_000;

/** "2026-09-25", the fleet day containing `iso`. */
export function fleetDayOf(iso) {
  return new Date(new Date(iso).getTime() + FLEET_OFFSET_MS).toISOString().slice(0, 10);
}

/** [start, end) of a fleet day, as ISO instants. */
export function fleetDayBounds(day) {
  const start = Date.parse(`${day}T00:00:00Z`) - FLEET_OFFSET_MS;
  return { from: new Date(start).toISOString(), to: new Date(start + 86_400_000).toISOString() };
}

/**
 * A refuel only counts when the fuel arrived. REDISTRIBUTION on a filling means
 * the tracker reported one and the tank is no fuller: a probe swing, not a
 * delivery (see chipKind in SensorPanel for the same rule).
 */
const realRefuel = (f) => f.verdict !== "REDISTRIBUTION";

/** A drop the server called a possible theft — the only kind the window highlights. */
export const isTheftEvent = (e) => e.type === "drop" && e.verdict === "DRAIN" && e.cause === "SIPHON";

/** How an event reads in the timeline. "Theft" only for the one cause allowed
 *  the word, and only as "Possible theft": elsewhere the probe sees a level
 *  fall, not where the fuel went. */
export function eventLabel(e) {
  if (e.type === "refuel") return e.verdict === "REDISTRIBUTION" ? "Refuel reported, tank no fuller" : "Refuelled";
  if (e.verdict === "REDISTRIBUTION") return "Level dipped and came back";
  if (e.verdict === "SENSOR_FAULT") return "Probe fault";
  if (e.verdict === "PENDING" || !e.verdict) return "Drop, still settling";
  return {
    SIPHON: "Possible theft",
    HIGH_BURN: "Burn above normal",
    UNEXPLAINED_BURN: "Burn far above normal",
  }[e.cause] ?? "Drop, stayed down";
}

/**
 * The day, from the three sources.
 *
 * `tank`     the unit's row from /fuel/tank-state?date= (initialMl, currentMl,
 *            engineBurnMl, engineSeconds, engineRateLPerHour, distanceM)
 * `fillings` /fuel/fillings for the unit and day
 * `drops`    /fuel/thefts for the unit and day
 *
 * Litres throughout. Any figure whose inputs are missing is null, never a
 * guess: a ledger line with an invented end is worse than a dash.
 */
export function dayBreakdown({ tank, fillings = [], drops = [] }) {
  const L = (ml) => (ml == null ? null : ml / 1000);

  const refuels = fillings.filter(realRefuel);
  const refuelled = refuels.reduce((s, f) => s + (f.filledMl ?? 0), 0) / 1000;
  const opening = L(tank?.initialMl);
  const closing = L(tank?.currentMl);
  const used = opening != null && closing != null ? opening + refuelled - closing : null;
  const engine = L(tank?.engineBurnMl);
  const unexplained = used != null && engine != null ? used - engine : null;

  const events = [
    ...fillings.map((f) => ({
      id: f.id, type: "refuel", at: f.filledAt, litres: L(f.filledMl), verdict: f.verdict,
    })),
    ...drops.map((d) => ({
      id: d.id, type: "drop", at: d.beganAt, litres: L(d.stolenMl), verdict: d.verdict,
      cause: d.drainCause, cameBack: L(d.recoveredMl),
    })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  return {
    opening,
    refuelled,
    refuelCount: refuels.length,
    closing,
    used,
    engine,
    engineHours: tank?.engineSeconds != null ? tank.engineSeconds / 3600 : null,
    engineRate: tank?.engineRateLPerHour ?? null,
    // A road vehicle on RaiFactorySuite's register is rated in km/L: the
    // expectation is then its distance at that rate, not hours at an hourly one.
    engineKmPerL: tank?.engineRateKmPerL ?? null,
    // 'register' = the operator's standard rate; 'vehicle' / 'type' = derived.
    engineRateBasis: tank?.engineRateBasis ?? null,
    unexplained,
    distanceKm: tank?.distanceM != null ? tank.distanceM / 1000 : null,
    events,
  };
}

/**
 * Whether the unexplained part is worth drawing attention to. A few litres
 * either way is the probe and the rate estimate disagreeing, not an event:
 * flagged at 5 L and 10 % of what the engine should have used, whichever is
 * larger.
 */
export function unexplainedMatters(b) {
  if (b.unexplained == null) return false;
  return b.unexplained > Math.max(5, 0.1 * (b.engine ?? 0));
}

// ── what the day shows ──────────────────────────────────────────────────────
//
// The ledger used to end on "Not explained: +32.1 L", which left the reader to
// do the case work the window has every figure for (operator, 2026-09-27: "why
// should we render not explained and we have every data to evaluate the case").
// `dayAssessment` does it: what the engine burned, what the theft took, and
// where the rest of the fall happened — before the theft, after it, or with the
// engine running — in sentences an operator can check against the tiles above.

const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit", hour12: false });
const litres = (v) => `${(Math.round(v * 10) / 10 || 0).toFixed(1)} L`;
/** A litre either way is the probe, not fuel. */
const SAME_LEVEL_L = 1;

/** "12 h 59 min", "40 min". */
export function hoursLabel(h) {
  if (h == null) return null;
  const m = Math.round(h * 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/**
 * Sentences reading the day, first one the headline; [] without a tank ledger.
 *
 * `b` is `dayBreakdown`'s result, `incident` the case the window is open on
 * (its tank before/after and start time place the rest of the fall), `today`
 * whether the day is still running.
 */
/** "standard" for the operator's register rate, "usual" for a derived one. */
const rateWord = (b) => (b.engineRateBasis === "register" ? "standard" : "usual");

/** The "Engine should use" caption: what the figure is that rate times. */
export function engineBasisLabel(b) {
  if (b.engineKmPerL != null) {
    return b.distanceKm != null ? `${b.distanceKm.toFixed(1)} km at ${b.engineKmPerL.toFixed(1)} km/L` : "no distance";
  }
  if (b.engineHours == null) return "no engine hours";
  return `${hoursLabel(b.engineHours)}${b.engineRate != null ? ` at ${b.engineRate.toFixed(1)} L/h` : ""}`;
}

export function dayAssessment(b, incident = null, today = false) {
  if (b?.used == null) return [];
  const dayWord = today ? "today" : "that day";
  const lost = b.used;
  const out = [];

  // 1. What the engine burned.
  const ran = b.engineHours != null && b.engineHours * 60 >= 1;
  const engineL = b.engineHours != null && !ran ? 0 : b.engine;
  if (b.engineHours != null && !ran) {
    out.push(`The engine did not run ${dayWord}, so none of the ${litres(lost)} the tank lost was burned.`);
  } else if (engineL != null) {
    const which = rateWord(b);
    const did = b.engineKmPerL != null && b.distanceKm != null
      ? `It covered ${b.distanceKm.toFixed(1)} km at its ${which} ${b.engineKmPerL.toFixed(1)} km/L`
      : `The engine ran ${hoursLabel(b.engineHours)}${b.engineRate != null ? ` at its ${which} ${b.engineRate.toFixed(1)} L/h` : ""}`;
    out.push(engineL >= lost
      ? `${did}, which burns ${litres(engineL)}, enough to cover all of the ${litres(lost)} the tank lost.`
      : `${did}, which burns ${litres(engineL)} of the ${litres(lost)} the tank lost.`);
  } else {
    out.push(`There is no engine-hour record for ${dayWord}, so the ${litres(lost)} the tank lost cannot be set against a burn.`);
  }

  // 2. What the theft took.
  const thefts = b.events.filter(isTheftEvent);
  const theftL = thefts.reduce((s, e) => s + (e.litres ?? 0), 0);
  const L = (ml) => (ml == null ? null : ml / 1000);
  const before = L(incident?.tankBeforeMl), after = L(incident?.tankAfterMl);
  const began = incident?.beganAt ? Date.parse(incident.beganAt) : null;
  if (thefts.length === 1) {
    const mine = thefts[0].id === incident?.id;
    const levels = mine && before != null && after != null ? ` (${litres(before)} → ${litres(after)})` : "";
    out.push(`${litres(theftL)} of it is ${mine ? "this" : "the"} possible theft at ${CLOCK.format(new Date(thefts[0].at))}${levels}.`);
  } else if (thefts.length > 1) {
    out.push(`${litres(theftL)} of it is ${thefts.length} possible thefts, at ${thefts.map(e => CLOCK.format(new Date(e.at))).join(", ")}.`);
  }

  // 3. The rest, and where it happened.
  if (engineL == null) return out;
  const rest = lost - engineL - theftL;
  const matters = Math.abs(rest) > Math.max(5, 0.1 * engineL);
  if (!matters) {
    out.push(thefts.length ? "Nothing else is missing." : "The rest matches the engine hours: nothing is missing.");
    return out;
  }
  if (rest < 0) {
    out.push(`That is ${litres(-rest)} under its ${rateWord(b)} rate for ${b.engineKmPerL != null ? "that distance" : "those hours"}, so nothing is missing.`);
    return out;
  }
  // Placed against the case's own levels, where no refuel and no running
  // engine muddies the tank between them and the day's two ends.
  const refuelBefore = began != null && b.events.some(e => e.type === "refuel" && e.verdict !== "REDISTRIBUTION" && Date.parse(e.at) < began);
  const refuelAfter  = began != null && b.events.some(e => e.type === "refuel" && e.verdict !== "REDISTRIBUTION" && Date.parse(e.at) >= began);
  const pre  = !ran && !refuelBefore && b.opening != null && before != null ? b.opening - before : null;
  const post = !ran && !refuelAfter && b.closing != null && after != null ? after - b.closing : null;
  const at = began != null ? CLOCK.format(new Date(began)) : null;
  const other = thefts.length ? "The other" : "Another";
  if (pre != null && post != null && pre > SAME_LEVEL_L && post <= SAME_LEVEL_L) {
    out.push(`${other} ${litres(rest)} went before ${at}, with no event of its own: the tank read ${litres(b.opening)} at the start of the day and ${litres(before)} when ${incident?.mayUseTheftWording ? "the theft" : "this drop"} began, a fall too gradual to be reported on its own.`);
  } else if (pre != null && post != null && post > SAME_LEVEL_L && pre <= SAME_LEVEL_L) {
    out.push(`${other} ${litres(rest)} went after ${at}, with no event of its own: ${litres(after)} then, ${litres(b.closing)} ${today ? "now" : "at the end of the day"}.`);
  } else {
    out.push(`${other} ${litres(rest)} is more than the engine hours account for, and no event of its own covers it.`);
  }
  if (post != null && post <= SAME_LEVEL_L && today) out.push("Nothing has gone since.");
  return out;
}
