// ne_10m_admin_0_countries → new-ui/public/data/countries.json
// Usage: download ne_10m_admin_0_countries.geojson from github.com/nvkelso/natural-earth-vector
// as ne10.geojson next to this script, then: node build-countries.js ../public/data/countries.json
// Douglas–Peucker simplify, round, 4-colour (DSatur) by shared borders.
const fs = require('fs');
const TOL = 0.008, ROUND = 1e3;
const g = JSON.parse(fs.readFileSync('ne10.geojson'));

function dp(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol * tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const countries = [];
for (const f of g.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = []; let b = [180, 90, -180, -90];
  for (const poly of polys) for (const ring of poly) {
    // Full detail where the fleet runs (East and Central Africa); elsewhere the
    // map is only ever seen zoomed out, so a coarser line does.
    const [cx, cy] = ring[0];
    const s = dp(ring, cx > 5 && cx < 55 && cy > -30 && cy < 20 ? TOL : 0.04);
    if (s.length < 4) continue;
    // Islets under ~3 km keep OSM's own land colour; they are most of the bytes.
    const xs = s.map((q) => q[0]), ys = s.map((q) => q[1]);
    if (Math.max(...xs) - Math.min(...xs) < 0.03 && Math.max(...ys) - Math.min(...ys) < 0.03) continue;
    const flat = [];
    for (const [x, y] of s) {
      flat.push(Math.round(x * ROUND) / ROUND, Math.round(y * ROUND) / ROUND);
      b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    }
    rings.push(flat);
  }
  if (rings.length) countries.push({ a: f.properties.ADM0_A3, b: b.map((v) => Math.round(v * 100) / 100), p: rings });
}

// Adjacency: vertices of two countries within ~2 km of each other.
const CELL = 0.02, grid = new Map();
countries.forEach((c, ci) => c.p.forEach((r) => {
  for (let i = 0; i < r.length; i += 2) {
    const k = Math.floor(r[i] / CELL) + ',' + Math.floor(r[i + 1] / CELL);
    let s = grid.get(k); if (!s) grid.set(k, (s = new Set())); s.add(ci);
  }
}));
const adj = countries.map(() => new Set());
for (const [k, s] of grid) {
  const [gx, gy] = k.split(',').map(Number);
  const near = new Set(s);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const o = grid.get(gx + dx + ',' + (gy + dy)); if (o) o.forEach((v) => near.add(v));
  }
  for (const a of s) for (const b of near) if (a !== b) { adj[a].add(b); adj[b].add(a); }
}

// DSatur, 4 colours; a country that cannot fit takes the least-clashing one.
const col = new Array(countries.length).fill(-1);
for (let done = 0; done < countries.length; done++) {
  let best = -1, bs = -1, bd = -1;
  countries.forEach((_, i) => {
    if (col[i] >= 0) return;
    const sat = new Set([...adj[i]].map((j) => col[j]).filter((c) => c >= 0)).size;
    if (sat > bs || (sat === bs && adj[i].size > bd)) { best = i; bs = sat; bd = adj[i].size; }
  });
  const clash = [0, 0, 0, 0];
  adj[best].forEach((j) => { if (col[j] >= 0) clash[col[j]]++; });
  col[best] = clash.indexOf(Math.min(...clash));
}
let clashes = 0;
countries.forEach((c, i) => { c.c = col[i]; adj[i].forEach((j) => { if (col[j] === col[i]) clashes++; }); });

const out = { source: 'Natural Earth 1:10m admin-0 countries (public domain), simplified ' + TOL + '°', countries };
fs.writeFileSync(process.argv[2], JSON.stringify(out));
const ke = countries.find((c) => c.a === 'KEN');
console.log('countries', countries.length, 'clashing pairs', clashes / 2, 'bytes', fs.statSync(process.argv[2]).size,
  'KEN neighbours', [...adj[countries.indexOf(ke)]].map((j) => countries[j].a + ':' + col[j]).join(' '), 'KEN', ke.c);
