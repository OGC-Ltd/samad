// What the fuel ledger concluded about each fuel event on a vehicle's day, as
// the spans the fuel chart shades: possible theft, slosh, redistribution,
// refill, and the FUEL RATE / FUEL DOWN findings.
//
// ## The verdicts are the server's
//
// Nothing here judges a drop. The server's adjudicator already decided what
// each drain and filling was (modules/fuel/fuel-adjudication); this only reads
// its verdict and cause and gives each a colour:
//
//   drain  DRAIN + SIPHON            possible theft — the only one allowed that word
//          DRAIN + SLOSH / SETTLING  slosh: fell faster than a pump draws, or settling
//          REDISTRIBUTION            redistribution: the level came back
//          DRAIN + UNEXPLAINED_BURN  FUEL RATE or FUEL DOWN, named as the alert names it
//          anything else             not shown: burned as expected, or undecidable
//   fill   REFILL, or PENDING        refill (a pending one is not yet checked)
//          REDISTRIBUTION            redistribution: the level rose and fell back
//
// ## The span is found on the tank line
//
// The ledger's times are the provider's report, and they are loose: a refill's
// `filledAt` lands anywhere inside the rise — at its start on some units, in
// the middle of a 35-minute delivery on others — and a drop that came back is
// logged a few minutes before the dip shows. So each event is placed on the
// level itself: the biggest move of the right direction near the ledger's
// time. A theft keeps its band while the level goes on stepping down, and a
// redistribution runs until the level came back. Where the line shows no
// such move, the ledger's own times stand.
//
// Except for FUEL RATE and FUEL DOWN, which keep the stretch the server
// measured, as slosh does. They happen while the machine drives or works, when
// the level swings by tens of litres from one reading to the next, and the
// biggest move on such a line is the slosh, not the drop: on KDE 585S (27 Sep)
// a single 42 L reading at 07:14 stretched a fall the server measured from
// 06:46 to 07:04 into a band running to 07:14. The alert gives the ledger's
// time, so the band now starts where the alert says.

const MIN = 60_000;

/** Colour and name per kind, in legend order. */
export const FUEL_EVENT_KINDS = {
  theft:          { label: 'Possible theft',   color: '#dc2626' },
  slosh:          { label: 'Slosh',            color: '#ea580c' },
  redistribution: { label: 'Redistribution',   color: '#7c3aed' },
  refill:         { label: 'Refill',           color: '#2563eb' },
  drop:           { label: 'FUEL RATE / DOWN', color: '#64748b' },
};
export const FUEL_EVENT_ORDER = ['theft', 'slosh', 'redistribution', 'refill', 'drop'];

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const litres = (ml) => (Number.isFinite(ml) ? ml / 1000 : null);
const L1 = (ml) => `${(ml / 1000).toLocaleString('en-KE', { maximumFractionDigits: 1 })} L`;

/**
 * The headline an announced cause reason goes out under, as the server words
 * it (fuel-adjudication's live text, and modules/fuel/fuel-rate-digest's
 * `digestKind`), or null for a reason that is never announced.
 */
export function fuelRateKind(reason) {
  if (reason === 'burn-above-class-ceiling' || reason === 'burn-far-above-band') return 'FUEL RATE';
  if (reason === 'drop-while-stationary' || reason === 'drop-exceeds-distance') return 'FUEL DOWN';
  return null;
}

/**
 * What a FUEL RATE or FUEL DOWN finding measured, in a line: the rule, and how
 * much fell and came back when some did — which is how the alert's figure can
 * be smaller than the fall on the chart.
 */
export function fuelRateDetail(d) {
  let what;
  switch (d.causeReason) {
    case 'burn-above-class-ceiling':
    case 'burn-far-above-band':
      what = Number.isFinite(d.impliedLph)
        ? `Fell at ${Math.round(d.impliedLph)} L/h, faster than this machine is measured to burn`
        : 'Fell faster than this machine is measured to burn';
      break;
    case 'drop-while-stationary': what = 'Fell while standing, with nothing driven'; break;
    case 'drop-exceeds-distance':
      what = Number.isFinite(d.fallDistanceKm)
        ? `Fell more than the ${d.fallDistanceKm.toLocaleString('en-KE', { maximumFractionDigits: 1 })} km driven accounts for`
        : 'Fell more than the distance driven accounts for';
      break;
    default: what = "Fell more than this machine's measured burn accounts for";
  }
  const fell = d.measuredDropMl, back = d.recoveredMl;
  return fell > 0 && back >= 500 && fell > back ? `${what} (${L1(fell)} down, ${L1(back)} back)` : what;
}

/** The chart's kind for one drain row, or null when it is not an event worth shading. */
export function drainKind(d) {
  if (d.verdict === 'REDISTRIBUTION') return 'redistribution';
  if (d.verdict !== 'DRAIN') return null;
  switch (d.drainCause) {
    case 'SIPHON': return 'theft';
    case 'SLOSH':
    case 'SETTLING': return 'slosh';
    case 'UNEXPLAINED_BURN': return 'drop';
    default: return null;
  }
}

/** The chart's kind for one filling row, or null. */
export function fillingKind(f) {
  if (f.verdict === 'REDISTRIBUTION') return 'redistribution';
  if (f.verdict === 'REFILL' || f.verdict === 'PENDING') return 'refill';
  return null;
}

/** What the server said, in a sentence. Never the word theft outside a SIPHON's label. */
function drainDetail(d, kind) {
  if (kind === 'theft') return 'Drawn off while the machine stood with its engine off';
  if (kind === 'redistribution') return 'The level came back: fuel moving in the tank, not leaving it';
  if (kind === 'slosh') {
    return d.drainCause === 'SETTLING'
      ? 'The level settling after the machine stopped'
      : 'Fell faster than any pump draws: fuel moving in the tank';
  }
  return fuelRateDetail(d);
}

function fillingDetail(f, kind) {
  if (kind === 'redistribution') return 'The level rose and fell back: no fuel went in';
  return f.verdict === 'PENDING' ? 'Reported as a refill, not yet checked against the tank' : 'Fuel put in';
}

// ── placing an event on the tank line ────────────────────────────────────────

/** Readings from `from` to `to` inclusive (levels sorted by t). */
function slice(levels, from, to) {
  return levels.filter(p => p.t >= from && p.t <= to);
}

/**
 * The biggest move of one direction inside a window: for 'down', the largest
 * fall from an earlier reading to a later one; for 'up', the largest rise.
 * Returns { i, j, size } over `pts`, or null.
 *
 * On a tie the LATEST extreme is the start, so a level that sat flat for
 * forty minutes before a delivery starts its band where the rise began, not
 * where the window did. The end is where the move is 95% done, so a tail of
 * one-litre creeps after the pump stopped does not stretch the band.
 */
function biggestMove(pts, dir) {
  let best = null;
  let pick = 0;                       // index of the running extreme so far
  for (let j = 1; j < pts.length; j++) {
    if (dir === 'down' ? pts[j - 1].ml >= pts[pick].ml : pts[j - 1].ml <= pts[pick].ml) pick = j - 1;
    const size = dir === 'down' ? pts[pick].ml - pts[j].ml : pts[j].ml - pts[pick].ml;
    if (size > 0 && (!best || size > best.size)) best = { i: pick, j, size };
  }
  if (!best) return null;
  // A litre of probe noise at the base is not the move starting: slide the
  // start up to the last reading still within noise of it.
  const noise = Math.max(1_500, 0.01 * best.size);
  while (best.i + 1 < best.j && Math.abs(pts[best.i + 1].ml - pts[best.i].ml) <= noise) best.i += 1;
  const from = pts[best.i].ml;
  for (let k = best.i + 1; k <= best.j; k++) {
    const done = dir === 'down' ? from - pts[k].ml : pts[k].ml - from;
    if (done >= 0.95 * best.size) { best.j = k; break; }
  }
  return best;
}

/** Keep going while the level is still falling within the next 10 minutes. */
function followDescent(levels, fromT, floorMl) {
  let end = fromT, low = floorMl;
  for (const p of levels) {
    if (p.t <= end) continue;
    if (p.t - end > 10 * MIN) break;
    if (p.ml < low - 2_000) { low = p.ml; end = p.t; }
    else if (p.ml > low + 2_000) break;   // came back up: a different event
  }
  return end;
}

/** First reading after `fromT`, within `withinMs`, that is back at `targetMl` (dir 'up' = at or above). */
function returnTo(levels, fromT, targetMl, dir, withinMs = 3 * 60 * MIN) {
  for (const p of levels) {
    if (p.t <= fromT) continue;
    if (p.t - fromT > withinMs) break;
    if (dir === 'up' ? p.ml >= targetMl : p.ml <= targetMl) return p.t;
  }
  return null;
}

/**
 * [start, end] of an event on the tank line, given the ledger's own span.
 *
 * `expectMl` is how much the ledger says moved; a move under 30% of it (or
 * under 2 L) is not taken as this event, and the ledger's span stands.
 */
function placeOnLine(levels, kind, dir, ledgerStart, ledgerEnd, expectMl, recovers) {
  if (!levels.length) return [ledgerStart, ledgerEnd];
  const before = dir === 'up' ? 40 * MIN : 5 * MIN;
  const after  = dir === 'up' ? 40 * MIN : Math.max(10 * MIN, ledgerEnd - ledgerStart + 10 * MIN);
  const pts = slice(levels, ledgerStart - before, ledgerEnd + after);
  const move = pts.length >= 2 ? biggestMove(pts, dir) : null;
  const floor = Math.max(2_000, 0.3 * (expectMl ?? 0));
  if (!move || move.size < floor) return [ledgerStart, ledgerEnd];
  // A refill that the ledger timed must overlap the rise found, give or take
  // twenty minutes; anything else is another delivery the same morning.
  if (dir === 'up' && (pts[move.j].t < ledgerStart - 20 * MIN || pts[move.i].t > ledgerStart + 20 * MIN)) {
    return [ledgerStart, ledgerEnd];
  }
  const start = pts[move.i].t;
  let end = pts[move.j].t;
  if (recovers) {
    // Redistribution: to where the level came back most of the way.
    const target = dir === 'down' ? pts[move.i].ml - 0.4 * move.size : pts[move.i].ml + 0.4 * move.size;
    const back = returnTo(levels, end, target, dir === 'down' ? 'up' : 'down');
    if (back != null) end = back;
  } else if (dir === 'down' && kind === 'theft') {
    end = followDescent(levels, end, pts[move.j].ml);
  }
  return [start, Math.max(end, start + MIN)];
}

/**
 * Every shaded event of one vehicle's day, numbered by start time.
 *
 * `drains` and `fillings` are the rows the fuel list endpoints return;
 * `levels` is the day's tank readings, [{ t, ml }] sorted by t, which places
 * each event on the line. Without readings the ledger's times stand.
 */
export function fuelEpisodes({ drains = [], fillings = [], levels = [] } = {}) {
  const out = [];

  for (const d of drains) {
    const kind = drainKind(d);
    if (!kind) continue;
    const began = ms(d.beganAt) ?? ms(d.detectedAt);
    if (began == null) continue;
    const detected = ms(d.detectedAt);
    const fellFor = Number.isFinite(d.fallSeconds) && d.fallSeconds > 0 ? d.fallSeconds * 1000 : null;
    const ledgerEnd = began + (fellFor ?? Math.max(2 * MIN, (detected ?? began) - began));
    // A FUEL RATE / FUEL DOWN finding carries the alert's figure — what stayed
    // down — and says in its detail how much fell and came back.
    const amountMl = kind === 'drop' && d.stolenMl > 0 ? d.stolenMl
      : d.measuredDropMl > 0 ? d.measuredDropMl : d.stolenMl;
    // Slosh is the whole stretch the server measured moving; placing it on
    // one fall would shrink it to its deepest swing. FUEL RATE / FUEL DOWN
    // keep the measured stretch too — see the header.
    const [start, end] = kind === 'slosh' || kind === 'drop'
      ? [began, ledgerEnd]
      : placeOnLine(levels, kind, 'down', began, ledgerEnd, amountMl, kind === 'redistribution');
    out.push({
      id: `drain-${d.id}`, ids: [`drain-${d.id}`], source: 'drain', kind, start, end,
      label: kind === 'drop' ? fuelRateKind(d.causeReason) ?? undefined : undefined,
      litres: litres(amountMl),
      detail: drainDetail(d, kind),
    });
  }

  for (const f of fillings) {
    const kind = fillingKind(f);
    if (!kind) continue;
    const at = ms(f.filledAt);
    if (at == null) continue;
    const amountMl = f.observedRiseMl > 0 ? f.observedRiseMl : f.filledMl;
    const [start, end] = placeOnLine(levels, kind, 'up', at, at, amountMl, kind === 'redistribution');
    out.push({
      id: `fill-${f.id}`, ids: [`fill-${f.id}`], source: 'filling', kind,
      start: start === end ? start - MIN : start,
      end: start === end ? end + MIN : end,
      litres: litres(amountMl),
      pending: f.verdict === 'PENDING',
      detail: fillingDetail(f, kind),
    });
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return mergeRepeats(out).map((e, i) => ({ ...e, n: i + 1 }));
}

/**
 * One event reported twice is shaded once.
 *
 * The provider can file the same dip as two drains a couple of minutes apart
 * (COMP 01 at 17:01 on 26 Sep, 11 L and 12 L), and both land on the same
 * stretch of the line. Two of a kind covering mostly the same time — 80% of
 * the shorter — become one event over both, with the larger figure. `ids`
 * keeps every report it stands for, so a ledger row can still find its band.
 */
function mergeRepeats(sorted) {
  const out = [];
  for (const e of sorted) {
    let prev = null;
    for (let k = out.length - 1; k >= 0 && !prev; k--) if (out[k].kind === e.kind && out[k].end > e.start) prev = out[k];
    if (prev) {
      const overlap = Math.min(prev.end, e.end) - Math.max(prev.start, e.start);
      const shorter = Math.min(prev.end - prev.start, e.end - e.start);
      if (shorter > 0 && overlap >= 0.8 * shorter) {
        prev.end = Math.max(prev.end, e.end);
        prev.litres = Math.max(prev.litres ?? 0, e.litres ?? 0) || prev.litres || e.litres;
        prev.pending = Boolean(prev.pending && e.pending);
        prev.reports = (prev.reports ?? 1) + 1;
        prev.ids = prev.ids.concat(e.ids);
        continue;
      }
    }
    out.push({ ...e });
  }
  return out;
}

/** The day's tank readings from the panel's pings, for `fuelEpisodes`. */
export function levelsFromPings(pings) {
  const out = [];
  for (const p of pings ?? []) {
    if (Number.isFinite(p.t) && Number.isFinite(p.fuelLevelMl)) out.push({ t: p.t, ml: p.fuelLevelMl });
  }
  return out;
}
