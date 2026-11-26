/**
 * The estate/site overlay's colour table, and the key that goes with it.
 *
 * Extracted from FleetMap so the KEY's rule can be tested: this project's
 * vitest runs in `node` with no jsdom, by choice, so a decision reachable only
 * through a 4,800-line map component is a decision that never gets a test.
 */

export const ZONE_STYLE = {
  // The one category that must never share the unclassified grey. Red is
  // otherwise unused in this palette, so a keep-out cannot be mistaken for a
  // land use — and "NO GO ZONES -SUKARI" drew in the fallback grey until the
  // taxonomy learned to read it.
  restricted: { color: "#f87171", label: "No-go zone"   },
  farm:       { color: "#4ade80", label: "Farm block"   },
  nursery:    { color: "#a3e635", label: "Nursery"      },
  commercial: { color: "#fbbf24", label: "Commercial"   },
  rainfed:    { color: "#fb923c", label: "Rain-fed"     },
  factory:    { color: "#22d3ee", label: "Factory"      },
  logistics:  { color: "#e879f9", label: "Logistics"    },
  /* Near-white for imagery, and invisible on OpenStreetMap's pale land. */
  facility:   { color: "#e2e8f0", osmColor: "#0d9488", label: "Facility" },
  wetland:    { color: "#38bdf8", label: "Wetland"      },
  water:      { color: "#3b82f6", label: "River"        },
  drain:      { color: "#818cf8", label: "Drain"        },
  road:       { color: "#fde047", label: "Haulage road" },
  /* The trading fences. Menengai's are nearly all of these (5,840 van-sales
     shops of 6,169 zones) and drew in the unclassified grey until 2026-11-04. */
  shop:       { color: "#ffb703", label: "Shop" },
  customer:   { color: "#db2777", label: "Customer"       },

  // ── Works-site categories ──────────────────────────────────────────────
  //
  // An industrial site is not a small estate, and the agricultural vocabulary
  // above describes none of it. Kabras' areas are a scrap yard, a cane inner
  // square, a vehicle park, a garage, a weighbridge and a row of gates — and
  // calling any of those a "Farm block" or leaving them in the unclassified
  // grey is what the site layer is here to stop.
  //
  // Deliberately warm and metallic against the agricultural greens, so the two
  // vocabularies stay distinguishable if an org ever carries both — West Kenya
  // has cane estates as well as this mill.
  yard:       { color: "#f59e0b", label: "Yard"          },
  parking:    { color: "#38bdf8", label: "Vehicle park"  },
  workshop:   { color: "#c084fc", label: "Workshop"      },
  storage:    { color: "#fb7185", label: "Store / stock" },
  weighing:   { color: "#2dd4bf", label: "Weighbridge"   },
  gate:       { color: "#f43f5e", label: "Gate"          },
  /* The site's own pump. Its own category rather than the generic `facility`
   * because on THIS product it is the place that explains a reading: every
   * refuel the fuel module reports happened at one of these, and a depot
   * drawn as an anonymous white "Facility" pin is the one building on the
   * sheet an operator needed to be able to find. Orange is the nearest
   * unclaimed hue to `yard`'s amber, which is the pairing to watch — where a
   * site carries both, the glyph is what separates them. */
  fuel:       { color: "#f97316", label: "Fuel station"  },
  process:    { color: "#22d3ee", label: "Process area"  },
  /* The surveyed site fence. Deliberately NOT `factory`, which is the cyan the
   * geofence overlay already draws the same ground in: two near-identical
   * outlines in one colour read as one wobbly line rather than as two sources
   * that agree. White carries a boundary over satellite imagery without
   * claiming a land use.
   *
   * On OpenStreetMap it carries nothing: the pastel land there is #eef0ed, and
   * a white fence on it was invisible on every one of the eight site plans that
   * draws one (operator, 2026-10-09). Orange there, a shade deeper than the
   * fuel-station pins' #f97316, so the fence still reads as a line rather than
   * as a big fuel station. */
  perimeter:  { color: "#f1f5f9", osmColor: "#ea580c", label: "Site perimeter" },

  /* The geofence layer: routes, HQs and shops in their own colours, then one colour
     for the remaining circles and one for the remaining shapes (operator, 2026-11-04).
     The popup still gives the purpose. See fenceColorKey. */
  route:      { color: "#fb8500", label: "Route"          },
  hq:         { color: "#90e0ef", label: "HQ"             },
  circle:     { color: "#386641", label: "Circular fence" },
  fence:      { color: "#a7c957", label: "Drawn fence"    },

  other:      { color: "#94a3b8", label: "Other"        },
};
export const ZONE_FALLBACK = ZONE_STYLE.other;

/**
 * The colour a category draws in over a given base map.
 *
 * `color` was chosen against Google's satellite imagery — dark, green, busy —
 * and most of the palette is saturated enough to read on OpenStreetMap's pale
 * tiles too. The exceptions are the near-whites, which vanish there; each
 * carries an `osmColor` for every base that is not satellite. OSM is the
 * default and the only base always available, so it is the fallback here.
 */
export function zoneColor(category, base = "osm") {
  const s = ZONE_STYLE[category] ?? ZONE_FALLBACK;
  // Imagery (hybrid, bare satellite) takes the satellite colours; terrain is
  // pale like OpenStreetMap.
  return base === "google" || base === "google-satellite" ? s.color : (s.osmColor ?? s.color);
}

// Legend order — biggest/most meaningful first, so the eye lands on the
// planting areas rather than on drains. Keep-outs lead: they are the only
// entry describing somewhere a machine should not be, and a legend that buries
// that under nine land uses is a legend read too late.
export const ZONE_LEGEND = ["restricted", "gate", "perimeter", "farm", "nursery", "commercial",
                     "rainfed", "factory", "process", "yard", "parking", "workshop", "fuel", "storage",
                     "weighing", "logistics", "route", "hq", "shop", "circle", "fence", "customer", "facility", "wetland", "water", "drain",
                     "road", "other"];

/* A river or drain is a line on the map, but not a way anyone drives. */
const NOT_A_ROUTE = new Set(["water", "drain"]);
const HQ_NAME = /(^|[^a-z0-9])hq($|[^a-z0-9])/i;
const SHOP_NAME = /(^|[^a-z0-9])shop($|[^a-z0-9])/i;
/* Whole words: "TESTIMONY SHOP" and "TESTAI SHOP" are real customers. */
const DUMMY_NAME = /(^|[^a-z0-9])(dummy|test)($|[^a-z0-9])/i;

/** Which ZONE_STYLE entry a geofence draws in on the geofence layer. */
export function fenceColorKey(feature) {
  const p = feature?.properties ?? {};
  const type = feature?.geometry?.type;
  const name = p.name ?? "";
  // Chosen when the fence was drawn: what it is for decides its colour.
  if (p.purpose && ZONE_STYLE[p.purpose]) return p.purpose;
  if (type === "LineString" && !NOT_A_ROUTE.has(p.category)) return "route";
  if (HQ_NAME.test(name)) return "hq";
  if (p.category === "shop" || SHOP_NAME.test(name)) return "shop";
  return type === "Point" ? "circle" : "fence";
}

/** The colour a geofence draws in: the one chosen for it, else its purpose's. */
export function fenceColor(feature, base = "osm") {
  const c = feature?.properties?.color;
  return /^#[0-9a-f]{6}$/i.test(c ?? "") ? c : zoneColor(fenceColorKey(feature), base);
}

/**
 * What a drawn fence can be for, in the order the Draw tool offers them: the
 * places a trucking fleet marks. The server accepts exactly these
 * (server/fences.go fencePurposes): keep the two lists the same.
 */
export const FENCE_PURPOSES = [
  "restricted", "perimeter", "gate", "yard", "parking", "workshop", "fuel", "weighing",
  "logistics", "customer", "facility", "road", "other",
];

/** A dummy or test fence, which stays off the map and out of its search. */
export const isDummyFence = (name) => DUMMY_NAME.test(name ?? "");

/**
 * The key, built from what this organisation actually has on the map.
 *
 * It used to be the constant above, in full, for every org — so Sukari, which
 * carries three zones, was handed a key naming twelve land uses including
 * Nursery, Rain-fed, Wetland and Haulage road. A key is a reading of the map in
 * front of you; one listing nine things that are not on it is a key you learn
 * to stop reading. It also made the whole vocabulary agricultural for a works
 * site, which is the other half of the same mistake.
 *
 * Ordered by ZONE_LEGEND — keep-outs and gates first, because they are the only
 * entries describing somewhere a machine should not be — with anything
 * unranked appended alphabetically rather than dropped, so a category the
 * backend learns to emit before this list is updated still gets a swatch.
 */
export function legendFor(categories, base = "osm") {
  const present = new Set(categories);
  const ranked  = ZONE_LEGEND.filter((k) => present.has(k));
  const rest    = [...present].filter((k) => !ZONE_LEGEND.includes(k)).sort();
  return [...ranked, ...rest].map((key) => ({
    key,
    // The swatch is the colour on the map in front of you, so it follows the base.
    color: zoneColor(key, base),
    label: (ZONE_STYLE[key] ?? ZONE_FALLBACK).label,
  }));
}
