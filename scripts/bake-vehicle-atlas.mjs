/**
 * Bakes the meshes in models/ into one sprite atlas per vehicle kind —
 * public/<kind>-atlas.png — which the fleet map draws its markers from.
 *
 * Run: npm run bake:sprites            all kinds
 *      npm run bake:sprites lmv bh     just those
 *      npm run bake:sprites lmv --preview
 *                                      big single-row contact sheet to
 *                                      scratch/, for eyeballing orientation
 *                                      and lighting. Writes no atlas.
 *
 * The atlases are committed; a normal build never runs this.
 *
 * ## Why bake instead of rendering the meshes at runtime
 *
 * The map can hold 224 vehicles at once and the source meshes total 253 MB
 * (930 k verts for the LMV alone). Drawing them live means three.js on a
 * WebGLOverlayView, a rewrite of the marker/hover/tween layer, and shipping
 * geometry no browser should download. Instead: render every heading once,
 * offline, and let the browser blit a sprite. Each atlas is a few hundred KB,
 * needs no dependency at build OR runtime, and 224 markers cost exactly what
 * 224 <div>s cost today.
 *
 * IMPORTANT: models/ is NOT public/. Anything in public/ is copied verbatim
 * into the build and served — the meshes were there once and shipped 244 MB to
 * production. Only the baked PNGs belong in public/.
 *
 * ## What it produces
 *
 * One PNG per kind, HEADINGS columns × one row per vehicle status:
 *
 *     col = round(heading / (360 / HEADINGS)) % HEADINGS
 *     row = ok | speeding | theft | parked | idling
 *
 * so the client picks a frame with two integers and a background-position —
 * see FleetMap.jsx's markerSprite.
 *
 * ## Renderer
 *
 * A small z-buffered triangle rasteriser (no dependencies — Node's zlib writes
 * the PNG). Orthographic, camera tilted CAMERA_PITCH_DEG off vertical so the
 * machine reads as a solid object rather than a flat plan view. Geometry is
 * transformed once per heading and the status colours are composited from that
 * same coverage/shade buffer, so tinting costs nothing.
 */

import { writeFileSync, mkdirSync, statSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BODY, WHEEL, GLASS, excavator, dozer, tractor, compactor } from './lib/procedural-meshes.mjs'

const HERE   = dirname(fileURLToPath(import.meta.url))
const ROOT   = join(HERE, '..')
const MODELS = join(ROOT, 'models')
const PUBLIC = join(ROOT, 'public')

// ── knobs ───────────────────────────────────────────────────────────────────

/** Heading frames. 24 = 15° steps, fine enough that turning looks continuous. */
const HEADINGS = 24
/**
 * Output cell size in DEVICE pixels. The marker is 40 CSS px, so 64 was under
 * 2× and visibly soft on any retina display; 96 covers 2.4× and holds up
 * everywhere. The client needs no change when this moves — FleetMap.css sizes
 * the atlas with `background-size: calc(--lf-marker * 24) calc(--lf-marker * 5)`
 * and offsets it in CSS px, so the atlas's own resolution is decoupled.
 */
const CELL = 96
/** Supersampling factor — the only antialiasing this rasteriser has. */
const SS = 4
/** 0° would be a plan view; this tilts the camera to show the machine's side. */
const CAMERA_PITCH_DEG = 34

// Must match STATUS_ROWS in src/components/body/FleetMap.jsx — the row order
// here IS the row order the client indexes with.
const STATUS_ROWS = [
  ['ok',       [0x22, 0xc5, 0x5e]],
  ['speeding', [0xf5, 0x9e, 0x0b]],
  ['theft',    [0xef, 0x44, 0x44]],
  ['parked',   [0x94, 0xa3, 0xb8]],
  // Idling — engine running, vehicle stationary. Cyan because amber is already
  // 'speeding' and the two must never be confused at a glance. Only ever shown
  // for units that actually report an ignition line.
  ['idling',   [0x06, 0xb6, 0xd4]],
]

// Materials (BODY / WHEEL / GLASS) are defined in lib/procedural-meshes.mjs so
// the generated meshes and the OBJ parser cannot drift apart. Body takes the
// status colour; the rest are fixed, or the machine reads as a coloured blob.
const WHEEL_RGB = [0x1f, 0x29, 0x37]
const GLASS_RGB = [0x38, 0x4b, 0x60]

// Lights in VIEW space. Key is over the viewer's left shoulder so the lit side
// is consistent no matter which way the machine points; the fill is opposite
// and weak, which keeps the shadow side from going flat black at 40 px.
const KEY_LIGHT  = normalise([-0.4, 0.75, 0.53])
const FILL_LIGHT = normalise([0.55, 0.35, -0.4])
const FILL_STRENGTH = 0.22
const AMBIENT = 0.38

// Blinn-Phong specular. The camera looks straight down the view-space depth
// axis, so the eye vector is a constant (0,1,0) and the half-vector can be
// precomputed once rather than per pixel.
const HALF_VECTOR = normalise([KEY_LIGHT[0], KEY_LIGHT[1] + 1, KEY_LIGHT[2]])

/**
 * Per-material specular: [strength, exponent]. Without this everything renders
 * as matte plastic. Bodywork is painted metal and takes a broad sheen; glass is
 * tight and bright; tyres and steel tracks are near-matte, and giving rubber a
 * highlight is what makes a render look like a toy.
 */
const SPECULAR = {
  0: [0.30, 28],   // BODY
  1: [0.06, 12],   // WHEEL
  2: [0.65, 70],   // GLASS
}

// ── model registry ──────────────────────────────────────────────────────────
//
// One entry per sprite kind. `kind` is what src/lib/vehicleMap.js maps
// equipment codes onto — the codes themselves are NOT here, so a re-mapping
// (say CTR moving off the tractor sprite) is a one-line edit over there and
// never a re-bake.
//
// An entry supplies its geometry either way round:
//   `file`  — an OBJ in models/, with exclude/wheels/glass naming rules.
//   `build` — a generator from lib/procedural-meshes.mjs, for the machines we
//             have no scanned model of. Materials are assigned as it builds, so
//             the naming rules do not apply.
//
// `exclude` matters more than it looks. Two of these meshes ship with studio
// dressing — a ground plane, a backdrop, floating text labels — and the fit is
// computed from the bounding box, so one stray 19-unit plane renders the
// machine at a third of its proper size. Exclusions are matched against the
// OBJ's `o` names; anything unmatched is body.
//
// `yaw` rotates the model so its NOSE points at +Z (screen up at heading 0,
// i.e. north). Verify with --preview, never by assumption: these come from four
// different authors and only agree by luck.

const REGISTRY = [
  {
    kind: 'lmv',
    file: 'lmv.obj',
    // "Panther 3d.blend" — an Isuzu NKR light truck on a studio backdrop.
    exclude: /^(Plane\.001|Plane\.015_Plane\.014|Text(\.\d+)?|Sphere)$/,
    wheels:  /Tire_Hankook/i,
    // No .mtl shipped with this mesh and every material is a bare
    // "Material.NNN", so the glazing can't be found by material name. These
    // three objects were confirmed to BE the glass by rendering with and
    // without them: darkened, the cab reads as a vehicle; left body-coloured,
    // the whole thing is a featureless blob at marker size.
    glass:   /^(Plane\.00[47]|Plane\.009_Plane\.010)$/,
    yaw: 0,
    fill: 0.86,
  },
  {
    kind: 'bus',
    file: 'bus.obj',
    // Interior geometry is invisible at 40 px but still rasterises; dropping it
    // costs nothing and removes z-fighting through the glass.
    exclude: /^(base2\(int\)_base2_int|steering_w)$/,
    wheels:  /^w_[FR]_\d$/,
    glass:   /^glass$/,
    yaw: 0,
    fill: 0.88,
  },
  {
    kind: 'bh',
    file: 'backhoe.obj',
    // ground_Plane.001 is a 4-vertex, 17×19 shadow catcher — it IS the reason
    // an unconfigured bake renders this machine tiny.
    exclude: /^ground_Plane\.001$/,
    wheels:  /^RUBER_WHEEL/,
    glass:   /^WIND_SREEN/,
    yaw: 0,
    fill: 0.90,
  },
  {
    kind: 'wl',
    file: 'wheel-loader.obj',
    // Was committed as "tractor.obj". It is a wheel loader — every sub-object
    // is KB3D_CZV_VehicLoader_A_*, including BucketArm and BucketPiston — so it
    // renders for WL and NOT for MTR/CTR, which are tractors.
    exclude: /_(Seat|SteeringWheel)$/,
    wheels:  /_Wheel[LR][FR]$/,
    glass:   /Glass$/,
    yaw: 0,
    fill: 0.90,
  },
  {
    kind: 'mc',
    file: 'motorbike.obj',
    // Honda CB650R, extracted from "CBR+650r.max" (a 3ds Max configurator
    // scene) by reading its Scene stream: every Editable Mesh, placed by its
    // node's PRS. The scene holds the bike twice (a second copy at 2.6× scale
    // inside Group009) and the CB650F/FR/R variants overlaid; only the root
    // copy is kept, without the ACC_ accessories. Front wheel is at +Z.
    // The tail light belongs to a tail section that copy lacks, so it floats
    // a hand's width behind the bike — and stretches the fit with it.
    exclude: /^(BASE_CB650FR_Stoplight(_GlassInterior)?_0|BASE_CB650_Main_11)$/,
    wheels:  /Tire|Rims|Disc|Chain_|Fork_|Swingarm|Exhaust|Muffler|Engine|Radiator/,
    glass:   /Glass|Windshield/,
    yaw: 0,
    fill: 0.90,
  },
  {
    kind: 'gen',
    file: 'generator.obj',
    // "generator-1.obj" — a canopied diesel genset. One body object; its parts
    // are told apart by material, so the rules match `usemtl` names. The
    // maker's logo objects are dropped: unreadable at 40 px, and not ours.
    exclude: /^CAT_logo/,
    wheelMtl: /^Black_/,
    glassMtl: /^(Glass|digital)/,
    // Modelled long side along X. Turned so its length runs with the heading
    // like every other machine; side-on list icons then show the long side.
    yaw: 90,
    fill: 0.80,
  },

  // ── generated, not scanned ────────────────────────────────────────────────
  // No mesh exists for these; see lib/procedural-meshes.mjs for the dimensions
  // each is built to and why low-poly is the right call at 40 px. They are
  // built nose-at-+Z by construction, so yaw is 0 by definition rather than by
  // measurement.
  { kind: 'ex',   build: excavator, yaw: 0, fill: 0.92 },
  { kind: 'dz',   build: dozer,     yaw: 0, fill: 0.92 },
  { kind: 'mtr',  build: tractor,   yaw: 0, fill: 0.88 },
  { kind: 'comp', build: compactor, yaw: 0, fill: 0.90 },
]

// ── OBJ parsing ─────────────────────────────────────────────────────────────
//
// Streamed line by line. lmv.obj is 149 MB / 930 k verts; reading it as one
// string and splitting produces a 149 MB string plus ~2 M substrings, which is
// enough to matter even offline.

/** Growable typed-array buffer — the vertex count is unknown until EOF. */
function grow(arr, needed, Type) {
  if (needed <= arr.length) return arr
  let cap = arr.length || 1 << 16
  while (cap < needed) cap *= 2
  const next = new Type(cap)
  next.set(arr)
  return next
}

async function parseObj(path, cfg) {
  let positions = new Float64Array(1 << 16), np = 0
  let normals   = new Float64Array(1 << 16), nn = 0
  let tri       = new Int32Array(1 << 16),   nt = 0   // [a,b,c, na,nb,nc] ×
  let triMat    = new Uint8Array(1 << 14),   nm = 0

  let material = BODY
  let objectMaterial = BODY
  let skipping = false

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    // Hot loop: charCodeAt beats startsWith by enough to notice over 2 M lines.
    const c0 = line.charCodeAt(0)

    if (c0 === 118 /* v */) {
      const c1 = line.charCodeAt(1)
      if (c1 === 32) {
        const p = line.split(/\s+/)
        positions = grow(positions, np + 3, Float64Array)
        positions[np++] = +p[1]; positions[np++] = +p[2]; positions[np++] = +p[3]
      } else if (c1 === 110 /* vn */) {
        const p = line.split(/\s+/)
        normals = grow(normals, nn + 3, Float64Array)
        normals[nn++] = +p[1]; normals[nn++] = +p[2]; normals[nn++] = +p[3]
      }
      continue
    }

    if (c0 === 111 /* o */ && line.charCodeAt(1) === 32) {
      // Vertex indices are GLOBAL across objects, so an excluded object drops
      // its faces only — its vertices stay addressable by later ones.
      const name = line.slice(2).trim()
      skipping = cfg.exclude?.test(name) ?? false
      material = cfg.wheels?.test(name) ? WHEEL : cfg.glass?.test(name) ? GLASS : BODY
      objectMaterial = material
      continue
    }

    // Material-name rules, for meshes that are one object with parts told
    // apart only by `usemtl`. Unmatched materials fall back to the object's.
    if ((cfg.wheelMtl || cfg.glassMtl) && line.startsWith('usemtl ')) {
      const m = line.slice(7).trim()
      material = cfg.wheelMtl?.test(m) ? WHEEL : cfg.glassMtl?.test(m) ? GLASS : objectMaterial
      continue
    }

    if (c0 === 102 /* f */ && !skipping) {
      // f v/vt/vn ... — may be a triangle, a quad or an ngon. Fan-triangulate.
      const chunks = line.slice(2).trim().split(/\s+/)
      const n = chunks.length
      if (n < 3) continue
      const idx = new Int32Array(n), nrm = new Int32Array(n)
      for (let i = 0; i < n; i++) {
        const s = chunks[i]
        const a = s.indexOf('/')
        if (a < 0) { idx[i] = +s - 1; nrm[i] = -1; continue }
        idx[i] = +s.slice(0, a) - 1
        const b = s.indexOf('/', a + 1)
        nrm[i] = b >= 0 && b + 1 < s.length ? +s.slice(b + 1) - 1 : -1
      }
      for (let i = 1; i < n - 1; i++) {
        tri = grow(tri, nt + 6, Int32Array)
        tri[nt++] = idx[0];   tri[nt++] = idx[i];   tri[nt++] = idx[i + 1]
        // All THREE vertex normals, not just the first. Keeping only vertex 0's
        // normal and applying it across the triangle is flat shading, and it is
        // what made these meshes look faceted — lmv.obj alone ships 1.06 M
        // vertex normals describing genuinely curved bodywork.
        tri[nt++] = nrm[0];   tri[nt++] = nrm[i];   tri[nt++] = nrm[i + 1]
        triMat = grow(triMat, nm + 1, Uint8Array)
        triMat[nm++] = material
      }
    }
  }

  return { positions, vertCount: np / 3, normals, tri, triCount: nt / 6, triMat }
}

// ── vector helpers ──────────────────────────────────────────────────────────

function normalise(v) {
  const L = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / L, v[1] / L, v[2] / L]
}

// ── render one heading ──────────────────────────────────────────────────────
//
// Returns supersampled buffers: per-pixel shade (0..1), and which material the
// pixel belongs to. Alpha is derived from coverage during the downsample.

function renderHeading(model, headingRad, centre, scale, size) {
  const { positions, normals, tri, triCount, triMat } = model

  const cosH = Math.cos(headingRad), sinH = Math.sin(headingRad)
  const phi  = (CAMERA_PITCH_DEG * Math.PI) / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)

  /**
   * Direction → view. Rotate about Y (up) by the heading, then tilt about X by
   * the camera pitch. Screen y is -z so the machine's +Z end points UP the
   * screen at heading 0, matching a map where 0° is north.
   */
  const rotate = (x, y, z, out) => {
    const x1 =  x * cosH + z * sinH
    const z1 = -x * sinH + z * cosH
    out[0] = x1
    out[1] = y * cosP - z1 * sinP   // depth: camera is above, larger is nearer
    out[2] = y * sinP + z1 * cosP   // screen up
  }

  const half = size / 2
  const depth = new Float32Array(size * size).fill(-Infinity)
  const shade = new Float32Array(size * size)
  const spec  = new Float32Array(size * size)
  const mat   = new Int8Array(size * size).fill(-1)

  const sx = new Float64Array(3), sy = new Float64Array(3), sd = new Float64Array(3)
  const v = new Float64Array(3), n = new Float64Array(3)
  const e1 = new Float64Array(3), e2 = new Float64Array(3)
  // View-space normal per vertex, interpolated across the triangle below.
  const vn = [new Float64Array(3), new Float64Array(3), new Float64Array(3)]

  for (let t = 0; t < triCount; t++) {
    const ia = tri[t * 6] * 3, ib = tri[t * 6 + 1] * 3, ic = tri[t * 6 + 2] * 3

    for (let k = 0; k < 3; k++) {
      const base = k === 0 ? ia : k === 1 ? ib : ic
      rotate(positions[base] - centre[0], positions[base + 1] - centre[1], positions[base + 2] - centre[2], v)
      sx[k] = half + v[0] * scale
      sy[k] = half - v[2] * scale
      sd[k] = v[1]
    }

    // Vertex normals in view space. Where the mesh supplies them the triangle
    // shades SMOOTH (Gouraud/Phong), which is the whole point — these meshes
    // describe curved bodywork and flat-shading them is what produced the
    // faceted look. Where it does not (normal index -1: procedural boxes and
    // struts, whose edges are genuinely hard), all three vertices share the
    // face normal and the triangle shades flat, exactly as before.
    const inA = tri[t * 6 + 3], inB = tri[t * 6 + 4], inC = tri[t * 6 + 5]
    if (inA >= 0 && inB >= 0 && inC >= 0) {
      rotate(normals[inA * 3], normals[inA * 3 + 1], normals[inA * 3 + 2], vn[0])
      rotate(normals[inB * 3], normals[inB * 3 + 1], normals[inB * 3 + 2], vn[1])
      rotate(normals[inC * 3], normals[inC * 3 + 1], normals[inC * 3 + 2], vn[2])
    } else {
      for (let k = 0; k < 3; k++) {
        e1[k] = positions[ib + k] - positions[ia + k]
        e2[k] = positions[ic + k] - positions[ia + k]
      }
      rotate(
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
        n,
      )
      vn[0].set(n); vn[1].set(n); vn[2].set(n)
    }

    const minX = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])))
    const maxX = Math.min(size - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])))
    const minY = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])))
    const maxY = Math.min(size - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])))
    if (minX > maxX || minY > maxY) continue

    const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0])
    if (Math.abs(area) < 1e-12) continue
    const invArea = 1 / area

    const material = triMat[t]
    const [specStrength, specPower] = SPECULAR[material]

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5, cy = py + 0.5
        const w0 = ((sx[1] - cx) * (sy[2] - cy) - (sx[2] - cx) * (sy[1] - cy)) * invArea
        const w1 = ((sx[2] - cx) * (sy[0] - cy) - (sx[0] - cx) * (sy[2] - cy)) * invArea
        const w2 = 1 - w0 - w1
        if (w0 < 0 || w1 < 0 || w2 < 0) continue

        const d = w0 * sd[0] + w1 * sd[1] + w2 * sd[2]
        const i = py * size + px
        if (d <= depth[i]) continue

        // Interpolate the normal, then shade THIS pixel.
        let nx = w0 * vn[0][0] + w1 * vn[1][0] + w2 * vn[2][0]
        let ny = w0 * vn[0][1] + w1 * vn[1][1] + w2 * vn[2][1]
        let nz = w0 * vn[0][2] + w1 * vn[1][2] + w2 * vn[2][2]

        // Two-sided shading rather than a backface cull. These meshes come from
        // four authors and none has consistent winding or outward normals;
        // culling by `ny < 0` drops real bodywork and renders the LMV hollow,
        // with its interior showing through the panels. Flipping the normal
        // toward the camera keeps every surface and shades it sensibly —
        // occlusion is the z-buffer's job, and it already does it correctly.
        let nl = Math.hypot(nx, ny, nz) || 1
        if (ny < 0) nl = -nl
        nx /= nl; ny /= nl; nz /= nl

        const key  = Math.max(0, nx * KEY_LIGHT[0]  + ny * KEY_LIGHT[1]  + nz * KEY_LIGHT[2])
        const fill = Math.max(0, nx * FILL_LIGHT[0] + ny * FILL_LIGHT[1] + nz * FILL_LIGHT[2])

        let s = 0
        if (key > 0) {
          const nh = nx * HALF_VECTOR[0] + ny * HALF_VECTOR[1] + nz * HALF_VECTOR[2]
          if (nh > 0) s = Math.pow(nh, specPower) * specStrength
        }

        depth[i] = d
        shade[i] = Math.min(1, AMBIENT + (1 - AMBIENT) * key + FILL_STRENGTH * fill)
        spec[i]  = s
        mat[i]   = material
      }
    }
  }

  applyAmbientOcclusion(depth, shade, mat, size, scale)
  return { shade, spec, mat }
}

// ── ambient occlusion ───────────────────────────────────────────────────────

/** How dark a fully-enclosed crevice gets. Past ~0.5 the machine looks grimy. */
const AO_STRENGTH = 0.55
/** Sample ring radii as a fraction of the cell — the scale creases are read at. */
const AO_RADII = [0.018, 0.038]

/**
 * Screen-space ambient occlusion over the z-buffer.
 *
 * Direct lighting alone leaves every large face a single flat tone, which is
 * most of what still reads as "toy" once shading is smooth: real objects go
 * darker where surfaces meet. This darkens a pixel by how many neighbours stand
 * in FRONT of it — the cab/hood junction, under a dozer blade, inside the
 * track frames — which is cheap here because the depth buffer already exists.
 *
 * Depth is view-space (larger = nearer) in MODEL units, so it is multiplied by
 * `scale` to compare against pixel-space radii and stay resolution-independent.
 */
function applyAmbientOcclusion(depth, shade, mat, size, scale) {
  // Eight directions per ring, two rings — enough for a smooth gradient without
  // the banding a single ring produces on flat faces.
  const dirs = []
  for (const frac of AO_RADII) {
    const r = Math.max(1, Math.round(size * frac))
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      dirs.push([Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r), r])
    }
  }

  const out = new Float32Array(shade.length)
  out.set(shade)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      if (mat[i] < 0) continue
      const here = depth[i] * scale

      let occ = 0
      for (const [ox, oy, r] of dirs) {
        const nx = x + ox, ny = y + oy
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        const j = ny * size + nx
        if (mat[j] < 0) continue                  // background occludes nothing
        const diff = depth[j] * scale - here      // >0 means the neighbour is nearer
        // Smooth falloff rather than a hard cutoff: full weight for a neighbour
        // level with this pixel, half at one ring radius away, tailing off from
        // there. A hard `diff < r * k` test throws away the STRONGEST
        // occluders — a dozer's cab stands ~0.9 m proud of its hood, and that
        // is a crease to darken, not a separate part to ignore.
        if (diff > 0.6) occ += r / (r + diff)
      }

      out[i] = shade[i] * (1 - AO_STRENGTH * (occ / dirs.length))
    }
  }
  shade.set(out)
}

// ── baked contact shadow ────────────────────────────────────────────────────
//
// The marker used to get its separation from the map with two CSS
// `drop-shadow()` filters. That is 2 filter passes × up to 224 markers, and the
// browser re-rasterises them whenever the layer scales — which is exactly what
// a map zoom does, every frame. Baking the shadow into the sprite makes it free
// at runtime: it is just more pixels in an image the GPU already has.

/** Gaussian-ish blur of the alpha channel, via three box passes. */
function blurAlpha(alpha, w, h, radius) {
  let src = Float32Array.from(alpha)
  let dst = new Float32Array(alpha.length)
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k
          if (xx < 0 || xx >= w) continue
          sum += src[y * w + xx]; n++
        }
        dst[y * w + x] = sum / n
      }
    }
    [src, dst] = [dst, src]
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k
          if (yy < 0 || yy >= h) continue
          sum += src[yy * w + x]; n++
        }
        dst[y * w + x] = sum / n
      }
    }
    [src, dst] = [dst, src]
  }
  return src
}

const SHADOW_RADIUS = 2      // px, at CELL resolution
const SHADOW_OFFSET_Y = 2    // px down — the machine sits above its shadow
const SHADOW_ALPHA = 0.72    // peak opacity of the shadow under the body

/** Draw `cell` over a baked shadow of itself, into the atlas at (dx, dy). */
function compositeWithShadow(cell, size, atlas, atlasW, dx, dy) {
  const alpha = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) alpha[i] = cell[i * 4 + 3] / 255

  const blurred = blurAlpha(alpha, size, size, SHADOW_RADIUS)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4

      // Shadow sampled from ABOVE by the offset, so it lands below the machine.
      const sy = y - SHADOW_OFFSET_Y
      const shadowA = sy >= 0 ? Math.min(1, blurred[sy * size + x] * 1.6) * SHADOW_ALPHA : 0

      const fgA = cell[si + 3] / 255
      const outA = fgA + shadowA * (1 - fgA)
      if (outA <= 0.002) continue

      const o = ((dy + y) * atlasW + (dx + x)) * 4
      // Colour is the foreground weighted by its own alpha; the shadow
      // contributes only blackness, so it darkens rather than tints.
      atlas[o]     = Math.round((cell[si]     * fgA) / outA)
      atlas[o + 1] = Math.round((cell[si + 1] * fgA) / outA)
      atlas[o + 2] = Math.round((cell[si + 2] * fgA) / outA)
      atlas[o + 3] = Math.round(outA * 255)
    }
  }
}

// ── PNG writer (RGBA8, no dependencies) ─────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function writePng(path, width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  // Filter type 0 (None) on every scanline.
  //
  // This is deliberate and was MEASURED, not assumed. Adaptive per-line
  // filtering (libpng's minimum-sum-of-absolute-differences heuristic over all
  // five filters) makes these atlases 2% BIGGER — 6432 KB against 6312 KB.
  // The reason is structural: a scanline crosses 24 near-identical heading
  // frames, so unfiltered bytes repeat across columns and deflate matches them
  // at long range. Filtering rewrites each pixel as a delta from its
  // neighbours, which destroys exactly those repeats. Don't "fix" this without
  // re-measuring.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

// ── fit ─────────────────────────────────────────────────────────────────────

/**
 * Centre and scale, from the bounding box of the geometry that SURVIVED the
 * exclusions — computed once, never per-frame. A per-frame fit would make the
 * machine subtly grow and shrink as it turned, which reads as a pulsing marker.
 */
function fitModel(model, fill, cellSize) {
  const { positions, tri, triCount } = model
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]

  // Over referenced vertices only: an excluded object's verts are still in the
  // array (indices are global) and would otherwise drag the box back out.
  const seen = new Uint8Array(model.vertCount)
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = tri[t * 6 + k]
      if (seen[vi]) continue
      seen[vi] = 1
      for (let i = 0; i < 3; i++) {
        const x = positions[vi * 3 + i]
        if (x < min[i]) min[i] = x
        if (x > max[i]) max[i] = x
      }
    }
  }

  const centre = [0, 1, 2].map(i => (min[i] + max[i]) / 2)
  // The worst case is the long axis lying across the screen, so fit to it.
  const longest = Math.max(...[0, 1, 2].map(i => max[i] - min[i]))
  return { centre, scale: (cellSize * fill) / longest, extent: [0, 1, 2].map(i => max[i] - min[i]) }
}

/** Downsample SS×SS supersamples into one output pixel, tinted for one status. */
function resolveCell(shade, spec, mat, size, cell, bodyRgb) {
  const out = Buffer.alloc(cell * cell * 4)
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      let r = 0, g = 0, b = 0, hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = (y * SS + sy) * size + (x * SS + sx)
          if (mat[i] < 0) continue
          const base = mat[i] === WHEEL ? WHEEL_RGB : mat[i] === GLASS ? GLASS_RGB : bodyRgb
          const s = shade[i]
          // Specular is ADDITIVE WHITE, not a brighter shade of the body
          // colour — a highlight that stays green reads as cartoon cel-shading,
          // whereas one that washes toward white reads as gloss on paint.
          const hl = spec[i] * 255
          r += Math.min(255, base[0] * s + hl)
          g += Math.min(255, base[1] * s + hl)
          b += Math.min(255, base[2] * s + hl)
          hits++
        }
      }
      if (!hits) continue
      const o = (y * cell + x) * 4
      // Colour is the average of the COVERED samples, so a half-covered edge
      // pixel keeps its full colour and only loses alpha.
      out[o]     = Math.round(r / hits)
      out[o + 1] = Math.round(g / hits)
      out[o + 2] = Math.round(b / hits)
      out[o + 3] = Math.round((hits / (SS * SS)) * 255)
    }
  }
  return out
}

// ── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const preview = args.includes('--preview')
const wanted = args.filter(a => !a.startsWith('--'))
const kinds = wanted.length ? REGISTRY.filter(m => wanted.includes(m.kind)) : REGISTRY

if (!kinds.length) {
  console.error(`no such kind. known: ${REGISTRY.map(m => m.kind).join(', ')}`)
  process.exit(1)
}

for (const cfg of kinds) {
  console.log(`\n${cfg.kind}  (${cfg.file ?? 'generated'})`)

  const t0 = Date.now()
  const model = cfg.build ? cfg.build() : await parseObj(join(MODELS, cfg.file), cfg)
  console.log(`  ${cfg.build ? 'built' : 'parsed'} ${model.vertCount} verts, ${model.triCount} triangles in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // Preview: a fixed large cell, so orientation, shading and materials are
  // actually inspectable. An atlas cell is far too small to tell a nose from a
  // tail, let alone judge a highlight.
  const cell = preview ? 256 : CELL
  const size = cell * SS

  const { centre, scale, extent } = fitModel(model, cfg.fill, size)
  console.log(`  fitted extent ${extent.map(x => x.toFixed(2)).join(' × ')}`)

  const yawRad = ((cfg.yaw ?? 0) * Math.PI) / 180

  if (preview) {
    // --frames=6,12 renders just those heading indices, for when a single view
    // has to be inspected closely enough to tell a nose from a tail.
    const framesArg = args.find(a => a.startsWith('--frames='))
    const frames = framesArg
      ? framesArg.slice('--frames='.length).split(',').map(Number)
      : [0, 3, 6, 9, 12, 18]   // N, NE, E, SE, S, W
    const atlasW = frames.length * cell
    const atlas = Buffer.alloc(atlasW * cell * 4)
    frames.forEach((h, col) => {
      const { shade, spec, mat } = renderHeading(model, yawRad + (h * 2 * Math.PI) / HEADINGS, centre, scale, size)
      const c = resolveCell(shade, spec, mat, size, cell, [0x22, 0xc5, 0x5e])
      compositeWithShadow(c, cell, atlas, atlasW, col * cell, 0)
      process.stdout.write(`\r  preview frame ${col + 1}/${frames.length}`)
    })
    process.stdout.write('\n')
    const dir = join(ROOT, 'scratch')
    mkdirSync(dir, { recursive: true })
    const out = join(dir, `preview-${cfg.kind}.png`)
    writePng(out, atlasW, cell, atlas)
    console.log(`  ✓ ${out}  (headings N NE E SE S W, left to right)`)
    continue
  }

  const atlasW = HEADINGS * cell
  const atlasH = STATUS_ROWS.length * cell
  const atlas  = Buffer.alloc(atlasW * atlasH * 4)   // zero = fully transparent

  for (let h = 0; h < HEADINGS; h++) {
    const { shade, spec, mat } = renderHeading(model, yawRad + (h * 2 * Math.PI) / HEADINGS, centre, scale, size)
    for (let row = 0; row < STATUS_ROWS.length; row++) {
      const c = resolveCell(shade, spec, mat, size, cell, STATUS_ROWS[row][1])
      compositeWithShadow(c, cell, atlas, atlasW, h * cell, row * cell)
    }
    process.stdout.write(`\r  rendering heading ${h + 1}/${HEADINGS}`)
  }
  process.stdout.write('\n')

  mkdirSync(PUBLIC, { recursive: true })
  const out = join(PUBLIC, `${cfg.kind}-atlas.png`)
  writePng(out, atlasW, atlasH, atlas)
  console.log(`  ✓ ${out}`)
  console.log(`    ${atlasW}×${atlasH}, ${HEADINGS} headings × ${STATUS_ROWS.length} statuses, ${(statSync(out).size / 1024).toFixed(1)} KB`)
}
