import { describe, it, expect } from 'vitest';
import { STATUS_STATS, countStatuses } from './fleetStatusStats';
import { matchesFilter } from './vehicleMap';

// The map's own vocabulary, not the labels'. ONLINE is `ok`, and a card that
// counted `online` would count nothing at all — `matchesFilter` has no such
// case, so it falls through to `status === 'online'`, which is never true.
const v = (over = {}) => ({ id: 'K1', online: true, status: 'parked', speed: 0, ...over });

describe('STATUS_STATS', () => {
  it('names a filter key matchesFilter actually understands', () => {
    // The default branch of matchesFilter compares against `status`, so an
    // unknown key does not throw — it silently counts zero. This is the test
    // that would have caught that.
    for (const s of STATUS_STATS) {
      const known = ['all', 'ok', 'offline', 'transit', 'idling', 'parked', 'warning', 'critical'];
      expect(known, `${s.key} → ${s.filterKey}`).toContain(s.filterKey);
    }
  });

  it('maps ONLINE to the connection count, not to a status named online', () => {
    const online = STATUS_STATS.find(s => s.key === 'online');
    expect(online.filterKey).toBe('ok');
    // A parked-but-reporting unit is ONLINE. If this ever reads false, the
    // sidebar's ONLINE card and the map's ONLINE chip have diverged.
    expect(matchesFilter(v({ online: true, status: 'parked' }), online.filterKey)).toBe(true);
  });

  it('maps CRITICAL to theft and WARNING to speeding', () => {
    const critical = STATUS_STATS.find(s => s.key === 'critical');
    const warning  = STATUS_STATS.find(s => s.key === 'warning');
    expect(matchesFilter(v({ status: 'theft' }),    critical.filterKey)).toBe(true);
    expect(matchesFilter(v({ status: 'speeding' }), warning.filterKey)).toBe(true);
    expect(matchesFilter(v({ status: 'parked' }),   critical.filterKey)).toBe(false);
  });

  it('gives every stat a distinct key', () => {
    const keys = STATUS_STATS.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('countStatuses', () => {
  it('agrees with matchesFilter for every bucket', () => {
    const fleet = [
      v({ id: 'A', online: true,  status: 'parked' }),
      v({ id: 'B', online: true,  status: 'speeding' }),
      v({ id: 'C', online: true,  status: 'theft' }),
      v({ id: 'D', online: false, status: 'parked' }),
      v({ id: 'E', online: false, status: 'theft' }),
    ];
    const counts = countStatuses(fleet);

    // The whole contract in one line: the number printed on a card is exactly
    // the number of vehicles the map will leave showing when it is clicked.
    for (const s of STATUS_STATS) {
      expect(counts[s.key], s.key).toBe(fleet.filter(x => matchesFilter(x, s.filterKey)).length);
    }
  });

  it('counts an offline unit carrying a theft flag as BOTH offline and critical', () => {
    // Deliberate: the alert states are decided before the connection check in
    // deriveStatus, so these buckets overlap. A test that asserted they summed
    // to the fleet size would be asserting the wrong thing.
    const counts = countStatuses([v({ online: false, status: 'theft' })]);
    expect(counts.offline).toBe(1);
    expect(counts.critical).toBe(1);
    expect(counts.all).toBe(1);
  });

  it('returns a zero for every bucket on an empty or missing fleet', () => {
    for (const input of [[], null, undefined]) {
      const counts = countStatuses(input);
      for (const s of STATUS_STATS) expect(counts[s.key], s.key).toBe(0);
    }
  });

  it('counts ALL as the whole fleet', () => {
    const fleet = [v({ id: 'A' }), v({ id: 'B', online: false }), v({ id: 'C', status: 'theft' })];
    expect(countStatuses(fleet).all).toBe(3);
  });

  /* Colour is not decoration on these six. It is the only thing telling a
     reader which control they are looking at once the rail has scrolled and
     the label is off the edge. */
  it('gives every bucket its own colour', () => {
    const seen = new Map();
    for (const s of STATUS_STATS) {
      const clash = seen.get(s.color.toLowerCase());
      expect(clash, `${s.key} shares ${s.color} with ${clash}`).toBeUndefined();
      seen.set(s.color.toLowerCase(), s.key);
    }
  });

  /* IDLING shipped as #2563eb — the same blue as ALL, and not the cyan the
     markers, the run row and the vehicle card all use for that state. It was
     briefly a green, folded in with the other online states; that is reversed,
     so this guards the cyan again — and, now, that it is not ONLINE's green
     either, which is the mistake the green version made. */
  it('paints IDLING a cyan, in step with IDLING_COLOR rather than with ALL', () => {
    const idling = STATUS_STATS.find(s => s.key === 'idling');
    const all    = STATUS_STATS.find(s => s.key === 'all');
    const ok     = STATUS_STATS.find(s => s.key === 'online');
    expect(idling.color).not.toBe(all.color);
    expect(idling.color).not.toBe(ok.color);

    // Same hue family as lib/vehicleMap's IDLING_COLOR (#06b6d4): blue channel
    // highest, green well clear of red. A blue like #2563eb fails the last of
    // these, which is what made the two chips identical.
    const [r, g, b] = [1, 3, 5].map(i => parseInt(idling.color.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(r + 40);
  });
});
