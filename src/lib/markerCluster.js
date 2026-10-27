// Marker clustering for the fleet map.
//
// ## Why a grid, and why hand-rolled
//
// The map's markers are not google.maps.Marker — they are a bespoke
// OverlayView subclass (FleetMap's DomMarker) carrying rich HTML, a tween
// loop, a viewport cull and a three-axis visibility rule. Every off-the-shelf
// clusterer owns the marker lifecycle: it calls setMap(null) on what it hides
// and re-adds what it shows. Handing that control over would fight the
// reconcile pass, the parked-vehicle tween and the route-extension logic all
// at once, for a saving of about forty lines.
//
// So the clustering here is a pure function over positions. It decides WHICH
// units belong together; FleetMap decides what to do about it. This file
// touches no map, no DOM and no React, which is also what makes it testable.
//
// ## Grid, not distance-based
//
// Units are bucketed into fixed pixel cells rather than grown outwards from
// seeds. It is the same choice Google's own GridAlgorithm makes, and it buys
// two things that matter more here than tighter grouping:
//
//   - It is O(n) with no sort, over a fleet that can be 800 units.
//   - It is STABLE. Cells are anchored to the world-pixel origin, not to the
//     viewport, so panning does not re-cut the groups — a cluster of four does
//     not become a three and a one because the map moved twenty pixels. A
//     seed-grown clusterer re-seeds on every pan and visibly reshuffles.
//
// The known artifact is the cell boundary: two units either side of one stay
// apart even though they are adjacent on screen. That is the accepted cost of
// stability, and it resolves the moment the reader zooms — which is the
// gesture the cluster is inviting anyway.

/**
 * Cell size in screen pixels.
 *
 * The marker sprite is ~34 px wide with its halo, so a cell somewhat wider
 * than two of them groups what genuinely overlaps without swallowing units
 * that are merely near each other. Below about 48 the badges themselves start
 * colliding; above about 90 a cluster can cover a yard and a road junction.
 */
export const CLUSTER_CELL_PX = 64;

/**
 * Group points into pixel cells.
 *
 * @param {{id: string, lat: number, lng: number}[]} points
 * @param {object} o
 * @param {(p: {lat: number, lng: number}) => ({x: number, y: number} | null)} o.project
 *        lat/lng → WORLD pixels at the current zoom. World, not screen: world
 *        pixels do not move when the map pans, which is what makes a cluster
 *        keep its membership across a pan.
 * @param {number} [o.cellPx]
 * @returns {{key: string, members: object[], lat: number, lng: number}[]}
 *        One entry per occupied cell, singles included — the caller decides
 *        what a group of one means. Ordered by cell key, so two passes over an
 *        unchanged fleet produce the same array and the DOM can be reconciled
 *        rather than rebuilt.
 */
export function clusterByGrid(points, { project, cellPx = CLUSTER_CELL_PX }) {
  const cells = new Map();

  for (const p of points) {
    const px = project(p);
    if (!px || !Number.isFinite(px.x) || !Number.isFinite(px.y)) continue;
    const key = `${Math.floor(px.x / cellPx)}:${Math.floor(px.y / cellPx)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { key, members: [], sumLat: 0, sumLng: 0 };
      cells.set(key, cell);
    }
    cell.members.push(p);
    cell.sumLat += p.lat;
    cell.sumLng += p.lng;
  }

  const out = [];
  for (const c of cells.values()) {
    const n = c.members.length;
    out.push({
      key: c.key,
      // Sorted by id so the hover list has a fixed order and the cluster's
      // identity does not depend on the order vehicles arrived in.
      members: c.members.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))),
      // The mean position. No antimeridian handling: a single cell is at most
      // ~64 px across, which even at zoom 0 is nowhere near 180° — two members
      // of one cell cannot straddle it.
      lat: c.sumLat / n,
      lng: c.sumLng / n,
    });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * The label a cluster badge carries.
 *
 * Exact up to 99, then "99+". Not because the number is unknown, but because a
 * four-digit badge is wider than the marker it sits on, and past a hundred the
 * reader's next action is the same either way: zoom in.
 */
export function clusterBadgeLabel(count) {
  return count > 99 ? "99+" : String(count);
}

/* ── Fanning a cluster open ────────────────────────────────────────────────

   Same contract as the grid above: pure functions over membership and
   pixels, no map, no DOM, no React. FleetMap owns the markers and decides
   what to do with what these return - which is why the numbers below can be
   tested at all, and they are the numbers a reader actually feels.
   ─────────────────────────────────────────────────────────────────────── */

/**
 * Fanning a cluster out — "spiderfy" — instead of zooming at it.
 *
 * Zooming only separates units that are actually in different places. Two
 * tippers in the same yard, or four trucks queued at one weighbridge, occupy
 * the same 64-px cell at EVERY zoom the map allows, so clicking their badge
 * used to do the one thing it could: move the camera, and come back with the
 * same badge. The fan is the answer to that case. It leaves each unit's
 * lat/lng untouched and nudges only the NODE, by a pixel offset, so every
 * member becomes its own clickable marker without the map ever claiming a
 * vehicle is somewhere it is not. The legs are what says the arrangement is a
 * diagram rather than a position.
 *
 * Feet are spaced by this much; the leg is whatever radius that spacing
 * implies, floored so a pair does not sit on top of each other. A marker is
 * ~34 px wide with its halo, hence a foot separation comfortably past that.
 */
export const SPIDER_FOOT_PX = 42;
export const SPIDER_MIN_LEG = 48;

/**
 * Foot positions in pixels, relative to the badge.
 *
 * A circle up to nine, then an Archimedean spiral: past nine feet a circle
 * either grows a radius that throws units off screen or crowds them back
 * together, and the spiral trades exact symmetry for a constant gap between
 * neighbours, which is the property that actually makes them clickable.
 */
export function spiderLayout(n) {
  const feet = [];
  if (n <= 9) {
    const leg = Math.max(SPIDER_MIN_LEG, (SPIDER_FOOT_PX * n) / (2 * Math.PI));
    for (let i = 0; i < n; i += 1) {
      // Starts at twelve o'clock so a pair reads as up/down, not left/right,
      // which keeps both plates clear of the badge's own hover list.
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      feet.push({ x: Math.cos(a) * leg, y: Math.sin(a) * leg });
    }
    return feet;
  }
  let leg = SPIDER_MIN_LEG;
  let angle = 0;
  for (let i = 0; i < n; i += 1) {
    angle += SPIDER_FOOT_PX / leg + i * 0.0005;
    feet.push({ x: Math.cos(angle) * leg, y: Math.sin(angle) * leg });
    leg += (2 * Math.PI * 7) / angle;
  }
  return feet;
}

/**
 * The most units a fan will put on the map at once, and the most feet it will
 * lay out in one ring.
 *
 * A cluster of eighty-nine cannot become eighty-nine markers in one gesture.
 * The ring would be a wheel of sprites wider than the viewport, the plates
 * would overlap their neighbours, and picking the one vehicle out of it is the
 * job the reader came to do. So a big cluster fans into CHUNKS - smaller
 * badges, each a cluster in its own right - and opening a chunk is another
 * click. Chunk, then chunk, then units.
 *
 * Twelve, because the layout below is a circle to nine and a spiral past it:
 * a dozen feet is the most that still reads as a ring around one place rather
 * than a shape of its own. It also sets the chunk SIZE, and that is the number
 * that was wrong before this existed - a click on eighty-nine handed back
 * pieces of thirty and forty, which is not a step towards one vehicle.
 */
export const SPIDER_MAX_UNITS = 12;
export const CHUNK_FANOUT = 12;

/**
 * Split a cluster's members into the pieces one click hands back.
 *
 * Chunks first, then size: at most CHUNK_FANOUT pieces, each as near equal as
 * integer division allows. Under SPIDER_MAX_UNITS every piece is a single
 * unit and the fan is the plain one.
 *
 *     12 -> 12 units          89 -> 8 chunks of 12 and one of 5
 *    144 -> 12 chunks of 12  597 -> 12 chunks of 50, which chunk again
 *
 * `ids` arrives sorted by id (clusterByGrid sorts members), so the chunks are
 * stable across passes AND alphabetical - the first chunk holds the first
 * plates, which is the only ordering a reader can predict.
 */
export function chunkMembers(ids) {
  const n = ids.length;
  if (n <= SPIDER_MAX_UNITS) return ids.map((id) => [id]);
  const groups = Math.min(CHUNK_FANOUT, Math.ceil(n / SPIDER_MAX_UNITS));
  const size = Math.ceil(n / groups);
  const out = [];
  for (let i = 0; i < n; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * The leg lines, as one SVG sitting under the fan.
 *
 * Takes SEGMENTS rather than feet because a fan is not always a simple star:
 * an opened chunk puts its units on the same ring as its unopened siblings,
 * and every one of them still needs a line home to the place they all are.
 *
 * Drawn from the fan's centre, not from each unit's true pixel position: the
 * members of a cell are within 64 px of that centre anyway, and a per-member
 * line would have to be reprojected on every camera frame for a difference no
 * reader can see. `overflow:visible` because the feet of a spiral run past the
 * box the viewBox declares.
 */
export function spiderLegsHtml(segments) {
  let max = 0;
  for (const g of segments) {
    max = Math.max(max, Math.abs(g.x1), Math.abs(g.y1), Math.abs(g.x2), Math.abs(g.y2));
  }
  const half = Math.ceil(max) + 2;
  const size = half * 2;
  const lines = segments
    .map((g) => `<line x1="${(half + g.x1).toFixed(1)}" y1="${(half + g.y1).toFixed(1)}" x2="${(half + g.x2).toFixed(1)}" y2="${(half + g.y2).toFixed(1)}" />`)
    .join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;overflow:visible;pointer-events:none">`
    + `<g stroke="rgba(148,163,184,0.9)" stroke-width="1.5" stroke-linecap="round">${lines}</g></svg>`;
}
