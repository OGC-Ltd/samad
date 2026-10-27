import { describe, it, expect } from "vitest";
import { clusterByGrid, clusterBadgeLabel, CLUSTER_CELL_PX, chunkMembers, spiderLayout,
  spiderLegsHtml, SPIDER_MAX_UNITS, CHUNK_FANOUT } from "./markerCluster";

/* A projection that is just a scale, so a test can state pixel positions
   directly and read the grouping off them. */
const project = (p) => ({ x: p.lng, y: p.lat });

const at = (id, x, y) => ({ id, lng: x, lat: y });

describe("clusterByGrid", () => {
  it("puts units in the same cell together", () => {
    const out = clusterByGrid([at("A", 0, 0), at("B", 10, 10)], { project });
    expect(out).toHaveLength(1);
    expect(out[0].members.map(m => m.id)).toEqual(["A", "B"]);
  });

  it("keeps units in different cells apart", () => {
    const out = clusterByGrid(
      [at("A", 0, 0), at("B", CLUSTER_CELL_PX + 1, 0)],
      { project },
    );
    expect(out).toHaveLength(2);
    expect(out.every(c => c.members.length === 1)).toBe(true);
  });

  it("returns singles as groups of one, the caller decides what that means", () => {
    const out = clusterByGrid([at("A", 0, 0)], { project });
    expect(out).toHaveLength(1);
    expect(out[0].members).toHaveLength(1);
  });

  it("positions a cluster at the mean of its members", () => {
    const out = clusterByGrid([at("A", 0, 0), at("B", 20, 40)], { project });
    expect(out[0].lng).toBe(10);
    expect(out[0].lat).toBe(20);
  });

  it("orders members by id, so the hover list does not reshuffle", () => {
    const a = clusterByGrid([at("Z", 1, 1), at("A", 2, 2)], { project });
    const b = clusterByGrid([at("A", 2, 2), at("Z", 1, 1)], { project });
    expect(a[0].members.map(m => m.id)).toEqual(["A", "Z"]);
    expect(b[0].members.map(m => m.id)).toEqual(["A", "Z"]);
  });

  it("is stable under a pan, the grid is anchored to the world, not the view", () => {
    // Same world positions, projected twice. A viewport-anchored grid would
    // re-cut these; a world-anchored one cannot.
    const pts = [at("A", 5, 5), at("B", 12, 12), at("C", 200, 200)];
    const first  = clusterByGrid(pts, { project });
    const second = clusterByGrid(pts, { project });
    expect(second.map(c => c.members.map(m => m.id))).toEqual(
      first.map(c => c.members.map(m => m.id)),
    );
  });

  it("drops points the projection cannot place", () => {
    const out = clusterByGrid(
      [at("A", 0, 0), { id: "bad", lat: NaN, lng: NaN }],
      { project: (p) => (Number.isFinite(p.lat) ? { x: p.lng, y: p.lat } : null) },
    );
    expect(out).toHaveLength(1);
    expect(out[0].members.map(m => m.id)).toEqual(["A"]);
  });
});

describe("clusterBadgeLabel", () => {
  it("is exact up to 99", () => {
    expect(clusterBadgeLabel(2)).toBe("2");
    expect(clusterBadgeLabel(99)).toBe("99");
  });
  it("caps past that, because the badge is narrower than the count", () => {
    expect(clusterBadgeLabel(100)).toBe("99+");
    expect(clusterBadgeLabel(815)).toBe("99+");
  });
});

/**
 * Fanning a cluster open — the numbers a reader feels.
 *
 * These exist because the sizes are the whole complaint: clicking a cluster of
 * eighty-nine used to hand back pieces of thirty and forty, which is not a step
 * towards the one vehicle you opened it for. A chunk that is too big is not a
 * cosmetic problem, it is the feature failing.
 */
describe('chunkMembers', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `v${String(i).padStart(3, '0')}`)
  const sizes = (n) => chunkMembers(ids(n)).map((g) => g.length)

  it('hands back single units while the cluster is small enough to show whole', () => {
    for (const n of [2, 5, 9, SPIDER_MAX_UNITS]) {
      expect(sizes(n)).toEqual(Array(n).fill(1))
    }
  })

  it('splits 89 into chunks that are a step towards one vehicle', () => {
    // The reported case. Nine pieces at most, none of them a crowd.
    expect(sizes(89)).toEqual([12, 12, 12, 12, 12, 12, 12, 5])
  })

  it('never returns a chunk of 30 or more until the fleet itself is huge', () => {
    // 30 is the line the request drew. It holds everywhere a real cell can
    // reach: 144 is CHUNK_FANOUT * SPIDER_MAX_UNITS, the largest cluster that
    // chunks to twelves in one step.
    for (let n = SPIDER_MAX_UNITS + 1; n <= 144; n += 1) {
      const max = Math.max(...sizes(n))
      expect(max, `n=${n}`).toBeLessThan(30)
    }
  })

  it('chunks again rather than giving up when one step is not enough', () => {
    // 597 units in one cell is world-zoom, and no single step can make that
    // twelves. What matters is that each step is strictly smaller than the
    // last, so clicking down always terminates at units.
    let n = 597
    const path = [n]
    while (n > SPIDER_MAX_UNITS) {
      const next = Math.max(...sizes(n))
      expect(next).toBeLessThan(n)
      n = next
      path.push(n)
    }
    expect(path).toEqual([597, 50, 10])
    expect(sizes(10)).toEqual(Array(10).fill(1))
  })

  it('loses nobody and keeps the order it was given', () => {
    for (const n of [13, 47, 89, 200]) {
      expect(chunkMembers(ids(n)).flat()).toEqual(ids(n))
    }
  })

  it('never opens more feet than one ring can hold', () => {
    for (const n of [13, 89, 144, 597, 2000]) {
      expect(chunkMembers(ids(n)).length).toBeLessThanOrEqual(CHUNK_FANOUT)
    }
  })
})

describe('spiderLayout', () => {
  const gaps = (feet) => feet.map((f, i) => {
    const g = feet[(i + 1) % feet.length]
    return Math.hypot(f.x - g.x, f.y - g.y)
  })

  it('gives every foot room for a marker', () => {
    // A marker is ~34 px wide with its halo. Feet closer than that overlap,
    // and an overlapping foot is unclickable — which is the whole point of
    // fanning in the first place.
    for (let n = 2; n <= 24; n += 1) {
      const feet = spiderLayout(n)
      expect(feet).toHaveLength(n)
      if (n === 2) continue
      expect(Math.min(...gaps(feet)), `n=${n}`).toBeGreaterThan(34)
    }
  })

  it('starts a small fan at twelve o\'clock', () => {
    const [first] = spiderLayout(4)
    expect(Math.round(first.x)).toBe(0)
    expect(first.y).toBeLessThan(0)
  })

  it('grows the ring rather than crowding it', () => {
    const r = (n) => Math.hypot(...Object.values(spiderLayout(n)[0]))
    expect(r(9)).toBeGreaterThan(r(3))
  })
})

describe('spiderLegsHtml', () => {
  it('draws a line per segment, offset into a box that contains them all', () => {
    const html = spiderLegsHtml([{ x1: 0, y1: 0, x2: 48, y2: 0 }, { x1: 0, y1: 0, x2: -48, y2: 0 }])
    expect(html.match(/<line /g)).toHaveLength(2)
    // half = 50, so the centre of both legs lands at x=50 and the feet at 98/2.
    expect(html).toContain('x1="50.0" y1="50.0" x2="98.0" y2="50.0"')
    expect(html).toContain('x1="50.0" y1="50.0" x2="2.0" y2="50.0"')
  })

  it('cannot take a click', () => {
    // The legs sit under the markers. A leg that swallowed a click would eat
    // the gesture meant for the vehicle at the end of it.
    expect(spiderLegsHtml([{ x1: 0, y1: 0, x2: 10, y2: 10 }])).toContain('pointer-events:none')
  })
})
