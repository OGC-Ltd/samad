/**
 * Procedurally-built meshes for the vehicle kinds we have no scanned model of.
 *
 * These are deliberately low-poly: at a 40 px map marker what carries meaning is
 * the SILHOUETTE — an excavator's tracks-house-boom outline, a tractor's small
 * front / large rear wheels, a roller's drum — not panel gaps or bolt heads.
 * A few hundred triangles of correct PROPORTION reads better at that size than
 * a million-triangle scan, and costs nothing to keep in the repo.
 *
 * Everything here emits the same structure scripts/bake-vehicle-atlas.mjs gets
 * from parseObj, so the baker renders these through the identical camera,
 * lighting, fit and shadow path — no special-casing downstream.
 *
 * Conventions, matching the scanned meshes:
 *   · Y is up, ground plane at y = 0.
 *   · +Z is the NOSE. The baker points +Z up-screen at heading 0 (north).
 *   · Units are METRES, taken from real machines in the 20-tonne / 75-100 hp
 *     classes this estate runs. Absolute scale is irrelevant (the baker
 *     auto-fits) but the RATIOS are what make the sprite recognisable.
 *
 * Triangles are emitted with normal index -1 so the baker computes face normals
 * — these are flat-shaded by design, and its two-sided shading means winding
 * order does not matter.
 */

/** Materials. Body takes the status colour; wheels and glass are fixed. */
export const BODY = 0, WHEEL = 1, GLASS = 2

// ── mesh builder ────────────────────────────────────────────────────────────

class Mesh {
  constructor() {
    this.pos  = []   // flat x,y,z
    this.nrm  = []   // flat nx,ny,nz — indexed independently of positions
    this.tris = []   // flat a,b,c, na,nb,nc  (normal index -1 = flat shade)
    this.mats = []
  }

  vert(x, y, z) {
    this.pos.push(x, y, z)
    return this.pos.length / 3 - 1
  }

  /** Register a vertex normal, for the surfaces that should shade SMOOTH. */
  normal(x, y, z) {
    const L = Math.hypot(x, y, z) || 1
    this.nrm.push(x / L, y / L, z / L)
    return this.nrm.length / 3 - 1
  }

  /**
   * Normal indices default to -1, meaning "flat": the baker computes a face
   * normal. That is the RIGHT answer for the boxes and struts these machines
   * are made of — a dozer blade and a cab pillar genuinely have hard edges, and
   * smoothing them would make the machine look inflated. Only curved surfaces
   * (wheels, drums) pass real normals.
   */
  tri(a, b, c, mat, na = -1, nb = -1, nc = -1) {
    this.tris.push(a, b, c, na, nb, nc)
    this.mats.push(mat)
  }

  /** Quad as two triangles. Corners must be given in ring order. */
  quad(a, b, c, d, mat, na = -1, nb = -1, nc = -1, nd = -1) {
    this.tri(a, b, c, mat, na, nb, nc)
    this.tri(a, c, d, mat, na, nc, nd)
  }

  /**
   * A BEVELLED box, given a centre, half-extents and an orthonormal basis.
   *
   * The bevel is the single biggest thing separating "3D render" from "toy
   * blocks". A perfectly sharp edge is a discontinuity that catches no light,
   * so a plain box reads as flat-shaded cardboard however good the lighting is.
   * A chamfer a few centimetres wide picks up a bright specular line along
   * every edge — which is exactly what real machined and folded steel does.
   *
   * Costs 44 triangles instead of 12 (6 inset faces + 12 chamfer strips + 8
   * corner triangles). At a few hundred triangles per machine that is free.
   *
   * Chamfers are left FLAT rather than smoothed: a crisp highlight line along
   * the edge is the effect wanted, and smoothing it would smear the edge back
   * into the faces and undo the point.
   */
  beveledBox(centre, half, mat, bevel = 0.04, basis = null) {
    // Never let the chamfer eat the face it is chamfering.
    const b = Math.min(bevel, 0.4 * Math.min(half[0], half[1], half[2]))

    const place = (l) => {
      if (!basis) return this.vert(centre[0] + l[0], centre[1] + l[1], centre[2] + l[2])
      const [U, V, W] = basis
      return this.vert(
        centre[0] + U[0] * l[0] + V[0] * l[1] + W[0] * l[2],
        centre[1] + U[1] * l[0] + V[1] * l[1] + W[1] * l[2],
        centre[2] + U[2] * l[0] + V[2] * l[1] + W[2] * l[2],
      )
    }

    // 24 vertices: three per corner, one pulled back along each axis. Corner
    // index packs the sign bits as (x,y,z).
    const v = []
    for (let c = 0; c < 8; c++) {
      const s = [(c & 4) ? 1 : -1, (c & 2) ? 1 : -1, (c & 1) ? 1 : -1]
      const trio = []
      for (let a = 0; a < 3; a++) {
        const l = [0, 1, 2].map(i => s[i] * (i === a ? half[i] : half[i] - b))
        trio.push(place(l))
      }
      v.push(trio)
    }

    // Six inset faces, each a ring of the corresponding axis-vertex.
    const FACES = [
      [0, [4, 5, 7, 6]], [0, [0, 1, 3, 2]],
      [1, [2, 3, 7, 6]], [1, [0, 1, 5, 4]],
      [2, [1, 3, 7, 5]], [2, [0, 2, 6, 4]],
    ]
    for (const [a, ring] of FACES) {
      this.quad(v[ring[0]][a], v[ring[1]][a], v[ring[2]][a], v[ring[3]][a], mat)
    }

    // Twelve edge chamfers. For an edge running along axis d, the strip joins
    // the two axis-vertices of the OTHER two axes at each end.
    for (let d = 0; d < 3; d++) {
      const [a1, a2] = [0, 1, 2].filter(a => a !== d)
      const bit = 1 << (2 - d)
      for (let c = 0; c < 8; c++) {
        if (c & bit) continue          // visit each edge once, from its low end
        const c2 = c | bit
        this.quad(v[c][a1], v[c][a2], v[c2][a2], v[c2][a1], mat)
      }
    }

    // Eight corner triangles closing the chamfers.
    for (let c = 0; c < 8; c++) this.tri(v[c][0], v[c][1], v[c][2], mat)

    return v
  }

  /**
   * Axis-aligned box by CENTRE and SIZE — the form every chassis, hood, cab and
   * counterweight here is built from.
   */
  box(centre, [sx, sy, sz], mat, bevel = 0.04) {
    return this.beveledBox(centre, [sx / 2, sy / 2, sz / 2], mat, bevel)
  }

  /**
   * An oriented box spanning p0 → p1 with a `w` × `h` cross-section: booms,
   * sticks, hydraulic rams, exhaust stacks. `w` runs along the machine's X, `h`
   * perpendicular to both, so a boom drawn in the ZY plane keeps its depth
   * across the machine and its thickness in the plane of the swing.
   */
  strut(p0, p1, w, h, mat, bevel = 0.03) {
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
    const L = Math.hypot(...d) || 1
    const u = d.map(x => x / L)

    // Frame: side ⟂ (u, up-ish), then true up = side × u. Falls back to X when
    // the strut is vertical and the cross product degenerates.
    let side = [-u[2], 0, u[0]]
    let sl = Math.hypot(...side)
    if (sl < 1e-6) { side = [1, 0, 0]; sl = 1 }
    side = side.map(x => x / sl)
    const up = [
      side[1] * u[2] - side[2] * u[1],
      side[2] * u[0] - side[0] * u[2],
      side[0] * u[1] - side[1] * u[0],
    ]

    // Same bevelled body as every other part, just carried into the strut's own
    // frame — booms and rams get their edge highlight for free.
    const mid = [0, 1, 2].map(i => (p0[i] + p1[i]) / 2)
    this.beveledBox(mid, [w / 2, h / 2, L / 2], mat, bevel, [side, up, u])
  }

  /**
   * Cylinder with its axis along X — every wheel, tyre and roller drum on these
   * machines. `segments` 16 is already past the point where more is visible in
   * a 64 px cell.
   */
  cylinderX([cx, cy, cz], radius, halfWidth, mat, segments = 16) {
    const ringL = [], ringR = [], ringN = []
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2
      const cos = Math.cos(t), sin = Math.sin(t)
      ringL.push(this.vert(cx - halfWidth, cy + cos * radius, cz + sin * radius))
      ringR.push(this.vert(cx + halfWidth, cy + cos * radius, cz + sin * radius))
      // Radial normal — this is what makes a 16-sided tube read as round
      // instead of as a faceted barrel.
      ringN.push(this.normal(0, cos, sin))
    }
    const capL = this.vert(cx - halfWidth, cy, cz)
    const capR = this.vert(cx + halfWidth, cy, cz)
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      // Tube smooth; the flat end caps stay flat (-1), so the rim keeps its
      // hard silhouette edge instead of bleeding round.
      this.quad(ringL[i], ringR[i], ringR[j], ringL[j], mat,
                ringN[i], ringN[i], ringN[j], ringN[j])
      this.tri(capL, ringL[j], ringL[i], mat)
      this.tri(capR, ringR[i], ringR[j], mat)
    }
  }

  /**
   * A closed polygon in the ZY plane, extruded along X — the crawler tracks,
   * whose chamfered idler ends are what make an excavator read as tracked
   * rather than wheeled.
   *
   * @param profile [z, y] pairs in ring order.
   */
  extrudeX(profile, cx, halfWidth, mat) {
    const L = profile.map(([z, y]) => this.vert(cx - halfWidth, y, z))
    const R = profile.map(([z, y]) => this.vert(cx + halfWidth, y, z))
    for (let i = 0; i < profile.length; i++) {
      const j = (i + 1) % profile.length
      this.quad(L[i], R[i], R[j], L[j], mat)
    }
    // Fan-triangulate the two flanks. The profiles used here are convex, so a
    // fan from vertex 0 is watertight.
    for (let i = 1; i < profile.length - 1; i++) {
      this.tri(L[0], L[i], L[i + 1], mat)
      this.tri(R[0], R[i + 1], R[i], mat)
    }
  }

  /** Mirror-build: run `fn` at +x and again at -x. Both sides, one call. */
  pair(x, fn) { fn(x); fn(-x) }

  /** Hand over in the shape scripts/bake-vehicle-atlas.mjs expects. */
  toModel() {
    return {
      positions: Float64Array.from(this.pos),
      vertCount: this.pos.length / 3,
      normals:   Float64Array.from(this.nrm),
      tri:       Int32Array.from(this.tris),
      triCount:  this.mats.length,
      triMat:    Uint8Array.from(this.mats),
    }
  }
}

// ── excavator ───────────────────────────────────────────────────────────────

/**
 * Tracked hydraulic excavator, 20-tonne class (CAT 320 / Komatsu PC210
 * proportions): 4.2 m track frame, 2.4 m gauge, 2.7 m upper structure.
 *
 * The boom is drawn part-CURLED rather than reaching. A fully-extended boom
 * pushes the bounding box past 8 m, and since the baker fits the longest axis
 * into the cell, a reaching excavator renders small and thin. Curled, it fills
 * the cell and matches the pose a parked machine is actually in.
 */
export function excavator() {
  const m = new Mesh()

  // Crawler tracks. The chamfers at each end are the idler/sprocket rise —
  // without them this silhouette is just a box and reads as a truck.
  const track = [
    [-2.10, 0.30], [-1.72, 0.00], [1.72, 0.00], [2.10, 0.30],
    [2.10, 0.72], [1.72, 0.90], [-1.72, 0.90], [-2.10, 0.72],
  ]
  m.pair(1.19, x => m.extrudeX(track, x, 0.30, WHEEL))

  // Turntable deck the upper structure slews on.
  m.box([0, 0.99, 0], [2.55, 0.22, 3.50], BODY)

  // Upper structure: engine house aft, counterweight at the tail. Kept LOW
  // (top at 2.0 m) so the cab clears it — on the real machine the house is
  // roughly waist-height to the cab, and when the two are level the sprite
  // collapses into one undifferentiated block.
  m.box([0, 1.55, -0.60], [2.50, 0.90, 2.90], BODY)
  m.box([0, 1.35, -2.02], [2.40, 1.30, 0.65], BODY)

  // Operator cab, offset to one side of the boom as on a real machine, and
  // standing ~0.9 m proud of the house.
  m.box([-0.72, 1.40, 0.85], [1.00, 0.60, 1.45], BODY)
  m.box([-0.72, 2.22, 0.85], [0.96, 1.05, 1.40], GLASS)
  m.box([-0.72, 2.81, 0.85], [1.06, 0.12, 1.50], BODY)

  // Boom (two segments approximating its curve), stick, bucket.
  const pivot = [0.30, 1.50, 1.45]
  const knee  = [0.30, 3.15, 2.55]
  const tip   = [0.30, 2.80, 3.85]
  const stick = [0.30, 1.05, 4.05]
  m.strut(pivot, knee, 0.52, 0.68, BODY)
  m.strut(knee, tip, 0.48, 0.60, BODY)
  m.strut(tip, stick, 0.40, 0.54, BODY)
  // Boom ram, slung under the first segment.
  m.strut([0.30, 1.30, 1.30], [0.30, 2.30, 2.35], 0.20, 0.20, BODY)

  // Bucket, curled back toward the machine, with a toothed lip.
  m.box([0.30, 0.62, 4.18], [1.02, 0.80, 0.72], BODY)
  for (let i = -2; i <= 2; i++) {
    m.box([0.30 + i * 0.21, 0.30, 4.60], [0.10, 0.14, 0.26], BODY)
  }

  return m.toModel()
}

// ── dozer ───────────────────────────────────────────────────────────────────

/**
 * Crawler bulldozer, CAT D6 class: 3.2 m blade, 1.9 m track gauge, 3.5 m track
 * frame, 2.9 m to the ROPS roof.
 *
 * Two features carry the whole silhouette and both are worth the triangles:
 *
 *  1. **A blade wider than the machine.** At 40 px this is the only thing that
 *     separates a dozer from an excavator, since both are dark-tracked green
 *     lumps. It overhangs the tracks by ~0.6 m each side, as the real one does.
 *  2. **The high-drive track profile** — elevated rear sprocket, low front
 *     idler, so the track is a rounded triangle rather than the excavator's
 *     flat oval. Instantly reads as a dozer even end-on.
 *
 * The blade is modelled as two stacked slabs offset in Z, which gives the
 * moldboard its concave curve for four extra triangles.
 */
export function dozer() {
  const m = new Mesh()

  // High-drive track: flat on the ground, rising to the sprocket at the rear.
  // Wound counter-clockwise and convex, which extrudeX's fan needs.
  const track = [
    [-1.45, 0.00], [1.35, 0.00], [1.68, 0.18], [1.80, 0.48], [1.55, 0.72],
    [-1.05, 1.48], [-1.55, 1.45], [-1.88, 1.10], [-1.92, 0.55],
  ]
  m.pair(0.95, x => m.extrudeX(track, x, 0.28, WHEEL))

  // Belly frame, engine hood forward, ROPS cab aft.
  m.box([0, 0.70, -0.10], [1.40, 0.55, 2.60], BODY)
  m.box([0, 1.55, 0.78], [1.15, 0.85, 1.85], BODY)
  m.box([0, 1.55, -0.75], [1.55, 0.55, 1.45], BODY)
  m.box([0, 2.30, -0.75], [1.48, 0.95, 1.38], GLASS)
  m.box([0, 2.85, -0.75], [1.68, 0.14, 1.58], BODY)

  // Blade. Lower slab sits further forward than the upper one — that Z offset
  // IS the moldboard curve. The cutting edge is steel, so it takes the wheel
  // material rather than the status colour.
  m.box([0, 1.42, 2.60], [3.20, 0.62, 0.26], BODY)
  m.box([0, 0.82, 2.74], [3.20, 0.62, 0.26], BODY)
  m.box([0, 0.24, 2.82], [3.20, 0.34, 0.22], WHEEL)
  // Blade end plates, which is why a dozer blade reads as a scoop not a plank.
  m.pair(1.52, x => m.box([x, 0.90, 2.58], [0.16, 1.30, 0.60], BODY))

  // Push arms back to the track frames, and the lift rams off the hood.
  m.pair(0.95, x => m.strut([x, 0.72, 2.52], [x, 0.58, 0.30], 0.18, 0.22, BODY))
  m.pair(0.62, x => m.strut([x, 1.62, 1.60], [x + Math.sign(x) * 0.14, 1.32, 2.50], 0.15, 0.15, BODY))

  // Rear ripper — common on estate dozers and it breaks up the tail silhouette.
  m.box([0, 0.95, -2.12], [1.60, 0.30, 0.36], BODY)
  m.strut([0, 0.95, -2.18], [0, 0.12, -2.52], 0.18, 0.30, BODY)

  return m.toModel()
}

// ── tractor ─────────────────────────────────────────────────────────────────

/**
 * Agricultural tractor, 75-100 hp (Massey Ferguson 385 / John Deere 5E
 * proportions): 3.9 m long, 2.1 m wide, 2.5 m to the cab roof.
 *
 * Serves both MTR and CTR — a cane tractor is this machine; what makes it a
 * cane tractor is the trailer it tows, not the tractor. The giveaway ratio is
 * the wheels: rear radius 0.80 m against front 0.48 m. Get that wrong and it
 * reads as a truck.
 */
export function tractor() {
  const m = new Mesh()

  // Wheels — the defining feature. Rears are nearly twice the radius.
  m.pair(0.78, x => m.cylinderX([x, 0.80, -0.75], 0.80, 0.25, WHEEL))
  m.pair(0.68, x => m.cylinderX([x, 0.48, 1.45], 0.48, 0.16, WHEEL))

  // Rear fenders, sitting just clear of the tyres.
  m.pair(0.78, x => m.box([x, 1.42, -0.75], [0.34, 0.12, 1.70], BODY))

  // Spine, bonnet and grille.
  m.box([0, 0.78, 0.30], [0.86, 0.52, 3.10], BODY)
  m.box([0, 1.14, 1.28], [0.80, 0.64, 1.60], BODY)
  m.box([0, 1.04, 2.06], [0.74, 0.52, 0.16], BODY)

  // Cab.
  m.box([0, 1.26, -0.35], [1.46, 0.56, 1.36], BODY)
  m.box([0, 1.94, -0.35], [1.40, 0.84, 1.30], GLASS)
  m.box([0, 2.42, -0.35], [1.56, 0.12, 1.46], BODY)

  // Exhaust stack up the side of the bonnet, and the rear drawbar.
  m.box([0.30, 1.80, 1.72], [0.11, 1.30, 0.11], BODY)
  m.box([0, 0.56, -1.62], [0.36, 0.22, 0.52], BODY)

  return m.toModel()
}

// ── compactor ───────────────────────────────────────────────────────────────

/**
 * Single-drum vibratory soil compactor (CAT CS44 / Bomag BW177 proportions):
 * 5.1 m long, 2.1 m wide, 1.5 m drum diameter.
 *
 * A single smooth steel drum forward and rubber tyres aft — the articulated
 * roller used for haul-road maintenance, which is what COMP/CM do on this
 * estate. The drum is given the wheel material: a steel drum reads dark, and it
 * is the one feature that separates this silhouette from a tractor's.
 */
export function compactor() {
  const m = new Mesh()

  // Drum, its yoke, and the front frame back to the articulation joint.
  m.cylinderX([0, 0.75, 1.55], 0.75, 1.05, WHEEL, 20)
  m.box([0, 1.38, 1.55], [2.32, 0.34, 0.46], BODY)
  m.box([0, 1.16, 0.76], [0.62, 0.42, 1.46], BODY)
  m.box([0, 1.16, 0.14], [0.48, 0.48, 0.32], BODY)

  // Rear chassis on rubber.
  m.box([0, 1.06, -0.92], [1.76, 0.52, 2.20], BODY)
  m.pair(0.80, x => m.cylinderX([x, 0.70, -1.25], 0.70, 0.23, WHEEL))

  // Engine hood aft of the cab.
  m.box([0, 1.66, -1.72], [1.52, 0.76, 1.46], BODY)

  // ROPS cab.
  m.box([0, 1.56, -0.32], [1.50, 0.46, 1.30], BODY)
  m.box([0, 2.16, -0.32], [1.44, 0.84, 1.24], GLASS)
  m.box([0, 2.64, -0.32], [1.60, 0.12, 1.40], BODY)

  return m.toModel()
}
