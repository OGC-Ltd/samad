"""
Kasulu's planting plan from the surveyor's drawing: ESTATE BOUNDARIES.dwg,
exported to KMZ (WGS 84 / UTM 36S embedded in the drawing, reprojected to
lon/lat), into public/estate-plan.geojson for FleetMap's plan layer.

Replaces the PDF-traced plan (scripts/clean-estate-plan.py), which was
georeferenced by eye to about +/-1.5 km. This one is the drawing's own
coordinates (operator, 2026-10-20: "replace the planting area on the new-ui
for kasulu with the newly created kmz").

    python scripts/kmz-to-estate-plan.py "C:/Users/HOD/Desktop/ESTATE BOUNDARIES.kmz" public/estate-plan.geojson

Kept: the boundaries, zones, head-control areas, irrigation blocks, nursery,
rainfed and flood areas, rivers and drainage, roads, the factory site, the
reservoirs and the irrigation mains. Dropped: the pump-station detail (6 MB of
CAD linework), the elevation contours (3 MB), the valves and fittings, and the
sheet's notes and legend. Points are not drawn by the plan layer; the zone
names become its labels instead (printed at the end, for PLAN_LABELS).

Each feature carries `c` (its class, FleetMap PLAN_STYLE), `n` (a name worth
showing on hover, when the drawing has one) and `a` (its area in hectares,
from the drawing).
"""

import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

K = "{http://www.opengis.net/kml/2.2}"

# Drawing layer -> plan class. Anything not listed is dropped.
LAYER_CLASS = {
    "AOI - PROJECT BORDER": "boundary",
    "Farm boundary 20.6": "boundary",
    "BORDER": "zone",
    "TZ-00097 zones distribution": "zone",
    "TZ-00097 updated zones borders": "zone",
    "TZ-00097-ZONES_BORDER_LINE": "zone",
    "HEAD CONTROL BORDER": "headcontrol",
    "IRRIGATION_AREAS": "planted",
    "IRRIGATION AREA - 2B-1": "planted",
    "TZ-00093-100 Ha Borders": "planted",
    "Polygon Area Nursery A": "nursery",
    "Rainfed Area": "rainfed",
    "Flood Boundary Zone Final": "flood",
    "Rivers": "water",
    "Drainage stream": "water",
    "Reservoir location": "reservoir",
    "TZ-00097 - Factory loaction B": "factory",
    "National Road": "road",
    "Roads": "road",
    "GRP 600": "irrigation", "GRP 700": "irrigation", "GRP 800": "irrigation",
    "GRP 900": "irrigation", "GRP 1000": "irrigation", "GRP 1100": "irrigation",
    "GRP 1200": "irrigation",
    "IRR_MAINLINE - Intake 3": "irrigation",
    "IRR_MAINLINE - Intake 4 + Res": "irrigation",
    "IRR_MAINLINE_- Intkae 2": "irrigation",
    "Mainline 2": "irrigation",
    "MAINLINE_PIPES": "irrigation",
    "GADER": "irrigation",
}

# Hover names. The drawing names most outlines by layer and index ("BORDER 7",
# "IRRIGATION_AREAS 213"), which says nothing; those get a plain description.
GENERIC = re.compile(
    r"^(BORDER|HEAD CONTROL BORDER|IRRIGATION_AREAS|IRRIGATION AREA - 2B-1|TZ-00093-100 Ha Borders|"
    r"TZ-00097 zones distribution|TZ-00097 updated zones borders|TZ-00097-ZONES_BORDER_LINE|"
    r"Rainfed Area|Rivers|Drainage stream|GRP \d+|GADER|Reservoir location|Roads|National Road|"
    r"IRR_MAINLINE.*|Mainline 2|MAINLINE_PIPES|Flood Boundary Zone Final|Farm boundary 20\.6|"
    r"AOI - PROJECT BORDER|TZ-00097 - Factory loaction B)( \d+)?$"
)
DESCRIBE = {
    "boundary": "Estate boundary", "zone": "Zone", "headcontrol": "Head-control area",
    "planted": "Irrigation block", "nursery": "Nursery", "rainfed": "Rainfed area",
    "flood": "Flood zone", "water": "River", "reservoir": "Reservoir", "factory": "Factory site",
    "road": "Road", "irrigation": "Irrigation main",
}
NICE = {"NURSERY -B": "Nursery B", "COMMERCIAL AREA (1600)": "Commercial area (1600)"}


def coords(text):
    out = []
    for tok in text.split():
        x, y = tok.split(",")[:2]
        out.append([round(float(x), 6), round(float(y), 6)])
    return out


def geoms(pm):
    for el in pm.iter():
        tag = el.tag[len(K):]
        if tag == "Polygon":
            rings = []
            outer = el.find(f"{K}outerBoundaryIs/{K}LinearRing/{K}coordinates")
            if outer is None or not outer.text:
                continue
            rings.append(coords(outer.text))
            for inner in el.findall(f"{K}innerBoundaryIs/{K}LinearRing/{K}coordinates"):
                if inner.text:
                    rings.append(coords(inner.text))
            if len(rings[0]) >= 4:
                yield {"type": "Polygon", "coordinates": rings}
        elif tag == "LineString":
            c = el.find(f"{K}coordinates")
            if c is not None and c.text:
                pts = coords(c.text)
                if len(pts) >= 2:
                    yield {"type": "LineString", "coordinates": pts}


def main(src, dst):
    with zipfile.ZipFile(src) as z:
        kml = next(n for n in z.namelist() if n.endswith(".kml"))
        root = ET.fromstring(z.read(kml))

    features, labels, seen = [], [], set()
    stats = {"kept": 0, "duplicates": 0, "dropped": 0}

    def walk(el, path):
        for ch in el:
            tag = ch.tag[len(K):]
            if tag in ("Folder", "Document"):
                n = ch.find(f"{K}name")
                walk(ch, path + [n.text if n is not None else ""])
            elif tag == "Placemark":
                layer = next((d.find(f"{K}value").text for d in ch.iter(f"{K}Data") if d.get("name") == "Layer"), None)
                name = (ch.findtext(f"{K}name") or "").strip()
                if layer == "TEXT - Zone names":
                    pt = next(ch.iter(f"{K}coordinates"), None)
                    if pt is not None and pt.text:
                        lng, lat = coords(pt.text)[0]
                        labels.append({"text": NICE.get(name, name), "lat": lat, "lng": lng})
                    continue
                cls = LAYER_CLASS.get(layer)
                if not cls:
                    stats["dropped"] += 1
                    continue
                area = next((d.find(f"{K}value").text for d in ch.iter(f"{K}Data") if d.get("name") == "Area (ha)"), None)
                for g in geoms(ch):
                    key = hashlib.sha1(json.dumps(g["coordinates"]).encode()).hexdigest()
                    if key in seen:
                        stats["duplicates"] += 1
                        continue
                    seen.add(key)
                    props = {"c": cls}
                    if g["type"] == "Polygon":
                        props["n"] = DESCRIBE[cls] if GENERIC.match(name) else NICE.get(name, name.title() if name.isupper() else name)
                        if area and float(area) > 0:
                            props["a"] = round(float(area), 1)
                    features.append({"type": "Feature", "properties": props, "geometry": g})
                    stats["kept"] += 1

    walk(root, [])
    # Draw order inside the layer: wide outlines first, so blocks sit on top.
    order = ["boundary", "zone", "headcontrol", "rainfed", "flood", "nursery", "planted",
             "water", "reservoir", "factory", "road", "irrigation"]
    features.sort(key=lambda f: order.index(f["properties"]["c"]))
    out = {
        "type": "FeatureCollection",
        "source": "ESTATE BOUNDARIES.dwg via KMZ (WGS 84 / UTM 36S), scripts/kmz-to-estate-plan.py",
        "stats": stats,
        "features": features,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    by = {}
    for f in features:
        by[f["properties"]["c"]] = by.get(f["properties"]["c"], 0) + 1
    print(json.dumps({"stats": stats, "byClass": by}, indent=1))
    print("labels:", json.dumps(labels, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
