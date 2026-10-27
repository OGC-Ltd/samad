"""Clean dash/public/estate-plan.geojson in place. Idempotent — safe to re-run.

Why this exists
---------------
The estate plan layer is vector-extracted from
`fleet-server/ESTATE AREAS TO BE PLANTED-Model.pdf`. The original extraction
script was not kept, which cost a day to re-derive, so this one lives in the
repo. Six passes over the shipped GeoJSON, 9,450 features in, 4,451 out:

1. STRIP VECTORISED TEXT. AutoCAD plots annotation text as linework as well as
   as text, and the extraction kept the strokes. The sheet's big red "B1".."B4"
   nursery callouts were sitting on the map as four red scribbles that read as
   land. The rule is CONTAINMENT, not size: a feature lying wholly inside a PDF
   text line's bounding box is a glyph, because a real field block is always
   bigger than the label printed inside it. 151 features.

2. TAG HATCH. The drawing shades land use with diagonal hatching, and the
   extraction cannot tell a hatch stroke from a block edge. Thin + short + NOT
   part of a chain — see the pass itself for why all three tests are needed.

3. DROP MISASSIGNED NAMES. 46 of them, including a `B2` and a `B4` stuck on
   swampy features 2.5 km and 4.1 km from the blocks they claimed to be.

4. DISSOLVE HATCH INTO SOLID SHADING. Buffer, union, shrink, simplify — the
   region the strokes represent, drawn as one flat wash instead of hundreds of
   dashes. All eight classes in SHADE_CLASSES, each checked against the
   hectares the sheet prints and, where the sheet has an on-map label for the
   class, anchored to it. Read the note there before trusting a wash.

5. REMOVE LEFTOVER HATCH AND MARKS. Whatever the shading did not consume loses
   its scribble. Structural outlines are NOT consumed — the biggest red feature
   is the estate boundary.

6. DEDUPE. The sheet double-draws: 622 features had a byte-identical twin.


Every pass needs the PDF -> WGS84 affine, which is recovered from the layer's
own named features rather than assumed: match each uniquely-named GeoJSON
feature to the uniquely-matching PDF text line, least-squares an affine, then
trim the worst decile five times. Names that are ambiguous on either side are
excluded outright — including them is what produced a 503 m median on the first
attempt, against 9 m once they were gone.

Usage:  python dash/scripts/clean-estate-plan.py [--dry-run]
"""
import collections
import json
import math
import os
import re
import sys

import fitz          # pymupdf
import numpy as np
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
PDF = os.path.normpath(os.path.join(
    HERE, '..', '..', 'fleet-server', 'ESTATE AREAS TO BE PLANTED-Model.pdf'))
GEO = os.path.normpath(os.path.join(HERE, '..', 'public', 'estate-plan.geojson'))

DRY = '--dry-run' in sys.argv
TEXT_PAD_PT = 1.5    # glyph strokes overshoot the reported text box slightly
HATCH_ASPECT = 4.0
# A hatch stroke is short: the sheet's are ~90 x 20 m. Aspect ratio ALONE also
# catches long thin legitimate linework — river traces, and the estate boundary's
# own straight runs — and removing those left the red boundary drawn as dashes.
HATCH_MAX_M = 300.0
CHAIN_SNAP_M = 8.0   # trace strokes abut within metres; hatch is 20-30 m apart
# Annotation marks the aspect test misses. The sheet stamps small symbols inside
# blocks — 43 x 35 m yellow-hatched squares, pale green tags, white label backing
# boxes, leader stubs — and they are near-square, so HATCH_ASPECT never caught
# them. They are what still read as "boxes in the cells" after the shading went
# in. Anything this small that is not part of a chain is annotation, not land:
# the smallest real field block on the sheet is comfortably over 110 m, and the
# 90-140 m band is entirely 3-point there-and-back strokes rather than closed
# blocks.
MARK_MAX_M = 110.0
NAME_MAX_M = 500     # a block label is printed inside its own 100-300 m block

# ── shading ──
# The drawing shades land use with diagonal HATCHING, and hatch strokes are what
# made the layer look like scribble. Real shading means dissolving the strokes
# back into the solid region they represent: buffer every feature of the class by
# CLOSE_M, union, shrink back, simplify.
#
# ALL EIGHT classes are shaded, on instruction. Four were added after being left
# out on the evidence below; the evidence is kept because it is the only honest
# statement of what each wash is worth. Checked against the sheet's KEY panel:
#
#   planted    632 vs  637    -1%   solid; stable at every cutoff 800 m - 3 km
#   reservoir    4 vs    4.5 -13%   SOLID; one patch, 60 m from the word RESEVOIR
#   borrow      29 vs   32   -10%   solid
#   rocky     1164 vs 1067    +9%   area is tuned, position is good — see below
#   swampy      88 vs  167   -47%   stable shape 1.0-3.0 km, but incomplete: the
#                                   extraction missed most of Zone 3's 144.55 ha
#   factory     29 vs  330   -91%   right place, but it is the factory YARD; the
#                                   green never covered the 330 ha allocation
#   logistics   42 vs   21  +102%   weak; its patches sit 4-5 km from the label
#   wet        146 vs    6.2 +2252% WEAKEST — follows canals and drains, and its
#                                   wash overlaps the planted strip. Do not rely.
#
# rocky has NO stable reconstruction. Its union climbs monotonically with the
# cutoff — 130 ha at 800 m, 212 at 1.4 km, 723 at 1.8 km, 1164 at 2 km, 2115 at
# 2.5 km, 3122 at 2.8 km — because rocky ground is drawn as large overlapping
# region polygons, and the estate boundary is drawn in the same red. 2 km is the
# cutoff that MATCHES the printed figure; it is chosen, not measured, so read the
# area as indicative. What does hold up is where it lands: 67 discrete patches,
# heaviest in the north-west, exactly where the sheet puts Zone 3's 641.8 ha. It
# does not blanket the sheet, and that spatial agreement is the better evidence.
# class -> (printed ha, outline cutoff m, anchor label, anchor radius km)
#
# The CUTOFF is per-class because the classes are drawn differently: planted and
# borrow are hatch fill, so 800 m takes everything real; rocky and swampy are
# drawn as region polygons kilometres across, and an 800 m cutoff caught only
# 12 % of rocky; the reservoir is a 4.5 ha pond, so 250 m is its actual size.
#
# The ANCHOR is how the colour collisions get resolved. The sheet labels its own
# features — `FACTORY`, `RESEVOIR`, `LOGISTICS` sit on the map (the versions with
# hectares in brackets are the KEY panel, not the map) — so a region of that class
# more than `radius` from the class's own label is something else wearing the same
# colour. Without it, "factory" green put a 43-patch wash across Nursery A, 9 km
# from the factory. With it, reservoir resolves to ONE patch 60 m from the word
# RESEVOIR. `None` means no usable on-map label, so no filter.
SHADE_CLASSES = {
    'planted':   (637.0,   800.0,  None,         None),
    'borrow':    (31.92,   800.0,  None,         None),
    'rocky':     (1066.84, 2000.0, None,         None),
    'swampy':    (166.87,  1500.0, None,         None),
    'factory':   (330.13,  2000.0, 'FACTORY',    3.0),
    'reservoir': (4.5,     250.0,  'RESEVOIR',   2.0),
    'logistics': (20.99,   800.0,  'LOGISTICS',  5.0),
    'wet':       (6.21,    800.0,  None,         None),
}
CLOSE_M = 25.0        # hatch spacing is ~20-30 m; this closes between strokes
SIMPLIFY_M = 3.0


def ring(feature):
    g = feature['geometry']
    return g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates']


def metres(w_deg, h_deg, lat):
    return w_deg * 111320 * math.cos(math.radians(lat)), h_deg * 110570


def main():
    page = fitz.open(PDF)[0]
    lines = []
    for blk in page.get_text('dict')['blocks']:
        for ln in blk.get('lines', []):
            t = ''.join(s['text'] for s in ln['spans']).strip()
            if t:
                lines.append((t, ln['bbox']))
    print('PDF text lines: %d' % len(lines))

    by_text = collections.defaultdict(list)
    for t, bb in lines:
        by_text[t].append(((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2))

    gj = json.load(open(GEO, encoding='utf-8'))
    feats = gj['features']
    print('features in: %d' % len(feats))

    # This is a one-way transform, not a repeatable filter. Pass 3 removes names,
    # and names are what the affine is fitted on — so a second run fits a
    # slightly different affine and strips a further 12 features. Re-running
    # would erode the layer a little each time. The output is stamped and a
    # re-run is a no-op; --force is there for when the extraction is regenerated.
    if gj.get('cleaned') and '--force' not in sys.argv:
        print('already cleaned: %s' % gj['cleaned'])
        print('nothing to do (pass --force to clean again anyway)')
        return

    by_name = collections.defaultdict(list)
    for f in feats:
        n = f['properties'].get('n')
        if n:
            r = ring(f)
            by_name[n].append((sum(p[0] for p in r) / len(r),
                               sum(p[1] for p in r) / len(r)))

    pairs = [(by_text[n][0][0], by_text[n][0][1], by_name[n][0][0], by_name[n][0][1])
             for n in by_name
             if len(by_name[n]) == 1 and len(by_text.get(n, [])) == 1]
    if len(pairs) < 30:
        sys.exit('only %d usable correspondences — refusing to guess' % len(pairs))

    P = np.array([[p[0], p[1], 1.0] for p in pairs])
    L = np.array([p[2] for p in pairs])
    T = np.array([p[3] for p in pairs])
    idx = np.arange(len(pairs))
    for _ in range(6):
        cx, *_ = np.linalg.lstsq(P[idx], L[idx], rcond=None)
        cy, *_ = np.linalg.lstsq(P[idx], T[idx], rcond=None)
        res = np.hypot((P @ cx - L) * 111320 * np.cos(np.radians(T)),
                       (P @ cy - T) * 110570)
        idx = idx[res[idx] <= np.percentile(res[idx], 90)]
    print('affine: %d pairs -> %d inliers, median %.0f m, max %.0f m'
          % (len(pairs), len(idx), np.median(res[idx]), res[idx].max()))

    def to_wgs(px, py):
        return cx[0] * px + cx[1] * py + cx[2], cy[0] * px + cy[1] * py + cy[2]

    # 1 ── strip vectorised text
    boxes = []
    for t, bb in lines:
        x0, y0, x1, y1 = (bb[0] - TEXT_PAD_PT, bb[1] - TEXT_PAD_PT,
                          bb[2] + TEXT_PAD_PT, bb[3] + TEXT_PAD_PT)
        cs = [to_wgs(x0, y0), to_wgs(x1, y0), to_wgs(x0, y1), to_wgs(x1, y1)]
        boxes.append((min(c[0] for c in cs), min(c[1] for c in cs),
                      max(c[0] for c in cs), max(c[1] for c in cs), t))
    arr = np.array([[b[0], b[1], b[2], b[3]] for b in boxes])

    kept, dropped = [], []
    for f in feats:
        r = ring(f)
        xs = [p[0] for p in r]
        ys = [p[1] for p in r]
        hit = ((arr[:, 0] <= min(xs)) & (arr[:, 1] <= min(ys)) &
               (arr[:, 2] >= max(xs)) & (arr[:, 3] >= max(ys)))
        (dropped if hit.any() else kept).append(f)
    print('stripped as vectorised text: %d   kept: %d' % (len(dropped), len(kept)))

    mx_deg = 111320 * math.cos(math.radians(-4.02))   # metres per degree of lng

    # 2 ── tag hatch
    #
    # Shape alone is not enough. The river trace and the estate boundary are
    # drawn as long runs of short 3-point segments — ~18 x 97 m each, thin and
    # high-aspect, indistinguishable from a hatch stroke by size. Tagging those
    # left the red boundary drawn as dashes.
    #
    # What separates them is topology: a trace is a CHAIN, so consecutive
    # segments share endpoints, while a hatch stroke is an isolated dash whose
    # ends touch nothing. Endpoints are snapped to ~1 m before counting.
    # A stroke's two ENDS are not r[0] and r[-1]. The trace is plotted "there and
    # back" — 3-point LineStrings that go A -> B -> A — so r[0] == r[-1] on every
    # one of them, and testing that pair skipped the whole river. Take r[0] and
    # whichever vertex is furthest from it instead. Polygons are excluded: a
    # closed block has no ends to chain.
    def chain_ends(f):
        if f['geometry']['type'] == 'Polygon':
            return None
        r = ring(f)
        a = r[0]
        b = max(r, key=lambda p: (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2)
        return a, b

    # Proximity, not equality. The trace's strokes do NOT share exact endpoints —
    # matching on equality spared only 2 features and the boundary still dashed.
    # They abut within a few metres, while hatch strokes are 20-30 m apart, so a
    # CHAIN_SNAP_M tolerance separates them cleanly. Grid hash over a 3x3
    # neighbourhood rather than a KD-tree: no scipy dependency.
    cell = CHAIN_SNAP_M / mx_deg
    grid = collections.defaultdict(int)
    for f in kept:
        ends = chain_ends(f)
        if ends:
            for p in ends:
                grid[(int(p[0] // cell), int(p[1] // cell))] += 1

    def near_count(p):
        gx, gy = int(p[0] // cell), int(p[1] // cell)
        return sum(grid.get((gx + dx, gy + dy), 0)
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1))

    hatch = chained = 0
    for f in kept:
        r = ring(f)
        xs = [p[0] for p in r]
        ys = [p[1] for p in r]
        w, h = metres(max(xs) - min(xs), max(ys) - min(ys), sum(ys) / len(ys))
        lo, hi = min(w, h), max(w, h)
        shaped = ((lo > 0.5 and hi / lo >= HATCH_ASPECT and hi <= HATCH_MAX_M)
                  or hi <= MARK_MAX_M)
        ends = chain_ends(f)
        linked = bool(ends) and any(near_count(p) > 1 for p in ends)
        if shaped and linked:
            chained += 1
        if shaped and not linked:
            f['properties']['h'] = 1
            hatch += 1
        else:
            f['properties'].pop('h', None)
    print('tagged as hatch: %d of %d (%.0f%%)  [%d spared as chain links]'
          % (hatch, len(kept), 100 * hatch / len(kept), chained))

    # 3 ── drop names that landed on the wrong feature
    # A block label is printed INSIDE its block, and a block is 100-300 m across,
    # so a named feature sitting half a kilometre from its own label has simply
    # been given the wrong name. The two worst were `B2` and `B4`, stuck on
    # swampy features 2.5 km and 4.1 km away in Zone 4 — a hover there claimed to
    # be the nursery block of that name. Geometry is kept; only the name goes.
    unnamed = []
    for f in kept:
        n = f['properties'].get('n')
        if not n or len(by_text.get(n, [])) != 1:
            continue
        r = ring(f)
        fx = sum(p[0] for p in r) / len(r)
        fy = sum(p[1] for p in r) / len(r)
        lx, ly = to_wgs(*by_text[n][0])
        d = math.hypot((lx - fx) * 111320 * math.cos(math.radians(fy)),
                       (ly - fy) * 110570)
        if d > NAME_MAX_M:
            unnamed.append((n, d))
            f['properties'].pop('n', None)
    print('names dropped as misassigned (>%d m from their own label): %d'
          % (NAME_MAX_M, len(unnamed)))
    for n, d in sorted(unnamed, key=lambda kv: -kv[1])[:8]:
        print('    %-16s %5.0f m' % (n, d))

    # 4 ── dissolve hatch into solid shading
    mx = mx_deg
    my = 110570
    shaded, checks = [], {}
    for cl, (printed, cutoff, anchor_label, anchor_km) in SHADE_CLASSES.items():
        anchor = None
        if anchor_label:
            hits = by_text.get(anchor_label, [])
            if len(hits) == 1:
                anchor = to_wgs(*hits[0])
            else:
                print('    ! %s: anchor %r found %d times, not filtering'
                      % (cl, anchor_label, len(hits)))
        # `consumed` is what actually goes into the union, and it is what gets
        # removed afterwards — NOT every feature of the class. The features the
        # cutoff rejects are the sheet's structural outlines, and the biggest of
        # them IS the red estate boundary. Deleting those along with the hatch
        # left the estate drawn without its outline.
        candidates = []      # (feature, shapely geom) that go into the union
        geoms = []
        for f in kept:
            if f['properties'].get('c') != cl:
                continue
            r = ring(f)
            xs = [p[0] for p in r]
            ys = [p[1] for p in r]
            if (max(xs)-min(xs))*mx > cutoff or (max(ys)-min(ys))*my > cutoff:
                continue                      # a sheet outline, not a land patch
            try:
                if f['geometry']['type'] == 'Polygon' and len(r) >= 4:
                    p = Polygon(r)
                    g = p if p.is_valid else p.buffer(0)
                elif len(r) >= 2:
                    g = LineString(r)
                else:
                    continue
                geoms.append(g)
                candidates.append((f, g))
            except Exception:
                pass
        if not geoms:
            continue
        b = CLOSE_M / mx
        u = unary_union([g.buffer(b, resolution=2) for g in geoms])
        u = u.buffer(-b * 0.9, resolution=2).simplify(SIMPLIFY_M / mx)
        parts = [p for p in ([u] if u.geom_type == 'Polygon' else list(u.geoms)) if p.area > 0]
        if anchor:
            near_label = []
            for p in parts:
                c = p.centroid
                d = math.hypot((c.x - anchor[0]) * mx, (c.y - anchor[1]) * my) / 1000
                if d <= anchor_km:
                    near_label.append(p)
            print('    %-9s anchor %-10r kept %d of %d patches within %.0f km'
                  % (cl, anchor_label, len(near_label), len(parts), anchor_km))
            parts = near_label
        if not parts:
            continue
        # Everything that PASSED the cutoff is land-use fill, and none of it
        # survives as linework: either it dissolved into a region, or its region
        # was anchor-rejected as a colour collision and it is not this class at
        # all. Keeping the rejects visible put 42 stray green boxes across
        # Nursery A — the exact "cells shaded with lines or boxes" complaint.
        # Only features the CUTOFF rejected stay, and those are the structural
        # outlines: the biggest is the 5.3 x 4.3 km estate boundary.
        consumed = [id(f) for f, _ in candidates]
        got = sum(p.area for p in parts) * mx * my / 10000
        checks[cl] = (round(got), printed, round((got/printed - 1) * 100), len(parts))
        for p in parts:
            shaded.append({
                'type': 'Feature',
                'properties': {'c': cl, 's': 1},
                'geometry': {'type': 'Polygon',
                             'coordinates': [[[round(x, 6), round(y, 6)]
                                              for x, y in p.exterior.coords]]},
            })
        gone = set(consumed)
        kept = [f for f in kept if id(f) not in gone]
        checks[cl] = checks[cl] + (len(consumed),)
    # Washes overlap where colours collide — `wet` at +2252 % covers part of the
    # planted strip. Emit worst-validated first so the better-evidenced class
    # ends up on top: google.maps.Data draws in insertion order at equal zIndex.
    trust = {cl: abs(v[2]) for cl, v in checks.items()}
    shaded.sort(key=lambda f: -trust.get(f['properties']['c'], 0))
    print('shading regions built: %d  (draw order worst-first: %s)'
          % (len(shaded), ', '.join('%s %+d%%' % (c, checks[c][2])
                                    for c in sorted(trust, key=lambda k: -trust[k]))))
    for cl, (got, printed, pct, np_, nsrc) in checks.items():
        print('    %-9s %5d ha vs %6.1f printed  (%+d%%)  %d patches from %d features'
              % (cl, got, printed, pct, np_, nsrc))

    # 5 ── every remaining hatch stroke goes. The classes that did not validate
    # keep their block outlines but lose their scribble; nothing is shaded that
    # the drawing's own hectares do not back.
    before = len(kept)
    kept = [f for f in kept if f['properties'].get('h') != 1]
    print('leftover hatch/marks removed: %d' % (before - len(kept)))

    # 6 ── drop exact duplicates. The sheet double-draws: 622 features had a
    # byte-identical twin, which is 12 % of the layer paying twice for the same
    # pixels and drawing every one of those edges at double weight.
    before = len(kept)
    seen = set()
    deduped = []
    for f in kept:
        k = (f['geometry']['type'],
             tuple((round(x, 6), round(y, 6)) for x, y in ring(f)))
        if k in seen:
            continue
        seen.add(k)
        deduped.append(f)
    dupes = before - len(deduped)
    kept = deduped
    print('exact duplicates removed: %d' % dupes)
    kept.extend(shaded)
    for f in kept:
        f['properties'].pop('h', None)

    if DRY:
        print('--dry-run: nothing written')
        return
    gj['features'] = kept
    gj['cleaned'] = {
        'script': 'clean-estate-plan.py',
        'featuresIn': len(feats),
        'textStripped': len(dropped),
        'hatchTagged': hatch,
        'namesDropped': len(unnamed),
        'duplicatesRemoved': dupes,
        'shadingRegions': len(shaded),
        'shadingCheckHa': {k: {'got': v[0], 'printed': v[1], 'deltaPct': v[2],
                               'patches': v[3], 'fromFeatures': v[4]}
                           for k, v in checks.items()},
        'affineInliers': int(len(idx)),
        'affineMedianM': round(float(np.median(res[idx])), 1),
    }
    json.dump(gj, open(GEO, 'w', encoding='utf-8'), separators=(',', ':'))
    print('written %s (%.2f MB)' % (GEO, os.path.getsize(GEO) / 1e6))
    print('stamped: %s' % gj['cleaned'])


if __name__ == '__main__':
    main()
