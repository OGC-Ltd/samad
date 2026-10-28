// Maps fleet-server vehicles onto the shape FleetMap/MapOverlay already expect
// (the old mock vehicleData shape), so the map, tooltip, search and filters keep
// working unchanged. Two entry points: mapSnapshotVehicle (initial /snapshot
// rows) and applyLiveUpdate (each SSE 'position' event), which share deriveStatus
// so a live update grades the vehicle the same way the snapshot did.

import { isTheftIncident } from './fuelAlerts'
import { plateIn } from './plate';

/**
 * The limit to use when the server did not send one.
 *
 * A LAST RESORT, not the rule. The effective limit is per machine type and
 * lives in one place on the server (`overspeedLimitFor`, driven by
 * OVERSPEED_LIMIT_BY_TYPE); it now travels on the snapshot as `speedLimitKmh`.
 * This file used to hold its own 80, playback held a third, and two cards fell
 * back to a fourth — so setting a 50 km/h limit for tractors would have left
 * every one of those judging them at 80 and the screens contradicting the feed.
 *
 * Exported under the old name too, because DriversScreen and the vehicle cards
 * import it; both now prefer `vehicle.speedLimit`, which this populates.
 */
export const FALLBACK_SPEED_LIMIT = 80
/** @deprecated Prefer `vehicle.speedLimit` — kept for existing importers. */
export const SPEED_LIMIT = FALLBACK_SPEED_LIMIT

// Legal max payload per vehicle type, in TONNES — must match the server's
// MAX_PAYLOAD_KG (tractors 20 t, trucks & lorries 36 t).
export function maxPayloadTonnes(vehicleType) {
  if (vehicleType === 'TRACTOR') return 20
  if (vehicleType === 'TRUCK' || vehicleType === 'LORRY') return 36
  if (vehicleType === 'BELL LOADER') return 0   // in-field loader — carries no cargo
  return 30
}

// fleettrack's 4-state scheme (ok / speeding / theft / parked), derived from the
// backend's engine + speed + violation flags. `theft` maps to fuel-inconsistency
// (siphoning), the same signal fleetdash treats as critical.

/**
 * km/h at or above which a unit counts as moving.
 *
 * In transit is "engine on and moving": 1 km/h and above.
 *
 * Mirrors MOVING_THRESHOLD_KMH in the server's lib/movement-state and must
 * keep mirroring it — if the two differ, a vehicle reads "In Transit" on the
 * card while its run row, which the server grades, reports it idling.
 *
 * It was 3, to clear the 1-2 km/h of GPS jitter a stationary unit can emit.
 * That jitter does not show up in this account: across 82 online units the
 * speeds were 77 at exactly 0 and 5 at 6+, nothing in between, so Wialon
 * filters it upstream.
 */
export const MOVING_THRESHOLD_KMH = 1

/**
 * The one idling colour — sky blue, matching `--accent-idling` in App.scss.
 *
 * Idling gets its own accent because it is neither healthy nor an alert. It
 * was amber on the vehicle card and the driver card, which is the SPEEDING
 * colour, so a stationary vehicle read as a violation.
 *
 * It was briefly folded into the green with the other online states, on the
 * reasoning that one question deserves one hue. That is REVERSED, by request:
 * idling is the state an operator is actually hunting for on this fleet — a
 * truck burning fuel while it sits — and a step within green is too quiet a
 * way to say so. Sky blue is loud enough to find and still not an alert
 * colour, which is the balance this constant has always been for.
 *
 * A literal rather than the CSS variable because these are written as inline
 * styles and composed with alpha suffixes (`IDLING_COLOR + "1a"`), which
 * `var()` cannot do. Keep it in step with --accent-idling.
 */
export const IDLING_COLOR = '#06b6d4'

/** Moving under power — the live equivalent of the simulator's `leg.moving`,
 *  and the same test the server uses to count IN TRANSIT. */
function isMoving(v) {
  return Boolean(v?.engineOn) && (v?.speedKmh ?? 0) >= MOVING_THRESHOLD_KMH
}

/**
 * Resolve a search query to ONE vehicle.
 *
 * Shared by the search box (which shows the result card) and the map (which
 * flies to it). They used to match independently with the same substring rule;
 * the moment either side changed, the card could describe one vehicle while the
 * camera moved to another. One function, one answer.
 *
 * Exact matches win over substring ones: typing a full plate must never land on
 * some other unit that merely contains it.
 */
export function findVehicleByQuery(vehicles, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return null
  const id     = v => String(v?.id ?? '').toLowerCase()
  const driver = v => String(v?.driver ?? '').toLowerCase()
  return vehicles.find(v => id(v) === q)
      ?? vehicles.find(v => driver(v) === q)
      ?? vehicles.find(v => id(v).includes(q))
      ?? vehicles.find(v => driver(v).includes(q))
      ?? null
}

/**
 * A tracker is DARK when its last fix is older than this.
 *
 * Distinct from "offline". Offline is a connection verdict that flips within
 * minutes and reverses just as fast. Dark means the unit has told us nothing
 * for a day or more, so the position still pinned to the map is a historical
 * fact, not a current one. Measured 2026-08-01: 77 of Sukari's 278 located
 * vehicles and 53 of Kasulu's 211 are dark, the worst at 564 days, most with a
 * single ping ever — the signature of a unit that died and left one last fix.
 */
export const DARK_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Has this vehicle's tracker gone dark? `null` capturedAt counts as dark: a
 * vehicle with a position but no timestamp cannot be shown to be current.
 */
export function isDark(vehicle, now = Date.now()) {
  const ms = vehicle?.capturedAtMs ?? (vehicle?.capturedAt ? Date.parse(vehicle.capturedAt) : null)
  if (!Number.isFinite(ms)) return true
  return now - ms >= DARK_AFTER_MS
}

/** How long a dark vehicle has been silent, compactly: "3d", "45d", "18h". */
export function darkAgeLabel(vehicle, now = Date.now()) {
  const ms = vehicle?.capturedAtMs ?? (vehicle?.capturedAt ? Date.parse(vehicle.capturedAt) : null)
  if (!Number.isFinite(ms)) return '?'
  const hrs = Math.floor((now - ms) / 3_600_000)
  if (hrs < 48) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`
}

/**
 * Is this unit LIVE?
 *
 * The provider's verdict decides it, with one override. `connectionOnline` is
 * that verdict (Wialon's `netconn`, carried by the server — see
 * lib/connection-state). `null` — no verdict — is NOT online, because "we
 * don't know" is not "connected".
 *
 * The override is isRunningNow: a unit reporting ignition on and covering
 * ground, in a frame fresh enough to be about now, is online whatever netconn
 * says. A machine that is demonstrably working cannot be drawn as
 * unreachable. Read that predicate's note before widening it — the freshness
 * gate is the only thing standing between this and the 15-minute window
 * described below, and on the live fleet it is the difference between one
 * unit and twenty.
 *
 * There used to be a fallback: with no verdict, anything that had reported in
 * the last 15 minutes counted as online. Two reasons it is gone.
 *
 * It is a different question. Against the live Wialon account the 15-minute
 * window disagreed with the provider on 28 of 224 units, 25 of them units
 * Wialon called offline while we showed them online. "Sent a message recently"
 * is not "is connected" — a unit can post a queued frame and be gone.
 *
 * And it inflated the count wherever the verdict was missing. An API-only
 * fleet-server (POLL_ENABLED=false) populates no connection state at all, so
 * every vehicle arrives with `connectionOnline: null` and the window alone
 * decided: 161 of Sukari's 597 read ONLINE against a true count of 0.
 *
 * Consequence worth knowing: against a backend that never supplies the verdict,
 * the whole fleet now reads OFFLINE. That is the honest answer — the poller is
 * what knows, and it is not running — but it is why a local dev dashboard can
 * show 0 online while production is correct.
 */
export function isOnline({ connectionOnline, engineOn, speedKmh, movement, capturedAt, capturedAtMs }) {
  if (connectionOnline === true) return true
  return isRunningNow({ engineOn, speedKmh, movement, capturedAt, capturedAtMs })
}

/**
 * How fresh the evidence of a running unit has to be to overrule the verdict.
 *
 * The same 30 minutes signalLost uses, and for the same reason: past that, a
 * frame describes what the unit WAS doing, not what it is doing.
 */
const RUNNING_EVIDENCE_MS = 30 * 60_000

/**
 * Is this unit demonstrably working RIGHT NOW, whatever the provider says?
 *
 * Ignition on, covering ground, and reporting recently enough for all three to
 * be one fact rather than three old ones. Only then does it overrule
 * `connectionOnline`.
 *
 * ## The freshness gate is the whole predicate
 *
 * Without it this is the removed 15-minute window again, and worse. Measured
 * against the live Sukari account on 2026-09-21: 20 of 597 units report
 * `engineOn: true` with a non-zero speed while the provider calls them
 * offline — and their fixes are 58, 35, 285, 20, 187, 173, 143 and 60 DAYS
 * old. They are frozen frames that were never superseded, not lorries on the
 * road. Meanwhile `connectionCheckedAt` has a median age of 27 seconds, so the
 * verdict really is the fresher signal, exactly as signalLost's note says.
 *
 * With the gate, 2 of those qualify — which is the honest answer, and the
 * reason the gate is not a tunable. Widen it and the map starts painting
 * eight-month-old frames green.
 *
 * ## Why `movement.state` is not enough on its own
 *
 * The server stops calling a run 'moving' after an hour of silence, so on a
 * unit that dropped mid-journey it can still read 'moving' while the fix
 * rots. Speed is read from the same frame as the ignition, which is what makes
 * the pair a single observation.
 */
export function isRunningNow({ engineOn, speedKmh, movement, capturedAt, capturedAtMs }) {
  if (engineOn !== true) return false
  if (!((speedKmh ?? 0) > 0 || movement?.state === 'moving')) return false
  const ms = capturedAtMs ?? (capturedAt ? Date.parse(capturedAt) : null)
  if (!Number.isFinite(ms)) return false
  const age = Date.now() - ms
  return age >= 0 && age <= RUNNING_EVIDENCE_MS
}

/**
 * Five states: theft > speeding > parked(offline) > idling > ok.
 *
 * `idling` comes from the SERVER's movement tracker, never from engineOn here:
 * the server reports state='idling' ONLY where a real ignition reading (Wialon
 * `engine operation` → io_239, fitted on 222/224 units) supports it, and
 * 'resting' otherwise — so this never has to guess.
 */
export function deriveStatus({ speedKmh, flags, capturedAt, capturedAtMs, movement, connectionOnline, engineOn, speedLimitKmh }) {
  if (flags?.fuelInconsistency) return 'theft'
  const spd = speedKmh ?? 0
  // The unit's OWN limit when the server sent one — see FALLBACK_SPEED_LIMIT.
  if (flags?.overspeeding || spd > (speedLimitKmh ?? FALLBACK_SPEED_LIMIT)) return 'speeding'

  // 'parked' (shown as OFFLINE) means the PROVIDER reports no connection —
  // not "hasn't moved" and not "hasn't pinged in a while". It is the one
  // thing an operator has to be able to spot, so it must match what Wialon
  // itself shows for the unit.
  if (!isOnline({ connectionOnline, engineOn, speedKmh, movement, capturedAt, capturedAtMs })) return 'parked'

  // Online and burning fuel while stationary — worth seeing on the map as its
  // own thing rather than being folded into the healthy 'ok' bucket.
  if (movement?.state === 'idling') return 'idling'
  return 'ok'
}

/**
 * What an ONLINE vehicle is doing: 'transit' | 'idling' | 'parked'.
 *
 * ## One classification, used everywhere
 *
 * This is the single source for the card's activity chip, the map marker's
 * colour and the filter counts. They used to derive activity separately —
 * driverDutyStatus for the chip, deriveStatus for the marker — and could
 * disagree about the same vehicle: during the server's 3-minute stop grace a
 * vehicle has movement.state 'moving' but zero speed, which made the chip read
 * "Idling" while the marker stayed green.
 *
 * ## The three are MUTUALLY EXCLUSIVE
 *
 * That is the point: a vehicle that was in transit and stops with its engine
 * running LEAVES transit and becomes idling, so the counts stay a partition.
 * For any online fleet:
 *
 *     transit + idling + parked === online
 *
 * Alerts (speeding, theft) are NOT part of this. They are a separate axis and
 * overlap it — a speeding vehicle is in transit and flagged.
 *
 * Offline vehicles report 'parked' but are excluded from the online buckets by
 * their connection state; their last frame cannot support an activity claim.
 */
export function vehicleActivity(vehicle) {
  // Compared against the ROUNDED speed the UI prints, so the classification
  // never contradicts the number shown beside it.
  if (vehicle?.engine === 'on' && (vehicle?.speed ?? 0) >= MOVING_THRESHOLD_KMH) return 'transit'

  // Stationary. The tracker distinguishes idling from parked only where a real
  // ignition line backs it; 'moving' here means a stop inside the grace period,
  // which says nothing usable about right now, so it falls through.
  const state = vehicle?.movement?.state
  if (state === 'idling')  return 'idling'
  if (state === 'resting') return 'parked'

  // Mid-stop or no movement data. Same rule the server applies: ignition on
  // means idling. Without an ignition line engineOn is speed-derived, so at a
  // standstill it is false and this collapses to parked.
  return vehicle?.engine === 'on' ? 'idling' : 'parked'
}

/**
 * Equipment code → what the machine actually IS.
 *
 * The server classifies each unit into a coarse class (PLANT, TRUCK, TRACTOR)
 * because that is what payload limits and marker sprites need. It is too blunt
 * to show a person: an excavator, a dozer, a grader and a backhoe all read
 * "Plant". The code that prefixes every unit name carries the real answer, so
 * the card shows that and keeps the class for everything else.
 *
 * Operator's legend, confirmed 2026-07-29. Codes NOT listed here (HST, GL,
 * SPY, T) are deliberately absent — they are unconfirmed, and falling back to
 * the class is better than inventing a name for them.
 */
const EQUIPMENT_LABELS = {
  LMV:  'Light Motor Vehicle',
  EX:   'Excavator',
  FT:   'Flatbed Truck',
  HFT:  'Heavy Flatbed Truck',
  MTR:  'Motor Tractor',
  WL:   'Wheel Loader',
  DZ:   'Dozer',
  FTT:  'Flatbed Trailer Truck',
  CTR:  'Cane Tractor',
  BH:   'Backhoe',
  COM:  'Commercial Vehicle',
  COMP: 'Compactor',
  CM:   'Compactor',   // the operator's other code for one
  HYD:  'Tractor',
  GR:   'Grader',
  BUS:  'Bus',
  DB:   'Dump Body',
  WB:   'Water Bowser',
  DG:   'Diesel Generator',   // MUFINDI - DG 12/13; the server's KASULU:DG
}

/**
 * The equipment code in a vehicle's name, or null when it carries none.
 *
 * Scans for the first token that IS a known code rather than assuming a
 * position — mirroring codeFromName in the server's wialon.vehicle-type, for
 * the same reasons: a site prefix can sit in front of the code
 * ("MUFINDI: OPTIM - CM 01"), some names carry no code at all
 * ("MUFINDI: 002"), and "MUFINDI:T199 ELC" is a plate, not equipment.
 */
function equipmentCode(vehicle) {
  const name = vehicle?.id ?? ''
  for (const token of String(name).toUpperCase().split(/[^A-Z0-9]+/)) {
    if (token && token in EQUIPMENT_LABELS) return token
  }
  return null
}

/**
 * A machine-family CODE as prose — 'EX' → 'Excavator'.
 *
 * Takes the code directly, where `equipmentLabel` below takes a vehicle and
 * digs the code out of its name. The Analytics vehicle-type filter already has
 * the code (the server groups by it, and it is the same `category` field
 * fleet-state puts on every unit), so it needs the second half of that journey
 * on its own.
 *
 * An UNKNOWN code returns itself rather than null. The deliberate gap in
 * EQUIPMENT_LABELS — HST, GL, SPY, T are unconfirmed, and OPTIM is a site
 * prefix rather than a machine — is right for a card that would otherwise
 * invent a name, but a filter has to be able to OFFER those units: 24 of
 * KASULU's 218 are OPTIM, and a filter that could not reach them would make
 * the parts disagree with the whole. Showing the operator their own code is
 * honest; inventing an expansion of it would not be.
 */
export function machineCategoryLabel(code) {
  const raw = String(code ?? '')
  // Compared BEFORE upper-casing: the sentinel is lower-case, so folding case
  // first made it a code like any other and the filter offered a row labelled
  // "__UNPREFIXED" to an operator.
  if (!raw || raw === UNPREFIXED_CODE) return 'No code'
  const c = raw.toUpperCase()
  return EQUIPMENT_LABELS[c] ?? c
}

/** Plates carrying no recognisable family at all — 14 of KASULU's 218 units
 *  are named `MUFINDI: 013`. Shared with the server's `UNPREFIXED`. */
export const UNPREFIXED_CODE = '__unprefixed'

/**
 * The specific equipment name for a vehicle, or null when its code is not one
 * we can name.
 *
 * The operator's own register wins: KASULU units listed on RaiFactorySuite's
 * machine register carry its `machineName` ("Excavator", "Bull Dozer", "CASE
 * PUMA"), which names the machine where the code only names its family —
 * every CTR read "Cane Tractor" whether it was a Case Puma or a Steiger. Shown
 * as the register spells it. Units it does not list fall back to the code.
 */
export function equipmentLabel(vehicle) {
  const registered = typeof vehicle?.machineName === 'string' ? vehicle.machineName.trim() : ''
  if (registered) return registered
  const code = equipmentCode(vehicle)
  return code ? EQUIPMENT_LABELS[code] : null
}

/**
 * Equipment code → the marker sprite that actually depicts it.
 *
 * The kind groups the Fleets type filter. The map draws every kind with the
 * truck atlas (FleetMap.scss). A code is listed here ONLY where it genuinely
 * names that machine —
 * everything else falls back to 'truck', which is honest about being generic
 * rather than dressing an excavator up as something it is not.
 *
 * Deliberately NOT mapped, pending meshes (unit counts as of 2026-07-29):
 *   FT 17 · FTT 14 · GR 3 · HFT 3 · DB 3 · WB 2
 *
 * CTR shares the tractor sprite with MTR on purpose: a cane tractor IS a farm
 * tractor — what makes it a cane tractor is the trailer it tows, not the
 * machine — so a separate mesh would differ only in a trailer that crowds the
 * cell at 40 px.
 */
const SPRITE_FOR_CODE = {
  LMV:  'lmv',   // Isuzu NKR light truck
  BUS:  'bus',
  BH:   'bh',    // backhoe loader
  WL:   'wl',    // wheel loader
  EX:   'ex',    // tracked hydraulic excavator
  DZ:   'dz',    // crawler bulldozer
  MTR:  'mtr',   // motor tractor
  CTR:  'mtr',   // cane tractor — same machine
  COMP: 'comp',  // single-drum roller
  CM:   'comp',  // the operator's other code for one
  DG:   'gen',   // canopied diesel genset
}

/**
 * Machine keywords → sprite, for fleets that carry no equipment code.
 *
 * Kasulu's units are NAMED by machine ("MUFINDI: OPTIM - CM 01"), so
 * equipmentCode above resolves them. Sukari's come from Controltech, where
 * `id` is a bare plate ("KHMA 858U") and the machine only appears in the
 * descriptive name ("125F Bell 38", "BOMAG COMPACTOR BW213PD-40", "Faw Prime
 * mover CA4181"). Without this every one of Sukari's 597 vehicles drew as the
 * generic truck — including 481 tractors.
 *
 * Ordered most specific first: "BOMAG COMPACTOR" must match the compactor
 * before anything else, and a "PRIME MOVER" is a truck even though the fleet
 * is mostly tractors. Brands are listed only where the brand implies the
 * machine in THIS fleet — Bell and Haulmaster are cane-haulage tractors here,
 * Mahindra/Same/Landini are farm tractors, Faw/Sino build the prime movers.
 */
const MACHINE_KEYWORDS = [
  [/\b(GENERATOR|GENSET)\b/,                                        'gen'  ],
  // West Sugar names its bikes "West Sugar-Bike-KMGJ 333W", "WKS - Bike - …".
  [/\b(MOTOR\s*BIKE|MOTOR\s*CYCLE|BIKES?|BODA)\b/,                  'mc'   ],
  [/\b(COMPACTOR|BOMAG|ROLLER)\b/,                                  'comp' ],
  [/\b(EXCAVATOR|DOOSAN)\b/,                                        'ex'   ],
  // Cat's D-series ("CATERPILLAR D8GC", "D8R") are crawler dozers. Matched on
  // the model because the names never say "dozer".
  [/\b(DOZER|BULLDOZER)\b|\bCATERPILLAR\s*D\d/,                     'dz'   ],
  [/\b(BACKHOE|JCB)\b/,                                             'bh'   ],
  [/\b(WHEEL\s*LOADER|WHEELBELL\s*LOADER|SHOVEL|LOADER)\b/,         'wl'   ],
  [/\b(BUS|BUSES|COASTER)\b/,                                       'bus'  ],
  // Truck-mounted plant. A hydra-crane IS a truck, so 'truck' is accurate
  // rather than a fallback. Graders have no mesh yet, and a grader is nothing
  // like a light vehicle — generic truck is the honest answer, not a wrong one.
  [/\b(CRANE|HYDRACRANE|HYDRAUKLIC|GRADER)\b/,                      'truck'],
  [/\b(PRIME\s*MOVER|TIPPER|LORRY|CANTER|TANKER|BOWSER)\b/,         'truck'],
  [/\b(MAHINDRA|HAULMASTER|BELL|SAME|LANDINI|MASSEY|TRACTOR)\b/,    'mtr'  ],
]

/** Coarse provider type → sprite. Beats brand names, loses to machine class. */
const SPRITE_FOR_TYPE = {
  TRACTOR:         'mtr',
  TRUCK:           'truck',
  COMPANY_VEHICLE: 'lmv',
  BUS:             'bus',
  GENERATOR:       'gen',
  MOTORCYCLE:      'mc',
  MOTORBIKE:       'mc',
}

/** Body styles, checked only when nothing stronger decided. */
const BODY_KEYWORDS = [
  [/\b(DOUBLE\s*CAB|D\/CABIN|PICK\s*-?\s*UP|HILUX|PROBOX|LAND\s*ROVER)\b/, 'lmv'],
  [/\b(LANDCRUISER|LAND\s*CRUISER|HIACE|VAN|SALOON)\b/,                    'lmv'],
  // Kenyan motorcycle plates are KM + two letters ("KMGJ 333W"); cars carry
  // three letters. Checked last because a plate is weak evidence: Naitiri's
  // "SAME 9358 (KMHA 326X)" is a tractor, and the brand catches it first.
  [/\bKM[A-Z]{2}\s*\d{3}[A-Z]\b/,                                         'mc' ],
]

/**
 * The sprite kind a vehicle's marker should draw from. Never null.
 *
 * Resolved strongest signal first, because the signals genuinely conflict.
 * Brand is the weakest of them: Mitsubishi builds both the Fuso tipper and a
 * pickup, Toyota both a Land Cruiser and a Hino, so a brand keyword must never
 * outrank the provider's own vehicleType — putting MITSUBISHI in the machine
 * list drew Sukari's Fuso trucks as light vehicles.
 */
export function spriteKind(vehicle) {
  // 1. An explicit equipment code in the name — unambiguous by construction.
  const code = equipmentCode(vehicle)
  if (code && SPRITE_FOR_CODE[code]) return SPRITE_FOR_CODE[code]

  const text = `${vehicle?.name ?? ''} ${vehicle?.id ?? ''}`.toUpperCase()

  // 2. A named machine class beats everything else.
  for (const [re, kind] of MACHINE_KEYWORDS) if (re.test(text)) return kind

  // 3. The provider's coarse type.
  const byType = SPRITE_FOR_TYPE[vehicle?.vehicleType]
  if (byType) return byType

  // 4. Body style, then the honest generic.
  for (const [re, kind] of BODY_KEYWORDS) if (re.test(text)) return kind
  return 'truck'
}

/**
 * Fleet TYPE — the machine-class axis the Fleets funnel filters on.
 *
 * ## Why this keys off spriteKind rather than the equipment code
 *
 * The two fleets name their machines in completely different ways. Kasulu's
 * units carry an equipment code in the name ("MUFINDI: OPTIM - CM 01"), so
 * `equipmentCode` resolves them. Sukari's `id` is a bare plate ("KHMA 858U")
 * and the machine only appears in the descriptive name ("BOMAG COMPACTOR
 * BW213PD-40"). A filter grouped on the CODE would therefore offer Kasulu a
 * real list and drop all 597 of Sukari's units into one "No code" bucket —
 * which is exactly the shape of filter nobody can use.
 *
 * `spriteKind` already resolves a machine class for EVERY vehicle in both
 * fleets, strongest signal first, because the map markers had the same problem
 * first. Keying on it means the funnel groups vehicles the same way the map
 * draws them: what a row says is what its markers look like. A vehicle can
 * never fall outside the list, so the rows always sum to the fleet.
 */
export const FLEET_TYPE_LABELS = {
  truck: 'Truck',
  mtr:   'Tractor',
  lmv:   'Light Vehicle',
  bus:   'Bus',
  ex:    'Excavator',
  wl:    'Wheel Loader',
  dz:    'Dozer',
  bh:    'Backhoe',
  comp:  'Compactor',
  mc:    'Motorbike',
  gen:   'Generator',
}

/**
 * Fold a live frame's movement record into the one we already hold.
 *
 * ## `exact: false` is an ABSENCE of evidence, and must not overwrite evidence
 *
 * `movement.exact` means "the server watched this unit make the transition".
 * False means it did not — it was already looking at a stopped machine when it
 * started, so its `since` is when IT started, not when the machine stopped.
 *
 * The snapshot and the live stream disagree about this, and measurably: over 61
 * vehicles compared on Mufindi, 49 arrive from /vehicles/snapshot with
 * `exact: true` and a real stop time, and then arrive over the live stream with
 * `exact: false` and a `since` of a few minutes ago. None went the other way.
 * MUFINDI: BH 03 is the shape of it — snapshot says it stopped on 25 August and
 * we saw it happen; the live frame says it stopped at 03:42 this morning and we
 * did not.
 *
 * A wholesale `data.movement ?? existing.movement` therefore DOWNGRADED every
 * one of those units on the first frame after load, which is what made the
 * "Stopped in transit" list fill from the snapshot and then empty seconds later:
 * `strandedStop` requires `exact === true`, so 28 units became 0 without a
 * single machine moving.
 *
 * So a frame that admits it saw nothing keeps the older record's `since` and
 * `exact`, and contributes only what it does know — the current state. A frame
 * that DID see the transition wins outright, which is what lets a genuine new
 * stop replace an old one.
 *
 * Both arms are cheap and neither invents anything: this only ever prefers the
 * observation that was actually made.
 */
function mergeMovement(existing, incoming) {
  if (!incoming) return existing ?? null
  if (!existing) return incoming

  // It saw the transition, or the unit is moving now: either way this frame is
  // the better record.
  if (incoming.exact === true || incoming.state === 'moving') return incoming

  // It did not. Keep the stop we have evidence for, take the state it reports.
  if (existing.exact === true && existing.state !== 'moving') {
    return { ...existing, state: incoming.state ?? existing.state, moving: incoming.moving ?? existing.moving }
  }

  return incoming
}

/** A sprite kind as prose. Unknown kinds return themselves rather than null —
 *  same reasoning as machineCategoryLabel: a filter must be able to OFFER a
 *  unit it cannot name, or the parts stop summing to the whole. */
export function fleetTypeLabel(kind) {
  return FLEET_TYPE_LABELS[kind] ?? String(kind ?? '')
}

/** The vehicle's fleet type. Never null — see spriteKind. */
export function fleetType(vehicle) {
  return spriteKind(vehicle)
}

/**
 * The type rows for a given fleet, biggest first.
 *
 * Derived from the vehicles handed in rather than from FLEET_TYPE_LABELS, so
 * the list is the ORGANISATION's own: Sukari's tractors and prime movers,
 * Kasulu's excavators and compactors, and no row for a machine the operator
 * does not own.
 */
export function fleetTypeOptions(vehicles) {
  const counts = new Map()
  for (const v of vehicles ?? []) {
    const kind = fleetType(v)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, label: fleetTypeLabel(kind), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * Does this vehicle pass the type filter?
 *
 * An EMPTY selection means "no filter", not "hide everything" — the funnel
 * opens with nothing ticked, and an operator who unticks their last row is
 * asking to see the fleet again, not to empty the map.
 */
export function matchesTypeFilter(vehicle, kinds) {
  if (!kinds) return true
  const list = kinds instanceof Set ? kinds : new Set(kinds)
  if (list.size === 0) return true
  return list.has(fleetType(vehicle))
}

/** Activity → the word the VEHICLE-facing surfaces use. */
export const ACTIVITY_LABELS = { transit: 'In Transit', idling: 'Idling', parked: 'Parked' }

/**
 * The ONLINE palette.
 *
 * Every state in here belongs to a unit the provider (or isRunningNow) says is
 * live. Two of the three are green — transit at full strength, standing still
 * the palest — and the fix that mattered was `stationary`: it used to be a
 * slate one shade from the slate that means OFFLINE, so a yard of connected
 * but stationary machines read as a yard of dead trackers.
 *
 * IDLING keeps its own sky blue, by request. It was green for a while, and the
 * argument for that was tidiness — one question, one hue. The argument against
 * it is the job: idling is the state an operator is hunting for, and a step
 * within green is too quiet a way to say "this one is burning fuel standing
 * still". See IDLING_COLOR, which is the same value and the only one to edit.
 *
 * Alert colours are NOT in here. A speeding or flagged unit is online too, and
 * folding it into the palette would lose the thing worth seeing.
 */
export const ONLINE_COLORS = {
  transit:    '#22c55e',
  idling:     IDLING_COLOR,
  stationary: '#86efac',
}

/** Activity → colour. All three are online states, so all three are green. */
export const ACTIVITY_COLORS = {
  transit: ONLINE_COLORS.transit,
  idling:  ONLINE_COLORS.idling,
  parked:  ONLINE_COLORS.stationary,
}

/**
 * Does a vehicle belong in a given status filter?
 *
 * Shared by the chip COUNTS (MapOverlay) and the map's marker visibility
 * (FleetMap) so a chip can never show a number that does not match what
 * clicking it reveals.
 *
 * OK is deliberately not `status === 'ok'`. OK/ONLINE is the CONNECTION axis:
 * it means the provider reports the tracker connected, so it covers every
 * connected unit — including the ones also flagged speeding, theft or idling,
 * which are alert/activity states layered on top of a live connection. OK and
 * OFFLINE therefore partition the fleet, and WARNING / CRITICAL / IDLING are
 * overlapping subsets of OK rather than siblings of it.
 */
export function matchesFilter(vehicle, filterKey) {
  // Connection comes from the vehicle's own field, NOT from `status !==
  // 'parked'`: the alert states are decided before the connection check in
  // deriveStatus, so an offline unit carrying a theft flag has status 'theft'.
  const online = Boolean(vehicle?.online)
  const status = vehicle?.status

  switch (filterKey) {
    case 'all':      return true
    case 'ok':       return online          // ONLINE — the connection count
    case 'offline':  return !online

    // The activity partition. Each is gated on `online` so the three sum to
    // ONLINE exactly, and a vehicle can only ever be in one of them.
    case 'transit':  return online && vehicleActivity(vehicle) === 'transit'
    case 'idling':   return online && vehicleActivity(vehicle) === 'idling'
    case 'parked':   return online && vehicleActivity(vehicle) === 'parked'

    // Alerts — overlapping subsets of ONLINE, not members of the partition.
    case 'warning':  return status === 'speeding'
    case 'critical': return status === 'theft'
    default:         return status === filterKey
  }
}

/**
 * Every map-visibility axis at once.
 *
 * ## Why one function rather than three call sites
 *
 * The map's markers, the camera's fit and the overlay's chip counts each have
 * to answer "is this vehicle showing?", and they live in three files that
 * cannot see each other's logic. When each composed the axes itself they
 * drifted — which is the failure the chip-count contract in MapOverlay exists
 * to prevent: a chip reading ONLINE 412 above a map showing three units.
 *
 * ## Tracked units always show (operator, 2026-10-15)
 *
 * It used to be a conjunction: tracking narrowed the fleet and every filter
 * narrowed it further, so clicking ONLINE in the sidebar while an offline
 * unit was tracked took that unit off the map, and reads as "the side panel
 * cancels my pinned units". Now a tracked unit is drawn whatever the status,
 * type or in-transit filter says — only Stop on the tracking pill releases
 * it. The filters still mean what they say about everything else: with no
 * filter set the map is the tracked units alone (as before); with one set,
 * the units matching it are drawn ALONGSIDE the tracked ones.
 *
 * ISOLATION is not here. Playback and focus are statements about ONE unit and
 * outrank every filter, so FleetMap keeps those branches ahead of this call.
 *
 * Allocation-free on purpose: this runs per vehicle on every SSE frame across
 * a 597-unit fleet.
 */
export function matchesMapFilters(vehicle, { filterKey = 'all', fleetTypes, trackedSet, inTransitOnly = false } = {}) {
  // An empty tracked set is "the whole fleet", the same rule matchesTypeFilter
  // states for an empty type selection.
  if (trackedSet && trackedSet.size > 0) {
    if (trackedSet.has(vehicle?.id)) return true
    // Untracked: hidden unless a filter is asking for its group.
    const narrowed = filterKey !== 'all' || (fleetTypes?.length ?? 0) > 0 || inTransitOnly
    if (!narrowed) return false
  }
  if (inTransitOnly && !isInTransit(vehicle)) return false
  return matchesFilter(vehicle, filterKey) && matchesTypeFilter(vehicle, fleetTypes)
}

/**
 * Driver duty status — 'Driving' | 'Idling' | 'Resting'.
 *
 * ## Duty is a different axis from connection
 *
 * `status` above answers "is the tracker reporting?" — ONLINE vs OFFLINE, plus
 * the two alert states. This answers "what is the vehicle doing?". They are
 * independent: ONLINE says the data is fresh, not that the vehicle is active,
 * so connection state is consulted here for exactly one purpose — an OFFLINE
 * unit's last frame cannot support ANY claim about what it is doing now.
 *
 * ## Speed decides Driving, not the run state
 *
 * This deliberately does NOT map movement.state === 'moving' → Driving. The
 * server's tracker describes the current RUN and holds it 'moving' through a
 * stop of up to STOP_GRACE_MS (3 min) so one red light does not split a
 * two-hour haul into two runs. That is right for the duration RunRow prints
 * ("on the road for 2h 14m") and wrong as a live label: a vehicle showing
 * 0 km/h is not driving, whatever the run says. So the CURRENT speed decides
 * whether it is moving, and the tracker is consulted only for the distinction
 * it alone can make — idling vs resting.
 */
export function driverDutyStatus(vehicle) {
  // An offline unit's last frame cannot support any claim about what the
  // driver is doing now.
  if (!vehicle?.online && vehicle?.status === 'parked') return 'Resting'

  // Same classification as the vehicle surfaces, different vocabulary: the
  // subject here is the PERSON, so a moving vehicle means the driver is
  // Driving and a stopped one means Resting.
  return { transit: 'Driving', idling: 'Idling', parked: 'Resting' }[vehicleActivity(vehicle)]
}

/**
 * Which marker treatment a vehicle gets on the map.
 *
 * Alerts outrank everything (a speeding truck must read as speeding), then
 * connection, then activity. Returns one of the STATUS_COLORS keys.
 *
 * 'stationary' is online-but-stopped and is deliberately distinct from
 * 'parked', which means OFFLINE — otherwise a truck sitting in the yard and a
 * tracker that has dropped off the network look identical on the map.
 */
/**
 * @param {object}  [opts]
 * @param {boolean} [opts.fuelAlerts=true] false paints a flagged unit by what
 *   it is DOING rather than red — the map half of the fuel-alerts toggle.
 *
 *   Only the treatment is suppressed, never the incident: `vehicle.fuelIncident`
 *   is untouched, the unit still appears in the alerts menu, and its window
 *   still opens. Switching the layer off is a statement about the map, not a
 *   dismissal — which is what `dismissed` in the incident window is for, and
 *   that one is deliberately harder to reach.
 */
export function markerState(vehicle, { fuelAlerts = true } = {}) {
  if (vehicle?.status === 'theft')    return fuelAlerts ? 'theft' : offAlertState(vehicle)
  if (vehicle?.status === 'speeding') return 'speeding'
  if (!vehicle?.online)               return signalLost(vehicle) ? 'signal-lost' : 'parked'
  const activity = vehicleActivity(vehicle)
  return activity === 'transit' ? 'ok' : activity === 'idling' ? 'idling' : 'stationary'
}

/**
 * What a flagged unit looks like with the alert treatment off.
 *
 * The rest of markerState's ladder, minus the branch we just skipped —
 * deliberately re-run rather than defaulted to 'ok', because a flagged unit
 * that is also OFFLINE must still read as offline. Painting it green would
 * replace one wrong story with another.
 */
function offAlertState(vehicle) {
  if (!vehicle?.online) return signalLost(vehicle) ? 'signal-lost' : 'parked'
  const activity = vehicleActivity(vehicle)
  return activity === 'transit' ? 'ok' : activity === 'idling' ? 'idling' : 'stationary'
}

/**
 * How recently a fix has to have arrived for its run state to still describe
 * what the vehicle was doing when we lost it.
 *
 * The server stops calling a run 'moving' after an hour of silence
 * (movement-state's STALE_FIX_MS). That is the right bound for a duration
 * readout and too loose for a live map, where "we just lost this truck" and
 * "this truck has been gone most of the morning" are different situations.
 */
const SIGNAL_LOST_MS = 30 * 60_000

/**
 * Was this vehicle DRIVING when the provider stopped seeing it?
 *
 * ## Why this is not simply "online"
 *
 * It is tempting to call these units online — they were doing 21 km/h a
 * quarter of an hour ago, and showing them as OFFLINE looks wrong. Measured
 * against the live account on 2026-08-04, that instinct is mistaken:
 * `connectionCheckedAt` is ZERO minutes old on every vehicle, so `netconn` is
 * the FRESHER signal, and it says these units are not connected. Their last
 * frame merely showed motion before they dropped — the queued-frame case
 * isOnline's own note warns about. Overriding it wholesale would re-inflate
 * the ONLINE count exactly as the removed 15-minute window did.
 *
 * isRunningNow carves out the one case where the frame does outrank the
 * verdict — ignition ON as well as motion, in a fix under half an hour old —
 * and those units come back `online`, so this returns false for them. What is
 * left here is the rest: moving, but with the engine reading off or unknown.
 * The two predicates share the 30-minute window on purpose; they are the same
 * judgement about how long a frame stays current.
 *
 * ## Why they still must not read as 'parked'
 *
 * Because the two are not the same event and the map was drawing them
 * identically. KDL 182X — 21 km/h, fix sixteen minutes old — looked exactly
 * like a truck whose last fix was 342,121 minutes ago (eight months). Losing a
 * moving vehicle is the more urgent of the two by a wide margin, and it was
 * indistinguishable from the most routine state on the map.
 *
 * So connection stays the provider's call and activity keeps its own voice.
 */
export function signalLost(vehicle) {
  if (vehicle?.online) return false
  if (vehicle?.movement?.state !== 'moving') return false
  const at = vehicle?.capturedAt
  if (at == null) return false
  const age = Date.now() - (typeof at === 'number' ? at : Date.parse(at))
  return Number.isFinite(age) && age >= 0 && age <= SIGNAL_LOST_MS
}

/**
 * Actually on the move — the test behind the "In Transit" badge and the
 * in-transit cargo total. Defined as duty, so one rule covers every surface.
 *
 * NOT `status !== 'parked'`. 'parked' means OFFLINE, so "not parked" reads as
 * ONLINE — which counted a queue of idling and stationary-but-reporting
 * vehicles as though they were driving.
 */
export function isInTransit(vehicle) {
  return Boolean(vehicle?.online) && vehicleActivity(vehicle) === 'transit'
}

/** A stop this long, by a unit that was demonstrably running, is worth a look. */
export const STRANDED_STOP_MS = 10 * 60_000

/**
 * A unit that WAS in transit and has now been standing still too long.
 *
 * ## Why the clock is a parameter
 *
 * This is the only predicate here whose answer changes with no new telemetry:
 * a unit that stopped nine minutes ago becomes flagged while nothing about it
 * is reported. Reading Date.now() inside would make it untestable and would
 * hide that fact from callers, who have to drive it from a tick. So the caller
 * passes the clock and owns the tick.
 *
 * ## The ladder, and why each rung is where it is
 *
 * 1. OFFLINE is not stranded. A dark tracker is a different story with a
 *    different action, and folding the two together buries the handful of
 *    stranded machines under every unit whose box has gone quiet. signalLost()
 *    already tells that story.
 * 2. A stale fix cannot support a claim about right now. `online` is the
 *    provider's verdict and can lag, so age is checked separately — against the
 *    same SIGNAL_LOST_MS the rest of the file uses, so no two surfaces can
 *    disagree about what "stale" means.
 * 3. Still rolling is not stopped.
 * 4. `movement.exact` is the load-bearing rung. False means the server was
 *    already watching a stopped unit when it started — it never saw the
 *    transition, so there is NO evidence this machine was ever in transit. On
 *    a 597-unit fleet that is most of the yard, and without this rung the list
 *    is every parked machine on the estate. `lastMovedAtMs` is not a
 *    substitute: it is stamped only from frames seen this session, so it is
 *    strictly weaker and re-admits exactly the population this excludes.
 *
 * ## The zone rung, and why it is injected
 *
 * A unit standing inside a geofence — imported from Wialon or configured here,
 * the estate does not distinguish — is standing somewhere the estate knows
 * about, and is not what this list is for. That containment is decided by
 * lib/zoneContainment against the geometry the map already draws, and handed in
 * as a function rather than computed here: this file is about what a vehicle
 * IS, it holds no geometry, and injecting the test keeps it that way and keeps
 * the point-in-polygon off the 500-odd units that fail a cheaper rung first.
 *
 * The test is deliberately TRI-STATE. `null` — no geometry loaded for this org
 * — is not `false`. Three of the four live orgs have no geofences at all, and
 * reporting "not in a safe zone" for a fleet that has no zones defined would be
 * an assertion we cannot support; the row says "location unverified" instead.
 *
 * @param {object} vehicle  a mapped vehicle (mapSnapshotVehicle shape)
 * @param {number} nowMs    the clock, passed in — see above
 * @param {object} [opts]
 * @param {number} [opts.minStopMs=STRANDED_STOP_MS]
 * @param {number} [opts.staleMs=SIGNAL_LOST_MS]
 * @param {(v: object) => (boolean|null)} [opts.insideZone] containment, tri-state
 * @returns {null | { sinceMs: number, forMs: number, state: string, zonesKnown: boolean }}
 */
export function strandedStop(vehicle, nowMs, { minStopMs = STRANDED_STOP_MS, staleMs = SIGNAL_LOST_MS, insideZone = null } = {}) {
  if (!Number.isFinite(nowMs)) return null
  if (!vehicle?.online) return null

  const captured = vehicle.capturedAtMs
  if (!Number.isFinite(captured) || nowMs - captured > staleMs) return null

  if (vehicleActivity(vehicle) === 'transit') return null

  const m = vehicle.movement
  if (!m || m.state === 'moving' || m.exact !== true) return null

  const sinceMs = Date.parse(m.since ?? '')
  if (!Number.isFinite(sinceMs)) return null

  const forMs = nowMs - sinceMs
  if (forMs < minStopMs) return null

  // Last, because it is the only rung that costs geometry: a unit standing
  // inside a fence the estate knows about is standing somewhere accounted for.
  const inZone = insideZone ? insideZone(vehicle) : null
  if (inZone === true) return null

  return {
    sinceMs,
    forMs,
    state: m.state,
    // Whether containment could be DECIDED — not whether it was clear. False
    // means no geometry to test against, so the unit is still flagged (absence
    // of evaluation is not evidence of safety) but the caller can say so rather
    // than implying a certainty we do not have.
    zonesKnown: inZone === false,
  }
}

/** The verdict alone, for callers that do not need the detail. */
export function isStrandedStop(vehicle, nowMs, opts) {
  return strandedStop(vehicle, nowMs, opts) != null
}

/**
 * Sprite kinds that do their work in place and never haul a load.
 *
 * A dozer pushing spoil, an excavator digging, a compactor rolling and a wheel
 * loader filling somebody else's tipper are all fully employed while carrying
 * nothing — the server already knows this for one case
 * (`maxPayloadTonnes('BELL LOADER') === 0`). Buses carry people and light
 * vehicles carry a crew; neither is cargo in tonnes.
 *
 * A tractor is NOT here: cane haulage in both fleets is tractor-and-trailer
 * (Bell, Haulmaster), so a tractor is one of the biggest carriers we have.
 */
const NON_CARRIER_KINDS = new Set(['ex', 'dz', 'bh', 'comp', 'wl', 'bus', 'lmv', 'mc', 'gen'])

// Machines that share the generic truck sprite (no mesh baked for them) but
// still carry nothing: a grader blades a road, a crane lifts on site, a pump
// moves water through a hose rather than on a bed. Matched
// the same two ways spriteKind matches everything else — equipment code for
// Kasulu's named units, keywords for Sukari's plate-only ones.
const NON_CARRIER_CODES = new Set(['GR'])
const NON_CARRIER_TEXT  = /\b(GRADER|CRANE|HYDRACRANE|HYDRAUKLIC|PUMPS?)\b/

/**
 * Is this vehicle one that carries cargo at all?
 *
 * The point is to stop calling plant "empty". "Empty" is a judgement about a
 * carrier — a tipper running back from the depot with nothing on it is a real
 * operational fact worth surfacing. A bulldozer with nothing on it is just a
 * bulldozer, and counting it as empty inflates the number that is supposed to
 * mean "capacity going to waste".
 *
 * Unknown machines default to TRUE: assuming a vehicle can carry is the
 * conservative answer, since it lands the vehicle in the bucket whose label
 * ("cargo not reported") already admits we do not know.
 */
/**
 * What the machine register says a unit is: 'plant' when it is rated in litres
 * per engine-hour, 'carrier' when rated in km per litre, null when the register
 * does not rate it (or the organisation has no register — only KASULU does).
 *
 * The register is the operator's own record, so where it speaks it decides the
 * Plant button outright (operator 2026-10-19: "plant should be strictly plant
 * units"), ahead of the name and sprite guesses carriesCargo makes.
 */
export function registerRole(vehicle) {
  const basis = vehicle?.ratedBurn?.basis
  return basis === 'HOURS' ? 'plant' : basis === 'DISTANCE' ? 'carrier' : null
}

export function carriesCargo(vehicle) {
  if (NON_CARRIER_KINDS.has(spriteKind(vehicle))) return false
  const code = equipmentCode(vehicle)
  if (code && NON_CARRIER_CODES.has(code)) return false
  return !NON_CARRIER_TEXT.test(`${vehicle?.name ?? ''} ${vehicle?.id ?? ''}`.toUpperCase())
}

/**
 * What the vehicle is carrying, in words.
 *
 * Needs the vehicle, not just the cargo fields: with no description and no
 * weight the answer depends on what the machine IS. "Empty" on a dozer read as
 * a missing load rather than a machine that never has one.
 */
function cargoLabel(vehicle, cargoDesc, cargoWeightKg) {
  if (cargoDesc) return cargoDesc
  if ((cargoWeightKg ?? 0) > 0) return 'General Cargo'
  return carriesCargo(vehicle) ? 'Empty' : 'No load expected'
}

function fmtLocation(lat, lng) {
  return lat != null && lng != null ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : 'No signal'
}

/** Initial snapshot row → map vehicle. Keeps both `id` (plate, used as the map
 *  marker key) and `vehicleId` (cuid, used to match live SSE events). */
export function mapSnapshotVehicle(v) {
  // The snapshot carries lowFuel, and since 2026-08-17 an open fuel incident.
  //
  // fuelInconsistency is what deriveStatus turns into 'theft' and the map
  // turns red. It had never once been set on live data — the Wialon adapter
  // hardcodes it false, because a position payload cannot see a fuel event, so
  // the whole red path was dead. The server now decides it, from an ADJUDICATED
  // cause rather than a raw provider claim: only a drain the classifier could
  // not explain as this machine's own consumption, inside a 24-hour window.
  //
  // Everything else on flags still arrives via SSE.
  //
  // Only a THEFT case is carried (operator, 2026-09-27: the fuel alert is for
  // theft only; FUEL RATE and FUEL DOWN go to the daily summary). A server
  // from before that change still sends those as the open incident, and each
  // one turned its unit red and into CRITICAL — seen 27 Sep evening: 14
  // critical against 1 in the fuel alerts, and the unit's card said "Fuel
  // Theft Alert" about a FUEL DOWN. Dropped here, the status bar, the markers,
  // the card and the alerts list all read the same one.
  const fuelIncident = isTheftIncident(v.fuelIncident) ? v.fuelIncident : null
  const flags = { lowFuel: v.lowFuel, fuelInconsistency: fuelIncident != null }
  // Machine identity in the MAPPED field names. spriteKind/equipmentCode read
  // `id` and `name`, and the snapshot row calls the plate `plate` — handing the
  // raw row to carriesCargo resolved every Kasulu machine to the generic truck
  // (measured: all 109 plant units came back as carriers, so a backhoe's cargo
  // read "Empty"). Everything else on this shape is telemetry, which the cargo
  // question does not use.
  const identity = { id: v.plate ?? v.vehicleId, name: v.name ?? null, vehicleType: v.vehicleType ?? 'TRUCK' }
  return {
    id:            v.plate ?? v.vehicleId,
    // The registration plate inside the name, for display (lib/plate):
    // "KCC 386Z" for "CPO - Menengai - KCC 386Z - FMB140"; null with none.
    regPlate:      plateIn(v.plate, v.name),
    vehicleId:     v.vehicleId,
    // The provider's descriptive name ("125F Bell 38 KHMA 858U", "Faw Prime
    // mover CA4181"). Carried because it is the only place the MACHINE is
    // named for fleets whose `id` is a bare plate — spriteKind reads it.
    name:          v.name ?? null,
    // The server resolves this: while a dispatch is open it is the driver who
    // took the keys for THAT run, otherwise the vehicle's newest open
    // assignment. 'Unassigned' now means genuinely neither, rather than "no
    // assignment row exists", which was true of 502 of Sukari's 597 units.
    driver:        v.driver ?? 'Unassigned',
    driverSource:  v.driverSource ?? null,
    vehicleType:   v.vehicleType ?? 'TRUCK',
    status:        deriveStatus({ speedKmh: v.speedKmh, flags, capturedAt: v.capturedAt, movement: v.movement, connectionOnline: v.connectionOnline, engineOn: v.engineOn, speedLimitKmh: v.speedLimitKmh }),
    // The provider's own connection verdict, kept raw so it can be recomputed
    // without re-reading the snapshot.
    connectionOnline: v.connectionOnline ?? null,
    // The incident behind a red vehicle, so the card and the popup can say
    // WHAT happened without a second request. Null on the great majority.
    fuelIncident,
    // Connection as its OWN field rather than something read back out of
    // `status`. It cannot be derived from status: the alert states (speeding,
    // theft) are decided BEFORE the connection check in deriveStatus, so an
    // offline unit carrying a theft flag has status 'theft', and
    // `status !== 'parked'` would call it connected.
    online:        isOnline({ connectionOnline: v.connectionOnline, engineOn: v.engineOn, speedKmh: v.speedKmh, movement: v.movement, capturedAt: v.capturedAt }),
    lat:           v.lat,
    lng:           v.lng,
    heading:       v.headingDeg ?? 0,
    speed:         Math.round(v.speedKmh ?? 0),
    speedLimit:    v.speedLimitKmh ?? FALLBACK_SPEED_LIMIT,
    engine:        v.engineOn ? 'on' : 'off',
    // NO fuelConsumption. It mapped fuelUsedMl (null on every live frame — the
    // Wialon position payload carries no consumption channel) onto 0, so the
    // card printed "0 L/h" for every vehicle including ones actively idling.
    // fuelUsedMl is a VOLUME delta between pings in any case, not a rate.
    // A genuine L/h needs fuel-level deltas divided by elapsed engine hours,
    // computed server side where the ping history lives.
    fuelLevel:     v.fuelLevelPct ?? null,
    fuelLitres:    v.fuelLevelMl != null ? v.fuelLevelMl / 1000 : null,
    tankCapacityL: v.tankCapacityLitres ?? null,
    // RaiFactorySuite machine register name (KASULU only) — see equipmentLabel.
    machineName:   v.machineName ?? null,
    // The register's standard burn (KASULU only): L/h on an HOURS basis, km/L
    // on DISTANCE. Null on unrated units — see lib/vehicleDay burnAgainst.
    ratedBurn:     v.ratedConsumption != null && v.ratedConsumptionBasis
      ? { value: v.ratedConsumption, basis: v.ratedConsumptionBasis } : null,
    // Why fuelLitres is null, when the reason is a broken probe rather than a
    // missing one — the server derives it from the unit's own sensor config.
    // See wialon.sensors readFuelProbeFault.
    fuelProbeFault: v.fuelProbeFault === true,
    // Flagged for a fuel probe repair: the server holds fuel theft alerts on
    // this unit until the repair is signed off fixed (fleet-server probe-hold).
    probeHold:     v.probeHold === true,
    // Snapshot rows don't carry temp/oil — both arrive with the first SSE
    // 'position' frame (same as fleetdash's useFleet).
    engineTemp:    null,
    oilLevel:      null,
    // Only carriers have a payload. maxPayloadTonnes falls back to 30 t for
    // any type it does not know, which put "0 / 30 t" on generators and
    // motorbikes; null here is what tells the cards to leave the row out.
    maxPayload:    carriesCargo(identity) ? maxPayloadTonnes(v.vehicleType) : null,
    driverRatingScore: v.driverRatingScore ?? null,
    phase:         v.phase ?? null,
    // Assigned-geofence containment, computed server side against the poller's
    // in-memory presence (lib/zone-presence) and attached to the snapshot so
    // it is available on FIRST PAINT — a parked vehicle may not emit an SSE
    // frame for hours, and it is the one most likely to be inspected. `null`
    // means not evaluated yet and renders as nothing; it used to be the string
    // 'inside', hardcoded, so the card asserted containment for every vehicle
    // including ones with no fix at all.
    zones:         v.zones ?? null,
    // Current moving/resting run — { moving, since, exact } from the server's
    // lib/movement-state. Answers "on the road for how long" and "resting
    // since when", neither of which `lastMovedAt` alone could.
    movement:      v.movement ?? null,
    cargo:         cargoLabel(identity, v.cargoDesc, v.cargoWeightKg),
    weight:        v.cargoWeightKg != null ? +(v.cargoWeightKg / 1000).toFixed(1) : 0,
    // 50 kg bags in the declared load, straight from the server — derived there
    // so the feed line, the cargo card and the persisted manifest cannot round
    // the same tonnage three different ways. Null on anything but a sales run.
    cargoBags:     v.cargoBags ?? null,
    location:      fmtLocation(v.lat, v.lng),
    // The open dispatch, as a round trip. `null` when the unit is not out.
    //
    // This is what the Active Trip card runs on now. It replaced `v.leg`, the
    // simulator's journey object, which has been null on every live vehicle
    // since the cutover — so the card had not rendered for anyone in months.
    // Everything in it is measured: the yard and the destination from the
    // fleet's own completed trips (see the server's sync-destinations), the
    // position from the vehicle.
    trip:          v.trip ?? null,
    // Route endpoints, now sourced from the dispatch. Every dispatch leaves
    // from the yard and is not finished until it is back there, so the two
    // ends of the leg are the plant and the cane zone it was sent to.
    departure:     v.trip ? (v.trip.yardName ?? 'Yard') : (v.leg?.from ?? null),
    departureLat:  v.trip?.yardLat ?? v.leg?.fromLat ?? null,
    departureLng:  v.trip?.yardLng ?? v.leg?.fromLng ?? null,
    destination:   v.trip?.destination ?? v.leg?.to ?? null,
    destinationLat: v.trip?.destinationLat ?? v.leg?.toLat ?? null,
    destinationLng: v.trip?.destinationLng ?? v.leg?.toLng ?? null,
    // No progress/distanceCovered/totalDistance/legBeganAtMs/legPlannedArrivalMs
    // any more. They read `v.leg`, the retired simulator's journey object, and
    // were null on every live vehicle — harmless only while nothing rendered
    // them. Sourcing departure/destination from the dispatch made the hover
    // card's journey block visible again and it promptly printed "0 / 0 km"
    // and a blank ETA off these. Trip figures come from `trip` (above), which
    // is measured; see lib/tripProgress.
    // "On the road" = actually moving. `leg.moving` was the simulator's own
    // trip state and no longer exists on live data, so falling back to it left
    // every real vehicle bucketed as off-duty and the EMPTY KPI stuck at zero.
    // Speed is the only movement signal a real tracker gives us.
    onRoad:              v.leg?.moving ?? isMoving(v),
    // Newest MOVING ping — "stationary for now − this" on parked vehicles.
    // Seeded from the snapshot, then kept current by applyLiveUpdate.
    lastMovedAtMs:       v.lastMovedAt ? Date.parse(v.lastMovedAt) : null,
    // Sensor counters, surfaced by the Maintenance page (lib/vehicleReadings).
    odometerKm:            v.odometerKm ?? null,
    engineHours:           v.engineHours ?? null,
    // When the DEVICE last reported. deriveStatus consumed v.capturedAt above
    // but nothing kept it, so nothing downstream could say how stale a row was
    // — the Maintenance page's "Last reported" column read empty for every
    // vehicle until this was carried through.
    capturedAtMs:          v.capturedAt ? Date.parse(v.capturedAt) : null,
    // maintenanceResetOdoKm / nextServiceOdoKm / inMaintenance used to be
    // mapped here to feed a service-interval grader. They came from the
    // retired simulator's `_sim.maintenance` block and are 0 / null / false
    // for every vehicle in production, so nothing honest can be built on them.
  }
}

/**
 * Refresh ONLY the connection verdict from a snapshot row.
 *
 * The SSE stream carries connection state, but only ON A POSITION FRAME — and
 * the Wialon adapter emits a frame only when a unit's fix time ADVANCES. A
 * parked unit stops emitting, so its verdict freezes at whatever it was when
 * the page loaded, however long the tab stays open.
 *
 * Measured on MUFINDI - DZ 02: last position stuck at 03:50:16 while its
 * `netconn` flipped true -> false -> true over the following minutes. The card
 * read OFFLINE against an API that said online, and only a full reload fixed
 * it — the exact "connected in Wialon, offline in the app" report.
 *
 * Deliberately connection-only. The snapshot is a second or two old and the SSE
 * frame may be newer, so merging position or telemetry from it would rewind a
 * moving vehicle. Connection is the one field the stream cannot keep current
 * for the vehicles that need it most.
 */
export function applyConnectionRefresh(existing, row) {
  const connectionOnline = row?.connectionOnline ?? null
  if (connectionOnline === existing.connectionOnline) return existing
  return {
    ...existing,
    connectionOnline,
    /* The running-evidence fields come off `existing`, not off `row`: this
       refresh is connection-only by design (see the note above), so the
       freshest thing we hold about ignition and motion is still the frame the
       stream last delivered. */
    online: isOnline({
      connectionOnline,
      engineOn: existing.engine === 'on',
      speedKmh: existing.speed,
      movement: existing.movement,
      capturedAtMs: existing.capturedAtMs,
    }),
    status: deriveStatus({
      speedKmh: existing.speed,
      flags: { overspeeding: existing.status === 'speeding', fuelInconsistency: existing.status === 'theft' },
      movement: existing.movement,
      connectionOnline,
      engineOn: existing.engine === 'on',
      capturedAtMs: existing.capturedAtMs,
      // Carried from the snapshot: the limit follows the machine TYPE, which
      // does not change mid-session, so a live update must not silently drop
      // back to the fallback and re-grade the unit against 80.
      speedLimitKmh: existing.speedLimit,
    }),
  }
}

/**
 * Merge a live SSE 'dispatch' event onto the existing map vehicle.
 *
 * What the unit is CARRYING, pushed by the paperwork rather than by the wheels.
 * The server emits one the moment a sales run is signed out at the gate or
 * signed back in — see its modules/dispatches/dispatch-refresh — because a
 * position frame cannot carry the load and a truck standing at the gate may not
 * produce another position for an hour.
 *
 * ## What it deliberately does not touch
 *
 * `trip`. The Active Trip card runs on measured geometry — the yard, the
 * destination point, the arrival probe — and this event carries a name, not
 * coordinates. Building half a trip from it would draw a route to a place we
 * have not placed; the snapshot brings the real one. The destination NAME is
 * taken, because that is what the vehicle card prints and it is exactly as
 * well-founded as the tonnage beside it.
 *
 * A closed run arrives as nulls throughout, which is how the bed is emptied
 * when the guard signs the unit back in.
 */
export function applyDispatchUpdate(existing, data) {
  return {
    ...existing,
    cargo:       cargoLabel(existing, data.cargoDesc, data.cargoWeightKg),
    weight:      data.cargoWeightKg != null ? +(data.cargoWeightKg / 1000).toFixed(1) : 0,
    cargoBags:   data.cargoBags ?? null,
    // The driver who took the keys for THIS run — the same precedence the
    // snapshot applies, where a dispatch beats the stale assignment. Kept when
    // the run closes: whoever is assigned to the vehicle does not stop being
    // assigned to it, and this event does not carry that name to fall back to.
    driver:      data.driverName ?? existing.driver,
    // Cleared when the run closes, unlike the driver. A destination is a
    // property of the RUN and means nothing once the unit has signed back in;
    // leaving it would caption a parked truck with where it went this morning.
    destination: data.destination ?? null,
    // The run's seal serial (SEAL SERIAL on the unit card, which falls back to
    // this when the snapshot's trip has none). It can arrive after the
    // sign-out, on a parked unit with no position to carry it. Only taken when
    // the server sends the field, so an older server leaves it alone; a closed
    // run sends null and clears it with the load.
    sealSerial:  'serialNumber' in data ? (data.serialNumber ?? null) : existing.sealSerial,
    // The trip keeps its geometry (see above), but its serial must not
    // outrank the one just pushed — the card reads trip.serialNumber first.
    trip:        existing.trip && 'serialNumber' in data
      ? { ...existing.trip, serialNumber: data.serialNumber ?? null }
      : existing.trip,
  }
}

/** Merge a live SSE 'position' event onto the existing map vehicle. */
export function applyLiveUpdate(existing, data) {
  return {
    ...existing,
    lat:           data.lat ?? existing.lat,
    lng:           data.lng ?? existing.lng,
    heading:       data.headingDeg ?? existing.heading,
    speed:         data.speedKmh != null ? Math.round(data.speedKmh) : existing.speed,
    engine:        data.engineOn != null ? (data.engineOn ? 'on' : 'off') : existing.engine,
    connectionOnline: data.connectionOnline ?? existing.connectionOnline ?? null,
    online:        isOnline({
      connectionOnline: data.connectionOnline ?? existing.connectionOnline,
      engineOn:         data.engineOn ?? existing.engine === 'on',
      speedKmh:         data.speedKmh ?? existing.speed,
      movement:         data.movement ?? existing.movement,
      capturedAt:       data.capturedAt,
      capturedAtMs:     existing.capturedAtMs,
    }),
    // A live frame's flags describe THIS PING — speed, violations — and know
    // nothing about an adjudicated fuel incident, which is a fact about the
    // last 24 hours held on the vehicle. Recomputing status from the frame
    // alone would clear the red state on the next ping, seconds after the
    // snapshot set it, and the vehicle would flicker back to 'ok' while an
    // incident was still open.
    status:        deriveStatus({
      speedKmh:   data.speedKmh,
      flags:      { ...data.flags, fuelInconsistency: existing.fuelIncident != null || data.flags?.fuelInconsistency === true },
      capturedAt: data.capturedAt ?? existing.capturedAt,
      movement:   data.movement ?? existing.movement,
      connectionOnline: data.connectionOnline ?? existing.connectionOnline,
      engineOn:   data.engineOn ?? existing.engine === 'on',
      // See applyConnectionRefresh: the SSE payload carries no limit, and the
      // type it derives from cannot change mid-session.
      speedLimitKmh: data.speedLimitKmh ?? existing.speedLimit,
    }),
    fuelLevel:     data.fuelLevelPct ?? existing.fuelLevel,
    fuelLitres:    data.fuelLevelMl != null ? data.fuelLevelMl / 1000 : existing.fuelLitres,
    tankCapacityL: existing.tankCapacityL,
    engineTemp:    data.engineTempC != null ? Math.round(data.engineTempC) : existing.engineTemp,
    oilLevel:      data.oilLevelPct != null ? Math.round(data.oilLevelPct) : existing.oilLevel,
    phase:         data.phase ?? existing.phase,
    // Real per-vehicle containment against ASSIGNED zones, computed server
    // side (lib/zone-presence). Replaces a read of flags.outsideGeofence,
    // which the Wialon adapter hardcodes to false on every frame.
    zones:         data.zones ?? existing.zones ?? null,
    movement:      mergeMovement(existing.movement, data.movement),
    // The declared load survives a position frame, because a position frame
    // knows nothing about it.
    //
    // This tested for PRESENCE, and the Wialon adapter sends
    // `cargoWeightKg: null` on every frame — present, and meaning "this fleet
    // has no load cells", not "the bed is empty". So the first live frame after
    // the snapshot relabelled a loaded truck "Empty" while the line below kept
    // its 29 tonnes: measured here, a unit signed out with 580 bags read
    // "Empty · 29 t · 580 bags" seconds after the card was opened. The tonnage
    // came from the dispatch and was right; the word came from an absent
    // sensor. `dash` fixed the same bug in its own copy of this function — see
    // its vehicleMapCargo.test.js — and this is the same rule.
    //
    // A null weight is the ABSENCE of a measurement and is treated as one. A
    // frame carrying a real figure still wins, so a fleet with load cells keeps
    // live weights; it is only nothing that no longer overwrites something.
    //
    // `existing` is what carries the machine identity (name/id) — a live frame
    // has only telemetry, so the "is this even a carrier" question is answered
    // from the vehicle we already hold.
    cargo:         data.cargoWeightKg != null
      ? cargoLabel(existing, data.cargoDesc, data.cargoWeightKg)
      : existing.cargo,
    weight:        data.cargoWeightKg != null ? +(data.cargoWeightKg / 1000).toFixed(1) : existing.weight,
    cargoBags:     data.cargoWeightKg != null ? data.cargoBags ?? null : existing.cargoBags,
    location:      data.lat != null ? fmtLocation(data.lat, data.lng) : existing.location,
    departure:     data.leg?.from ?? existing.departure,
    departureLat:  data.leg?.fromLat ?? existing.departureLat,
    departureLng:  data.leg?.fromLng ?? existing.departureLng,
    destination:   data.leg?.to ?? existing.destination,
    destinationLat: data.leg?.toLat ?? existing.destinationLat,
    destinationLng: data.leg?.toLng ?? existing.destinationLng,
    onRoad:              data.leg?.moving ?? isMoving(data),
    // `trip` is carried through by the ...existing spread and deliberately not
    // touched here: a position frame has no dispatch in it, and the trip's own
    // figures are re-derived from the live lat/lng at render time rather than
    // being stored stale on the vehicle (see lib/tripProgress).
    // A moving frame stamps "last movement"; stationary frames keep the old one.
    lastMovedAtMs: (data.speedKmh ?? 0) > 0 && data.capturedAt
      ? Date.parse(data.capturedAt)
      : existing.lastMovedAtMs,
    odometerKm:            data.odometerKm ?? existing.odometerKm,
    engineHours:           data.engineHours ?? existing.engineHours,
    capturedAtMs:          data.capturedAt ? Date.parse(data.capturedAt) : existing.capturedAtMs,
  }
}
