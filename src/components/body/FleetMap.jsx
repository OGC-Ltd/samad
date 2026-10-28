// Fleet map: markers, routes, search, filters.
// Engine: Leaflet behind a Google-Maps-shaped API (lib/mapEngine), on
// OpenStreetMap tiles (lib/osmBase). Operator, 2026-10-04: "we are
// openstreetmap now". `maps` below is that namespace, not Google's.
//
import { useMapLayers } from '../../context/MapLayersContext';
// The map SHELL (tiles, controls) is created exactly once on mount; vehicle
// markers are RECONCILED against the live fleet on every change — new vehicles
// get markers, moved vehicles slide, vanished vehicles are removed. That is
// what makes an org switch instant: useFleetLive hydrates the new company's
// cached fleet synchronously, and the very next reconcile pass swaps every
// marker without tearing the map down or waiting on the slow snapshot query.
//
// Markers are custom OverlayView elements rather than google.maps.Marker or
// AdvancedMarkerElement: the fleet's marker is rich HTML (status ring, pulsing
// halo, shadowed dot) styled entirely in FleetMap.scss, and OverlayView is the
// only option that renders arbitrary DOM without requiring a cloud-configured
// Map ID.
//
// The glyph itself is a frame of the baked truck atlas (public/truck-atlas.png;
// layout in FleetMap.scss), not a runtime mesh.

import { pointerXY, layoutViewport } from "../../lib/appZoom";
import { panClearOfWindows } from "../../lib/clearView";
import { apiFetch } from "../../services/api";
import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import "./FleetMap.scss";
import MapOverlay, { FuelIncidentHost } from "./MapOverlay";
import { useIncidentInvestigation, InvestigationWindow } from "./IncidentInvestigation";
import { useHubArrivals, ArrivalsWindow } from "./HubArrivals";
import VehicleStatsCard from "../cards/VehicleStatsCard";
import { copyText } from "../../lib/copyText";
import { mapLabel } from "../../lib/plate";
import { eventMl } from "../../lib/eventLitres";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { useAppFields, useAppActions } from "../../context/AppContext";
import { usePermissions } from "../../hooks/usePermissions";
import COMPANIES from "../../data/companyData";
import { useEstateZones } from "../../hooks/useEstateZones";
import { useWeighbridges } from "../../hooks/useWeighbridges";
import { spokenSiteName } from "../../lib/spokenName";
import { weighbridgeCard, bridgeTitle } from "../../lib/weighbridgeCard";
import { readCache, writeCache } from "../../services/cache";
import { readMapPrefs, writeMapPrefs } from "../../lib/mapPrefs";
import LoadError from "../shared/LoadError";
import { zoneTestFor } from "../../lib/zoneContainment";
import { clusterByGrid, clusterBadgeLabel, CLUSTER_CELL_PX, SPIDER_MAX_UNITS, spiderLayout, spiderLegsHtml, chunkMembers } from "../../lib/markerCluster";
import ClusterList from "./ClusterList";
import { matchesFilter, matchesMapFilters, strandedStop, markerState, spriteKind, isDark, darkAgeLabel, vehicleActivity, ONLINE_COLORS } from "../../lib/vehicleMap";
import RoutePlayback, { todayFleetDay } from "./RoutePlayback";

// The map filter when tracking isn't narrowing the map — one shared instance so
// memo/effect dependencies don't see a "new" empty set on every render.
const EMPTY_TRACKED = new Set();
import { useVehiclePlayback } from "../../hooks/useVehiclePlayback";
import { useRoutePlayback } from "../../hooks/useRoutePlayback";
import { travelledTo, gapsOf, sampleAt, syncReveal, minuteMarks, zonesAt } from "../../lib/playbackPath";
import { useFloatingWindow, useSafeAreaVars } from "../../hooks/useFloatingWindow";
import VehicleCamera from "./VehicleCamera";
import MapLayersMenu from "./MapLayersMenu";
import FleetsMenu from "./FleetsMenu";
import FuelAlertsMenu from "./FuelAlertsMenu";
import { isTheftAlert } from "../../lib/fuelAlerts";
import UnitsMenu from "./UnitsMenu";
import { loadMapEngine } from "../../lib/mapEngine";
import { installOsmBase, OSM_TYPE_ID, OSM_ATTRIBUTION } from "../../lib/osmBase";
import MapStatusBar from "./MapStatusBar";
import StrandedWindow from "./StrandedWindow";
import { SITE_PLANS, NO_PLANS } from "../../lib/sitePlans";
import { useGuestSitePlans } from "../../hooks/useGuestSitePlans";

/** Stable empty list, so clearing the header's links on unmount is one
  * render rather than a new array every time. */
const EMPTY_LINKS = [];
import { useNowTick } from "../../hooks/useNowTick";
import StatusRail from "../layout/StatusRail";
import { useBreakpoint } from "../../hooks/useBreakpoint";
import {
  JAM_COLOR, ROUTE_COLOR, travelModeFor,
  trackJourney, fetchExpectedTime, TRAFFIC_AVAILABLE as EXPECTED_AVAILABLE,
} from "../../lib/tomtomTraffic";
import RouteCoveredCard from "./RouteCoveredCard";
import MapToolRail from "./MapToolRail";
import {
  installGoogleBase, isGoogleBase, GOOGLE_BASE_AVAILABLE, GOOGLE_ATTRIBUTION,
  LIVE_TRAFFIC_AVAILABLE, GOOGLE_TRAFFIC_LEGEND, TRAFFIC_REDRAW_MS, addGoogleTraffic,
} from "../../lib/googleBase";
import { addWeatherLayer } from "../../lib/weatherLayer";
import { getWeatherGrid } from "../../api/weather";
import { pathLengthM, plainPoint, formatDistance } from "../../lib/measure";

/* "Show the route covered" → expected-time card (RouteCoveredCard, TomTom
 * leg-by-leg timing). Switched OFF 2026-10-04 at the operator's request
 * ("disable the calculate route for now"); true brings it back unchanged. */
const ROUTE_TIMING_ENABLED = false;
import { useTrafficRoute, routeTarget, positionFresh } from "../../hooks/useTrafficRoute";
import { useGoogleRoutingOn } from "../../lib/googleRouting";

import { liveTrip } from "../../lib/tripProgress";

import { ZONE_STYLE, ZONE_FALLBACK, legendFor, zoneColor } from "../../lib/zoneLegend";
import { claimSidePanel, onSidePanelClaim, claimMapWindow, onMapWindowClaim } from "../../lib/sidePanels";
const STATUS_COLORS = {
  ok:       ONLINE_COLORS.transit,
  speeding: "#f59e0b",
  theft:    "#ef4444",
  // OFFLINE — the provider reports no connection. Dimmed so it recedes: an
  // unreachable tracker is not something to look at, it is something missing.
  parked:   "#64748b",
  // ── The three ONLINE states are all GREEN ────────────────────────────────
  //
  // One question gets one hue. "Is this unit live?" is the first thing read
  // off the map, and it used to be answered in three unrelated colours: green
  // for a moving unit, cyan for an idling one, and a slate for a stopped one
  // that sat a shade away from the slate meaning OFFLINE. A yard of parked but
  // connected machines read as a yard of dead trackers.
  //
  // So green says live, and the step within it says how much is happening.
  // The alert states above keep their own colours — a speeding or flagged unit
  // is online too, and painting it green would lose the thing worth seeing.
  //
  // Online but stopped, engine off. The palest step: present, healthy, idle.
  stationary: ONLINE_COLORS.stationary,
  // Engine running, vehicle stationary. Emerald keeps a trace of the cyan this
  // used to be, so idling is still its own thing at a glance while sitting
  // inside the online hue.
  idling:   ONLINE_COLORS.idling,
  // Was DRIVING when the provider stopped seeing it — see vehicleMap's
  // signalLost. Violet, deliberately not amber: this shares no meaning with
  // speeding, and it must not recede like `parked`, because a truck lost
  // mid-journey is the opposite of routine. It reads as its own event at a
  // glance, which is the whole point — KDL 182X at 21 km/h and a tracker
  // silent for eight months were drawn identically before this existed.
  "signal-lost": "#a855f7",
};

// Which baked atlas row a marker state draws its TRUCK from.
//
// The atlas rows are poses AND colours: `ok` is baked green, `parked` slate,
// `idling` cyan. That mattered more than it looked, because the truck body is
// most of a marker's pixels - the halo is only a ring around it. A connected
// unit standing in a yard was drawing the SLATE truck, so it read as a dead
// tracker from any distance, with only a pale-green halo to say otherwise.
//
// So `stationary` draws the green `ok` truck, shaded paler by CSS, and green
// says LIVE at a glance - which is the question the map is read for.
//
// `idling` does NOT borrow it. It has a baked row of its own in the sky blue
// IDLING_COLOR names, and that is the colour it keeps: a truck burning fuel
// while it stands is the thing an operator is hunting for, and it should not
// have to be told apart from a healthy one by a shade.
//
// The better fix is a re-bake with a row per online state, and it is not
// available here: models/ is not in this checkout, and truck.obj was never in
// it even when it was (see FleetMap.scss). Borrowing a row is what this table
// exists for.
//
// `signal-lost` has always borrowed the MOVING art, for a different reason:
// the vehicle was in motion when we lost it, and drawing it stopped would
// assert the one thing we do not know.
//
// Stated rather than left to indexOf's -1, which happens to land on row 0 and
// would silently move if the row order ever changed.
const TRUCK_ROW_FOR = { stationary: "ok", "signal-lost": "ok" };

// ── Estate zone overlay ────────────────────────────────────────────────────
//
// Land-use palette for the estate boundaries, keyed by the `category` the
// backend derives from each zone's name (see geofence.repository categorise).
// Chosen to read against HYBRID satellite imagery, which is dark, green and
// visually busy: saturated strokes carry the shape, fills stay near-transparent
// so the ground underneath — the thing operators actually want to check the
// boundary against — is never hidden.

//
// ## Why this layer came back, and for one organisation only
//
// Every geofence we hold came from the tracking provider, and on 2026-09-13 we
// were asked to stop drawing that geometry on the map — we draw our own, from
// surveys we can point at. That removal was right for the three orgs whose
// fences are a handful of provider-typed shapes over ground we already draw.
//
// It was wrong for Mufindi, and asked back 2026-09-14. Kasulu's 97 zones ARE
// the estate: the planted blocks, both nurseries, the factory site, the
// wetlands, the Malagarasi and the haulage roads — and unlike the other orgs'
// fences they are the only surveyed thing we hold for that ground. The planting
// plan beside them is the surveyor's drawing of what the estate is laid out to
// be (zones, irrigation blocks, mains); these say where its fences are, and the
// violation engine enforces them. Two different questions, so two switches
// rather than one layer standing in for the other.
//
// Hence the gate below: this is Mufindi's layer, not a general return of the
// provider's geometry. The other orgs stay as 2026-09-13 left them.
//
// REMOVED 2026-10-20 (operator: "remove the estate plan, we remain with the
// planning area"): no org draws the Estate areas layer any more; Kasulu keeps
// the planting plan. The geometry is still fetched for the stranded-stop test
// and playback. Set back to "kasulu" to restore the layer.
const ZONE_AREAS_COMPANY = null;

// The 67 `VES-nnn` sample points are omitted from the overlay. They are
// 1 km-radius circles that blanket the whole estate and would bury the
// boundaries underneath them — and they are not estate areas, so they are not
// what this toggle is for.
const ZONE_SKIP_CATEGORIES = new Set(["sample"]);

// Wialon zone names are operator-typed and not clean: "FARM#213" arrives with a
// leading ZERO-WIDTH SPACE (U+200B), and "FARM #215" has a space its five
// siblings do not. Every name-keyed lookup below goes through this, so a
// constant can be written the way a human reads it.
const zoneKey = (name) => (name ?? "")
  .replace(/[\u200B-\u200D\uFEFF]/g, "")   // zero-width space / joiner / BOM
  .replace(/\s+/g, " ")
  .trim();

// Zones dropped from the overlay entirely — no shape, no plate, no click, and
// excluded from the layer's camera-fit bounds.
//
// These three are not on the surveyor's 2026-27 sheet, and unlike the wet-land
// plates (suppressed by name below, shapes kept) they are not wanted on the map
// at all. Measured against the DWG's recovered UTM-36S extent they have ZERO
// overlap with the drawing: FARM#212 sits 17.6 km west, FARM#213 25.1 km west
// and 6.3 km south, FARM#214 12.8 km south — 3,000+ ha apiece, off the sheet in
// every direction. Their siblings stay: FARM#210 (16 % overlap), FARM#211
// (59 %, the nesting envelope) and FARM #215 (94 %) are all on drawn ground.
//
// They remain in `geofences` and are still served by /geofences/geojson — all
// three are is_active = false, so nothing is enforced either way. This hides
// them; it does not decide whether they are real parcels outside this season's
// plan. See fleet-server/docs/estate-areas-overlay.md §6.
const ZONE_EXCLUDE = new Set(["FARM#212", "FARM#213", "FARM#214"]);

// EVERY zone carries a name plate — but not at every zoom.
//
// The estate's zones NEST — FARM#211's 16,374 ha envelope contains the factory,
// the 2500 Ha block and both nurseries — so at estate-wide zoom their centroids
// land within a few pixels of each other. The ladder plus the declutter pass is
// what keeps that from stacking into an unreadable pile. Shapes always draw;
// only the text waits.
const ZONE_LABEL_TIERS = [
  { minHa: 1000, minZoom: 11 },   // ZONE 4, the farm envelopes, Rain-fed
  { minHa: 100,  minZoom: 12 },   // factory, nurseries, labour camp, swamps
  { minHa: 10,   minZoom: 14 },   // Logistic centre2, Swamp area3
  { minHa: 0,    minZoom: 15 },   // workshops, dispensary, staff residence
];

// Corridors have no area to fit text inside — a drain is metres wide at any
// zoom — so they get a single midpoint plate once the camera is close enough
// for the corridor itself to be more than a hairline.
const ZONE_CORRIDOR_LABEL_MIN_ZOOM = 13;

/** Lowest zoom at which a zone of this size is allowed a name plate. */
function zoneLabelMinZoom(areaHa) {
  const ha = areaHa ?? 0;
  for (const t of ZONE_LABEL_TIERS) if (ha >= t.minHa) return t.minZoom;
  return ZONE_LABEL_TIERS[ZONE_LABEL_TIERS.length - 1].minZoom;
}

// Plates suppressed by name, shapes left alone.
//
// The wet-land plates are not wanted on the overlay. They are also the two
// zones the surveyor's drawing cannot corroborate — both sit ~12 km WEST of the
// plan's extent, and the drawing's only wet-ground class is WET FIELDS 6.21 ha
// inside Nursery B, three orders of magnitude off "Wet land2" at 1,110 ha. The
// polygons still draw and still answer a click; they just do not shout a name
// the plan does not back.
const ZONE_LABEL_SUPPRESS = new Set(["Wet area1", "Wet land2"]);

// The surveyor's own designation, for the zones the 2026-27 planting drawing
// covers. Wialon carries the operators' names ("2500 Ha Area"); the printed
// plan carries different ones ("ZONE 4"), and nobody holding the sheet can tell
// they are the same ground — which is exactly the confusion two layers on one
// map would otherwise create. `planHa` is what the drawing PRINTS, kept beside
// our computed ring area rather than reconciled with it: the ring is the outer
// envelope and the printed figure the plantable subset inside it.
const ZONE_PLAN_ALIAS = {
  "2500 Ha Area":          { plan: "ZONE 4",       planHa: 2320 },
  "Commercial Area":       { plan: "COMMERCIAL",   planHa: 1296 },
  "Nursery A":             { plan: "NURSERY A" },
  "Nursery - B":           { plan: "NURSERY B",    planHa: 664.36 },
  "Factory site Location": { plan: "FACTORY AREA", planHa: 330.13 },
  "Rainfed Area":          { plan: "RAIN FED",     planHa: 250 },
  "Reservoir site":        { plan: "RESEVOIR",     planHa: 4.5 },
  "Logistic centre2":      { plan: "LOGISTICS 2",  planHa: 20.99 },
};

/** Centroid of a ring, for label placement. Good enough for convex-ish blocks. */
function ringCentroid(ring) {
  let lat = 0, lng = 0;
  // The closing vertex repeats the first — skip it so it isn't double-weighted.
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0]
                            && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) { lng += ring[i][0]; lat += ring[i][1]; }
  return { lat: lat / n, lng: lng / n };
}

/**
 * Point half way ALONG a corridor, by length rather than by vertex index.
 *
 * Vertex spacing is wildly uneven — `Main river malagarasi3` carries 2,414
 * points, dense through the meanders and sparse on the straights — so the
 * middle vertex is not the middle of the river. Walking cumulative length puts
 * the plate where a reader would point at it.
 */
function pathMidpoint(path) {
  let total = 0;
  const seg = [];
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let run = 0;
  for (let i = 0; i < seg.length; i++) {
    if (run + seg[i] >= total / 2) {
      const t = seg[i] ? (total / 2 - run) / seg[i] : 0;
      const [x0, y0] = path[i], [x1, y1] = path[i + 1];
      return { lat: y0 + (y1 - y0) * t, lng: x0 + (x1 - x0) * t };
    }
    run += seg[i];
  }
  const mid = path[Math.floor(path.length / 2)];
  return { lat: mid[1], lng: mid[0] };
}

function zoneLabelHtml(name, color, detail, plan) {
  const sub  = detail ? `<span class="zone-label-area">${detail}</span>` : "";
  // The drawing's designation, only where it differs from the operators' name —
  // repeating "Nursery A / NURSERY A" on the plate is noise.
  const alias = plan && plan.toUpperCase() !== name.toUpperCase()
    ? `<span class="zone-label-plan">${plan}</span>` : "";
  return `<div class="zone-label" style="--zone-color:${color}">${name}${alias}${sub}</div>`;
}

// ── Estate PLAN overlay (the CAD drawing) ──────────────────────────────────
//
// The surveyor's ESTATE BOUNDARIES.dwg: the estate and zone boundaries, the
// head-control areas, 507 irrigation blocks, the nurseries, rainfed and flood
// areas, rivers, reservoirs, the factory site and the irrigation mains — none
// of which exist in the geofence data.
//
// Since 2026-10-20 (operator: "replace the planting area on the new-ui for
// kasulu with the newly created kmz") it is the drawing's OWN coordinates
// (WGS 84 / UTM 36S, embedded in the DWG), through a KMZ export. Samad ships
// no estate plan, so the layer stays empty here.
const ESTATE_PLAN_URL = "/estate-plan.geojson";

// Only this org has an estate plan. The layer is a static asset rather than
// org-scoped API data, so without an explicit gate it would happily draw
// Kasulu's fields underneath Sukari's fleet.
const ESTATE_PLAN_COMPANY = "kasulu";


/** Which of this company's surveys are on, read from its stored preferences. */
function siteOnFor(companyId) {
  const { layers } = readMapPrefs(companyId);
  const out = {};
  for (const p of SITE_PLANS[companyId] ?? NO_PLANS) out[p.id] = Boolean(layers[p.prefKey]);
  return out;
}

/**
 * ON by default for West Kenya — asked for: the mill should already be drawn
 * when the org opens, not something switched on every session.
 *
 * Persisted, so turning it off is a preference rather than a thing to redo each
 * morning. Same treatment as the estate areas and the fuel alerts, and safe to
 * leave true for everyone: the layer is gated on `siteAllowed`, so on any other
 * organisation there is no toggle, no key and nothing drawn.
 */
/* Visibility is a PER-ORGANISATION preference now — see lib/mapPrefs. It was a
 * single global key, which meant closing the survey on West Kenya also closed
 * a layer on an org that has no survey, and the layer defaults could not differ
 * by place. */

// Below this the whole site is a few hundred pixels across and 29 markers pile
// into one blob. The two POLYGONS always draw, so the site is still findable
// from the fleet view; only the pins wait for a camera close enough to tell
// them apart. A survey may raise or lower it — see `pointMinZoom` above.
const SITE_POINT_MIN_ZOOM = 15;

// What "take me to the site" means, in numbers.
//
// The fleet fit pads for hundreds of units and caps at 14, which on a 1.2 km
// survey is a smudge in the middle third of the pane — one step BELOW the zoom
// its own pins need, so the layer arrived with its polygons and none of its 29
// markers. These three are the site's own window: tight padding, a floor above
// the pin gate, and a ceiling that still shows the whole fence rather than one
// corner of it.
const SITE_FIT_PADDING = 24;
const SITE_MIN_ZOOM = 16;
const SITE_MAX_ZOOM = 18;

/**
 * A glyph per category, instead of the place's name.
 *
 * Names were tried first and were unreadable: 29 plates inside 1.2 km overlap
 * into a grey smear at every zoom that shows the whole site, and the site is
 * dense exactly where the plates are longest — "Unhinged Trailler Yard" and
 * "Admin Tractor Auto" sit 80 m apart. An icon is the same information in a
 * fixed 24 px, so density stops mattering, and the NAME moves to hover where
 * there is room for it and for everything else about the place.
 *
 * Stroke-only paths on a 24-unit grid, drawn dark on the category's own colour,
 * so a marker carries its class twice — by shape and by hue — and stays
 * readable for anyone who cannot separate the two colours.
 */
const SITE_GLYPH = {
  // A boom barrier: two posts and the bar across.
  gate:      '<path d="M4 6v12M20 6v12M4 10.5h16"/>',
  // A weighbridge deck with the load on it.
  weighing:  '<path d="M3 17h18M6 17V9h12v8M9 9V6h6v3"/>',
  // A spanner, laid at the usual angle.
  workshop:  '<path d="M16.5 4.5a4 4 0 0 0-5 5L5 16v3h3l6.5-6.5a4 4 0 0 0 5-5l-2.6 2.6-2.1-2.1Z"/>',
  // A crate, banded.
  storage:   '<path d="M4 7h16v12H4zM4 11h16M12 7v12"/>',
  // A stockpile against a ground line.
  yard:      '<path d="M3 18h18M5 18l5-8 4 5 2-2.5 3 5.5"/>',
  // A car, front three-quarter simplified to a body and two wheels.
  parking:   '<path d="M5 15h14M6 15l1.4-4.2A2 2 0 0 1 9.3 9.4h5.4a2 2 0 0 1 1.9 1.4L18 15M7.5 15v2.5M16.5 15v2.5"/>',
  // A vessel with its stack — the distillery and the effluent plant.
  process:   '<path d="M7 20V9a5 5 0 0 1 10 0v11zM7 13h10M14 4h4v5"/>',
  // A pump: the column, the hose looping down, and the nozzle on its hook.
  fuel:      '<path d="M5 20V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14M4 20h11M5 11h8M16 9h3v7a2 2 0 0 0 2 2"/>',
  // A building with windows.
  facility:  '<path d="M5 20V5h14v15M9 9h2M13 9h2M9 13h2M13 13h2M9 17h6"/>',
  // Anything the survey grows that this table has not learnt yet.
  other:     '<path d="M12 5v14M5 12h14"/>',
};

/**
 * The marker, as a data URI.
 *
 * An inline SVG rather than a `Symbol.path`, because a symbol is ONE path in
 * one fill — it cannot carry a dark glyph on a coloured disc, and a flat
 * silhouette at 24 px loses the detail that makes a spanner a spanner.
 */
function siteIcon(category) {
  const { color } = ZONE_STYLE[category] ?? ZONE_FALLBACK;
  const glyph = SITE_GLYPH[category] ?? SITE_GLYPH.other;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24">' +
    `<circle cx="12" cy="12" r="11" fill="${color}" stroke="#0b1220" stroke-width="1.6"/>` +
    '<g fill="none" stroke="#0b1220" stroke-width="1.8" stroke-linecap="round" ' +
    `stroke-linejoin="round" transform="translate(12 12) scale(0.62) translate(-12 -12)">${glyph}</g>` +
    "</svg>";
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

// Classes of the surveyor's drawing. `weight`
// is the outline in px (0 = none), `fill` the wash; lines take only the stroke.
const PLAN_STYLE = {
  boundary:    { color: "#f97316", weight: 2.2, fill: 0 },
  zone:        { color: "#c2410c", weight: 1.6, fill: 0.03 },
  headcontrol: { color: "#b45309", weight: 1.1, fill: 0.03 },
  planted:     { color: "#16a34a", weight: 0.8, fill: 0.14 },
  nursery:     { color: "#65a30d", weight: 1.2, fill: 0.2 },
  rainfed:     { color: "#ca8a04", weight: 1, fill: 0.12 },
  flood:       { color: "#06b6d4", weight: 1.4, fill: 0.08 },
  water:       { color: "#2563eb", weight: 1.4, fill: 0.35 },
  reservoir:   { color: "#d946ef", weight: 1.2, fill: 0.4 },
  factory:     { color: "#22c55e", weight: 1.4, fill: 0.2 },
  road:        { color: "#78716c", weight: 2, fill: 0.15 },
  irrigation:  { color: "#0d9488", weight: 1.6, fill: 0 },
};
const PLAN_LEGEND = ["planted", "nursery", "rainfed", "flood", "water", "reservoir", "factory", "irrigation", "headcontrol", "zone", "boundary"];
const PLAN_LABEL = {
  boundary: "Estate boundary", zone: "Zone", headcontrol: "Head-control area", planted: "Irrigation block",
  nursery: "Nursery", rainfed: "Rainfed area", flood: "Flood zone", water: "River", reservoir: "Reservoir",
  factory: "Factory site", road: "Road", irrigation: "Irrigation main",
};

// The drawing's area names — the ones a reader of the sheet navigates by, and
// the only labels on it that no geofence carries.
//
// From ESTATE BOUNDARIES.dwg itself since 2026-10-20 (its own UTM 36S
// coordinates), replacing the PDF-traced plan that was placed to about
// +/-1.5 km: ZONE 3 moved 2.5 km and ZONE 4 1.8 km against the old plates,
// which is that error. Each named zone sits at the centroid of its own outline
// in the drawing (the sheet's text is a callout on a block edge, which reads as
// labelling the next block); the intakes, which have no outline, at the
// drawing's text.
const PLAN_LABELS = [
  { text: "ZONE 3", lat: -3.99006, lng: 30.40023, minZoom: 11, priority: 3 },
  { text: "ZONE 4", lat: -4.02411, lng: 30.41735, minZoom: 11, priority: 3 },
  { text: "COMMERCIAL AREA", lat: -4.02738, lng: 30.48222, minZoom: 11, priority: 3 },
  { text: "NURSERY B", lat: -4.02092, lng: 30.51427, minZoom: 11, priority: 3 },
  { text: "NURSERY A", lat: -4.03049, lng: 30.54103, minZoom: 12, priority: 2 },
  { text: "FACTORY SITE", lat: -4.03881, lng: 30.41352, minZoom: 13, priority: 2 },
  { text: "INTAKE 1", lat: -4.02183, lng: 30.54110, minZoom: 13, priority: 1 },
  { text: "INTAKE 2", lat: -4.00190, lng: 30.49923, minZoom: 13, priority: 1 },
  { text: "INTAKE 3", lat: -3.98890, lng: 30.45628, minZoom: 13, priority: 1 },
];

function planLabelHtml(text) {
  return `<div class="zone-label plan-label">${text}</div>`;
}

/**
 * Move the camera to `bounds`, reliably.
 *
 * A bare `map.fitBounds()` is silently dropped when the map is busy — during a
 * React commit, or straight after a large addGeoJson. Measured on this map: the
 * identical bounds object landed on (33.50, -3.24) called inline and on
 * (30.35, -4.01) called a moment later. Symptom is a layer that draws perfectly
 * and is never seen, because the camera is still a thousand kilometres away.
 *
 * So: wait a frame, nudge the map to re-measure, fit — then verify once the
 * camera settles and fit again if it did not land. The verify pass is what
 * makes this dependable rather than a race that usually wins.
 */
function fitMapToBounds(map, maps, bounds, padding = 70, zoom = {}) {
  if (!map || !maps || !bounds || bounds.isEmpty()) return () => {};
  // The cap is the fleet's, and a caller framing one yard needs its own. 14 is
  // a sensible ceiling for a fleet fit and a floor-through-the-ceiling for a
  // 1.2 km site: it stops the camera a full zoom step BELOW the level the
  // site's own markers are gated at, so fitting a site plan drew its polygons
  // and none of its 29 pins, every time.
  const maxZoom = zoom.max ?? FIT_MAX_ZOOM;
  const minZoom = zoom.min ?? 0;
  const pad = { top: padding, right: padding, bottom: padding, left: padding };
  let idleOnce = null;
  const raf = requestAnimationFrame(() => {
    maps.event.trigger(map, "resize");
    map.fitBounds(bounds, pad);
    idleOnce = maps.event.addListenerOnce(map, "idle", () => {
      const c = map.getCenter();
      if (c && !bounds.contains(c)) map.fitBounds(bounds, pad);
      // Clamp into the caller's window. The ceiling stops a single parked
      // vehicle filling the screen; the floor — opt-in, 0 for everyone who does
      // not ask — is how a subject smaller than the pane still arrives legible.
      if (map.getZoom() > maxZoom) map.setZoom(maxZoom);
      if (map.getZoom() < minZoom) map.setZoom(minZoom);
    });
  });
  return () => { cancelAnimationFrame(raf); idleOnce?.remove(); };
}

// Breathing room around a name plate before it counts as colliding, in pixels.
const ZONE_LABEL_GAP = 3;

// A plate that collides may step off its centre to find free space, in whole
// plate-heights, nearest slot first. Only from this zoom up: nudging is for the
// yard cluster east of the nurseries — Dispensary, two workshops, both staff
// residences and the Agriculture Lab all sit within ~200 m of each other and
// several round to under a hectare, so at the map's maxZoom of 18 they still
// cannot all hold their own centre. Below this zoom a nudge would be measured in
// hundreds of metres and would point at the wrong block, which is worse than
// staying quiet.
const ZONE_LABEL_NUDGE_MIN_ZOOM = 15;
const ZONE_LABEL_NUDGE_STEPS = [0, 1, -1, 2, -2];

/**
 * Hide name plates that would overlap one already placed.
 *
 * The zoom ladder decides which zones are *eligible* for a label; this decides
 * which of those actually get one, so that a plate never lands on top of
 * another. Entries arrive in priority order (biggest area first, corridors
 * last): the more significant zone keeps its name and the one underneath goes
 * quiet until the camera separates them.
 *
 * Measured in world-pixel space at the current zoom — `fromLatLngToPoint` is
 * stable while `fromLatLngToDivPixel` moves with the pane origin, and the
 * comparison only cares about relative positions. Sizes come off the live nodes
 * rather than an estimate, because the plates are variable-width text.
 */
function declutterLabels(map, maps, entries, obstacles) {
  const proj = map.getProjection?.();
  if (!proj) return;      // pre-first-idle: leave the ladder's decision alone
  const zoom = map.getZoom();
  const scale = 2 ** zoom;
  const steps = zoom >= ZONE_LABEL_NUDGE_MIN_ZOOM ? ZONE_LABEL_NUDGE_STEPS : [0];
  const hits = (r, b) => r.minX < b.maxX && r.maxX > b.minX && r.minY < b.maxY && r.maxY > b.minY;

  const boxAt = (e, size, oy) => {
    const p = proj.fromLatLngToPoint(new maps.LatLng(e.pos.lat, e.pos.lng));
    if (!p) return null;
    const cx = p.x * scale, cy = p.y * scale + oy;
    return {
      minX: cx - size.w / 2 - ZONE_LABEL_GAP, maxX: cx + size.w / 2 + ZONE_LABEL_GAP,
      minY: cy - size.h / 2 - ZONE_LABEL_GAP, maxY: cy + size.h / 2 + ZONE_LABEL_GAP,
    };
  };

  // Plates belonging to the OTHER layer are immovable here: whichever set ran
  // first has already committed its positions, and a plan label must not land on
  // an authoritative zone name. Both sets re-run on idle, so this converges.
  const placed = [];
  for (const o of obstacles ?? []) {
    if (!o.attached || !o.shown) continue;
    const size = o.marker.getDivSize();
    if (!size) continue;
    const box = boxAt(o, size, o.dy ?? 0);
    if (box) placed.push(box);
  }

  for (const e of entries) {
    const size = e.marker.getDivSize();
    // No size means the node is culled off-screen — nothing to collide with,
    // and it will be re-evaluated on the idle after it scrolls back in.
    if (!size) { e.shown = false; continue; }
    let box = null, dy = 0;
    for (const step of steps) {
      const oy = step * (size.h + ZONE_LABEL_GAP);
      const cand = boxAt(e, size, oy);
      if (cand && !placed.some(r => hits(r, cand))) { box = cand; dy = oy; break; }
    }
    if (!box) { e.marker.setVisible(false); e.shown = false; continue; }
    e.marker.setOffset(0, dy);
    e.dy = dy;
    e.shown = true;
    placed.push(box);
  }
}

/**
 * A hover card that survives being hovered.
 *
 * The three overlays on this map all wanted the same thing and all had the same
 * bug. An InfoWindow opens on `mouseover` and closes on `mouseout`, and it
 * opens ON TOP OF the thing being pointed at — so the moment it appears it
 * takes the pointer, the feature underneath fires `mouseout`, the window
 * closes, the feature is under the pointer again, and it re-opens. That loop is
 * the flicker: not a rendering fault, a geometry one. Two of the three made it
 * worse by re-positioning the window to the cursor on every `mousemove`, which
 * guarantees the card is always exactly where the pointer is about to be.
 *
 * What this fixes, in the order the problems bite:
 *
 *  1. CLOSING IS DEFERRED. `leave()` schedules the close rather than doing it,
 *     and any re-entry inside the grace window cancels it. A pointer crossing
 *     the gap between a marker and its card no longer reads as a departure.
 *  2. THE CARD ITSELF IS A HOVER TARGET. The content is built as a real element
 *     rather than an HTML string, so `mouseenter` on it cancels the pending
 *     close and `mouseleave` starts another. That is WCAG 1.4.13's hoverable
 *     requirement, and it is what makes the link inside the weighbridge card
 *     reachable at all.
 *  3. OPENING IS DELAYED. A short one — sweeping the pointer across a yard of
 *     pins should not flash six cards. Deliberately shorter than the 800 ms a
 *     tooltip on a button earns: this card IS the interaction, and on a map a
 *     pin that takes most of a second to answer reads as a dead pin.
 *  4. POSITION IS FIXED AT OPEN. Never `mousemove`-tracked. A card that chases
 *     the cursor is a card you cannot reach.
 *  5. ESCAPE DISMISSES, and a pinned card ignores hover entirely.
 *
 * The element is owned here rather than queried out of the document, which is
 * also how the weighbridge card's link gets wired: `document.querySelector`
 * would find the first matching node on the page, and with two cards open that
 * is not reliably this one.
 */
function hoverWindow(maps, map, { openDelay = 140, closeDelay = 220 } = {}) {
  const win = new maps.InfoWindow({ disableAutoPan: true });
  let openTimer = null, closeTimer = null;
  let pinned = false;
  let node = null;

  const clearTimers = () => {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    openTimer = closeTimer = null;
  };

  /** Build the content node and hand it to the window. `onNode` is where a
   *  caller wires whatever the card holds — the one link, so far. */
  const paint = (html, onNode) => {
    node = document.createElement("div");
    node.className = "mapcard-host";
    node.innerHTML = html;
    node.addEventListener("mouseenter", () => clearTimeout(closeTimer));
    node.addEventListener("mouseleave", () => { if (!pinned) leave(); });
    onNode?.(node);
    win.setContent(node);
  };

  /**
   * @param {object} o
   * @param {string} o.html     the card
   * @param {object} [o.anchor] a Marker to hang off — preferred, it tracks
   * @param {object} [o.position] a LatLng, for a Data feature that has no marker
   * @param {boolean} [o.pin]   a click, which holds the card until dismissed
   * @param {(el: HTMLElement) => void} [o.onNode]
   */
  const open = ({ html, anchor, position, pin = false, onNode }) => {
    clearTimers();
    const show = () => {
      paint(html, onNode);
      if (position) win.setPosition(position);
      if (anchor) win.open(map, anchor); else win.open(map);
      pinned = pin;
    };
    // A pinned card is a deliberate click: never make a click wait.
    if (pin || win.getMap()) show(); else openTimer = setTimeout(show, openDelay);
  };

  const leave = () => {
    if (pinned) return;
    clearTimeout(openTimer);
    closeTimer = setTimeout(() => win.close(), closeDelay);
  };

  const close = () => { clearTimers(); pinned = false; win.close(); };

  // Dismissible, per WCAG 1.4.13. Bound to the document because the map's own
  // container is not reliably the focused element when a card is open.
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  return {
    open,
    leave,
    close,
    enter: () => clearTimeout(closeTimer),
    get pinned() { return pinned; },
    get isOpen() { return Boolean(win.getMap()); },
    destroy: () => {
      document.removeEventListener("keydown", onKey);
      clearTimers();
      win.close();
      node = null;
    },
  };
}

/**
 * Put a set of name plates on the map: the zoom ladder decides eligibility, the
 * declutter pass decides which of those survive. Shared by the zone layer and
 * the plan layer, which have the same problem and different data.
 *
 * `apply()` re-runs itself once on the next frame after attaching anything —
 * OverlayView builds its node on the map's schedule, not synchronously, so a
 * freshly attached plate measures as nothing and cannot be decluttered yet.
 */
function labelApplier(map, maps, entries, on, obstacles) {
  let raf = 0;
  const apply = (deferred = false) => {
    const zoom = map.getZoom();
    let attachedAny = false;
    for (const l of entries) {
      const eligible = on && zoom >= l.minZoom;
      // Only touch setMap on a real change: it tears the node down and builds it
      // again, which would throw away the measurement about to be taken.
      if (eligible !== l.attached) {
        l.marker.setMap(eligible ? map : null);
        l.attached = eligible;
        if (eligible) attachedAny = true;
      }
      if (eligible) l.marker.setVisible(true);
      else l.shown = false;
    }
    if (!on) return;
    declutterLabels(map, maps, entries, obstacles?.());
    if (attachedAny && !deferred) {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => apply(true));
    }
  };
  return { apply, cancel: () => cancelAnimationFrame(raf) };
}


// `ft-map-legend-open` retired with the standalone map key — a third
// persisted preference after ft-zone-legend-open and ft-plan-legend-open, all
// of them remembering whether a box the operator never asked for was folded.
// The key now lives inside the layers menu and shows for a layer that is on,
// so there is nothing left to remember. Old values are simply ignored.

/**
 * Whether flagged units are painted red on the map. ON by default — a fuel
 * incident is the thing this fleet exists to catch, and an operator has to opt
 * OUT of seeing it rather than discover a switch that turns it on. Persisted,
 * because muting it is a working preference and re-muting it every morning is
 * how a preference stops being one.
 */
const FUEL_ALERTS_KEY = "ft-fuel-alerts-on";
// The left tool rail's two remembered choices: vehicle names on the markers,
// and whether the rail shows its tools' names.
const NAMES_KEY = "ft-map-names-on";
const TOOLS_EXPANDED_KEY = "ft-map-tools-expanded";
// The base map picked in the rail's Maps panel, or on a phone or tablet the
// toggle at the map's top left: "osm" or one of googleBase's GOOGLE_BASES
// ("google" is the hybrid). `short` is the toggle's word.
const BASE_MAP_KEY = "ft-map-base";
const BASE_MAPS = [
  { id: "osm",              label: "OpenStreetMap",    short: "Map" },
  { id: "google-satellite", label: "Google Satellite", short: "Satellite" },
  { id: "google",           label: "Google Hybrid",    short: "Hybrid" },
  { id: "google-terrain",   label: "Google Terrain",   short: "Terrain" },
];

// Pan/zoom limits. Deliberately wider than Kenya alone: Kasulu (TZ) sits at
// ~30.1°E, west of any Kenya-only bound, and would be unreachable.
const REGION_BOUNDS = { north: 5.6, south: -12.0, west: 28.9, east: 42.2 };

const DEFAULT_CENTER = { lat: -0.0236, lng: 37.9062 };
/**
 * Ceiling on the whole-fleet fit.
 *
 * Was 8 — a regional view, roughly all of western Kenya — and it was clamping
 * the NORMAL case, not the degenerate one it was written for. Measured on the
 * live fleets: half of Sukari's located units sit within 600 m of the plant and
 * 90% within 27 km, so fitBounds asks for zoom 9-10 and the cap dragged it back
 * out every time. 14 still stops a single located vehicle from slamming the
 * camera to street level (that is what FOCUS_ZOOM 17 is for), while letting a
 * fleet that works inside 30 km actually fill the screen.
 */
// CHANGED 2026-08-05: lowered from 14 → 10 so auto-fit doesn't override the
// CHANGED 2026-08-06: FIT_MAX_ZOOM is now only a safety cap for edge cases
// (e.g. single vehicle, or all vehicles at the same point). fitBounds
// calculates the correct zoom automatically based on fleet spread.
// 14 = street level, enough to stop a single parked vehicle filling the screen.
const FIT_MAX_ZOOM   = 14;

/**
 * Share of the fleet the default view is fitted to.
 *
 * The camera should frame where the fleet WORKS, not the convex hull of every
 * last fix. Both live fleets have a long tail that makes those two wildly
 * different things: Kasulu's 95th percentile is 604 km from the fleet centre
 * and its furthest unit is 1,014 km away, so fitting the extremes zooms out to
 * half a continent to accommodate a handful of stale or stray fixes. Sukari's
 * tail is milder but the same shape — p90 27 km, max 91 km.
 *
 * The outliers are not hidden: their markers still render, they are simply
 * outside the opening viewport, and zooming out reveals them.
 */
// CHANGED 2026-08-06: lowered from 0.9 → 0.75 so the opening fit focuses
// on where most vehicles actually operate, ignoring the long tail of stale
// or outlier positions that push the view out to country level.
const FIT_CORE_SHARE = 0.75;
/** Below this a fleet has no meaningful tail — fit all of it. */
const FIT_CORE_MIN   = 12;
// Zoom used whenever the camera is sent to ONE vehicle — a live-feed
// notification, a marker click, the header search, a ticked unit. Close enough
// that neighbouring vehicles fall outside the viewport, far enough that the
// subject still has the road it is on around it.
//
// CHANGED 2026-08-05: raised from 17→20 to match new maxZoom of 21.
// CHANGED 2026-09-22: back to 17. Chasing maxZoom was the wrong instinct — it
// framed the vehicle and nothing else, which answers "which pixel" rather than
// "what is this unit doing". Three comments in this file were never updated
// for the raise and still described 17 (FIT_MAX_ZOOM's note above, and
// FOCUS_EXIT_ZOOM's "three steps below"), which is its own evidence about
// which number the rest of the design was built around.
const FOCUS_ZOOM     = 17;
/* A selection brought back by a reload: close enough to see the unit and what
   is around it, not the street-level fly-to a search asks for. */
const RESTORE_ZOOM   = 15;
/* A weighbridge, from the sidebar's Weighbridges rows. Equal to FOCUS_ZOOM
   since 2026-09-22 and kept separate anyway: a scale is a place with a yard
   around it and a vehicle is a thing on a road, and the day one of those wants
   retuning is not the day the other does. It was written when FOCUS_ZOOM was
   20 and this needed to be lower. */
const BRIDGE_FOCUS_ZOOM = 17;
/* How long a focus request waits for its vehicle to arrive. Long enough for
   an organisation switch to fetch a cold snapshot (~seconds on the remote
   pooler), short enough that a request nobody can honour does not sit armed. */
const PENDING_FOCUS_TTL_MS = 30_000;
// Zooming out past this releases the isolation and the rest of the fleet comes
// back. Three steps below FOCUS_ZOOM: far enough that it takes a deliberate
// zoom-out rather than one wheel notch, close enough that the fleet reappears
// before the vehicle becomes a dot in an empty map.
const FOCUS_EXIT_ZOOM = 14;

// Track window. Served by /vehicles/:id/track, which returns {t, lat, lng}
// oldest-first, already thinned, for the WHOLE window.
//
// This used to hit /telemetry?limit=500, which returns every sensor field
// newest-first and caps at 500 rows: 177 KB per click to draw lat/lng pairs,
// and on an active vehicle those 500 rows reached back only ~5.5 h of the 12 h
// asked for — so the window was silently truncated and the "no movement in the
// last 12 h" label was asserting something the data never showed. The track
// endpoint returns the full 12 h in ~47 KB.
const TRACK_WINDOW_H = 12;

/**
 * How far a vehicle must move before an open route's line is extended to it.
 *
 * The same floor the server thins tracks with. Below it the movement is GPS
 * jitter rather than travel, and pushing a point onto a Polyline re-rasterises
 * the whole line — doing that every frame for a parked unit would be constant
 * work that changes nothing on screen.
 */
const ROUTE_EXTEND_MIN_M = 15;

/** How long a fetched live track stays usable before it is re-read. Just over
 *  the 30 s poll cycle, so a reopened route picks up whatever has landed. */
const TRACK_CACHE_TTL_MS = 45_000;

// A track is a record of where a vehicle WAS, not a route it followed. Where
// the data has a hole, the line must BREAK rather than draw a straight chord
// across it: measured on production, one vehicle's track contained a 9.4 km
// single hop spanning a 1.7 h reporting gap, drawn as a straight line through
// open country.
//
// CHANGED 2026-08-08: whether there IS a hole is the SERVER's answer now
// (`gapBefore`), not a time comparison made here.
//
// This used to break wherever two points were more than 6 minutes apart. But
// the points arriving here are thinned — the server drops fixes closer than
// 15 m — so a unit that stood still for six minutes has every fix in between
// removed and looks exactly like a unit that stopped transmitting. The line
// was being cut at every pause. Measured on a prime mover the same day: 2,107
// fixes, 28 s apart, not one reporting hole in twelve hours, drawn as nine
// separate runs.
//
// The distance guard stays and stays local: a teleport between two
// close-in-time fixes (a respawned tracker, a bad fix) is visible in the drawn
// points themselves and needs no help from the server.
const TRACK_GAP_M  = 3_000;

// The track window ANCHORS ON THE VEHICLE'S LAST FIX, not on now.
//
// A window of "the last 12 h" is empty for exactly the vehicles an operator
// most wants to inspect. Measured on Kasulu: of 142 units the provider calls
// offline, 87 have no fix inside 12 h — 49 of them have not reported in over a
// week. Clicking any of those drew nothing at all. EX 03, silent 57 h, returned
// 0 points; anchored on its last fix it returns 94 points spanning 11.6 h —
// the journey it made before it went quiet, which is the useful thing to see.
//
// The endpoint is queried newest-first under a scan cap, so sliding the window
// back costs nothing: it returns that vehicle's final fixes either way.
// (Applied in showRoute — `stale` / `anchorMs`.)

// Parked and offline tracks draw near-black.
//
// Asked for. It also fixes a legibility problem: `parked` is #64748b, a mid
// slate that disappears into satellite imagery at the zooms these tracks are
// read at. Near-black holds against grass, soil and roof alike, and it reads
// as "historical" next to the live status colours rather than competing with
// them.
const TRACK_IDLE_COLOR = "#0b1220";

// Which WAY it went. A track is a line with no inherent direction, and on a
// there-and-back run — which is most of them on this fleet — the outbound and
// return legs sit on the same road, so the drawn line alone cannot say whether
// the unit is on its way out or coming home.
//
// REMOVED 2026-08-08: the route line used to carry decorative arrowheads for
// this, drawn as Polyline `icons` every 110 px. They are gone because a
// Polyline symbol is PAINT — it is part of the line's own SVG and cannot take
// a click — so once the trip path's triangles became the thing you click for a
// timestamp, the map showed two kinds of triangle where only one answered.
// Direction is now carried by the trip-path ticks (see showTripPath), which
// point along the heading AND hand back the fix behind them.

/** Split an oldest→newest track wherever the data has a hole. */
function splitTrack(points) {
  const segments = [];
  let run = [];
  for (const p of points) {
    const prev = run[run.length - 1];
    if (prev && (p.gapBefore || metresBetween(prev, p) > TRACK_GAP_M)) {
      if (run.length > 1) segments.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 1) segments.push(run);
  return segments;
}

/**
 * The line across a hole: dashed, so the route reads as ONE journey without
 * claiming the unit drove that way.
 *
 * A break is the honest thing to draw where there is no data, but a route
 * delivered in nine disconnected pieces is not readable as a journey either —
 * you cannot see the order, and two runs that meet at a yard look like two
 * vehicles. Joining them with a line that is visibly NOT the measured track
 * gives back the continuity while keeping the distinction the break existed to
 * make. Dots, not a solid stroke, and no arrowheads: there is no direction to
 * assert about a stretch we did not see.
 */
function gapConnector(maps, map, from, to, color, zIndex) {
  return new maps.Polyline({
    map,
    path: [from, to],
    strokeOpacity: 0,          // the dots below ARE the line
    icons: [{
      icon: {
        path: maps.SymbolPath.CIRCLE,
        scale: 1.6,
        fillColor: color, fillOpacity: 0.55,
        strokeColor: color, strokeOpacity: 0.55, strokeWeight: 0.5,
      },
      offset: '0',
      repeat: '10px',
    }],
    zIndex,
  });
}

/** "3 min", "5 h", "6 days" — for saying how stale a fix actually is. */
function agoLabel(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} h`;
  return `${Math.round(hrs / 24)} days`;
}

/** Metres between two lat/lng points (equirectangular — fine at these scales). */
function metresBetween(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  return Math.sqrt(dLat * dLat + dLng * dLng) * R;
}

/**
 * The bulk of a fleet, for framing the camera.
 *
 * A whole-fleet fit is only useful if it frames where the fleet actually
 * operates, and the extremes of a live fleet do not describe that. Measured on
 * 2026-08-03: half of Kasulu's located units sit within 200 m of the fleet
 * centre, yet its furthest is 1,014 km away — fitting every point zooms out to
 * half a continent for a handful of stale or stray fixes and leaves the two
 * hundred vehicles that matter as one indistinguishable clump.
 *
 * So: take the median position (robust — a mean is dragged by the same
 * outliers this exists to ignore), rank by distance from it, and keep the
 * nearest FIT_CORE_SHARE. Nothing is hidden; the dropped units still have
 * markers and appear as soon as the operator zooms out.
 */
function fleetCore(located) {
  if (located.length <= FIT_CORE_MIN) return located;

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const centre = {
    lat: median(located.map(v => v.lat)),
    lng: median(located.map(v => v.lng)),
  };

  const keep = Math.max(FIT_CORE_MIN, Math.ceil(located.length * FIT_CORE_SHARE));
  return [...located]
    .sort((a, b) => metresBetween(a, centre) - metresBetween(b, centre))
    .slice(0, keep);
}

// Thinning used to happen here, after the fetch. It now happens in the query
// (`minSpacingM`), which is where it belongs: thinning client-side meant
// paying to transfer the hundreds of identical fixes a parked machine emits
// before throwing them away.

// ── smooth marker movement ──────────────────────────────────────────────────
// Telemetry advances vehicles once per poll cycle (~30 s), so writing each fix
// straight to the marker makes the fleet sit frozen and then teleport. Instead
// each new fix starts a linear tween from wherever the marker is currently
// drawn, paced to the observed update cadence — vehicles stay continuously in
// motion (one cycle behind real time, like any live tracker). A single rAF
// loop advances all tweens (see FleetMap).
const TWEEN_DEFAULT_MS = 30_000; // matches the server's poll cadence
// CHANGED 2026-08-06: lowered TWEEN_MIN from 4s→2s so fast-moving vehicles
// respond more quickly to new fixes instead of sluggishly gliding for 4s.
// TWEEN_MAX kept at 35s to handle slow poll cycles gracefully.
const TWEEN_MIN_MS     = 2_000;
const TWEEN_MAX_MS     = 35_000;
const TWEEN_SNAP_DEG   = 0.5;    // ~55 km — a jump this big is a respawn, not motion

function startMarkerTween(marker, toLat, toLng) {
  const cur = marker.getPosition();
  const jump = Math.abs(cur.lat - toLat) + Math.abs(cur.lng - toLng);
  const now = performance.now();
  if (jump < 1e-7) { marker._tween = null; return; }              // stationary
  if (jump > TWEEN_SNAP_DEG) {                                    // teleport, don't glide
    marker._tween = null;
    marker.setPosition({ lat: toLat, lng: toLng });
    marker._lastFixAt = now;
    return;
  }
  // Bearing of this leg, kept as the fallback heading for trackers that report
  // no course (Wialon's `pos.c` is often absent on stationary or low-quality
  // fixes). Where the vehicle actually went is a better guess than "north".
  marker._travelBearing = bearingDeg(cur.lat, cur.lng, toLat, toLng);
  const sinceLast = marker._lastFixAt ? now - marker._lastFixAt : TWEEN_DEFAULT_MS;
  const dur = Math.min(TWEEN_MAX_MS, Math.max(TWEEN_MIN_MS, sinceLast));

  // ── ADDED 2026-08-05: capture departure bearing for smooth heading tween ─
  // _headingFrame reflects the sprite's current atlas column. Back-convert it
  // to a degree value so the tween loop can interpolate from "where it was
  // pointing" to "where it is going" without a snap on tween start.
  // Formula inverts truckFrame(): column * (360 / TRUCK_HEADINGS).
  const fromBearing = (marker._headingFrame ?? 0) * (360 / TRUCK_HEADINGS);
  // ── END ADDED ────────────────────────────────────────────────────────────

  marker._tween = { fromLat: cur.lat, fromLng: cur.lng, toLat, toLng, start: now, dur, fromBearing };
  marker._lastFixAt = now;
}

// Initial bearing from one fix to the next, in compass degrees (0 = north,
// increasing clockwise) — the same convention the sprite atlas is baked in.
function bearingDeg(fromLat, fromLng, toLat, toLng) {
  const rad = Math.PI / 180;
  const y = Math.sin((toLng - fromLng) * rad) * Math.cos(toLat * rad);
  const x = Math.cos(fromLat * rad) * Math.sin(toLat * rad) -
            Math.sin(fromLat * rad) * Math.cos(toLat * rad) * Math.cos((toLng - fromLng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// ── the vehicle sprite atlas ────────────────────────────────────────────────
// public/truck-atlas.png. Columns are headings (TRUCK_HEADINGS of them, evenly
// spaced clockwise from north), rows are vehicle statuses in TRUCK_STATUS_ROWS
// order; the background-POSITION maths below indexes into it. These constants
// MUST stay in step with the image.
const TRUCK_HEADINGS    = 24;
const TRUCK_STATUS_ROWS = ["ok", "speeding", "theft", "parked", "idling"];
// Rendered cell is 64 device px; drawing it at 40 CSS px keeps it crisp on
// 1.5×+ displays and legible at the zoom levels the fleet is usually viewed at.
const TRUCK_PX = 40;

/** Compass heading → atlas column. */
/**
 * Which playback events earn a pin on the map.
 *
 * Not all of them. A busy unit's day carries hundreds of zone crossings and
 * movement transitions, and pinning those would bury the line under its own
 * annotations — they are still every one of them in the timeline beside the
 * scrubber, which is where a complete list belongs. What goes on the MAP is
 * what has a place worth looking at: where it stopped, where fuel left the
 * tank, where fuel went in, and where it was driven too fast.
 */
/**
 * Which playback events get a pin on the track.
 *
 * `zone` is in the list although this fleet currently produces none: the
 * server maps ZONE_ENTRY / ZONE_EXIT / GEOFENCE_BREACH to it, and the day a
 * geofence starts emitting those they should appear without anyone
 * remembering this line.
 *
 * `other` and `dispatch` were the omission worth fixing. They are the
 * fleet's actual gate crossings — a unit arriving at or clearing a gate
 * reaches playback as a MOVEMENT_ENTRY / MOVEMENT_EXIT notification, which
 * the server flattens to `other` with the generic label "Started moving"
 * while the real sentence ("arrived at the gate from OPAPO") rides in
 * `detail`. Measured on KDL 710E, 2026-09-06: 6 of those and 3 dispatches in
 * a day, against 0 events of kind `zone`. Leaving them off the map meant the
 * one question a replay is opened to answer — when was it at the gate — had
 * no mark on the line at all.
 */
const DRAWN_EVENT_KINDS = new Set([
  "stop", "theft", "refill", "speeding", "zone", "dispatch", "other",
]);

/** Kinds that mark a PLACE the unit reached, rather than something that happened to it. */
const WAYPOINT_KINDS = new Set(["zone", "dispatch", "other"]);

/** HH:MM on the fleet clock, for an event pin's tooltip. */
const evClock = (ms) => {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * A playback event as a marker.
 *
 * ## Stops reuse the track's own dots
 *
 * `.tp-dot--stop` (amber) and `.tp-dot--end` (red) already exist and already
 * mean "paused here" and "finished here" everywhere else on this map. A replay
 * that invented a third stop treatment would be teaching a second vocabulary
 * for the same fact.
 *
 * A stop is the END one when the unit never moved again that day — its rest
 * runs to the last fix. That is the same distinction the live track draws
 * (there: a stop the unit DROVE AWAY FROM is temporary), decided here from the
 * replayed day rather than from an engine-off clock, because a finished day is
 * a closed question and does not need the hour of grace a live one does.
 *
 * ## Fuel gets an icon and no chip
 *
 * A pump glyph and the litres, drawn straight onto the map with no background
 * plate: these sit on a route the operator is trying to read, and a filled
 * card at every fuel event would cover more of the line than it explains. Red
 * out of the tank, green into it — the same two colours the alerts menu and
 * the scrubber use for the same two facts.
 */
/**
 * One time tick on a replayed track: a direction triangle, and — when open —
 * the clock and speed at that exact fix.
 *
 * Shares `tp-tick` with the static trip path on purpose. The two answer the
 * same question ("when was it here, and how fast?") and there is no reason for
 * them to look like two different features; the difference is in the numbers,
 * not the dress.
 *
 * The time is HH:MM:SS with no date. A replay is bounded to one fleet day, and
 * the day is already named on the panel — repeating it on every tick spends a
 * bubble's width saying something the reader chose two clicks ago.
 *
 * A null speed prints "no speed" rather than "0 km/h". They are different
 * claims: one is a unit standing still, the other is a fix that did not carry
 * the channel, and a replay that renders the second as the first invents a
 * stop that nothing measured.
 */
function playbackTickHtml(deg, ms, kmh, open) {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  const clock = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  const speed = kmh == null ? "no speed" : Math.round(kmh) + " km/h";
  return (
    '<div class="tp-tick' + (open ? " tp-tick--open" : "") + '">' +
      '<span class="tp-tick__arrow" style="transform:rotate(' + Math.round(deg) + 'deg)"></span>' +
      (open
        ? '<span class="tp-tick__bubble">' +
            '<span class="tp-tick__ts">' + clock + "</span>" +
            '<span class="tp-tick__speed">' + speed + "</span>" +
          "</span>"
        : "") +
    "</div>"
  );
}

/**
 * A waypoint on the replayed track: where the unit was, and WHEN.
 *
 * The clock is on the pin rather than inside a tooltip, which is the opposite
 * of every other pin here and is the whole point of this one. A gate crossing
 * is read while following the line — "it was here at 13:15" — and a time you
 * have to hover for is a time you do not read at all. There are a handful of
 * these in a day (nine on the day this was measured against), so nine small
 * clocks is a legible route; the twenty-eight stop pins keep their time on
 * hover precisely because they are not.
 *
 * The sentence goes in the tip, with the plate and driver stripped off the
 * front. The server sends "KDL 710E · JOSHUA FILIMON MBAKAYA arrived at the
 * gate from OPAPO", and on a replay of that unit the first two thirds of that
 * is the answer to a question nobody asked — the panel's title bar has said
 * the plate since the moment it opened.
 */
function wayPinHtml(ev) {
  const when = evClock(ev.t);
  // "PLATE · DRIVER did the thing" -> "did the thing". Only when the sentence
  // really is prefixed that way; anything else is left exactly as sent.
  const said = String(ev.detail ?? "").replace(/^[^·]+·[^a-z]*/u, "").trim();
  const text = said || ev.label || "";
  return (
    '<div class="pb-way">' +
      '<span class="pb-way__dot" aria-hidden="true"></span>' +
      '<span class="pb-way__time">' + esc(when.slice(0, 5)) + "</span>" +
      (text
        ? '<span class="pb-way__tip">' +
            '<span class="tp-dot__time">' + esc(when) + "</span>" +
            '<span class="tp-dot__detail">' + esc(text) + "</span>" +
          "</span>"
        : "") +
    "</div>"
  );
}

/**
 * "1 h 27 min ago" — how long ago an absolute moment was.
 *
 * Not `agoLabel` above, which takes a DURATION and rounds it to one unit
 * ("1 h"). A replay card is read against a tracker that says "1 h 27 min ago",
 * and rounding away the minutes is the difference between confirming what you
 * are looking at and wondering whether it is the same point.
 */
function sinceLabel(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return d + " d " + (h % 24) + " h ago";
  if (h >= 1) return h + " h " + (m % 60) + " min ago";
  return m + " min ago";
}

/** "07.09.2026 01:05:10" — the operator's own stamp format, as the tracker writes it. */
function stampLabel(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear() +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/**
 * Street address for a point, resolved once and remembered.
 *
 * Reverse geocoding is a BILLED call per lookup, so three things guard it: it
 * runs only when somebody opens a card, the answer is cached for the life of
 * the page, and the key is rounded to about eleven metres — every dot inside
 * one yard shares a single lookup rather than paying for each.
 *
 * Failure is silent and returns null. An address is the one line on this card
 * that is a convenience rather than a fact about the unit, and a replay must
 * not show an error where a street name would go.
 */
const geoCache = new Map();
function reverseGeocode(maps, lat, lng) {
  const key = lat.toFixed(4) + "," + lng.toFixed(4);
  if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));
  if (!maps?.Geocoder) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      new maps.Geocoder().geocode({ location: { lat, lng } }, (res, status) => {
        const addr = status === "OK" && res?.[0]?.formatted_address ? res[0].formatted_address : null;
        geoCache.set(key, addr);
        resolve(addr);
      });
    } catch {
      geoCache.set(key, null);
      resolve(null);
    }
  });
}

/** A crosshair — the shape a GPS reading has worn on every device since. */
function gpsIconSvg() {
  return (
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
      '<circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
      '<circle cx="8" cy="8" r="0.9" fill="currentColor"/>' +
      '<path d="M8 0.8v2.6M8 12.6v2.6M0.8 8h2.6M12.6 8h2.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    "</svg>"
  );
}

/**
 * The card a minute dot opens: where this unit was at this minute, and what it
 * was doing there.
 *
 * ## What is on it, and what is deliberately not
 *
 * Everything here comes from the fix itself or from geometry over fences this
 * map already has: the clock, how long ago, speed, heading, ignition, the
 * coordinates, and every geofence the point falls inside.
 *
 * There is no street address and no satellite count. The playback endpoint
 * sends neither — `vehicle_telemetries` carries no satellite column at all,
 * and an address would mean a reverse-geocode per dot, which is a billable
 * call to Google for every click. Both are additions worth making
 * deliberately rather than by inventing a number that looks like the tracker's
 * and is not.
 */
function minuteCardHtml(plate, mark, zoneNames, address) {
  const coords = mark.lat.toFixed(5) + ", " + mark.lng.toFixed(5);
  const zones = (zoneNames ?? []).slice(0, 4);
  // undefined = still looking, null = looked and found nothing. The two say
  // different things to somebody watching the card, so they render
  // differently rather than both collapsing to a blank line.
  const addrLine = address === undefined
    ? '<div class="pb-card__addr pb-card__addr--wait">Locating…</div>'
    : address
      ? '<div class="pb-card__addr">' + esc(address) + "</div>"
      : "";
  return (
    '<div class="pb-min pb-min--open">' +
      '<span class="pb-min__dot" aria-hidden="true"></span>' +
      '<div class="pb-card">' +
        '<div class="pb-card__head">' +
          '<span class="pb-card__title">' + esc(plate ?? "Unit") + "</span>" +
          '<span class="pb-card__when">' +
            '<span class="pb-card__ago">' + esc(sinceLabel(mark.t)) + "</span>" +
            '<span class="pb-card__stamp">' + esc(stampLabel(mark.t)) + "</span>" +
          "</span>" +
        "</div>" +
        addrLine +
        (zones.length
          ? '<div class="pb-card__zones">' +
              zones.map((z) => '<span class="pb-card__zone">' + esc(z) + "</span>").join("") +
            "</div>"
          : "") +
        '<div class="pb-card__stats">' +
          '<span class="pb-card__stat"><b>' +
            (mark.spd == null ? "-" : Math.round(mark.spd) + " km/h") + "</b>speed</span>" +
          '<span class="pb-card__stat"><b>' +
            (mark.hdg == null ? "-" : Math.round(mark.hdg) + "°") + "</b>heading</span>" +
          // `null`/absent is not "Off". A track served by a build that does not
          // send ignition would otherwise report every minute of the day as key
          // out, which is a claim about the machine rather than about the data.
          '<span class="pb-card__stat"><b>' +
            (mark.eng == null ? "-" : mark.eng ? "On" : "Off") + "</b>ignition</span>" +
        "</div>" +
        '<div class="pb-card__coords">' +
          '<span class="pb-card__latlng">' + esc(coords) + "</span>" +
          '<button type="button" class="pb-card__copy" title="Copy coordinates" aria-label="Copy coordinates">' +
            gpsIconSvg() +
          "</button>" +
        "</div>" +
      "</div>" +
    "</div>"
  );
}

/** The dot itself, closed. Small on purpose: there is one a minute. */
function minuteDotHtml() {
  return '<div class="pb-min"><span class="pb-min__dot" aria-hidden="true"></span></div>';
}

/**
 * One time mark: a dot that opens into "where was it at 13:07".
 *
 * Shared by the two things that draw a track — the replay, and the plain click
 * on a unit — because they are answering the same question with the same data
 * and only differ in when the dot appears. Written once so the card, the
 * exclusive-open rule, the copy button and the deferred address cannot drift
 * apart between them; the caller supplies `state`, whose `openTick` is the one
 * card currently open in ITS layer, so a replay and a click track never fight
 * over each other's marks.
 *
 * The card is built ON CLICK, not here: it carries a "27 min ago" that would be
 * wrong by the time anyone opened it, and the zone lookup is geometry against
 * every fence on the map — work worth doing once for the dot somebody actually
 * asks about rather than hundreds of times for the ones they do not.
 *
 * @param {Function} DomMarker the overlay class
 * @param {object}   o
 * @param {{t:number,lat:number,lng:number,spd:?number,hdg:?number,eng:boolean}} o.mark
 * @param {string}   o.plate    what to head the card with
 * @param {Function} o.features () => GeoJSON features to test the point against
 * @param {Function} o.maps     () => the Google maps library, for the geocoder
 * @param {{openTick: ?object}} o.state mutated: the caller's open card
 * @param {number}   [o.zIndex] resting z, restored on close
 */
function minuteMarker(DomMarker, { mark, plate, features, maps, state, zIndex = 2 }) {
  const m = new DomMarker({
    position: { lat: mark.lat, lng: mark.lng },
    html:     minuteDotHtml(),
    anchor:   "center",
    zIndex,
    onClick: (e) => {
      // The copy button lives INSIDE the card this handler opened, so its
      // clicks arrive here too. Delegating is what lets a button exist in
      // markup that React does not own.
      const copyBtn = e?.target?.closest?.(".pb-card__copy");
      if (copyBtn) {
        copyText(mark.lat.toFixed(5) + ", " + mark.lng.toFixed(5)).then((ok) => {
          copyBtn.classList.add(ok ? "is-copied" : "is-failed");
          copyBtn.setAttribute("title", ok ? "Copied" : "Could not copy");
          setTimeout(() => {
            copyBtn.classList.remove("is-copied", "is-failed");
            copyBtn.setAttribute("title", "Copy coordinates");
          }, 1400);
        });
        return;
      }

      const prev = state.openTick;
      if (prev) { prev.close(); state.openTick = null; }
      if (prev?.marker === m) return;

      const zoneNames = zonesAt(mark, features()?.features);
      // Drawn immediately with the address still pending: everything else on
      // this card is already known, and holding all of it back behind a network
      // call would make a dot feel slow to answer.
      m.setHtml(minuteCardHtml(plate, mark, zoneNames, undefined));
      m.setZIndex(10);
      state.openTick = {
        marker: m,
        close: () => { m.setHtml(minuteDotHtml()); m.setZIndex(zIndex); },
      };
      reverseGeocode(maps(), mark.lat, mark.lng).then((addr) => {
        // It may have been closed, or another dot opened, while that was in
        // flight — in which case this card is no longer on screen and rewriting
        // it would reopen it.
        if (state.openTick?.marker !== m) return;
        m.setHtml(minuteCardHtml(plate, mark, zoneNames, addr));
      });
    },
  });
  return m;
}

function eventMarkerHtml(ev, lastT) {
  const when = evClock(ev.t);
  const detail = esc(ev.detail ?? "");

  // Places, with their clock on the face of the pin.
  if (WAYPOINT_KINDS.has(ev.kind)) return wayPinHtml(ev);

  if (ev.kind === "stop") {
    // Within a minute of the last fix: the unit was still there when the day's
    // record ran out.
    const isEnd = (ev.endT ?? ev.t) >= lastT - 60_000;
    const kind = isEnd ? "end" : "stop";
    const label = isEnd ? "Stopped here" : "Stopped";
    return (
      '<div class="tp-dot tp-dot--' + kind + '">' +
        '<span class="tp-dot__pin"></span>' +
        '<span class="tp-dot__tip">' +
          '<span class="tp-dot__time">' + when + "</span>" +
          '<span class="tp-dot__detail">' + label + (detail ? " · " + detail : "") + "</span>" +
        "</span>" +
      "</div>"
    );
  }

  if (ev.kind === "theft" || ev.kind === "refill") {
    const drain = ev.kind === "theft";
    /**
     * The figure ALONE — "-15L", "+120L".
     *
     * No time, no place, no verdict wording, and no tooltip carrying them. A
     * pin on a route is read at a glance while following a line, and the one
     * thing it has to answer there is how much fuel moved and which way. The
     * timeline beside the scrubber already holds the sentence, the clock and
     * the confirmation, and repeating them here would cover the route with
     * text nobody is reading at that moment.
     *
     * The sign comes from the KIND, not from the number: the server sends an
     * unsigned magnitude precisely so the two cannot disagree.
     */
    return fuelPinHtml(eventMl(ev), drain, null);
  }

  // Speeding.
  return (
    '<div class="pb-fuel pb-fuel--speed">' +
      '<span class="pb-fuel__icon" aria-hidden="true">⚡</span>' +
      (detail ? '<span class="pb-fuel__amt">' + detail + "</span>" : "") +
      '<span class="pb-fuel__tip">' +
        '<span class="tp-dot__time">' + when + "</span>" +
        '<span class="tp-dot__detail">' + esc(ev.label) + "</span>" +
      "</span>" +
    "</div>"
  );
}

/**
 * Millilitres as the shortest honest figure for a pin: "15L", "120L", "0.4L".
 *
 * Whole litres from one upward, because a probe sitting in a moving tank does
 * not measure to a tenth and printing one implies it does. Below a litre the
 * decimal is the only thing there is to say — rounding a 400 ml drain to "0L"
 * would report an event as nothing at all.
 *
 * Null for an unknown volume, and the caller then draws the icon ALONE. A
 * coloured pump on the route still says a drain happened here, which is true;
 * "?L" says we measured something and cannot tell you what, which is not.
 */
function fmtPinLitres(ml) {
  if (!Number.isFinite(ml)) return null;
  const l = Math.abs(ml) / 1000;
  return (l < 1 ? l.toFixed(1) : String(Math.round(l))) + "L";
}

/** A fuel pump, inline so it inherits `currentColor` and needs no asset. */
const FUEL_PUMP_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 21h11M4 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17"/>' +
  '<path d="M6 8h6"/>' +
  '<path d="M18 9v7a2 2 0 0 0 3 0V8l-3-3"/>' +
  "</svg>";

/**
 * A fuel event as a map pin: the pump, and the signed litres.
 *
 * ONE function for both places fuel is drawn on this map — the day replay's
 * route and the click-to-show trip path. They used to be two treatments for
 * one fact: the trip path drew a filled 9-px-padded plate stacking an emoji,
 * the volume and a timestamp in three rows, and the replay drew this pill.
 * Same event, same map, two vocabularies, and the plates were large enough
 * that a unit with several refills covered the line they were annotating.
 *
 * The pill is what survived, for the reason it was built: these sit on a route
 * the operator is trying to READ, and the pin's whole job at a glance is how
 * much fuel moved and which way. Red out of the tank, green into it — the same
 * two colours the alerts menu and the scrubber use for the same two facts.
 *
 * The sign comes from the KIND, not from the number: every source here sends
 * an unsigned magnitude precisely so the two cannot disagree.
 *
 * `atMs` is the one thing the trip path keeps that the replay does not, and
 * passing it opens the pin to a hover carrying the clock. The replay passes
 * null: its scrubber already has a timeline holding the moment of every event,
 * and a second copy on the route would be noise. The trip path has no such
 * list, so without this the time would be lost outright rather than moved
 * somewhere better.
 *
 * A hover, not a `title` — the pin is `pointer-events: none` so that a pan
 * beginning on top of one is not swallowed by it, and a native tooltip on an
 * element that cannot receive the pointer never appears at all. This is the
 * bargain `.pb-fuel--speed` already struck for the same reason: a figure whose
 * moment matters earns the pointer back, a bare volume does not.
 */
function fuelPinHtml(ml, drain, atMs) {
  const amt  = fmtPinLitres(ml);
  const sign = drain ? "−" : "+";
  const kind = drain ? "drain" : "fill";
  return (
    '<div class="pb-fuel pb-fuel--' + kind + (atMs ? " pb-fuel--hover" : "") + '">' +
      '<span class="pb-fuel__icon" aria-hidden="true">' + FUEL_PUMP_SVG + "</span>" +
      (amt ? '<span class="pb-fuel__amt">' + sign + amt + "</span>" : "") +
      (atMs
        ? '<span class="pb-fuel__tip">' +
            '<span class="tp-dot__time">' + evClock(atMs) + "</span>" +
            '<span class="tp-dot__detail">' + (drain ? "Fuel drain" : "Refill") + "</span>" +
          "</span>"
        : "") +
    "</div>"
  );
}

function truckFrame(headingDeg) {
  const h = Number.isFinite(headingDeg) ? headingDeg : 0;
  return ((Math.round((h % 360) / (360 / TRUCK_HEADINGS)) % TRUCK_HEADINGS) + TRUCK_HEADINGS) % TRUCK_HEADINGS;
}

function truckBackgroundPosition(status, headingDeg) {
  const row = Math.max(0, TRUCK_STATUS_ROWS.indexOf(TRUCK_ROW_FOR[status] ?? status));
  return `${-truckFrame(headingDeg) * TRUCK_PX}px ${-row * TRUCK_PX}px`;
}

/**
 * Which way this vehicle's truck should point.
 *
 * The tracker's own course is authoritative when it reports one. Wialon leaves
 * `pos.c` at 0 for plenty of fixes though, and a fleet of trucks all facing
 * north looks broken — so a parked vehicle keeps whichever way it was last
 * seen travelling, and a moving one falls back to the bearing of its current
 * leg (recorded by startMarkerTween).
 */
function markerHeading(marker, v) {
  if (Number.isFinite(v.heading) && v.heading !== 0) return v.heading;
  return marker?._travelBearing ?? 0;
}

// ── Rich hover card ─────────────────────────────────────────────────────────
// Content lives in cards/VehicleStatsCard (shared with the left panel's search
// result, so hover and search always show identical stats). This wrapper only
// pins it to the cursor. Read-only, so the whole card is pointer-events:none
// and never steals the mouse from the map.

const TOOLTIP_W = 264;
const TOOLTIP_H = 470;
const TOOLTIP_PAD = 12;

/** Clamp the card to the viewport so it never hangs off an edge.
 *
 *  Everything here is LAYOUT px: TOOLTIP_W/H are the card's CSS size and the
 *  result is written as a `translate3d` inside the zoomed tree. The pointer is
 *  converted by the callers and the viewport is converted here — mixing a
 *  screen-px viewport with a layout-px card width would put the flip-to-the-
 *  left decision 10% off the edge it is meant to protect. */
function tooltipOffset(mouseX, mouseY) {
  const { width: vw, height: vh } = layoutViewport();

  let left = mouseX + 18;
  if (left + TOOLTIP_W + TOOLTIP_PAD > vw) left = mouseX - TOOLTIP_W - 14;
  left = Math.max(TOOLTIP_PAD, Math.min(left, vw - TOOLTIP_W - TOOLTIP_PAD));

  let top = mouseY - 10;
  if (top + TOOLTIP_H + TOOLTIP_PAD > vh) top = vh - TOOLTIP_H - TOOLTIP_PAD;
  top = Math.max(TOOLTIP_PAD, top);

  return { left, top };
}

/**
 * Hover card.
 *
 * The cursor position is applied by writing `style.transform` on this node
 * directly (see the pointer effect in FleetMap) rather than by passing x/y as
 * props. Position used to live in React state updated from a window-level
 * mousemove listener, which re-rendered FleetMap — and with it MapOverlay and
 * this whole VehicleStatsCard subtree — on EVERY pixel of mouse movement
 * anywhere on the page, hovering or not. That was the single largest source of
 * input lag on the fleet screen.
 */
/**
 * A route: a path with a start and an end.
 *
 * An icon rather than the words "Replay day", because this bar has to hold
 * three controls inside a 248px card and a labelled button crowded out the
 * rest. Drawn rather than an emoji — no glyph in the standard set reads as
 * "the way this went", and the nearest candidates (arrows, footprints) all say
 * something else.
 */
/**
 * A surveyor's reticle: rings and cross hairs, with a gap where they meet so
 * the centre stays legible at 13px. Deliberately not a magnifier — a magnifier
 * reads as "search", and there is already a search on this screen.
 */
function TargetIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <path
        d="M8 0.6v3.1M8 12.3v3.1M0.6 8h3.1M12.3 8h3.1"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
      />
    </svg>
  );
}

function RouteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M3.5 12.5c0-2 3-2.2 4.5-3s2.8-1.2 2.8-2.8"
        fill="none" stroke="currentColor" strokeWidth="1.4"
        strokeLinecap="round" strokeDasharray="2.4 1.8"
      />
      <circle cx="3.5" cy="12.5" r="1.9" fill="currentColor" />
      <path
        d="M11 1.6c1.4 0 2.5 1.1 2.5 2.5 0 1.7-2.5 4-2.5 4s-2.5-2.3-2.5-4c0-1.4 1.1-2.5 2.5-2.5z"
        fill="currentColor"
      />
    </svg>
  );
}

/** A dash camera: a lens on a body. */
function CameraIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M1.6 4.6h7.2c.5 0 .9.4.9.9v5c0 .5-.4.9-.9.9H1.6a.9.9 0 0 1-.9-.9v-5c0-.5.4-.9.9-.9z"
        fill="none" stroke="currentColor" strokeWidth="1.3"
      />
      <path d="M11 8.6l3.3-2v6l-3.3-2z" fill="currentColor" />
      <circle cx="5.2" cy="8" r="1.7" fill="currentColor" />
    </svg>
  );
}

const VehicleTooltip = memo(function VehicleTooltip({
  vehicle, nodeRef, pinned = false, onReplay, onClose, replaying = false,
  onToggleRoute, routeOn = false,
  onPointerDown, minimized = false, onToggleMinimize,
  onToggleCamera, cameraOn = false,
  onZoomTo, onZoomBack, zoomedIn = false, onOpenTheft,
}) {
  return (
    <div
      ref={nodeRef}
      className={"vehicle-tooltip vehicle-tooltip--rich"
        + (pinned ? " vehicle-tooltip--pinned" : "")
        + (pinned && minimized ? " vehicle-tooltip--min" : "")}
    >
      {/* Only when pinned. On hover the card is pointer-events:none and a
          button inside it could not be clicked — it would also be a control
          that appears under the cursor and vanishes when you move toward it.

          Doubles as the DRAG HANDLE, which is why the plate is repeated here:
          a title bar needs something to grab that is not a button, and the
          grip alone is a small target. */}
      {pinned && (
        <div className="vehicle-tooltip__bar" onPointerDown={onPointerDown} title="Hold and drag to move">
          <span className="vt-grip" aria-hidden="true">⠿</span>
          <span className="vt-bar-plate">{vehicle?.id}</span>

          {/* FIRST in the row, because it is the cheapest thing you can ask
              of a unit: "show me where this is". Replay, camera and the panel
              all open something; this only moves the camera.

              Click zooms to the unit, double-click returns to the view you
              were on. The single click is NOT debounced waiting to see whether
              a second one is coming - that would put 250ms of lag on the
              common action to serve the rare one. Instead the first click of a
              double simply zooms in and the dblclick undoes it, so the net
              effect of a double-click is still "go back", which is what the
              gesture promises. The saved view is stamped once, on the first
              zoom-in, so hammering the button cannot overwrite the place you
              are trying to get back to. */}
          <button
            type="button"
            className={"vt-action vt-action--zoom" + (zoomedIn ? " vt-action--on" : "")}
            onClick={onZoomTo}
            onDoubleClick={onZoomBack}
            aria-pressed={zoomedIn}
            aria-label="Zoom to this unit on the map; double-click to go back"
            title={zoomedIn ? "Zoom to this unit - double-click to return to the previous view" : "Zoom to this unit on the map"}
          >
            <TargetIcon />
          </button>
          {/* Route: click draws the path the unit has covered today (the
              units list's quick-track line), click again takes it off;
              double-click replays the day (operator, 2026-10-03). The same
              no-debounce rule as the zoom button above: the two clicks of a
              double toggle the line on and off, then the dblclick starts the
              replay, which clears any line anyway — so a double-click lands
              on the replay with nothing left drawn under it. */}
          <button
            type="button"
            className={"vt-action vt-action--route" + (replaying || routeOn ? " vt-action--on" : "")}
            onClick={onToggleRoute}
            onDoubleClick={onReplay}
            disabled={replaying}
            aria-pressed={routeOn}
            aria-label="Show this unit's route; double-click to replay it"
            title={replaying ? "Already replaying this unit"
              : routeOn ? "Hide the route - double-click to replay it"
              : "Show the route covered - double-click to replay it"}
          >
            <RouteIcon />
          </button>
          {/* Camera. Enabled regardless of whether this unit reports one —
              the window itself explains the difference, and a control that is
              permanently disabled on every unit teaches nobody what it does.
              See VehicleCamera for what is and is not wired up. */}
          <button
            type="button"
            className={"vt-action vt-action--cam" + (cameraOn ? " vt-action--on" : "")}
            onClick={onToggleCamera}
            aria-pressed={cameraOn}
            aria-label="Camera feed"
            title={cameraOn ? "Hide camera" : "Show camera feed"}
          >
            <CameraIcon />
          </button>
          <button
            type="button"
            className="vt-action"
            onClick={onToggleMinimize}
            aria-expanded={!minimized}
            aria-label={minimized ? "Expand card" : "Minimize card"}
            title={minimized ? "Expand" : "Minimize"}
          >{minimized ? "▲" : "▬"}</button>
          <button
            type="button"
            className="vt-action"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >✕</button>
        </div>
      )}
      {/* Minimised leaves the bar — and with it the route button, so a replay
          can still be started from a card folded out of the way. */}
      {/* A clicked (pinned) card reads the unit's day for its start row;
          a hover card does not — see VehicleStatsCard `withDay`. */}
      {/* The alert badge is a button only on a clicked card — a hover card is
          pointer-events:none, so a button there could never be pressed. */}
      {!(pinned && minimized) && (
        <VehicleStatsCard vehicle={vehicle} withDay={pinned} onAlertClick={pinned ? onOpenTheft : undefined} />
      )}
    </div>
  );
});

// Marker icon HTML — pulsing wrap for warn/crit statuses (speeding/theft), the
// same flickering treatment the original map had. Classes are styled in
// FleetMap.scss and are unchanged from the Leaflet implementation.
//
// `moving` adds a circular ripple on top of that, so a vehicle in transit is
// findable at a glance on a map where most markers are parked and static. It is
// deliberately a separate class from .lf-pulse: pulse means "something is
// wrong", ripple means "this one is driving", and a speeding vehicle is both.
function markerIconHtml(status, { highlighted = false, searched = false, moving = false, heading = 0, sprite = "truck", dark = false, darkAge = "", name = "" } = {}) {
  const color = STATUS_COLORS[status];
  // Pulse is reserved for the two states that need chasing: speeding and
  // suspected theft. Idling used to ring too, but a fleet parked up with the
  // engine running is the common case here — dozens of markers rippling at
  // once turned the alert cue into background noise. Idling still reads off
  // the marker's own status colour.
  const pulse = status === "speeding" || status === "theft";
  // Only ripple a vehicle we currently believe is driving. `moving` comes from
  // the last fix, which may be stale; status "parked" is what deriveStatus
  // returns once a tracker has gone quiet past the online window. Rippling one
  // of those would assert it is on the move when we have not heard from it.
  const ripple = moving && status !== "parked" && status !== "stationary" && status !== "idling";
  const halo   = searched ? "lf-halo--searched" : highlighted ? "lf-halo--active" : "";
  // Always in the markup and shown by a class on the map (the rail's eye), so
  // turning names on or off is one class change, not 600 marker rebuilds.
  const nameTag = name ? `<div class="lf-name">${esc(name)}</div>` : "";
  // A dark unit gets no halo and no animation at all. Both cues assert "this is
  // happening now", and the whole point is that it is not — the marker shows
  // where the vehicle WAS when its tracker last spoke. The age badge is the
  // only way to tell that from the map without opening the card.
  if (dark) {
    return `
    <div class="lf-marker-wrap lf-dark${searched ? " lf-searched" : ""}" data-status="${status}">
      <div class="lf-truck lf-truck--${sprite}" style="background-position:${truckBackgroundPosition(status, heading)}"></div>
      <div class="lf-dot" style="background:${color}"></div>
      <div class="lf-dark-age" title="Last reported ${darkAge} ago">${darkAge}</div>
      ${nameTag}
    </div>`;
  }
  return `
    <div class="lf-marker-wrap${pulse ? " lf-pulse" : ""}${ripple ? " lf-ripple" : ""}${searched ? " lf-searched" : ""}" data-status="${status}">
      <div class="lf-halo ${halo}" style="--lf-status:${color}"></div>
      <div class="lf-truck lf-truck--${sprite}" style="background-position:${truckBackgroundPosition(status, heading)}"></div>
      <div class="lf-dot" style="background:${color};box-shadow:0 0 5px ${color}"></div>
      ${nameTag}
    </div>`;
}

/**
 * The badge that stands in for a group of overlapping units.
 *
 * Deliberately built from the marker's own parts — the same sprite frame, the
 * same status dot — rather than a fresh circle-with-a-number. A reader zoomed
 * out over a yard should recognise it as "several of those", not meet a new
 * kind of thing on the map. The count rides on the corner in the alert red the
 * rest of the map already uses for "look here".
 *
 * `sprite` and `status` come from the FIRST member, so a cluster of tippers
 * looks like a tipper. That is a representative, not a summary: the badge says
 * how many, the hover list says which, and nothing here claims they are all
 * the same machine or all in the same state.
 */
function clusterIconHtml(count, { sprite = "truck", status = "parked" } = {}) {
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.parked;
  return `
    <div class="lf-cluster" data-status="${status}">
      <div class="lf-cluster-body">
        <div class="lf-truck lf-truck--${sprite}" style="background-position:${truckBackgroundPosition(status, 0)}"></div>
        <div class="lf-dot" style="background:${color};box-shadow:0 0 5px ${color}"></div>
      </div>
      <span class="lf-cluster-badge" data-len="${clusterBadgeLabel(count).length}">${clusterBadgeLabel(count)}</span>
    </div>`;
}

/**
 * How far a cluster click is allowed to zoom.
 *
 * A cluster of units parked on ONE spot has zero-area bounds, and fitBounds on
 * that slams the camera to maxZoom where they are still one pixel apart — the
 * click would read as broken. Capped here, and the degenerate case steps in a
 * few levels instead; the hover list is what actually names those units.
 */
const CLUSTER_MAX_ZOOM = 18;

/**
 * How long a unit stays OUT of the clusterer after you break its cluster.
 *
 * Asked for, and the reason is the task: you open a cluster because you want
 * to watch ONE vehicle. Every pass of the clusterer is a chance to swallow it
 * again - a pan that brings a neighbour into the cell, a fix that moves it
 * forty metres, a zoom back out to see where it is heading - and re-grouping
 * it mid-watch throws away the click that opened it.
 *
 * Ten minutes is long enough to follow a truck across a yard or out to the
 * gate, and short enough that a map left open goes back to being readable on
 * its own. It is deliberately a per-UNIT exemption, not a per-cluster one:
 * the cell a unit belongs to is re-cut on every pass and would not survive
 * the vehicle moving, which is the case this exists for.
 *
 * The cost is honest and worth stating: exempt units are drawn where they
 * actually are, so two that sit on one coordinate will overlap for the
 * duration rather than merge into a badge. That is the trade the request
 * makes - a marker you can keep your eye on beats a tidy map.
 */
const CLUSTER_EXEMPT_MS = 10 * 60_000;

/* CLUSTER_TIP_ROWS moved to ClusterList, which is what enforces it. */

// Route endpoint pins. The hover label reuses the .route-tip styling the
// Leaflet tooltips had; CSS reveals it on hover of the pin.
function routePinHtml(kind, color, label) {
  const shape = kind === "dest"
    ? `<div class="rp-dest" style="background:${color};box-shadow:0 0 6px ${color}88"></div>`
    : `<div class="rp-dep"  style="background:${color};border-color:${color}"></div>`;
  const icon  = kind === "dest" ? "🏁" : "🟢";
  const word  = kind === "dest" ? "To"  : "From";
  return `
    <div class="route-pin">
      ${shape}
      <span class="route-tip"><b>${icon} ${word}:</b> ${label ?? ""}</span>
    </div>`;
}

// Status-bar chip key → the vehicle status it shows (statuses come from
// lib/vehicleMap's deriveStatus: ok | speeding | theft | parked).
// Filter membership lives in lib/vehicleMap so the chip counts in MapOverlay
// and the marker visibility here cannot drift apart. Note OK means ONLINE (any
// connected unit), not `status === 'ok'`.
const visibleUnderFilter = matchesFilter;

// Map engine loader: lib/mapEngine (shared with Fuel › Report).

// ── DOM marker overlay ──────────────────────────────────────────────────────
// google.maps.Marker only renders an image, and AdvancedMarkerElement needs a
// cloud-configured Map ID. OverlayView renders our existing marker HTML as-is,
// so every FleetMap.scss rule keeps working.
function makeDomMarkerClass(maps) {
  return class DomMarker extends maps.OverlayView {
    constructor({ position, html, anchor = "bottom", zIndex = 0, onClick, onOver, onOut }) {
      super();
      this._pos     = position;
      this._html    = html;
      this._anchor  = anchor;
      this._zIndex  = zIndex;
      this._onClick = onClick;
      this._onOver  = onOver;
      this._onOut   = onOut;
      this._div     = null;
      this._visible = true;
      this._clustered = false;
      // Anchoring half of the transform, fixed for the marker's lifetime.
      this._baseTransform = anchor === "center"
        ? "translate(-50%, -50%)"
        : "translate(-50%, -100%)";
      // Last drawn pixel position, so draw() can skip no-op writes.
      this._px = null;
      this._py = null;
      this._onScreen = true;
      // Pixel nudge away from the anchor, used by the zone-label declutter to
      // park a plate in free space instead of dropping it.
      this._ox = 0;
      this._oy = 0;
    }

    /**
     * Shared cull rectangle in div-pixel space, refreshed once per viewport
     * change by FleetMap rather than recomputed per marker per frame.
     */
    static _viewport = null;

    onAdd() {
      const div = document.createElement("div");
      div.style.position  = "absolute";
      // Anchored at the pane origin; draw() supplies the position as a
      // translate3d appended to this base anchoring transform.
      div.style.left      = "0";
      div.style.top       = "0";
      div.style.zIndex    = String(this._zIndex);
      div.style.willChange = "transform";
      div.style.transform = this._baseTransform;
      div.style.cursor    = this._onClick ? "pointer" : "";
      div.innerHTML       = this._html;
      if (!this._visible || this._clustered) div.style.display = "none";

      if (this._onClick) {
        div.addEventListener("click", (e) => { e.stopPropagation(); this._onClick(e); });
      }
      if (this._onOver) div.addEventListener("mouseenter", this._onOver);
      if (this._onOut)  div.addEventListener("mouseleave", this._onOut);

      this._div = div;
      // overlayMouseTarget is the pane that receives pointer events.
      const panes = this.getPanes();
      if (!panes) return; // map not ready yet — draw() will be called again
      panes.overlayMouseTarget.appendChild(div);
      this.draw();
    }

    /**
     * Google calls draw() on EVERY overlay for every frame of a pan or zoom.
     * With 224 markers that is the map's hot loop, so it does three things
     * differently from the obvious implementation:
     *
     *  1. `transform`, not left/top. Writing left/top invalidates layout for
     *     every marker on every frame; a translate3d is a compositor-only
     *     change. This is the single biggest win while zooming.
     *  2. Culls anything outside the viewport (plus a margin). A fleet spread
     *     across two countries has most of its markers off-screen at street
     *     zoom, and an off-screen marker still costs a style write and a
     *     composite. Culled nodes are display:none, so they cost nothing.
     *  3. Skips the write when the rounded pixel position has not changed,
     *     which is the common case for a parked vehicle during a slow pan.
     */
    draw() {
      if (!this._div) return;
      const proj = this.getProjection();
      if (!proj) return;
      const p = proj.fromLatLngToDivPixel(new maps.LatLng(this._pos.lat, this._pos.lng));
      if (!p) return;

      const x = Math.round(p.x + this._ox);
      const y = Math.round(p.y + this._oy);

      // Cull against the div-pixel viewport. The margin keeps markers that are
      // only just off-screen mounted, so panning does not pop them in late.
      const b = DomMarker._viewport;
      const onScreen = !b || (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY);
      if (onScreen !== this._onScreen) {
        this._onScreen = onScreen;
        this._applyDisplay();
      }
      if (!onScreen) return;

      if (x === this._px && y === this._py) return;
      this._px = x;
      this._py = y;
      this._div.style.transform = `${this._baseTransform} translate3d(${x}px, ${y}px, 0)`;
    }

    onRemove() {
      this._div?.remove();
      this._div = null;
      // Forget where the OLD node was drawn. The next onAdd builds a fresh
      // node with no position on it, and draw() skips the write when the
      // pixel matches the last one drawn — so a marker taken off and put
      // back at the same place (every replay pin, tick and minute dot after
      // a rewind) stayed parked at the pane origin, off the line and out of
      // sight. Cleared, the first draw() after onAdd always places it.
      this._px = this._py = null;
      this._onScreen = true;
    }

    getPosition() { return this._pos; }

    setPosition(pos) {
      this._pos = pos;
      this.draw();
    }

    setHtml(html) {
      this._html = html;
      if (this._div) this._div.innerHTML = html;
    }

    /**
     * Restack the node after construction. Used by the trip path's timestamp
     * ticks: an opened tick has to clear the stop and endpoint markers it may
     * be standing next to, and drop back under them when it closes.
     */
    setZIndex(z) {
      this._zIndex = z;
      if (this._div) this._div.style.zIndex = String(z);
    }

    /**
     * Point the truck sprite at a new heading WITHOUT rewriting innerHTML.
     * Heading changes on nearly every fix, and re-setting innerHTML would
     * restart the pulse/ripple CSS animations each time, so the marker of a
     * speeding vehicle would visibly stutter. Only the background offset moves.
     */
    setTruckFrame(status, heading) {
      const el = this._div?.querySelector(".lf-truck");
      if (el) el.style.backgroundPosition = truckBackgroundPosition(status, heading);
    }

    /**
     * Rendered size of the node, or null if it is not currently laid out —
     * hidden by the status filter, or culled off-screen. Used by the zone-label
     * declutter pass, which needs real widths because the plates are text.
     */
    /** Shift the node off its anchor by a pixel offset. */
    setOffset(dx, dy) {
      if (dx === this._ox && dy === this._oy) return;
      this._ox = dx;
      this._oy = dy;
      // The skip-if-unchanged guard in draw() compares the OFFSET position, so
      // clear it or the move is dropped as a no-op.
      this._px = this._py = null;
      this.draw();
    }

    getDivSize() {
      const d = this._div;
      if (!d) return null;
      const w = d.offsetWidth, h = d.offsetHeight;
      return w && h ? { w, h } : null;
    }

    /**
     * Visibility has THREE axes, and they are all subtractive.
     *
     *   _visible    the filters allow this unit
     *   _onScreen   the viewport cull has not dropped it
     *   _clustered  a cluster badge is standing in for it
     *
     * Kept apart rather than folded into one boolean because each is owned by
     * a different pass at a different cadence: the reconcile pass sets the
     * first on every SSE frame, draw() sets the second on every camera frame,
     * and the cluster pass sets the third on idle. Any one of them writing a
     * single combined flag would silently undo the other two.
     */
    _applyDisplay() {
      if (!this._div) return;
      this._div.style.display =
        (this._visible && this._onScreen && !this._clustered) ? "" : "none";
    }

    setVisible(visible) {
      this._visible = visible;
      this._applyDisplay();
    }

    /**
     * Stand this marker down because a cluster badge is carrying it.
     *
     * Not setVisible: the filters' answer has to survive being clustered, or
     * a unit hidden by the funnel would reappear the moment its cluster broke
     * up. See the cluster pass in FleetMap.
     */
    setClustered(clustered) {
      if (this._clustered === clustered) return;
      this._clustered = clustered;
      this._applyDisplay();
    }

    isClustered() { return this._clustered; }

    /** What the FILTERS decided, ignoring the cull and the cluster pass. */
    wantsVisible() { return this._visible; }
  };
}

export default function FleetMap() {
  const mapContainerRef = useRef(null);
  const mapRef          = useRef(null);
  const mapsLibRef      = useRef(null); // the google.maps namespace the map was built with
  const DomMarkerRef    = useRef(null); // overlay class bound to that namespace
  // Read before any state below, because several of those states are seeded
  // from THIS ORGANISATION's stored preferences (lib/mapPrefs).
  const { windowOpen, activeCompanyId, desktopActiveTab, pendingFocusId, sitePlanRequest, fleetTypes, trackedIds, inTransitOnly, restoredVehicleId, selectedVehicleId, mapClearN } = useAppFields("windowOpen", "activeCompanyId", "desktopActiveTab", "pendingFocusId", "sitePlanRequest", "fleetTypes", "trackedIds", "inTransitOnly", "restoredVehicleId", "selectedVehicleId", "mapClearN");
  // The names under the markers (the rail's eye): the licence number only,
  // or the id at Kasulu (lib/plate mapLabel). A ref, since markers are drawn
  // from callbacks that outlive a render.
  const labelCompanyRef = useRef(activeCompanyId);
  labelCompanyRef.current = activeCompanyId;
  const { setSelectedVehicleId, setFeedVehicleId, setDesktopActiveTab, setMobileActiveTab, setPendingFocusId, requestIncident, setSitePlanLinks, setTrackedIds, setInTransitOnly, markSelectionRestored } = useAppActions();

  const [mapReady, setMapReady]             = useState(false);
  // Hover tracks the ID, not a vehicle snapshot — the card re-renders with
  // each SSE frame while the cursor rests on a marker.
  const [hoveredId, setHoveredId]           = useState(null);
  // Mirrors hoveredId (+ when it opened) for map event handlers, which live
  // outside React's render cycle. Touch devices fire the emulated mouseenter
  // on tap but never mouseleave, so the card must also close on a repeat tap
  // of the marker, a tap elsewhere, or a map pan/zoom.
  const hoveredIdRef     = useRef(null);
  const hoverOpenedAtRef = useRef(0);
  // Cursor position is a ref, not state — see the pointer effect below.
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const tooltipRef     = useRef(null);

  /** Record where the pointer was, from any event that carries coordinates. */
  const notePointer = useCallback((e) => {
    if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY) && (e.clientX || e.clientY)) {
      /* Remembered in LAYOUT px, because every consumer of it feeds
         tooltipOffset, which works in them. */
      lastPointerRef.current = pointerXY(e);
    }
  }, []);
  const [searchedId, setSearchedId]         = useState(null);
  // Isolation. Set by a live-feed click: while it holds, the focused vehicle is
  // the ONLY marker on the map — a notification about one truck should not
  // arrive with its neighbours in the frame. Released by zooming out, which is
  // the gesture that means "show me the wider picture again".
  const [focusedId, setFocusedId]           = useState(null);

  // The status chips, remembered per organisation — see lib/mapPrefs. "moving
  // only", chosen on a fleet of 800, used to follow you onto a fleet of 20 and
  // look like an empty map.
  const [activeFilter, setActiveFilterState] = useState(
    () => readMapPrefs(activeCompanyId).filter,
  );
  const setActiveFilter = useCallback((f) => {
    setActiveFilterState(f);
    writeMapPrefs(activeCompanyId, { filter: f });
  }, [activeCompanyId]);
  const [showMobileMap, setShowMobileMap]   = useState(false);


  // Fuel alerts: the map treatment only. The incidents themselves are never
  // affected — see markerState in lib/vehicleMap for why that distinction is
  // load-bearing.
  const [showFuelAlerts, setShowFuelAlerts] = useState(
    () => readCache(FUEL_ALERTS_KEY) ?? true,
  );
  // A fresh object each render would defeat nothing (markerState reads it and
  // discards it), but memoising keeps it out of the reconcile's dep list as a
  // changing value.
  const alertOpts = useMemo(() => ({ fuelAlerts: showFuelAlerts }), [showFuelAlerts]);
  // The playback draw runs inside a subscription that must not be rebuilt when
  // the toggle flips — a resubscribe mid-replay drops the frame it was on.
  const alertOptsRef = useRef(alertOpts);
  useEffect(() => { alertOptsRef.current = alertOpts; }, [alertOpts]);
  // Stable, so the memoised MapOverlay is not invalidated by an inline arrow
  // rebuilt on every render — which would have made the memo do nothing.
  const showMobileMapOn = useCallback(() => setShowMobileMap(true), []);

  const [mapLibError, setMapLibError]       = useState(null);
  // Weighbridge markers — the scales, each carrying its last ticket. Off by
  // default: they are four sites inside a national fleet, so drawing them
  // unasked would put six pins on a view where they are two pixels wide.
  const [showBridges, setShowBridges]       = useState(
    () => readMapPrefs(activeCompanyId).layers.bridges,
  );
  const bridgeMarkersRef = useRef(null);    // google.maps.Marker[] | null
  const bridgeWinRef     = useRef(null);
  /* The estate's surveyed boundaries — the provider's geofences, drawn for
   * Mufindi alone. See ZONE_AREAS_COMPANY for why this layer exists on one org
   * and nowhere else. The shapes are built once from geometry that is already
   * fetched for every org (the stranded-stop test reads it), so the switch
   * costs a render, not a request. */
  const [showZones, setShowZones]           = useState(
    () => readMapPrefs(activeCompanyId).layers.zones,
  );
  const zoneLayerRef      = useRef(null);   // { shapes[], labels[], info, bounds } | null
  /* Live traffic (Google's TrafficLayer, lib/googleBase) over the base map,
   * and the pinned unit's routed line. TomTom's tiles were switched off
   * 2026-10-09 and replaced by Google's 2026-10-27. */
  const [showTraffic, setShowTraffic]       = useState(
    () => LIVE_TRAFFIC_AVAILABLE && readMapPrefs(activeCompanyId).layers.traffic,
  );
  /* Current weather, Google Weather API points over the view (lib/weatherLayer). */
  const [showWeather, setShowWeather]       = useState(
    () => readMapPrefs(activeCompanyId).layers.weather,
  );
  const [weatherNote, setWeatherNote]       = useState(null);
  const zonesRequestedRef = useRef(false);  // a toggle is a request; a default is not
  // CAD plan overlay — separate toggle, separate layer, lazily fetched.
  const [showPlan, setShowPlan]             = useState(
    () => readMapPrefs(activeCompanyId).layers.plan,
  );
  const [planState, setPlanState]           = useState("idle"); // idle|loading|ready|error
  /* Same pair as the site plan's below: whether the operator ASKED for the
   * layer, and whether its camera fit has already run for this org. */
  const planRequestedRef = useRef(false);
  const planFittedRef    = useRef(false);
  /* The works-site and estate surveys, all keyed by survey id — see
   * SITE_PLANS. One org can have two, so none of this can be a single value
   * any more. */
  const [siteOn, setSiteOn]         = useState(() => siteOnFor(activeCompanyId));
  const [siteStatus, setSiteStatus] = useState({});  // id → idle|loading|ready|error
  const [siteCats, setSiteCats]     = useState({});  // id → category[]
  /* id → { data, hover, style, requested, fitted }
   *
   *   data       the google.maps.Data layer, built once per org visit
   *   hover      its InfoWindow
   *   style      the style callback, kept so a change elsewhere (the
   *              weighbridge switch) can re-run it without a rebuild
   *   requested  the operator ASKED for this layer, as against it being on
   *              because it is on by default. Decides one thing: whether
   *              enabling it moves the camera
   *   fitted     its camera fit has already run on this visit
   */
  const sitesRef = useRef({});
  const siteSlot = (id) => (sitesRef.current[id] ??= {
    data: null, hover: null, style: null, requested: false, fitted: false,
  });
  const planDataRef  = useRef(null);   // google.maps.Data instance
  const planHoverRef = useRef(null);   // hover InfoWindow for block names
  const planLabelsRef = useRef(null);  // the drawing's macro name plates
  const markerMapRef   = useRef({});   // vehicle id → DomMarker

  const routeLayerRef  = useRef({});   // vehicle id → { routeLines[], depPin, destPin }
  /* The verdict on the drawn route: real time vs the time the same roads
   * should take (RouteCoveredCard). One at a time, like the route itself. */
  const [covered, setCovered] = useState(null);
  const expectedCacheRef = useRef(new Map());  // `${vehicleId}:${start}:${end}` → expected
  const activeRouteRef = useRef(null);
  // The same value as activeRouteRef, for RENDER only. A ref cannot make a
  // control re-draw its own on/off state, and a second source of truth is only
  // safe because exactly one function writes both — see setActiveRoute.
  const [routeId, setRouteId] = useState(null);

  // ── left tool rail (MapToolRail) ──────────────────────────────────────
  const [namesOn, setNamesOn] = useState(() => readCache(NAMES_KEY) ?? false);
  const [toolsExpanded, setToolsExpanded] = useState(() => readCache(TOOLS_EXPANDED_KEY) ?? false);
  // The ruler: on/off, and the points clicked so far (plain {lat,lng}).
  const [measuring, setMeasuring] = useState(false);
  const [measurePts, setMeasurePts] = useState([]);
  const measuringRef = useRef(false);
  measuringRef.current = measuring;
  // Base map. Google only where a key was built in; otherwise OSM, always.
  const [baseMap, setBaseMap] = useState(() => {
    const stored = readCache(BASE_MAP_KEY);
    return GOOGLE_BASE_AVAILABLE && isGoogleBase(stored) ? stored : "osm";
  });
  // For the overlay style callbacks, which are built once and re-run on a base
  // switch rather than rebuilt — the polygon colours depend on it (zoneColor).
  const baseMapRef = useRef(baseMap);
  baseMapRef.current = baseMap;
  const [baseNote, setBaseNote] = useState(null);
  const vehiclesRef    = useRef([]);   // latest fleet, for event handlers
  // The funnel's selection, for the same reason: handleFilter is handed to
  // MapOverlay, and putting fleetTypes in its dep list would rebuild the
  // callback — and re-run everything downstream of it — on every tick of a
  // checkbox that the camera only needs to read when a chip is pressed.
  const fleetTypesRef  = useRef([]);
  // The tracked selection and the in-transit lens, mirrored for the same
  // reason and read at the same moment: when a chip is pressed, so the camera
  // frames the units that are actually drawn.
  const trackedSetRef  = useRef(null);
  const inTransitRef   = useRef(false);
  const trackCacheRef    = useRef(new Map());  // vehicleId → travelled track
  const viewportProbeRef = useRef(null);  // OverlayView used only for its projection
  const tweenKickRef     = useRef(null);  // restarts the parked rAF loop
  const isFirstRenderRef = useRef(true);   // skip tween on initial load to prevent flying
  // ADDED 2026-08-06: Trip Path overlay
  const [tripPathId, setTripPathId]     = useState(null);  // vehicle whose trip path is shown
  const tripLayerRef                    = useRef(null);     // { lines[], markers[] } to clean up
  const tripTokenRef                    = useRef(null);     // identity of the in-flight request

  // ── Route playback ────────────────────────────────────────────────────────
  // A recorded DAY, replayed. Distinct from the click-to-show track above,
  // which is a static line over a rolling 12 h window: this one is scoped to a
  // fleet calendar day, carries heading and speed per fix, and has a cursor.
  const [playbackId,  setPlaybackId]  = useState(null);
  const [playbackDay, setPlaybackDay] = useState(() => todayFleetDay());
  const playbackLayerRef = useRef(null);  // { full[], trail[] } to tear down
  /**
   * Read by the live reconcile pass, which runs on every SSE frame and must not
   * fight the playback cursor for the same marker. A ref rather than the state
   * because that pass is not re-created when playback starts.
   */
  const playbackIdRef = useRef(null);
  useEffect(() => { playbackIdRef.current = playbackId; }, [playbackId]);

  /**
   * The vehicle card PINNED open by a click, as opposed to shown by a hover.
   *
   * The card was hover-only and `pointer-events: none` — deliberately, so it
   * could never steal the mouse from the map. That is right for something that
   * follows the cursor and is read at a glance, and wrong the moment it has to
   * contain a button: moving toward the control dismisses the thing you were
   * reaching for.
   *
   * A click therefore pins it. Pinned, it stops tracking the pointer, accepts
   * clicks, and carries the actions that belong to one unit.
   */
  const [pinnedId, setPinnedId] = useState(null);

  /* A side-panel filter clears the map down to the group asked for: tracking
   * stops and the pinned card closes (operator, 2026-10-15: "when I interact
   * with the buttons on the side panel like critical, idling… the unit card
   * is to close and disappear, the tracking should be stopped and clear the
   * UI"). Called by the status chips (handleFilter) and when the Fleets
   * block's types or In transit change (effect below). */
  const endTracking = useCallback(() => {
    setTrackedIds((prev) => (prev?.length ? [] : prev));
    setPinnedId(null);
  }, [setTrackedIds]);

  const fittedCompanyRef = useRef(null);
  const pendingFitRef  = useRef(false);
  const deepLinkedRef  = useRef(false);


  // Membership, derived once. The context holds an ARRAY — see the note there
  // for why a Set must not live in the provider.
  //
  // ONE piece of state: the tracked list in AppContext, persisted per
  // organisation. The map filter is DERIVED from it — ticked units narrow the
  // map, no ticks shows the fleet — exactly as in dash. There used to be a
  // second, unpersisted "Show tracked only" switch beside it, so a refresh
  // restored the ticks but not the switch and the map came back showing the
  // whole fleet with the ticks silently ignored. Derived state cannot drift
  // from its source. A stable empty Set keeps an empty list from re-running
  // the effects below.
  const trackedSet = useMemo(
    () => (trackedIds?.length ? new Set(trackedIds) : EMPTY_TRACKED),
    [trackedIds],
  );

  /**
   * Publish the free area — the map minus its two rails, the header and the
   * footer nav — as CSS variables, for the windows that have to cap their WIDTH
   * against it rather than only their position. Once, here, because this is the
   * component that owns the map the area is measured from.
   *
   * Keyed on the tab: the map measures 0×0 while its panel is display:none, and
   * coming back fires no resize event to recompute from.
   */
  useSafeAreaVars(desktopActiveTab);

  // Real, live fleet from the fleet-server DB (cache-hydrated snapshot + SSE),
  // shared app-wide via FleetLiveProvider — one stream for map, header, panels.
  // Layer control, fuel alerts and the unit filter are separate permissions,
  // not one "can use the map". An operator is meant to watch the fleet without
  // recolouring it or seeing fuel incidents, so the three are asked separately.
  //
  // Read HERE rather than beside the layer menu that consumes it, because the
  // guest-survey sweep below is gated on the same permission and runs long
  // before the menu is built.
  const { can: canDo, orgId: permOrgId } = usePermissions();
  const { publishLayers, registerFocus, registerFilter, registerPlayback, publishFilter, publishStranded, registerFocusBridge, registerReveal, unitsOpen, setUnitsOpen, strandedOpen, setStrandedOpen, fuelAlertsOpen, setFuelAlertsOpen } = useMapLayers();
  const { isCompact, isMobile } = useBreakpoint();
  /* Where the side panel exists (desktop) a click selects the unit and the
     panel shows it; the map card is the HOVER preview only (operator,
     2026-10-07: "the unit card should be seen on hover since we have the
     sidepanel card already"). Pinning a second card beside the panel showed
     the same unit twice and, being pinned, switched hover off for every other
     marker. Phones and tablets have no side panel (selection is cleared below
     1024px), so there the click still pins the card — it is the only detail
     they get. A ref so the restore effect below reads the current layout. */
  const isCompactRef = useRef(isCompact);
  isCompactRef.current = isCompact;

  const { vehicles: _lv, orgId, loading: vehiclesLoading, error: vehiclesError, retry } = useFleetLiveShared();

  // A halted unit picked in the Halted window (operator, 2026-10-15): where
  // it stopped, its route, stops and drive zones (IncidentInvestigation).
  //
  // Opening a fuel alert no longer opens it (operator, 2026-10-20: "when I
  // click on the fuel theft alert I don't want this card rendered, we can
  // deprecate it"). The `kind: "fuel"` subject still works in
  // IncidentInvestigation; nothing sets it.
  //
  // What is drawn stays on the map after the window that opened it closes
  // (operator, 2026-10-15: "when we close this modal it should not close the
  // modal for Isochrones"); only the key's own × clears it, or picking
  // another halted unit, or changing organisation.
  const [investigateSubject, setInvestigateSubject] = useState(null);
  useEffect(() => { setInvestigateSubject(null); }, [orgId]);
  const investigation = useIncidentInvestigation({
    map: mapRef.current, maps: mapsLibRef.current, ready: mapReady, orgId, subject: investigateSubject,
  });
  // Arrivals at a hub (operator, 2026-10-15): every unit's live drive time
  // to it, in its own window (HubArrivals). Opened
  // from the tool rail; closed by its own ×, or by changing organisation.
  const [arrivalsOpen, setArrivalsOpen] = useState(false);
  useEffect(() => { setArrivalsOpen(false); }, [orgId]);
  const arrivals = useHubArrivals({
    map: mapRef.current, maps: mapsLibRef.current, ready: mapReady, orgId, open: arrivalsOpen,
  });
  const vehicles = _lv ?? [];

  /* The map's own status counts used to be computed here, as two `.filter()`
   * passes for the CRITICAL and WARNING chips. StatusRail counts all six
   * buckets in a single pass instead (lib/fleetStatusStats), against the same
   * `matchesFilter` predicate the side panel's cards use — which is the
   * contract that stops a chip reading CRITICAL 3 above a map showing one. */
  vehiclesRef.current = vehicles;
  fleetTypesRef.current = fleetTypes;
  trackedSetRef.current = trackedSet;
  inTransitRef.current = inTransitOnly;

  // The Fleets block (types, In transit, Clear filters) ends tracking the
  // same way a status chip does. Only on a change after mount, so arriving on
  // the page with a saved type filter leaves a restored track alone.
  const fleetFilterSig = `${[...(fleetTypes ?? [])].sort().join(",")}|${inTransitOnly ? 1 : 0}`;
  const fleetFilterSigRef = useRef(fleetFilterSig);
  useEffect(() => {
    if (fleetFilterSigRef.current === fleetFilterSig) return;
    fleetFilterSigRef.current = fleetFilterSig;
    endTracking();
  }, [fleetFilterSig, endTracking]);

  // Estate boundaries — fetched once per org, cached, never polled. Keyed on
  // orgId, so switching company swaps the geometry rather than mixing it.
  const { zones } = useEstateZones(orgId);
  // Mirrored for handlers that run outside render — the minute-dot card asks
  // which fences a point falls inside at CLICK time, and taking the value
  // through a ref keeps that current without making the playback layer rebuild
  // itself every time the estate's zones load.
  const zonesRef = useRef(null);
  zonesRef.current = zones;
  // The CAD planting plan belongs to one estate only.
  const planAllowed = activeCompanyId === ESTATE_PLAN_COMPANY;
  // The surveys this organisation has. An empty list is also the gate: a
  // company absent from the table is offered no switch and draws nothing.
  const ownPlans = SITE_PLANS[activeCompanyId] ?? NO_PLANS;

  /* ── and the surveys it is VISITING ───────────────────────────────────────
   *
   * A survey belonging to another organisation, offered for exactly as long as
   * one of this fleet's units is standing inside its fence. A West Kenya lorry
   * unloading at Raiply is on ground that has been surveyed and whose file is
   * already on this server — without this it sits on blank imagery, because the
   * survey is filed under a tenant the operator does not have open.
   *
   * See lib/guestSitePlans. Three things keep a guest from behaving like one of
   * this org's own layers, and each is deliberate: it is never written to this
   * organisation's stored preferences (it carries no prefKey), it never takes
   * the camera (see the two fit rules below), and it is torn down by the
   * discard effect the moment it drops off this list.
   *
   * APPENDED, never prepended: fitPlaceLayers frames the first drawn survey
   * when nothing else has claimed the camera, and a visitor must not become the
   * subject of a fit the operator asked another layer for. */
  const guestPlans = useGuestSitePlans({ vehicles, activeCompanyId, enabled: canDo("map:layers") });
  const sitePlans = useMemo(
    () => (guestPlans.length ? [...ownPlans, ...guestPlans] : ownPlans),
    [ownPlans, guestPlans],
  );
  const siteAllowed = sitePlans.length > 0;

  /* A guest arrives switched ON — it is offered BECAUSE it is relevant, and an
   * off switch for a layer that appeared on its own is a control nobody knows
   * to look for. Its key is dropped again when the visit ends, so a lorry that
   * comes back tomorrow is drawn again rather than inheriting an off from a
   * visit the operator has long forgotten. */
  useEffect(() => {
    const guests = new Set(guestPlans.map((p) => p.id));
    setSiteOn((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const id of guests) {
        if (next[id] === undefined) { next[id] = true; changed = true; }
      }
      for (const id of Object.keys(prev)) {
        if (!guests.has(id) && !ownPlans.some((p) => p.id === id)) {
          delete next[id]; changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [guestPlans, ownPlans]);

  /* ── the header's quick links ─────────────────────────────────────────────
   *
   * The surveys this map would draw, published so the header can offer them
   * as a menu. It has to come from here rather than from the table directly:
   * the list is this org's own plans PLUS whichever of another tenant's it is
   * lending right now, and only this component knows which those are.
   *
   * Trimmed to what a link needs. Handing the header the plan objects would
   * give it the fetch URL and the camera settings as well, which is an
   * invitation for a second thing to start drawing site plans. */
  const sitePlanLinks = useMemo(
    () => sitePlans.map((p) => ({
      id: p.id,
      label: p.label,
      guest: Boolean(p.guest),
      occupants: p.occupants?.length ?? 0,
    })),
    [sitePlans],
  );
  useEffect(() => {
    setSitePlanLinks(sitePlanLinks);
    // Cleared on unmount: a menu of places the map is no longer offering is a
    // menu of dead links.
    return () => setSitePlanLinks(EMPTY_LINKS);
  }, [sitePlanLinks, setSitePlanLinks]);

  // And so do the surveyed boundaries beside it.
  const zonesAllowed = activeCompanyId === ZONE_AREAS_COMPANY;
  const hasZones = zonesAllowed && (zones?.features?.length ?? 0) > 0;

  /**
   * The categories this organisation actually has on the map, for the key.
   *
   * Read from the features AFTER the same two exclusions the layer draws by —
   * ZONE_SKIP_CATEGORIES and ZONE_EXCLUDE — because a key is a reading of what
   * is in front of you, and a swatch for something not drawn is a swatch you
   * spend time hunting for.
   */
  const zoneCategories = useMemo(() => {
    const seen = new Set();
    for (const f of zones?.features ?? []) {
      const p = f.properties ?? {};
      if (ZONE_SKIP_CATEGORIES.has(p.category)) continue;
      if (ZONE_EXCLUDE.has(zoneKey(p.name))) continue;
      seen.add(p.category && ZONE_STYLE[p.category] ? p.category : "other");
    }
    return [...seen];
  }, [zones]);

  /* The scales, with the last ticket each one took.
   *
   * Gated on the RESPONSE rather than on an org name: only Sukari's four
   * centres weigh anything today, but the day another mill's scales start
   * reporting, its markers appear without an edit here. */
  const { bridges, loading: bridgesLoading } = useWeighbridges(orgId);
  const hasBridges = (bridges?.length ?? 0) > 0;
  // A deliberate toggle takes the camera to the scales; merely having the
  // layer available does not. Same rule, and the same ref shape, as a site
  // plan's `requested`.
  const bridgeRequestedRef = useRef(false);
  /* Read by the site layer's style callback, which is built once — see the
   * weighbridge rule there. A ref, not the value, so the layer is not rebuilt
   * when the answer changes. */
  const hasBridgesRef = useRef(false);
  hasBridgesRef.current = hasBridges;

  /**
   * Everything selected here names ONE VEHICLE, and a vehicle belongs to one
   * organisation. So none of it may survive a company switch.
   *
   * Left alone, a replay opened on a Sukari hauler stayed on screen after the
   * operator moved to West Sugar: the panel kept its plate in the header, the
   * scrubber kept running, and `useVehiclePlayback` re-fetched that vehicle
   * under the NEW org id — a request for a unit the new organisation does not
   * own. The trip path behaved the same way, and the pinned card carried a
   * plate belonging to a fleet no longer on the map.
   *
   * Cleared DURING RENDER rather than in an effect, which is the pattern
   * useFleetLive already uses for the same event and for the same reason:
   * effects run after paint, so an effect would show the previous
   * organisation's overlay for one frame and let its fetch start. Adjusting
   * state during render makes React re-run this component before painting, so
   * the stale selection is never displayed at all.
   *
   * Keyed on `activeCompanyId`, the operator's actual choice — not on `orgId`,
   * which resolves asynchronously from it and is briefly null in between.
   *
   * The map objects the trip path owns cannot be torn down from here; that is
   * a side effect, and it happens in the effect below.
   */
  const [selectionCompanyId, setSelectionCompanyId] = useState(activeCompanyId);
  if (selectionCompanyId !== activeCompanyId) {
    setSelectionCompanyId(activeCompanyId);
    setPlaybackId(null);
    setPlaybackDay(todayFleetDay());
    setTripPathId(null);
    setPinnedId(null);
    setSearchedId(null);
    setFocusedId(null);
  }

  /**
   * Hover yields to anything the operator has COMMITTED to.
   *
   * A hover card is for scanning a fleet you have not chosen from yet. Once a
   * unit is pinned, a replay is running, or an incident window is up, the
   * cursor passing over a marker has nothing to add — and what it adds instead
   * is a second floating description of a different unit, on top of the one
   * that was deliberately opened. That was the single largest source of clutter
   * on this screen: five surfaces could be up at once and none of them yielded.
   *
   * The three states are separate on purpose. `pinnedId` and `playbackId` are
   * local; `windowOpen` comes from AppContext because the incident window lives
   * in MapOverlay, a sibling that cannot be seen from here.
   */
  const hoverSuppressed = Boolean(pinnedId) || Boolean(playbackId) || windowOpen;

  const hoveredVehicle = hoveredId && !hoverSuppressed
    ? vehicles.find(v => v.id === hoveredId) ?? null
    : null;

  /**
   * The clicked unit, whose card stays open.
   *
   * This card used to be hover-ONLY — a click drew the route and the card went
   * with the cursor. That stopped working once the card had to hold a control:
   * a button that disappears when you move the mouse toward it cannot be
   * pressed. A click now pins the same card instead of opening a second one, so
   * there is still only ever one description of one unit on screen.
   */
  const pinnedVehicle = pinnedId
    ? vehicles.find(v => v.id === pinnedId) ?? null
    : null;

  /* The pinned (else the selected) unit's road to the end of its current
   * leg, with live traffic. The same query the unit panel's Arrives row reads
   * (keyed per unit and target), so the line on the map and the ETA beside it
   * are one request and agree. */
  /* Exactly ONE tracked unit gets its road and traffic ETA to wherever it
   * is going, from its Wialon fix through the server's Google proxy
   * (lib/googleRouting). It outranks the pinned or selected unit for the
   * route line, since a single tracked unit is the only one on the map. (The
   * Route ahead card that went with it — pick a destination, reach rings —
   * was removed on request, 2026-10-15.) */
  const googleRouting  = useGoogleRoutingOn();
  const trackedVehicle = googleRouting && trackedIds.length === 1
    ? vehicles.find(v => v.id === trackedIds[0]) ?? null
    : null;

  const routedVehicle = trackedVehicle ?? pinnedVehicle
    ?? (selectedVehicleId ? vehicles.find(v => v.id === selectedVehicleId) ?? null : null);
  const pinnedTrip   = routedVehicle ? liveTrip(routedVehicle.trip, routedVehicle.lat, routedVehicle.lng) : null;

  const closeInvestigation = useCallback(() => setInvestigateSubject(null), []);
  const routedFresh  = positionFresh(routedVehicle);
  const pinnedTarget = routedFresh ? routeTarget(pinnedTrip) : null;
  const trackedRouting = trackedVehicle != null && routedVehicle === trackedVehicle;
  const pinnedRouteQ = useTrafficRoute({
    vehicleId:  routedVehicle?.id ?? null,
    lat:        routedVehicle?.lat,
    lng:        routedVehicle?.lng,
    to:         pinnedTarget?.to ?? null,
    travelMode: travelModeFor(routedVehicle?.vehicleType),
    enabled:    (showTraffic || trackedRouting) && pinnedTarget != null,
  });
  const pinnedRoute = pinnedRouteQ.data;


  /* Opening a side-panel window — Units, Stopped in transit, Fuel alerts —
   * takes the pinned card down: what was opened is what is being worked now
   * (operator, 2026-10-15). Only the opening edge — a row clicked inside the
   * open window pins its unit's card beside it. */
  const openWindow = unitsOpen ? "units" : strandedOpen ? "stranded" : fuelAlertsOpen ? "fuel" : null;
  useEffect(() => {
    if (openWindow) setPinnedId(null);
  }, [openWindow]);

  /* One side panel at a time (lib/sidePanels; operator, 2026-10-20: "no
   * cards or modal are to be stacked over the other"). The map's card and its
   * windows are one owner, so a row in an open window still pins its card
   * beside it; opening either closes the notifications feed, and the feed
   * opening takes both down. */
  useEffect(() => {
    if (pinnedId || openWindow) claimSidePanel("map");
  }, [pinnedId, openWindow]);
  useEffect(() => onSidePanelClaim("map", () => {
    setPinnedId(null);
    setUnitsOpen(false);
    setStrandedOpen(false);
    setFuelAlertsOpen(false);
  }), [setUnitsOpen, setStrandedOpen, setFuelAlertsOpen]);

  /* One map window at a time (lib/sidePanels claimMapWindow; operator,
   * 2026-10-20: "the arrivals should have cleared the fuel alerts modal").
   * Units, Halted and Fuel alerts already replace each other (mapSlice); this
   * adds Arrivals, a fuel alert's incident window (MapOverlay) and a halted
   * unit's investigation. Whatever opens last closes the rest, except that a
   * list stays open for the window one of its rows opened: Fuel alerts for
   * the incident window, Halted for the investigation. */
  useEffect(() => { if (openWindow) claimMapWindow(openWindow); }, [openWindow]);
  useEffect(() => { if (arrivalsOpen) claimMapWindow("arrivals"); }, [arrivalsOpen]);
  useEffect(() => onMapWindowClaim(["units", "stranded", "fuel"], (owner) => {
    if (owner !== "investigation") setStrandedOpen(false);
    if (owner !== "incident") setFuelAlertsOpen(false);
    setUnitsOpen(false);
  }), [setUnitsOpen, setStrandedOpen, setFuelAlertsOpen]);
  useEffect(() => onMapWindowClaim("arrivals", () => setArrivalsOpen(false)), []);
  /* The investigation does not claim: it only ever opens from a Halted row,
     and Halted is already the newest window. It closes for anything else. */
  useEffect(() => onMapWindowClaim(["investigation", "stranded"], () => setInvestigateSubject(null)), []);

  const [cardMinimized, setCardMinimized] = useState(false);
  /** Which unit's camera window is open, if any. */
  const [cameraId, setCameraId] = useState(null);
  /** True when the camera window was opened from the Units list: then it is
   *  a window of its own, not an extension of the unit's card, and the card
   *  opening, moving on or closing leaves it alone. */
  const cameraDetachedRef = useRef(false);

  /**
   * The pinned card is a WINDOW, on the same primitive as the playback
   * transport and the incident window — draggable, clamped, and remembered.
   *
   * It opens at the pointer rather than at a dock: this card is about the
   * marker that was just clicked, so appearing beside it is the whole point.
   * A position the operator has dragged to still wins over that, because
   * moving a window is a statement about where they want it.
   *
   * `enabled` is the pin: while merely hovering, the node is positioned by the
   * pointer effect below instead, and the hook must not fight it for the same
   * inline styles.
   */
  const { ref: pinnedCardRef, onPointerDown: onCardPointerDown } = useFloatingWindow({
    id: "vehicle-card",
    enabled: Boolean(pinnedId),
    initial: lastPointerRef.current,
  });

  // A newly pinned unit gets an expanded card: the minimised state belongs to
  // the card that was folded away, not to the next question asked.
  useEffect(() => { if (pinnedId) setCardMinimized(false); }, [pinnedId]);
  // A camera window outlives its card otherwise, leaving a feed on screen for a
  // unit that is no longer selected and cannot be closed from the card.
  useEffect(() => {
    if (cameraDetachedRef.current) return;
    setCameraId(id => (id && id !== pinnedId ? null : id));
  }, [pinnedId]);

  const clearHover = useCallback(() => {
    hoveredIdRef.current = null;
    setHoveredId(null);
  }, []);


  // ADDED 2026-08-06: Trip Path overlay ─────────────────────────────────────
  const clearTripPath = useCallback(() => {
    // Drop any in-flight request FIRST, and unconditionally: the common case
    // for "no layer yet" is a fetch still running, and that is precisely the
    // one that would otherwise draw itself onto a map the user has moved on
    // from — a closed path that reappears a second later.
    tripTokenRef.current = null;
    const layer = tripLayerRef.current;
    if (!layer) return;
    for (const line of layer.lines ?? []) line.setMap(null);
    for (const m of layer.markers ?? []) m.setMap(null);
    tripLayerRef.current = null;
    setTripPathId(null);
  }, []);

  /**
   * The trip path's teardown half of the company switch above.
   *
   * Its polyline and dots are Google Maps objects held in a ref, not React
   * state, so clearing `tripPathId` during render removes nothing from the
   * map — the line would stay drawn over the new organisation's fleet with no
   * state left pointing at it, surviving every later clear. This also drops
   * `tripTokenRef`, so a request that was still in flight when the operator
   * switched cannot draw itself onto the new map when it lands.
   */
  useEffect(() => { clearTripPath(); }, [activeCompanyId, clearTripPath]);

  const showTripPath = useCallback((vehicleId) => {
    const map   = mapRef.current;
    const maps  = mapsLibRef.current;
    const DomMarker = DomMarkerRef.current;
    const v = vehiclesRef.current.find(x => x.id === vehicleId || x.vehicleId === vehicleId);
    if (!map || !maps || !DomMarker || !v || !orgId) return;

    // Not while a replay is running. The replay owns the map's history layer
    // for as long as it is open — it is drawing a path point by point, and a
    // finished twelve-hour path laid over that is the same double-draw the
    // replay button clears on the way in, arriving by a different door.
    // Same call the hover card already makes for the same reason
    // (see hoverSuppressed).
    if (playbackIdRef.current) return;

    // Toggle off if already showing for this vehicle
    if (tripPathId === vehicleId) { clearTripPath(); return; }
    clearTripPath();
    setTripPathId(vehicleId);

    const from = new Date(Date.now() - 12 * 3600_000).toISOString();
    const vId  = v.vehicleId;

    // Which request the map is currently waiting on.
    //
    // The layer is not built until the fetch resolves, so until then there is
    // nothing for clearTripPath to tear down: click one unit and then another
    // before the first lands and BOTH layers get drawn, with tripLayerRef
    // holding only the second. The first unit's dots and ticks are then
    // orphaned on the map with nothing left pointing at them — they survive
    // every subsequent clear, including the one on a map click. Same guard
    // showRoute uses for the same reason.
    const token = {};
    tripTokenRef.current = token;

    // Fetch track + fuel fillings + fuel thefts in parallel
    Promise.all([
      apiFetch(`/api/v1/organisations/${orgId}/vehicles/${vId}/track?from=${from}`),
      apiFetch(`/api/v1/organisations/${orgId}/fuel/fillings?vehicleId=${vId}&from=${from}`).catch(() => ({ data: [] })),
      apiFetch(`/api/v1/organisations/${orgId}/fuel/thefts?vehicleId=${vId}&from=${from}`).catch(() => ({ data: [] })),
    ]).then(([trackRes, fillRes, theftRes]) => {
      // Superseded or closed while we were fetching — draw nothing.
      if (tripTokenRef.current !== token) return;

      const track    = trackRes.data ?? trackRes;
      const points   = track?.points ?? [];
      const fillings = fillRes.data ?? [];
      const thefts   = theftRes.data ?? [];

      // When the key last came out, if it is still out — served by the track
      // endpoint off the same rows it builds the polyline from. This is what
      // decides whether the run has ENDED; see the end dot below.
      const engineOffSinceMs      = track?.engineOffSinceMs ?? null;
      const engineOffRunsPastWindow = Boolean(track?.engineOffRunsPastWindow);

      if (points.length < 2) return;

      // openTick: the one timestamp tick currently showing its stamp, if any.
      const layer = { lines: [], markers: [], openTick: null };
      tripLayerRef.current = layer;

      // ── Draw cyan path ───────────────────────────────────────────────────
      const segments = splitTrack(points);
      for (const seg of segments) {
        const line = new maps.Polyline({
          map,
          path:          seg,
          strokeColor:   '#00e5ff',
          strokeOpacity: 0.9,
          strokeWeight:  4,
          zIndex:        3,
        });
        layer.lines.push(line);
      }
      // Bridge whatever holes are left, so the run still reads as one journey.
      for (let i = 1; i < segments.length; i++) {
        const a = segments[i - 1][segments[i - 1].length - 1];
        const b = segments[i][0];
        layer.lines.push(gapConnector(maps, map, a, b, '#00e5ff', 2));
      }

      // ── Timestamp ticks ──────────────────────────────────────────────────
      // CHANGED 2026-08-08: the timestamp is per-triangle, and one at a time.
      //
      // Every ~12th fix used to draw a permanent plate carrying its timestamp
      // and speed. Twelve open plates is more ink than the line they annotate:
      // on a there-and-back run — most of them on this fleet — the outbound and
      // return legs sit on the same road, so the plates land on top of each
      // other and on the fuel and stop markers, and the path they are
      // describing becomes the hardest thing on the map to read.
      //
      // "When was it here?" is a question about ONE point, so it is answered
      // one point at a time. Each sample draws a direction triangle instead;
      // clicking a triangle opens its own timestamp beside it, clicking
      // another moves the answer there, and clicking the open one closes it.
      const TICK_MAX    = 28;  // ceiling on how many triangles a path carries
      const TICK_MIN_M  = 60;  // never two closer together than this
      const TICK_Z      = 4;
      const TICK_OPEN_Z = 9;   // clear of the stop (5) and endpoint (6) markers

      // Spaced by DISTANCE ALONG THE PATH, not by index. Index sampling puts
      // every tick of a two-hour stop on the same spot — a stack of triangles
      // on one pixel, which is the clutter this is meant to remove. Dividing
      // the run by TICK_MAX keeps a 40 km haul and a lap of the yard carrying
      // the same number of them.
      let pathM = 0;
      for (let i = 1; i < points.length; i++) pathM += metresBetween(points[i - 1], points[i]);
      const tickGapM = Math.max(TICK_MIN_M, pathM / TICK_MAX);

      const tickIdx = [];
      let sinceTick = 0;
      for (let i = 1; i < points.length; i++) {
        sinceTick += metresBetween(points[i - 1], points[i]);
        if (sinceTick < tickGapM) continue;
        sinceTick = 0;
        tickIdx.push(i);
      }

      /** Which way the vehicle was heading at `i`, in degrees from north. */
      const bearingAt = (i) => {
        const a = points[i - 1] ?? points[i];
        const b = points[i + 1] ?? points[i];
        const dLat = b.lat - a.lat;
        const dLng = (b.lng - a.lng) * Math.cos(points[i].lat * Math.PI / 180);
        if (!dLat && !dLng) return 0;
        return (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
      };

      // The track endpoint returns {t, lat, lng} only — no speedKmh — so a
      // fix's speed is the distance to its neighbour over the time between.
      const speedAt = (i) => {
        const a = points[i], b = points[i + 1] ?? points[i - 1];
        if (!b) return 0;
        const dt = Math.abs(b.t - a.t) / 1000;
        return dt > 0 ? (metresBetween(a, b) / dt) * 3.6 : 0;
      };

      const stamp = (ms) => {
        const d = new Date(ms), pad = n => String(n).padStart(2, '0');
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear()
             + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      };

      const tickHtml = (deg, ms, kmh, open) =>
        '<div class="tp-tick' + (open ? ' tp-tick--open' : '') + '">' +
          '<span class="tp-tick__arrow" style="transform:rotate(' + Math.round(deg) + 'deg)"></span>' +
          (open
            ? '<span class="tp-tick__bubble">' +
                '<span class="tp-tick__ts">' + stamp(ms) + '</span>' +
                '<span class="tp-tick__speed">' + Math.round(kmh) + ' km/h</span>' +
              '</span>'
            : '') +
        '</div>';

      for (const i of tickIdx) {
        const pt  = points[i];
        const deg = bearingAt(i);
        const kmh = speedAt(i);
        const m = new DomMarker({
          position: { lat: pt.lat, lng: pt.lng },
          html:     tickHtml(deg, pt.t, kmh, false),
          anchor:   'center',
          zIndex:   TICK_Z,
          onClick: () => {
            // Exactly one open at a time — the whole point is that the rest of
            // the route stays clean while you read this one.
            const prev = layer.openTick;
            if (prev) { prev.close(); layer.openTick = null; }
            if (prev?.marker === m) return;   // that click closed this one
            m.setHtml(tickHtml(deg, pt.t, kmh, true));
            m.setZIndex(TICK_OPEN_Z);
            layer.openTick = {
              marker: m,
              close: () => {
                m.setHtml(tickHtml(deg, pt.t, kmh, false));
                m.setZIndex(TICK_Z);
              },
            };
          },
        });
        m.setMap(map);
        layer.markers.push(m);
      }

      // CHANGED 2026-08-06: FuelFilling and FuelTheft have no lat/lng fields.
      // Match each event to the nearest track point by timestamp instead.
      const nearestPoint = (atMs) => {
        if (!points.length) return null;
        let best = points[0], bestDiff = Math.abs(points[0].t - atMs);
        for (const pt of points) {
          const diff = Math.abs(pt.t - atMs);
          if (diff < bestDiff) { best = pt; bestDiff = diff; }
        }
        return best;
      };

      // Fuel refill markers (green)
      for (const fill of fillings) {
        const atMs = fill.filledAt ? new Date(fill.filledAt).getTime() : null;
        const pos  = atMs ? nearestPoint(atMs) : null;
        if (!pos) continue;
        const ml   = fill.filledMl ?? fill.finalFuelLevelMl ?? null;
        const html = fuelPinHtml(ml, false, atMs);
        const m = new DomMarker({ position: { lat: pos.lat, lng: pos.lng }, html, anchor: 'center', zIndex: 5 });
        m.setMap(map);
        layer.markers.push(m);
      }

      // Fuel drain/theft markers (red)
      for (const theft of thefts) {
        const atMs = theft.beganAt ? new Date(theft.beganAt).getTime()
                   : theft.detectedAt ? new Date(theft.detectedAt).getTime() : null;
        const pos  = atMs ? nearestPoint(atMs) : null;
        if (!pos) continue;
        const ml   = theft.stolenMl ?? null;
        const html = fuelPinHtml(ml, true, atMs);
        const m = new DomMarker({ position: { lat: pos.lat, lng: pos.lng }, html, anchor: 'center', zIndex: 5 });
        m.setMap(map);
        layer.markers.push(m);
      }

      // ── Stop detection ───────────────────────────────────────────────────
      // A stop is where consecutive track points stay within STOP_RADIUS_M
      // metres for at least STOP_MIN_MS milliseconds.
      // We calculate speed from consecutive points (same as speed labels).
      // Speed < STOP_SPEED_KMH for >= STOP_MIN_MS = a stop event.
      // CHANGED 2026-08-06: Added stop markers to trip path.
      const STOP_SPEED_KMH = 2;    // below this = stationary
      const STOP_MIN_MS    = 120_000; // 2 minutes minimum to count as a stop
      const STOP_RADIUS_M  = 30;   // must stay within 30m

      function metersBetween(a, b) {
        const R = 6371000, rad = Math.PI / 180;
        const dLat = (b.lat - a.lat) * rad;
        const dLng = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
        return Math.sqrt(dLat * dLat + dLng * dLng) * R;
      }

      function fmtDuration(ms) {
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return mins + ' min';
        const h = Math.floor(mins / 60), m = mins % 60;
        return h + 'h ' + (m > 0 ? m + 'm' : '');
      }

      const stops = [];
      let stopStart = null;
      let stopAnchor = null;

      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const dt   = curr.t - prev.t;
        const dist = metersBetween(prev, curr);
        const spd  = dt > 0 ? (dist / (dt / 1000)) * 3.6 : 0;

        if (spd < STOP_SPEED_KMH && dist < STOP_RADIUS_M) {
          if (!stopStart) { stopStart = prev.t; stopAnchor = prev; }
        } else {
          if (stopStart && (prev.t - stopStart) >= STOP_MIN_MS) {
            stops.push({ lat: stopAnchor.lat, lng: stopAnchor.lng, startMs: stopStart, endMs: prev.t, dur: prev.t - stopStart });
          }
          stopStart = null; stopAnchor = null;
        }
      }
      // Catch stop at end of track
      if (stopStart) {
        const last = points[points.length - 1];
        if ((last.t - stopStart) >= STOP_MIN_MS) {
          stops.push({ lat: stopAnchor.lat, lng: stopAnchor.lng, startMs: stopStart, endMs: last.t, dur: last.t - stopStart });
        }
      }

      // ── The three dots ───────────────────────────────────────────────────
      // CHANGED 2026-08-08: a green dot (rippling) where the run began, amber
      // dots for the stops it drove away from, and a red dot where it ended.
      // Replaces a green START chip, a red END chip and red "STOP" octagons —
      // three shouty labels for what is really one scale of the same thing:
      // how long the unit stood there.
      const dotTime = (ms) => {
        const d = new Date(ms), pad = n => String(n).padStart(2, '0');
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
      };

      /** kind: 'start' | 'stop' | 'end'. `place` is filled in by geocode later. */
      function dotHtml(kind, atMs, detail, place, lat, lng) {
        const loc = place
          ? '<span class="tp-dot__place">' + place + '</span>'
          : (lat != null
              ? '<span class="tp-dot__place tp-dot__place--coords">' + lat.toFixed(4) + ', ' + lng.toFixed(4) + '</span>'
              : '');
        return (
          '<div class="tp-dot tp-dot--' + kind + '">' +
            '<span class="tp-dot__pin"></span>' +
            '<span class="tp-dot__tip">' +
              '<span class="tp-dot__time">' + dotTime(atMs) + '</span>' +
              '<span class="tp-dot__detail">' + detail + '</span>' +
              loc +
            '</span>' +
          '</div>'
        );
      }

      // The run ENDED only once the key has been out for an hour or more.
      //
      // Not "the track stopped here" — that is just where the window ran out,
      // and a unit taking a 20-minute break would have been captioned as having
      // finished for the day. Not "it stopped moving" either: a real ignition
      // line is fitted on 222 of 224 units, so idling at a loading bay is
      // visible as engine-on and is not the end of anything.
      const END_ENGINE_OFF_MS = 3600_000;
      const endedMs = engineOffSinceMs != null && Date.now() - engineOffSinceMs >= END_ENGINE_OFF_MS
        ? engineOffSinceMs
        : null;

      // A temporary stop is one the unit DROVE AWAY FROM. Anything still
      // standing when the key came out is the end, not a pause in the middle,
      // so it must not draw an amber dot underneath the red one.
      const tempStops = endedMs == null ? stops : stops.filter(s => s.endMs < endedMs);

      for (const stop of tempStops) {
        const detail = 'Stopped ' + fmtDuration(stop.dur);
        // Coordinates now, a place name when the geocode lands.
        const m = new DomMarker({
          position: { lat: stop.lat, lng: stop.lng },
          html: dotHtml('stop', stop.startMs, detail, null, stop.lat, stop.lng),
          anchor: 'center', zIndex: 5,
        });
        m.setMap(map);
        layer.markers.push(m);

        apiFetch(`/api/v1/reverse-geocode?lat=${stop.lat}&lng=${stop.lng}`)
          .then(res => {
            const place = res.data?.place ?? null;
            if (place && m.getMap()) m.setHtml(dotHtml('stop', stop.startMs, detail, place, stop.lat, stop.lng));
          })
          .catch(() => { /* keep the coords fallback */ });
      }

      // ── Start / End dots ─────────────────────────────────────────────────
      const startPt = points[0];
      const endPt   = points[points.length - 1];
      const startM = new DomMarker({
        position: { lat: startPt.lat, lng: startPt.lng },
        html: dotHtml('start', startPt.t, 'Journey start', null, startPt.lat, startPt.lng),
        anchor: 'center', zIndex: 6,
      });
      startM.setMap(map);
      layer.markers.push(startM);

      // No end dot while the unit is still out: an unfinished run has no end,
      // and drawing one at the last fix would be asserting it does.
      if (endedMs != null) {
        const offFor = fmtDuration(Date.now() - endedMs);
        const endM = new DomMarker({
          position: { lat: endPt.lat, lng: endPt.lng },
          html: dotHtml(
            'end', endedMs,
            'Engine off ' + (engineOffRunsPastWindow ? 'over ' : '') + offFor,
            null, endPt.lat, endPt.lng,
          ),
          anchor: 'center', zIndex: 6,
        });
        endM.setMap(map);
        layer.markers.push(endM);
      }

    }).catch(err => {
      console.warn('[FleetMap] trip path failed:', err);
      setTripPathId(null);
    });
  }, [orgId, tripPathId, clearTripPath]);

  // A marker's onClick is wired once, when the marker is created, and keeps
  // whatever closure it was born with. showTripPath is rebuilt on every
  // tripPathId change, so capturing it directly would freeze a marker's handler
  // at the identity it had on creation — the toggle would work once and then
  // compare against a tripPathId that stopped updating. The ref always holds
  // the current one.
  const showTripPathRef = useRef(null);
  useEffect(() => { showTripPathRef.current = showTripPath; }, [showTripPath]);
  // ── END Trip Path ─────────────────────────────────────────────────────────

  // Stable: it reads a ref, so it has no dependencies, and the playback
  // subscription lists it as one. Recreated each render it would tear down and
  // rebuild that subscription on every render — which is the cost the
  // subscription exists to avoid.
  const findVehicle = useCallback(
    (id) => vehiclesRef.current.find(v => v.id === id) ?? null, []);

  // ── route show/hide (created lazily per click, so composition changes can't
  // leave orphaned layers behind) ──────────────────────────────────────────
  const hideRoute = useCallback((id) => {
    const layers = routeLayerRef.current[id];
    if (layers) {
      // A track is drawn as one polyline PER continuous run, so this has to
      // clear them all — missing any would strand it on the map forever.
      for (const line of layers.routeLines ?? []) line.setMap(null);
      // The time marks along it go with it — one per reported minute, so
      // leaving them behind would bury the map under the last unit clicked.
      for (const m of layers.timeMarks ?? []) m.setMap(null);
      layers.depPin?.setMap(null);
      layers.destPin?.setMap(null);
    }
    delete routeLayerRef.current[id];
    setCovered((c) => (c?.id === id ? null : c));
  }, []);

  /**
   * Draw the vehicle's ACTUAL travelled track.
   *
   * This used to draw a planned A→B route from `leg.fromLat`/`leg.toLat` and
   * road-snap it via /road-path. Those fields came from the retired
   * simulator's `_sim.leg`; live Wialon frames carry no leg, so `hasRoute` was
   * false for every real vehicle and clicking a truck silently did nothing.
   *
   * There is no plan to draw for a live fleet — nothing tells us where a
   * vehicle is GOING. What we do have is where it has BEEN: its stored
   * telemetry. So the click now draws the recent track from real fixes, which
   * needs no route service and cannot be wrong about intent.
   */
  const showRoute = useCallback((id) => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    const DomMarker = DomMarkerRef.current;
    const v = findVehicle(id);
    if (!map || !maps || !DomMarker || !v || !orgId || !v.vehicleId) return;

    // Offline units, and online ones sitting parked, draw their track near-black
    // (see TRACK_IDLE_COLOR). Everything still moving keeps its status colour.
    const idle  = !v.online || vehicleActivity(v) === "parked";
    const color = idle ? TRACK_IDLE_COLOR : STATUS_COLORS[v.status];

    // Where the track window sits. Anchored on the last fix for a vehicle that
    // has gone quiet, so the line shows its final journey rather than an empty
    // "last 12 h" — see trackAnchorMs.
    const stale    = Number.isFinite(v.capturedAtMs)
                     && Date.now() - v.capturedAtMs > TRACK_WINDOW_H * 3600_000;
    const anchorMs = stale ? v.capturedAtMs : Date.now();

    // Placeholder so a second click can detect an in-flight request and so
    // hideRoute always has something to tear down.
    const layers = {
      routeLines: [], tailLine: null, timeMarks: [], openTick: null,
      depPin: null, destPin: null, token: {},
    };
    routeLayerRef.current[id] = layers;

    /** A pin carrying a message, when there is no line worth drawing. */
    const note = (position, text) => {
      layers.depPin = new DomMarker({ position, html: routePinHtml("dep", color, text), anchor: "center", zIndex: 2 });
      layers.depPin.setMap(map);
    };

    // Keyed by window as well as vehicle: a unit that goes quiet moves from
    // the live window to a last-fix one, and the cached line for the other
    // window is the wrong track, not a stale one.
    const cacheKey = `${v.vehicleId}:${stale ? anchorMs : 'live'}`;
    // Cached tracks EXPIRE. Without this, closing a route and reopening it ten
    // minutes later redrew the line as it was at the first click and then
    // extended from there, so the middle of the journey was simply missing.
    // A stale-window track (anchored on a last fix that is no longer moving)
    // never goes out of date, so only the live window is aged.
    const hit    = trackCacheRef.current.get(cacheKey);
    const fresh  = hit && (stale || Date.now() - hit.at < TRACK_CACHE_TTL_MS);
    const cached = fresh ? hit.track : null;
    if (hit && !fresh) trackCacheRef.current.delete(cacheKey);
    const draw = (track) => {
      // Bail if this route was closed, or superseded, while we were fetching.
      if (routeLayerRef.current[id] !== layers) return;

      const points = track.points ?? [];
      const here = Number.isFinite(v.lat) ? { lat: v.lat, lng: v.lng } : null;

      // "No fixes at all" and "sat still" are DIFFERENT, and saying "no
      // movement" for both is how a vehicle the map shows driving at 8 km/h
      // ended up captioned as parked — its last fix was five weeks old, so
      // there was simply nothing in the window. Say which it is.
      //
      // With the window anchored on the last fix, "nothing here" no longer
      // means "quiet lately" — it means this unit has no stored position at
      // all, so say that instead of blaming the window.
      if (points.length === 0) {
        const age = v.capturedAtMs ? `, last fix ${agoLabel(Date.now() - v.capturedAtMs)} ago` : "";
        if (here) note(here, `No stored track for this vehicle${age}`);
        return;
      }
      if (points.length === 1) {
        note(points[0], stale
          ? `One fix only, ${agoLabel(Date.now() - v.capturedAtMs)} ago`
          : `Stationary for the last ${TRACK_WINDOW_H} h`);
        return;
      }

      // One polyline per continuous run. Breaking on gaps is what stops the
      // track claiming a straight-line journey it has no fixes for.
      const segments = splitTrack(points);
      for (const seg of segments) {
        const line = new maps.Polyline({
          map,
          path: seg,
          strokeColor:   color,
          strokeOpacity: 0.85,
          strokeWeight:  3,
          zIndex: 1,
        });
        layers.routeLines.push(line);
        // The newest run: the one the live pass extends. NOT routeLines' last
        // entry, which is a gap connector whenever the track has a gap.
        layers.tailLine = line;
      }
      // Dotted across the stretches the unit went quiet for — see gapConnector.
      for (let i = 1; i < segments.length; i++) {
        const a = segments[i - 1][segments[i - 1].length - 1];
        const b = segments[i][0];
        layers.routeLines.push(gapConnector(maps, map, a, b, color, 0));
      }

      /**
       * The same time marks a replay draws, on the line a click draws.
       *
       * A track without them says where the unit went and nothing about when,
       * so the question that actually gets asked of it — "what time was it
       * here" — had only one answer: open playback and watch the day back.
       * `minuteMarks` reads the timestamps already on these points, drops the
       * minutes inside a reporting silence and collapses a stationary run to
       * one mark, so a parked hour costs one dot rather than sixty stacked on
       * the same pixel.
       *
       * All of them are shown at once, because a click track has no clock to
       * reveal them against — that difference, and nothing else, is what
       * separates this from the playback loop.
       */
      for (const mark of minuteMarks(points)) {
        const m = minuteMarker(DomMarker, {
          mark,
          plate:    v.id,
          features: () => zonesRef.current,
          maps:     () => mapsLibRef.current,
          state:    layers,
          // Under the track's own pins, above the line.
          zIndex:   2,
        });
        m.setMap(map);
        layers.timeMarks.push(m);
      }

      // Where the track starts. `truncated` means the scan cap was hit and the
      // earliest point is NOT the window start, so don't imply it is.
      const spanH = (track.lastAt - track.firstAt) / 3600_000;
      const gaps  = segments.length - 1;
      // A stale vehicle's track is history, and dating it is the difference
      // between "this is where it is working" and "this is where it stopped".
      const ended = stale ? ` · ended ${agoLabel(Date.now() - track.lastAt)} ago` : "";
      const label = [
        track.truncated
          ? "Track start (partial)"
          : `${stale ? "Last journey" : "Track start"} - ${spanH.toFixed(1)} h`,
        gaps > 0 ? `${gaps} reporting gap${gaps > 1 ? "s" : ""}` : null,
      ].filter(Boolean).join(" · ") + ended;

      layers.depPin = new DomMarker({
        position: points[0],
        html:     routePinHtml("dep", color, label),
        anchor:   "center",
        zIndex:   2,
      });
      layers.depPin.setMap(map);

      // How long it took vs how long it should have (operator, 2026-10-04).
      if (!ROUTE_TIMING_ENABLED) return;
      const journey = trackJourney(points);
      if (!journey) { setCovered({ id, plate: v.id, status: "nodrive" }); return; }
      if (!EXPECTED_AVAILABLE) { setCovered({ id, plate: v.id, status: "error", journey, error: "no TomTom key" }); return; }
      const ekey = `${v.vehicleId}:${journey.startMs}:${journey.endMs}`;
      const hitE = expectedCacheRef.current.get(ekey);
      if (hitE) { setCovered({ id, plate: v.id, status: "ok", journey, expected: hitE }); return; }
      setCovered({ id, plate: v.id, status: "loading", journey });
      fetchExpectedTime(journey, { travelMode: travelModeFor(v.vehicleType) })
        .then((expected) => {
          expectedCacheRef.current.set(ekey, expected);
          if (routeLayerRef.current[id] !== layers) return;
          setCovered({ id, plate: v.id, status: "ok", journey, expected });
        })
        .catch((err) => {
          if (routeLayerRef.current[id] !== layers) return;
          setCovered({ id, plate: v.id, status: "error", journey, error: err.message });
        });
    };

    if (cached) { draw(cached); return; }

    const from = new Date(anchorMs - TRACK_WINDOW_H * 3600_000).toISOString();
    apiFetch(`/api/v1/organisations/${orgId}/vehicles/${v.vehicleId}/track?from=${from}`)
      .then((res) => {
        // { points: [{t, lat, lng}] oldest-first, fixes, truncated, firstAt, lastAt }
        const track = res.data ?? { points: [] };
        trackCacheRef.current.set(cacheKey, { track, at: Date.now() });
        draw(track);
      })
      .catch((err) => {
        console.warn("[FleetMap] could not load the vehicle track:", err);
        if (routeLayerRef.current[id] !== layers) return;
        // Say so on the map. Failing silently left the click looking like a
        // no-op, which is indistinguishable from a vehicle with no track.
        if (Number.isFinite(v.lat)) note({ lat: v.lat, lng: v.lng }, "Could not load track");
      });
  }, [orgId, findVehicle]);

  const reIcon = useCallback((id, opts) => {
    const marker = markerMapRef.current[id];
    const v = findVehicle(id);
    if (!marker || !v) return;
    marker.setHtml(markerIconHtml(markerState(v), {
      moving:  Boolean(v.onRoad),
      heading: markerHeading(marker, v),
      sprite:  spriteKind(v),
      name:    mapLabel(v, labelCompanyRef.current),
      ...opts,
    }));
    marker._iconSig = null;   // force the next reconcile pass to re-evaluate
  }, [findVehicle]);

  /**
   * Show exactly ONE unit's route, or none.
   *
   * Two tracks over the same estate roads are two tangles of the same colour,
   * and the departure pins at their ends stop belonging to anything — which is
   * why this stayed single even once TRACKING went plural.
   *
   * The ref is what the reconcile pass reads (it must not rebuild when this
   * changes), and the state is what a control renders its own checked-ness
   * from. Written together, in one place, so the two cannot disagree — this is
   * now the only writer of activeRouteRef outside marker teardown.
   *
   * `draw: false` selects and highlights the unit WITHOUT its line. A click
   * on a marker is a selection, not a request for the day's track (operator,
   * 2026-10-02: clicking a unit "automatically displays the route path which
   * should not be the case"); the line is asked for explicitly, from the
   * units list's route switch or the card's Replay. So activeRouteRef is the
   * highlighted unit, and routeId (what the route switch shows) is set only
   * while its line is actually drawn.
   */
  const setActiveRoute = useCallback((id, { draw = true } = {}) => {
    const prev = activeRouteRef.current;
    if (prev && prev !== id) { hideRoute(prev); reIcon(prev, {}); }
    else if (prev && !draw) hideRoute(prev);
    if (id) {
      if (draw && !routeLayerRef.current[id]) showRoute(id);
      if (prev !== id) reIcon(id, { highlighted: true });
    }
    activeRouteRef.current = id;
    setRouteId(id && draw ? id : null);
  }, [hideRoute, showRoute, reIcon]);

  /** The same thing as a toggle, for a control that has an on/off state. */
  const toggleRoute = useCallback((id) => {
    const drawn = activeRouteRef.current === id && Boolean(routeLayerRef.current[id]);
    setActiveRoute(drawn ? null : id);
  }, [setActiveRoute]);

  // Clicking a MARKER is the one gesture that scopes the Live Feed to a unit.
  // A feed row, the search box and the units list all open the same detail
  // panel, but they leave the feed showing the whole fleet — see feedVehicleId
  // in AppContext.
  const handleMarkerClick = useCallback((id) => {
    const wasActive = activeRouteRef.current === id;
    setActiveRoute(wasActive ? null : id, { draw: false });
    if (wasActive) {
      // Clicking the same marker twice is the toggle-off gesture, so it hands
      // the feed back to the whole fleet as well.
      setFeedVehicleId(null);
      setPinnedId(null);
      return;
    }
    setSelectedVehicleId(id);
    setFeedVehicleId(id);
    // Pin the card where the click happened. It stops following the cursor
    // from here, so the Replay button inside it can actually be reached.
    // On every screen since 2026-10-15 (operator: "when I click on the unit
    // the unit card should be pinned"); it used to be phones and tablets only.
    // One card at a time still holds: a second unit replaces this one, and a
    // map window or the fuel alert window opening closes it (see openWindow
    // and the windowOpen effect).
    setPinnedId(id);
  }, [setActiveRoute, setSelectedVehicleId, setFeedVehicleId]);

  /**
   * Open a unit from the units list.
   *
   * Selection and the pinned card, and NOTHING else. Not the feed (a list row
   * is not a marker click), and not handleFocusVehicle — that isolates the map
   * to one unit, which is the opposite of what someone browsing a list of
   * tracked units is asking for.
   */
  // frameUnits is built further down, beside fitTo; read through a ref here.
  const frameUnitsRef = useRef(null);
  const handleOpenUnit = useCallback((id) => {
    setSelectedVehicleId(id);
    if (isCompactRef.current) setPinnedId(id);
    // Found in Units, opened: on the map and zoomed to it, in the same press
    // (operator, 2026-10-13). Not isolated - the rest of the fleet stays.
    const v = vehiclesRef.current.find(x => x.id === id);
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lng)) {
      frameUnitsRef.current?.([v]);
      setSearchedId(v.id);
      setTimeout(() => setSearchedId(null), 6000);
    }
  }, [setSelectedVehicleId]);

  /* Opening a fuel alert closes the unit's map card (operator, 28 Sep:
     "whenever I open the fuel alert modal then the unit card should disappear
     from the UI"). The alert window carries the unit's own card and the side
     panel opens beside it, so a card left pinned over the map was a third
     account of a unit — often a different one — under the window being
     worked. Hover cards already stand down while the window is up
     (hoverSuppressed); this is the pinned one, closed as its ✕ closes it,
     route highlight and all. */
  useEffect(() => {
    if (!windowOpen || !pinnedId) return;
    if (activeRouteRef.current === pinnedId) setActiveRoute(null);
    setPinnedId(null);
  // Only on the window opening: a unit clicked while it is up still pins
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowOpen]);

  // ── Route playback ────────────────────────────────────────────────────────
  const playbackVehicle = playbackId ? findVehicle(playbackId) : null;
  const {
    data: pbData, points: pbPoints, events: pbEvents, loading: pbLoading, error: pbError,
  } = useVehiclePlayback(orgId, playbackVehicle?.vehicleId, playbackId ? playbackDay : null);
  const pb = useRoutePlayback(pbPoints);
  // Pulled out so the draw effect below can list it as a dependency without
  // listing `pb`, whose identity changes on every render.
  const pbSubscribe = pb.subscribe;

  /**
   * The BUILD half: everything the replay will need, created once and revealed
   * by the clock. Rebuilt only when the day's points change.
   *
   * Split from the cursor effect below deliberately. Recreating 65 Polylines
   * every frame is what makes a playback stutter at high rates — Google
   * re-rasterises a line on every path write — and the same argument applies to
   * the markers here: they are built once and then only shown or hidden, never
   * constructed on a frame.
   *
   * Nothing here draws the route. A replay that paints the whole day the
   * instant it opens has already answered the question it exists to ask: you
   * can see where the unit went before it goes there, and the line stops being
   * a record of a journey and becomes a diagram of one. The trail in the
   * cursor effect below is the only thing that draws the path, and it draws it
   * as the unit travels it.
   */
  useEffect(() => {
    const map = mapRef.current, maps = mapsLibRef.current, DomMarker = DomMarkerRef.current;
    // `mapReady` is a dependency, not just a guard. Everything below is bound
    // to ONE map instance, and closing the map tears that instance down — so
    // without it a replay left open across a map close came back with its
    // polyline and every one of its markers still pointing at the dead map:
    // the panel kept running, the clock kept moving, and nothing drew. The
    // zone layers already take this dependency for the same reason.
    if (!mapReady || !map || !maps || !DomMarker || !playbackId || pbPoints.length === 0) return undefined;

    // `timed` holds everything the clock reveals — events and time ticks alike
    // — each with the moment it belongs to. One array, because the reveal rule
    // is identical for both and two loops would be two chances to disagree.
    // `trailT`: the moment the trail was last drawn to — see the cursor effect.
    const layers = { trail: [], trailT: -Infinity, timed: [], openTick: null };
    playbackLayerRef.current = layers;

    // NO second marker. The unit's OWN marker is what moves — a replay that
    // adds a ghost leaves two of the same machine on the map, one at a place it
    // was hours ago and one where it is standing now, and nothing on either
    // says which is which. The live reconcile pass yields position for this
    // vehicle while playback is up (see playbackIdRef there), so the two never
    // write to it at once.
    const marker = markerMapRef.current[playbackId];
    if (marker) {
      // Cancel any live glide still in flight, or it will keep walking the
      // marker toward the live fix underneath the playback writes.
      marker._tween = null;
      marker.setPosition({ lat: pbPoints[0].lat, lng: pbPoints[0].lng });
    }

    /**
     * WHERE the day's events happened, pinned onto the line they happened on.
     *
     * Placed by TIME, not by coordinates — no event source on this fleet
     * records a position (fuel_fillings.location is free text, notifications
     * has no lat/lng at all), so the position is interpolated from the very
     * track being drawn. That is better than a stored coordinate would be: the
     * pin lands ON the line, and the two can never disagree about where the
     * unit was.
     *
     * `inGap` events are dropped rather than drawn at the edge of a silence.
     * sampleAt holds the last known position across a reporting hole, so a
     * pin there would claim a place for something we only know the time of.
     */
    const lastT = pbPoints[pbPoints.length - 1]?.t ?? 0;
    for (const ev of pbEvents) {
      if (!DRAWN_EVENT_KINDS.has(ev.kind)) continue;
      const at = sampleAt(pbPoints, ev.t);
      if (!at || at.inGap) continue;

      const m = new DomMarker({
        position: { lat: at.lat, lng: at.lng },
        html: eventMarkerHtml(ev, lastT),
        anchor: "center",
        // Above the trail and the ticks, below the unit itself — the machine
        // being replayed must never be hidden by a pin about it.
        zIndex: 4,
      });
      // NOT put on the map here. A pin that is already standing there when the
      // replay opens says the drain has happened; it has not, and at 09:00 on
      // a day whose drain was at 16:20 that is simply false. It goes up when
      // the cursor reaches it.
      layers.timed.push({ marker: m, t: ev.t, shown: false });
    }

    /**
     * WHEN the unit was at a point on the line, and how fast it was going.
     *
     * A direction triangle per sample; clicking one opens its own timestamp
     * and speed beside it, clicking another moves the answer there. The same
     * device the static trip path uses (see TICK_MAX there) and deliberately
     * the same CSS, so the two read as one idea in two places.
     *
     * Two differences from the trip-path version, both improvements this data
     * allows: the bearing is the fix's OWN recorded heading rather than one
     * inferred from its neighbours, and the speed is the fix's own `spd` in
     * km/h rather than distance-over-time between samples. The playback
     * endpoint sends both on every point and until now the client rendered
     * neither.
     *
     * Spaced by DISTANCE ALONG THE PATH, not by index: index spacing puts
     * every tick of a two-hour stop on one pixel, which is a stack of
     * triangles where the unit did not move.
     */
    const TICK_MAX    = 28;
    const TICK_MIN_M  = 60;
    const TICK_Z      = 3;
    const TICK_OPEN_Z = 9;

    let pathM = 0;
    for (let i = 1; i < pbPoints.length; i++) pathM += metresBetween(pbPoints[i - 1], pbPoints[i]);
    const tickGapM = Math.max(TICK_MIN_M, pathM / TICK_MAX);

    let sinceTick = 0;
    for (let i = 1; i < pbPoints.length; i++) {
      sinceTick += metresBetween(pbPoints[i - 1], pbPoints[i]);
      if (sinceTick < tickGapM) continue;
      sinceTick = 0;

      const pt = pbPoints[i];
      // A tick inside a silence would claim a place for a time we only know
      // the clock of — the same reason event pins skip gaps.
      if (pt.gapBefore) continue;

      const deg = Number.isFinite(pt.hdg) ? pt.hdg : 0;
      const kmh = Number.isFinite(pt.spd) ? pt.spd : null;
      const m = new DomMarker({
        position: { lat: pt.lat, lng: pt.lng },
        html:     playbackTickHtml(deg, pt.t, kmh, false),
        anchor:   "center",
        zIndex:   TICK_Z,
        onClick: () => {
          // Exactly one open at a time — the point of a tick is that the rest
          // of the route stays clean while you read this one.
          const prev = layers.openTick;
          if (prev) { prev.close(); layers.openTick = null; }
          if (prev?.marker === m) return;   // that click closed this one
          m.setHtml(playbackTickHtml(deg, pt.t, kmh, true));
          m.setZIndex(TICK_OPEN_Z);
          layers.openTick = {
            marker: m,
            close: () => {
              m.setHtml(playbackTickHtml(deg, pt.t, kmh, false));
              m.setZIndex(TICK_Z);
            },
          };
        },
      });
      layers.timed.push({ marker: m, t: pt.t, shown: false, tick: true });
    }

    /**
     * A dot for every minute the unit was reporting, and a card behind each.
     *
     * The ticks above are spaced by DISTANCE and answer "how fast along here".
     * These are spaced by TIME and answer "where was it at 13:07" — a question
     * a distance-spaced mark cannot answer at all on a unit that spent the
     * hour standing still.
     *
     * `minuteMarks` drops the minutes inside a reporting silence and collapses
     * a stationary run to one mark, so a parked hour costs one dot rather than
     * sixty stacked on the same pixel. Measured on a moving unit that keeps a
     * day to a few hundred.
     *
     * The dot itself is `minuteMarker`, shared with the click track — see
     * there for why the card is built on click. All this loop adds is that the
     * replay reveals them on the clock rather than all at once.
     */
    const plate = vehiclesRef.current.find(
      (x) => x.id === playbackId || x.vehicleId === playbackId,
    )?.id ?? playbackId;

    for (const mark of minuteMarks(pbPoints)) {
      const m = minuteMarker(DomMarker, {
        mark,
        plate,
        features: () => zonesRef.current,
        maps:     () => mapsLibRef.current,
        state:    layers,
        // Under the event pins and the unit, above the trail: a minute dot is
        // the most numerous thing here and the least urgent.
        zIndex:   2,
      });
      layers.timed.push({ marker: m, t: mark.t, shown: false, minute: true });
    }

    const bounds = new maps.LatLngBounds();
    for (const p of pbPoints) bounds.extend({ lat: p.lat, lng: p.lng });
    fitMapToBounds(map, maps, bounds);

    return () => {
      for (const l of layers.trail) l.setMap(null);
      for (const e of layers.timed) e.marker.setMap(null);
      playbackLayerRef.current = null;
      // Hand the marker back to the live fix, rather than leaving it parked
      // wherever the replay was stopped until the next SSE frame happens to
      // arrive — which on a quiet unit can be minutes.
      const m = markerMapRef.current[playbackId];
      const live = vehiclesRef.current.find(x => x.id === playbackId);
      if (m && live && Number.isFinite(live.lat)) {
        m._tween = null;
        m.setPosition({ lat: live.lat, lng: live.lng });
      }
    };
  }, [playbackId, pbPoints, pbEvents, mapReady]);

  /**
   * The MOVING half, driven by the cursor.
   *
   * Only the run currently being travelled changes shape, so completed runs
   * keep the path they were given and just the last one is rewritten. That is
   * what keeps this O(1) per frame instead of O(runs) — a day can hold 64
   * silences, and rewriting 65 paths at 60 fps is a slideshow.
   */
  useEffect(() => {
    if (!playbackId || !pbPoints.length) return undefined;

    /**
     * SUBSCRIBED, not re-rendered.
     *
     * This used to depend on `pb.cursor`, which is React state that moved 60
     * times a second — so a playing track re-rendered this 3,200-line component
     * and its unmemoised MapOverlay child on every frame, feed list and vehicle
     * cards included. Everything below writes straight to Google's overlay, so
     * none of it ever needed a render; it needed the number.
     */
    return pbSubscribe((t, sample) => {
      const map = mapRef.current, maps = mapsLibRef.current;
      const layers = playbackLayerRef.current;
      if (!map || !maps || !layers || !sample) return;

      const runs = travelledTo(pbPoints, t);

      // Seeking BACKWARD drops runs, so retire any the cursor no longer reaches.
      while (layers.trail.length > runs.length) layers.trail.pop().setMap(null);

      // On an ordinary frame only the leading edge moves. A seek either way,
      // or a new run starting, can change the runs before it too — a jump
      // forward left the run it jumped out of drawn only as far as it had got
      // — so those frames rewrite every run. Rare, so still O(1) per frame.
      const rewriteAll = t < layers.trailT || runs.length !== layers.trail.length;
      layers.trailT = t;
      for (let i = 0; i < runs.length; i++) {
        if (!layers.trail[i]) {
          layers.trail[i] = new maps.Polyline({
            map, path: runs[i], strokeColor: "#38bdf8", strokeOpacity: 0.95, strokeWeight: 4, zIndex: 2,
          });
        } else if (rewriteAll || i === runs.length - 1) {
          layers.trail[i].setPath(runs[i]);
        }
      }

      /**
       * Reveal what has happened by now, and un-reveal what has not.
       *
       * A linear pass over a few hundred entries per frame, which is nothing —
       * but `setMap` is not, so it is called only on the frames where a marker
       * actually crosses the cursor. `shown` is what makes that true.
       *
       * Against the CURSOR, so a rewind starts the day again from scratch:
       * the trail, pins, ticks and minute dots all go back with it and come
       * up again as the replay reaches them. Keeping the markers to the
       * furthest point reached was tried 2026-10-02 and reverted the same
       * day — dots and arrows standing on the map with no line under them
       * read as the path half-cleared, not as information kept.
       */
      syncReveal(layers.timed, t, (e, due) => {
        e.marker.setMap(due ? map : null);
        // A tick hidden while its bubble was open must not keep the
        // one-open-at-a-time slot, or the next click closes nothing.
        if (!due && layers.openTick?.marker === e.marker) {
          layers.openTick.close();
          layers.openTick = null;
        }
      });

      // The unit's own marker, moved along its recorded day.
      const marker = markerMapRef.current[playbackId];
      if (!marker) return;
      marker.setPosition({ lat: sample.lat, lng: sample.lng });

      /**
       * The FRAME, and the record of it that stops the live pass undoing it.
       *
       * setTruckFrame rather than setHtml: rewriting innerHTML restarts the
       * sprite's CSS animations, so at 50x the marker flickered on every frame
       * instead of turning.
       *
       * `_headingFrame` has to be written too. The reconcile pass compares it
       * against the LIVE heading and calls setTruckFrame whenever they differ —
       * so leaving it stale meant every pass snapped the sprite back to where
       * the unit is pointing now, in the middle of a replay of where it was
       * pointing this morning. Position was guarded against that pass from the
       * start; the frame was not.
       *
       * A null heading keeps the frame the marker already has rather than
       * falling back to 0, which is a real direction (due north) and would spin
       * a parked unit to face it.
       */
      const v = findVehicle(playbackId);
      const mstate = markerState(v ?? {}, alertOptsRef.current);
      const hdg = Number.isFinite(sample.hdg) ? sample.hdg : null;
      const frame = hdg == null ? marker._headingFrame : truckFrame(hdg);
      if (hdg != null && marker._headingFrame !== frame) {
        marker.setTruckFrame(mstate, hdg);
        marker._headingFrame = frame;
      } else if (marker._playbackState !== mstate) {
        marker.setTruckFrame(mstate, hdg ?? 0);
      }
      marker._playbackState = mstate;
    });
    // `mapReady` for the same reason the build effect takes it, plus one of its
    // own: when that effect rebuilds, it hands back a layer whose markers are
    // all `shown: false`, and only a frame can reveal them. A PAUSED replay
    // produces no frames, so without re-subscribing here the map stays empty
    // until the user happens to press play — the layer is rebuilt and nothing
    // draws. Both effects have to turn over together.
  }, [pbSubscribe, pbPoints, playbackId, findVehicle, mapReady]);

  /** Silences with their spans, for the ticks under the scrubber. */
  const pbGapSpans = useMemo(() => gapsOf(pbPoints), [pbPoints]);

  /**
   * The supplementary layers, for the menu in the map's control rail.
   *
   * ONE description of a layer — its switch, its state and its key together —
   * instead of the button in one place and the key in another saying the same
   * word. See MapLayersMenu for why that stopped being two things.
   *
   * Membership is gated on the org HAVING the layer, never on the toggle: an
   * org with no zone geometry is offered no switch rather than a switch that
   * draws nothing. (The KEY is gated on the toggle, inside the menu.) The
   * org-reset effect runs after the render that follows a company switch, so on
   * that one frame `showZones` is still true while the new org's geometry is
   * already gone — long enough to flash Kasulu's key over Sukari's map.
   */
  // Publish layers to context so SidePanel can render them
  const mapLayers = useMemo(() => {
    const out = [];
    // MapLayersMenu already hides itself on an empty list, so withholding the
    // entries removes the control rather than leaving a dead button.
    if (!canDo("map:layers")) return out;
    // The scales. Offered where the ORGANISATION has any: the server scopes the
    // feed to the yards this fleet weighs in, so the switch appears where
    // weighbridges exist without an org name being written down here.
    if (hasBridges) {
      out.push({
        id: "bridges",
        label: "All Weighbridges",
        on: showBridges,
        onToggle: () => {
          bridgeRequestedRef.current = !showBridges;
          writeMapPrefs(activeCompanyId, { layers: { bridges: !showBridges } });
          setShowBridges(v => !v);
        },
        note: bridgesLoading && !hasBridges ? "loading…" : null,
        legend: [{ key: "weighing", color: (ZONE_STYLE.weighing ?? ZONE_FALLBACK).color,
                   label: "Weighbridge" }],
        hint: "Hover a scale for its last ticket · click to keep it open",
      });
    }
    // One switch per survey. An org with two places worth drawing gets two
    // rows here, each naming its own place, because "Site plan" on a company
    // that runs two mills names neither of them.
    for (const plan of sitePlans) {
      const status = siteStatus[plan.id] ?? "idle";
      const here = plan.occupants?.length ?? 0;
      out.push({
        id: `site:${plan.id}`,
        label: plan.label,
        on: Boolean(siteOn[plan.id]),
        onToggle: () => setSiteOn(prev => {
          const next = !prev[plan.id];
          // A toggle is a request; the default is not. Set before the state
          // change so the draw effect it triggers already sees it.
          siteSlot(plan.id).requested = next;
          // A GUEST carries no prefKey and is never persisted. The visit is
          // what put the row here; when it ends the row goes, and a stored
          // preference would outlive the thing it was a preference about.
          if (plan.prefKey) writeMapPrefs(activeCompanyId, { layers: { [plan.prefKey]: next } });
          return { ...prev, [plan.id]: next };
        }),
        // A visitor says so, and says why it is here. Without the count the
        // row is another tenant's place appearing in this org's list with no
        // explanation — which reads as a bug rather than as an answer.
        note: status === "loading" ? "loading…"
          : status === "error" ? "failed"
          : plan.guest ? (here === 1 ? "1 unit here" : `${here} units here`)
          : null,
        // Its own categories, not the geofence layer's — the site plan and the
        // org's fences are different collections and need not agree about what
        // is on them. Same colour table, so where they do agree they match.
        //
        // `weighing` is dropped ONLY where the Weighbridges layer is actually
        // drawing scales here; otherwise the survey's weighbridge is the only
        // one on this map and the key has to name it. Same condition as the
        // style rule that decides whether the pin draws at all.
        legend: legendFor((siteCats[plan.id] ?? [])
          .filter(c => !(c === "weighing" && hasBridges)), baseMap),
        hint: plan.guest
          ? "Another organisation's survey, shown while your units are inside it"
          : "Names appear as you zoom in · click a place for detail",
      });
    }
    if (zonesAllowed && hasZones) {
      out.push({
        id: "zones",
        // "Estate areas", not "Geofences": an operator navigates by the ground,
        // and what these rows are to the violation engine is not what they are
        // on a map.
        label: "Estate areas",
        on: showZones,
        onToggle: () => setShowZones(v => {
          zonesRequestedRef.current = !v;
          writeMapPrefs(activeCompanyId, { layers: { zones: !v } });
          return !v;
        }),
        note: null,
        legend: legendFor(zoneCategories, baseMap),
        hint: "Names appear as you zoom in, smaller zones need a closer look · click a zone for detail",
      });
    }
    if (planAllowed) {
      out.push({
        id: "plan",
        label: "Planting plan",
        on: showPlan,
        onToggle: () => setShowPlan(v => {
          planRequestedRef.current = !v;
          writeMapPrefs(activeCompanyId, { layers: { plan: !v } });
          return !v;
        }),
        note: planState === "loading" ? "loading…" : planState === "error" ? "failed" : null,
        legend: PLAN_LEGEND.map(key => ({ key, color: PLAN_STYLE[key].color, label: PLAN_LABEL[key] })),
        hint: null,
      });
    }
    // Live traffic is a property of the roads, not of the org, so every org
    // with a key configured is offered it.
    if (LIVE_TRAFFIC_AVAILABLE) {
      out.push({
        id: "traffic",
        label: "Live traffic",
        on: showTraffic,
        onToggle: () => setShowTraffic(v => {
          writeMapPrefs(activeCompanyId, { layers: { traffic: !v } });
          return !v;
        }),
        note: null,
        legend: GOOGLE_TRAFFIC_LEGEND,
        hint: "Google live traffic · click a unit on a trip for its route and traffic-adjusted ETA",
      });
    }
    // Weather, like traffic, belongs to the ground rather than the org.
    out.push({
      id: "weather",
      label: "Weather",
      on: showWeather,
      onToggle: () => setShowWeather(v => {
        writeMapPrefs(activeCompanyId, { layers: { weather: !v } });
        return !v;
      }),
      note: showWeather ? weatherNote : null,
      legend: null,
      hint: "Google current weather · falling rain, wind waves, storms with lightning",
    });
    return out;
  }, [showTraffic, showWeather, weatherNote, showBridges, hasBridges, bridgesLoading, activeCompanyId,
      showZones, zonesAllowed, hasZones, zoneCategories,
      showPlan, planAllowed, planState,
      sitePlans, siteOn, siteStatus, siteCats, canDo, baseMap]);

  /**
   * The units carrying an open fuel incident, for the alerts menu.
   *
   * Off the live snapshot, which already carries `fuelIncident` on every
   * vehicle — no request, no second source that could disagree with the red
   * markers about who is flagged. Sorted by volume so the worst is first;
   * measured on the live fleet, 28 of 815 units qualified.
   */
  const flaggedVehicles = useMemo(
    // FuelAlertsMenu renders nothing on an empty list, so withholding the
    // vehicles removes the control — no dead button, and no count in the badge
    // hinting at incidents this account is not shown.
    () => (canDo("map:fuel_alerts")
      ? vehicles
          .filter(v => v.fuelIncident)
          .sort((a, b) => (b.fuelIncident.volumeMl ?? 0) - (a.fuelIncident.volumeMl ?? 0))
      : []),
    [vehicles, canDo],
  );

  /**
   * Units that were in transit and have now been standing still too long.
   *
   * The clock is a state value here rather than a Date.now() inside the
   * predicate, because this is the one list that changes with NO new
   * telemetry: a unit that stopped nine minutes ago becomes flagged while
   * nothing at all is reported about it. Thirty seconds is fine granularity
   * for a ten-minute threshold and cheap — the tick feeds this memo, and the
   * marker reconcile pass does not list it, so an idle fleet does not repaint.
   *
   * Same withholding as flaggedVehicles above: no permission, no list, so the
   * funnel shows no section and no count rather than a badge hinting at units
   * this account is not shown.
   */
  const nowTick = useNowTick(30_000);
  /**
   * Containment, from the estate geometry this component already has.
   *
   * The same FeatureCollection the map draws as the Estate areas layer, which
   * is every geofence the org owns — the ones imported from Wialon and the ones
   * configured here, since they are one table. Memoised on the geometry alone:
   * it is fetched once per org and never polled, so this rebuilds on a company
   * switch and at no other time.
   */
  const insideZone = useMemo(() => zoneTestFor(zones), [zones]);

  const strandedVehicles = useMemo(
    () => (canDo("map:filter")
      ? vehicles
          .map(v => ({ vehicle: v, why: strandedStop(v, nowTick, { insideZone }) }))
          .filter(r => r.why)
          // Longest stranded first: the machine that stopped two hours ago is
          // the one somebody needs to hear about.
          .sort((a, b) => b.why.forMs - a.why.forMs)
      : []),
    [vehicles, nowTick, canDo, insideZone],
  );

  /* Out to the sidebar's Fleets tree.
   *
   * The test needs `insideZone`, which needs the estate geometry, which only
   * this component has fetched — so the list is computed here and published,
   * the same direction `mapLayers` travels. The panel renders it; it does not
   * re-derive it, because a second implementation of "stranded" is a second
   * answer to a question the operator asks once. */
  useEffect(() => { publishStranded(strandedVehicles); }, [strandedVehicles, publishStranded]);

  /**
   * A replay starts with the replay window alone on screen.
   *
   * The unit's map card is closed wherever Playback was pressed: it sat over
   * the track being replayed and said the same things about the unit. The
   * details panel closes too where it is a sheet over the map (below 1024);
   * on a desktop it is a column beside the map, covers nothing, and stays.
   */
  const closeCardsForReplay = useCallback(() => {
    setPinnedId(null);
    if (isCompact) setSelectedVehicleId(null);
  }, [isCompact, setSelectedVehicleId]);

  const closePlayback = useCallback(() => {
    setPlaybackId(null);
    setPlaybackDay(todayFleetDay());
  }, []);

  // ── create the map shell ONCE ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    loadMapEngine().then((maps) => {
      if (cancelled || mapRef.current || !mapContainerRef.current) return;

      // Pin the exact namespace the map was built with. Everything downstream
      // (markers, bounds, overlays) must come from THIS copy.
      mapsLibRef.current  = maps;
      DomMarkerRef.current = makeDomMarkerClass(maps);

      const map = new maps.Map(mapContainerRef.current, {
        center:      DEFAULT_CENTER,
        zoom:        7,
        // ── CHANGED 2026-08-05: minZoom lowered from 6 → 1 (maximum zoom-out)
        // restriction removed — it was capping how far the user could zoom out
        // and pan, even with strictBounds: false. Removing it allows full
        // world-level zoom-out with no pan boundaries.
        minZoom:     1,
        // CHANGED 2026-08-05: maxZoom raised from 18→21 to allow zooming in
        // close enough to see individual vehicles in the yard.
        maxZoom:     21,
        // Scroll wheel zooms without a modifier, matching the old behaviour.
        gestureHandling:    "greedy",
        // Every built-in control anchors to an EDGE of the map div, and on this
        // screen all four edges are covered: MapOverlay pins a 336px panel down
        // the left and a 340px panel down the right, both full-height at
        // z-index 400, and the footer nav is fixed across the bottom 64px at
        // z-index 1000. RIGHT_BOTTOM — where zoom and the camera widget were —
        // is the worst of them, buried under the right panel's cards whenever
        // they run long enough to reach it. There is no ControlPosition that
        // lands in the free centre column, so the map draws its own zoom and
        // camera-reset buttons instead (.map-cam-controls below), placed clear
        // of both rails and the footer. Gestures are untouched: scroll-zoom,
        // drag-pan and ctrl-drag rotate all still work.
        zoomControl:        false,
        cameraControl:      false,
        mapTypeControl:     false,
        streetViewControl:  false,
        fullscreenControl:  false,
        rotateControl:      false,
        // CHANGED 2026-08-05: enabled so operator can see current zoom level.
        // CHANGED 2026-10-04: off again — MapStatusBar draws a km + mi scale
        // in the free centre column instead (operator's screenshot).
        scaleControl:       false,
        keyboardShortcuts:  false,
        clickableIcons:     false,
        tilt:               0,
      });

      // OpenStreetMap, recoloured — the only base map (lib/osmBase).
      installOsmBase(maps, map);
      map.setMapTypeId(OSM_TYPE_ID);

      // Clicking/tapping empty map clears the active route + highlight AND
      // dismisses the hover card (touch devices never fire mouseleave). The
      // trip path goes with the route: both are drawn by the same marker
      // click, so the deselect gesture has to take both away or the annotated
      // line is left behind describing a unit that is no longer selected.
      map.addListener("click", () => {
        // The ruler owns clicks while it is on (see the measure effect).
        if (measuringRef.current) return;
        clearHover();
        clearTripPath();
        const prevId = activeRouteRef.current;
        if (!prevId) return;
        hideRoute(prevId);
        reIcon(prevId, {});
        activeRouteRef.current = null;
        setRouteId(null);
        // Tapping empty map is a deselect, so the feed goes back to the fleet.
        setFeedVehicleId(null);
      });

      // Pan/zoom dismisses the hover card too — it's pinned at fixed screen
      // coordinates and would float detached from its marker.
      map.addListener("dragstart", clearHover);
      map.addListener("zoom_changed", clearHover);

      // Keep the shared cull rectangle current. Computed once per viewport
      // change here rather than per marker per frame inside draw(): the bounds
      // are identical for all 224 markers, and projecting them 224 times a
      // frame is exactly the kind of work that makes zooming stutter.
      const CULL_MARGIN_PX = 160;
      const MarkerClass = DomMarkerRef.current;
      const refreshViewport = () => {
        const overlay = viewportProbeRef.current;
        const proj = overlay?.getProjection?.();
        const bounds = map.getBounds();
        if (!proj || !bounds) { MarkerClass._viewport = null; return; }
        const ne = proj.fromLatLngToDivPixel(bounds.getNorthEast());
        const sw = proj.fromLatLngToDivPixel(bounds.getSouthWest());
        if (!ne || !sw) { MarkerClass._viewport = null; return; }
        MarkerClass._viewport = {
          minX: Math.min(sw.x, ne.x) - CULL_MARGIN_PX,
          maxX: Math.max(sw.x, ne.x) + CULL_MARGIN_PX,
          minY: Math.min(sw.y, ne.y) - CULL_MARGIN_PX,
          maxY: Math.max(sw.y, ne.y) + CULL_MARGIN_PX,
        };
      };

      // An OverlayView of our own purely to borrow a projection — the map does
      // not expose one otherwise.
      const probe = new maps.OverlayView();
      probe.onAdd = () => {};
      probe.draw  = () => { refreshViewport(); };
      probe.onRemove = () => {};
      probe.setMap(map);
      viewportProbeRef.current = probe;
      map.addListener("idle", refreshViewport);

      mapRef.current = map;
      setMapReady(true);
    }).catch((err) => {
      console.error("[FleetMap] failed to load the map library:", err);
      if (!cancelled) setMapLibError(err);
    });

    return () => {
      cancelled = true;
      for (const m of Object.values(markerMapRef.current)) m.setMap(null);
      for (const layers of Object.values(routeLayerRef.current)) {
        for (const line of layers.routeLines ?? []) line.setMap(null);
        layers.depPin?.setMap(null);
        layers.destPin?.setMap(null);
      }
      viewportProbeRef.current?.setMap(null);
      viewportProbeRef.current = null;
      if (DomMarkerRef.current) DomMarkerRef.current._viewport = null;
      markerMapRef.current  = {};
      routeLayerRef.current = {};
      activeRouteRef.current = null;
      fittedCompanyRef.current = null;
      mapRef.current = null;
      setMapReady(false);
    };
  }, [hideRoute, reIcon, clearHover, clearTripPath, setFeedVehicleId]);

  // Publish layers to context whenever they change — must be in useEffect, not render
  useEffect(() => {
    publishLayers(mapLayers);
  }, [mapLayers, publishLayers]);

  // Fit the map to a set of vehicles — to where the fleet WORKS, not to the
  // convex hull of every last fix. See FIT_CORE_SHARE and FIT_MAX_ZOOM.
  // The zoom cap a fit leaves for the map's next settle. One at a time, and
  // dropped by frameUnits: a cap left over from the opening fit used to pull a
  // unit just framed at FOCUS_ZOOM back out to FIT_MAX_ZOOM.
  const fitCapRef = useRef(null);
  const dropFitCap = useCallback(() => {
    mapsLibRef.current?.event.removeListener(fitCapRef.current);
    fitCapRef.current = null;
  }, []);

  const fitTo = useCallback((located, { animate = false } = {}) => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!map || !maps || located.length === 0) return false;
    dropFitCap();

    const bounds = new maps.LatLngBounds();
    for (const v of fleetCore(located)) bounds.extend({ lat: v.lat, lng: v.lng });
    if (bounds.isEmpty()) return false;

    map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
    // CHANGED 2026-08-06: only clamp if fitBounds zooms in TOO CLOSE (e.g.
    // single vehicle). Do NOT clamp if it zooms out — that means the fleet
    // is spread across a large area and the zoom is correct. This lets Kasulu
    // (spread across Tanzania) and Sukari (concentrated in one yard) both get
    // the right opening zoom automatically.
    fitCapRef.current = maps.event.addListenerOnce(map, "idle", () => {
      fitCapRef.current = null;
      if (map.getZoom() > FIT_MAX_ZOOM) map.setZoom(FIT_MAX_ZOOM);
    });
    void animate;
    return true;
  }, [dropFitCap]);

  /**
   * Bring the camera to units the operator picked (operator, 2026-10-13: a
   * unit found in Units should be "rendered on the map and zoomed in to the
   * unit"; several picked "close to each other" are focused together, and
   * ones far apart are clustered, for the operator to break up if they wish).
   *
   * One unit, or several on one spot: to it at FOCUS_ZOOM, as a search does.
   * Several: every one of them framed - not fitTo's core, which drops a
   * quarter of the fleet as tail; a picked unit is never tail - at no closer
   * than FOCUS_ZOOM. Far apart, that frame is wide, and the cluster pass
   * groups the ones near each other into badges; a badge click zooms in on
   * its members (the existing cluster click), which is the "decluster".
   */
  const frameUnits = useCallback((located) => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!map || !maps || located.length === 0) return false;
    dropFitCap();
    fittedCompanyRef.current = activeCompanyId;   // the camera is the operator's now
    pendingFitRef.current = false;

    const bounds = new maps.LatLngBounds();
    for (const v of located) bounds.extend({ lat: v.lat, lng: v.lng });
    const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
    if (located.length === 1 || metresBetween({ lat: ne.lat(), lng: ne.lng() }, { lat: sw.lat(), lng: sw.lng() }) < 30) {
      map.setView({ lat: located[0].lat, lng: located[0].lng }, FOCUS_ZOOM);
      return true;
    }
    map.fitBounds(bounds, { top: 80, right: 80, bottom: 80, left: 80 });
    fitCapRef.current = maps.event.addListenerOnce(map, "idle", () => {
      fitCapRef.current = null;
      if (map.getZoom() > FOCUS_ZOOM) map.setZoom(FOCUS_ZOOM);
    });
    return true;
  }, [activeCompanyId, dropFitCap]);
  frameUnitsRef.current = frameUnits;

  /**
   * The company's opening view: its configured `defaultView` if it has one,
   * otherwise a fit to the bulk of its located fleet.
   *
   * Sukari has one because no bounds-based fit can serve it well — half its
   * located units are within 600 m of the plant and the tail runs to 91 km, so
   * a fit is always a compromise between framing the yard and framing the
   * stragglers. A named point is simply the better answer, and it is also the
   * answer to "where is this organisation".
   *
   * Used for the FIRST paint and for every "show me the whole fleet again"
   * (clearing a search, clearing a vehicle), so those all land back in the same
   * place rather than one of two different ones.
   */
  /**
   * The card's reticle button: go to this unit, and come back.
   *
   * The view to come back TO is stamped on the first zoom-in and not on any
   * after it. Stamping every time would mean a second click saved the place
   * the first click had already taken you, and "back" would be a 20-zoom
   * frame of the same truck - the button would quietly stop working while
   * appearing to.
   *
   * Cleared when the card closes or changes unit (see the effect below), so
   * the saved view can never outlive the question it was saved for.
   */
  const preZoomViewRef = useRef(null);
  const [zoomedIn, setZoomedIn] = useState(false);

  const zoomToPinned = useCallback(() => {
    const map = mapRef.current;
    const v = vehiclesRef.current.find(x => x.id === pinnedId);
    if (!map || !Number.isFinite(v?.lat) || !Number.isFinite(v?.lng)) return;

    if (!preZoomViewRef.current) {
      const c = map.getCenter?.();
      // Centre AND zoom. Restoring the zoom alone would leave the reader at
      // the old scale over the truck they zoomed to, which is not the view
      // they left and not what "back" means to anybody.
      preZoomViewRef.current = c
        ? { lat: c.lat(), lng: c.lng(), zoom: map.getZoom() ?? FIT_MAX_ZOOM }
        : null;
    }
    map.setView({ lat: v.lat, lng: v.lng }, FOCUS_ZOOM);
    setZoomedIn(true);
  }, [pinnedId]);

  const zoomBack = useCallback(() => {
    const map = mapRef.current;
    const view = preZoomViewRef.current;
    if (!map || !view) return;
    map.setView({ lat: view.lat, lng: view.lng }, view.zoom);
    preZoomViewRef.current = null;
    setZoomedIn(false);
  }, []);

  /* A saved view belongs to ONE card. Closing it, or pinning a different unit,
     ends the round trip - otherwise "back" on the next unit would fly to
     wherever the last one was opened from. */
  useEffect(() => {
    preZoomViewRef.current = null;
    setZoomedIn(false);
  }, [pinnedId]);

  const resetCamera = useCallback((located) => {
    const map = mapRef.current;
    if (!map) return false;

    // Read from the static module, NOT from context's `activeCompany`.
    //
    // That value is populated through an async getCompanies() and so is
    // undefined for at least one render. The map is gated on the Google Maps
    // script load, which is far slower, so in practice it would be there in
    // time — but "in practice" means the failure is a rare race that silently
    // opens Sukari on the wrong view. The data is a static import either way.
    const view = COMPANIES.find(c => c.id === activeCompanyId)?.defaultView;
    if (view && Number.isFinite(view.lat) && Number.isFinite(view.lng)) {
      map.setCenter({ lat: view.lat, lng: view.lng });
      map.setZoom(view.zoom ?? FIT_MAX_ZOOM);
      // CHANGED 2026-08-05: claim the camera immediately so no subsequent
      // fitBounds (zone layer, plan layer, pending fit) can override this
      // explicit defaultView zoom. Any async idle callbacks that fire after
      // this point will see fittedCompanyRef already set and skip their fit.
      fittedCompanyRef.current = activeCompanyId;
      pendingFitRef.current = false;
      return true;
    }
    return fitTo(located ?? []);
  }, [activeCompanyId, fitTo]);

  // ── map camera controls ───────────────────────────────────────────────────
  // Stand-ins for the built-in zoom and camera widgets, which Google can only
  // anchor to a map EDGE — and every edge here is under a panel or the footer
  // (see the map options). Placement is ours, so they land in the free centre
  // column instead of behind MapOverlay's right rail.
  const nudgeZoom = useCallback((delta) => {
    const map = mapRef.current;
    if (!map) return;
    const z = map.getZoom();
    // The engine clamps to the map's own minZoom/maxZoom, so no bounds check here.
    if (Number.isFinite(z)) map.setZoom(z + delta);
  }, []);

  const resetView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    // Level the camera before recentring: a heading or tilt left over from a
    // rotate gesture survives a setCenter, so without this the "reset" would
    // put the fleet back in frame but still crooked.
    map.setHeading?.(0);
    map.setTilt?.(0);
    resetCamera(vehiclesRef.current.filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lng)));
  }, [resetCamera]);

  // ── the left tool rail: ruler, place search, names ───────────────────

  const toggleNames = useCallback(() => {
    setNamesOn(v => { writeCache(NAMES_KEY, !v); return !v; });
  }, []);
  const toggleToolsExpanded = useCallback(() => {
    setToolsExpanded(v => { writeCache(TOOLS_EXPANDED_KEY, !v); return !v; });
  }, []);
  const toggleMeasure = useCallback(() => {
    setMeasuring(v => !v);
    setMeasurePts([]);
  }, []);

  // While the ruler is on, a click on the map adds a point. Backspace takes
  // the last one back and Escape ends the measurement. The map's own click
  // (deselect, close cards) stands aside — see measuringRef in its handler.
  useEffect(() => {
    const map = mapRef.current;
    if (!measuring || !map || !mapReady) return undefined;
    const h = map.addListener("click", (e) => {
      if (e?.latLng) setMeasurePts(p => [...p, plainPoint(e.latLng)]);
    });
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
      if (typing) return;
      if (e.key === "Escape") { setMeasuring(false); setMeasurePts([]); }
      else if (e.key === "Backspace") { e.preventDefault(); setMeasurePts(p => p.slice(0, -1)); }
    };
    document.addEventListener("keydown", onKey);
    return () => { h.remove(); document.removeEventListener("keydown", onKey); };
  }, [measuring, mapReady]);

  // The measured path: one line, a dot per point and the total at the end.
  // Redrawn whole on every change; a ruler has a handful of points.
  useEffect(() => {
    const map = mapRef.current, maps = mapsLibRef.current, DomMarker = DomMarkerRef.current;
    if (!map || !maps || !DomMarker || measurePts.length === 0) return undefined;
    const line = new maps.Polyline({
      path: measurePts, map, clickable: false, zIndex: 900,
      strokeColor: "#1d4ed8", strokeOpacity: 0.95, strokeWeight: 3,
    });
    const dots = measurePts.map(p => {
      const m = new DomMarker({ position: p, html: '<div class="mtr-dot"></div>', anchor: "center", zIndex: 900 });
      m.setMap(map);
      return m;
    });
    let total = null;
    if (measurePts.length > 1) {
      total = new DomMarker({
        position: measurePts[measurePts.length - 1], anchor: "center", zIndex: 901,
        html: `<div class="mtr-total">${formatDistance(pathLengthM(measurePts))}</div>`,
      });
      total.setMap(map);
    }
    return () => { line.setMap(null); for (const d of dots) d.setMap(null); total?.setMap(null); };
  }, [measurePts]);

  const measureText = measurePts.length > 1
    ? `${formatDistance(pathLengthM(measurePts))} · ${measurePts.length - 1} leg${measurePts.length > 2 ? "s" : ""}`
    : measurePts.length === 1 ? "Click the next point" : null;

  // Apply the base map. Google is loaded on first use; if it cannot be (no
  // key, a refused referrer, offline) the map stays on OpenStreetMap and the
  // Maps panel says why, rather than going blank.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return undefined;
    let dead = false;
    if (isGoogleBase(baseMap)) {
      installGoogleBase(map, baseMap)
        .then(() => { if (!dead) { map.setMapTypeId(baseMap); setBaseNote(null); } })
        .catch((e) => {
          if (dead) return;
          setBaseNote(`Google Maps is unavailable: ${e.message}. Showing OpenStreetMap.`);
          setBaseMap("osm");
        });
    } else {
      map.setMapTypeId(OSM_TYPE_ID);
    }
    return () => { dead = true; };
  }, [baseMap, mapReady]);

  // The phone and tablet toggle (see the render). Only with a second base map
  // to choose: no Google key built in, no toggle.
  const baseToggle = isCompact && GOOGLE_BASE_AVAILABLE;

  const chooseBase = useCallback((id) => {
    writeCache(BASE_MAP_KEY, id);
    setBaseNote(null);
    setBaseMap(id);
  }, []);

  // Place search biases to what is on screen.
  const getSearchBias = useCallback(() => {
    const b = mapRef.current?.getBounds?.();
    if (!b) return null;
    const ne = b.getNorthEast(), sw = b.getSouthWest();
    return { west: sw.lng(), south: sw.lat(), east: ne.lng(), north: ne.lat() };
  }, []);

  // ── the estate's surveyed boundaries ───────────────────────────────────
  //
  // Built once per org, then only shown or hidden. Deliberate: the full set is
  // ~8,600 vertices (the Malagarasi alone is 2,414), and re-creating those
  // Polygons on the marker-reconcile path — which runs on every SSE frame —
  // would rebuild thousands of shapes several times a minute. The map has been
  // here before; see the mousemove re-render storm that made this view
  // unusable.
  //
  // Gated on `zonesAllowed`, not merely on having geometry: every org's fences
  // are fetched (`zoneTestFor` reads them for the stranded-stop flag, `zonesAt`
  // for playback), and drawing them everywhere is precisely what was removed on
  // 2026-09-13. This draws Mufindi's.
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    const DomMarker = DomMarkerRef.current;
    if (!mapReady || !map || !maps || !DomMarker || !zones?.features) return;
    if (!zonesAllowed) return;                      // wrong org — never build
    if (zoneLayerRef.current) return;               // already built for this map

    const shapes = [];
    const labels = [];
    // Each shape with its category, so a base-map switch can recolour it in
    // place (zoneColor) rather than rebuild the layer.
    const tinted = [];
    const info   = new maps.InfoWindow();
    // Accumulated while building, so the shared camera fit can frame the layer.
    const bounds = new maps.LatLngBounds();

    for (const f of zones.features) {
      const p = f.properties ?? {};
      if (ZONE_SKIP_CATEGORIES.has(p.category)) continue;
      // Ahead of every bounds.extend below, so an excluded zone cannot drag the
      // camera fit out to ground the layer no longer draws.
      const key = zoneKey(p.name);
      if (ZONE_EXCLUDE.has(key)) continue;

      // The outline and fill follow the base map; the name plate does not. It
      // sits on its own dark backing whatever is under it, which is what the
      // satellite palette was chosen against.
      const color = zoneColor(p.category, baseMapRef.current);
      const plateColor = (ZONE_STYLE[p.category] ?? ZONE_FALLBACK).color;
      const geom  = f.geometry;
      const alias = ZONE_PLAN_ALIAS[key];
      let shape = null;
      // Where the plate goes, and the lowest zoom it may appear at. Left null
      // for a zone that gets no plate at all.
      let labelAt = null, labelMinZoom = 0;

      if (geom?.type === "Polygon") {
        const ring = geom.coordinates?.[0] ?? [];
        if (ring.length < 3) continue;
        for (const [lng, lat] of ring) bounds.extend({ lat, lng });
        shape = new maps.Polygon({
          paths: ring.map(([lng, lat]) => ({ lat, lng })),
          strokeColor: color, strokeWeight: 2, strokeOpacity: 0.95,
          fillColor: color, fillOpacity: 0.14,
          clickable: true, zIndex: 1,
        });
        labelAt      = ringCentroid(ring);
        labelMinZoom = zoneLabelMinZoom(p.areaHa);
      } else if (geom?.type === "LineString") {
        const path = geom.coordinates ?? [];
        if (path.length < 2) continue;
        for (const [lng, lat] of path) bounds.extend({ lat, lng });
        // A corridor's real footprint is its width, which at estate zoom is a
        // few metres — far thinner than any drawable stroke. Draw it as a line
        // and put the width in the popup rather than pretending to scale it.
        shape = new maps.Polyline({
          path: path.map(([lng, lat]) => ({ lat, lng })),
          strokeColor: color, strokeWeight: 2.5, strokeOpacity: 0.9,
          clickable: true, zIndex: 2,
        });
        labelAt      = pathMidpoint(path);
        labelMinZoom = ZONE_CORRIDOR_LABEL_MIN_ZOOM;
      }
      if (!shape) continue;

      const detail = geom.type === "Polygon"
        ? `${(p.areaHa ?? 0).toLocaleString()} ha`
        : `corridor · ${p.widthM ?? "?"} m wide`;
      // What the printed plan says, next to what our geometry measures. The two
      // disagree by design (envelope vs plantable subset) and by accident
      // (Rain-fed: 250 ha printed, 1,933 ha ring) — showing both is the only
      // honest option, since neither is ours to overrule. It is also the line
      // that lets someone holding the sheet know these two layers are the same
      // ground under different names.
      const planLine = alias
        ? `<span class="zone-info-plan">Plan: ${alias.plan}${
             alias.planHa ? ` · ${alias.planHa.toLocaleString()} ha printed` : ""}</span>`
        : "";
      shape.addListener("click", (e) => {
        info.setContent(
          `<div class="zone-info">
             <strong>${p.name}</strong>
             <span>${(ZONE_STYLE[p.category] ?? ZONE_FALLBACK).label} · ${detail}</span>
             ${planLine}
             <span class="zone-info-state">${p.isActive ? "Enforced" : "Not enforced"}</span>
           </div>`,
        );
        info.setPosition(e.latLng);
        info.open(map);
      });

      // The plate's second line is shorter than the popup's: "3 m wide", not
      // "corridor · 3 m wide", and nothing at all for the yard-sized zones that
      // round to 0 ha — a plate reading "Dispensary / 0 ha" states something
      // false, and every pixel of plate width is a pixel that can collide.
      const labelSub = geom.type === "Polygon"
        ? ((p.areaHa ?? 0) >= 1 ? `${p.areaHa.toLocaleString()} ha` : "")
        : `${p.widthM ?? "?"} m wide`;

      if (labelAt && !ZONE_LABEL_SUPPRESS.has(key)) {
        labels.push({
          marker: new DomMarker({
            position: labelAt,
            html: zoneLabelHtml(p.name, plateColor, labelSub, alias?.plan),
            anchor: "center",
            // Above the plan's linework and its plates — see the plan label
            // effect, which now yields to these.
            zIndex: 3,
          }),
          pos: labelAt,
          minZoom: labelMinZoom,
          // Declutter priority. Area first so the significant zone keeps its
          // name; corridors last because a river's plate can sit anywhere along
          // it, while a block's belongs at its centre.
          priority: geom.type === "Polygon" ? (p.areaHa ?? 0) : -1,
        });
      }

      shapes.push(shape);
      tinted.push({ shape, category: p.category, filled: geom.type === "Polygon" });
    }

    labels.sort((a, b) => b.priority - a.priority);

    zoneLayerRef.current = { shapes, labels, info, bounds, tinted };

    // Built hidden; the visibility effect below puts it on the map if the
    // toggle is already on.
    return () => {
      for (const s of shapes) { maps.event.clearInstanceListeners(s); s.setMap(null); }
      for (const l of labels) l.marker.setMap(null);
      info.close();
      zoneLayerRef.current = null;
    };
  }, [mapReady, zones, zonesAllowed]);

  // Show/hide the built layer. Cheap — no geometry is created or destroyed.
  //
  // Shapes follow the toggle; labels additionally require enough zoom to be
  // legible, and are re-evaluated as the camera settles — a pan changes the
  // answer on its own, since a plate suppressed by a neighbour is a candidate
  // again once that neighbour scrolls off screen.
  useEffect(() => {
    const map   = mapRef.current;
    const maps  = mapsLibRef.current;
    const layer = zoneLayerRef.current;
    if (!map || !maps || !layer) return;

    const on = showZones && zonesAllowed;
    for (const s of layer.shapes) s.setMap(on ? map : null);
    if (!on) layer.info.close();

    // Zone plates go down first and yield to nobody — they are the
    // authoritative names, and the plan layer's labels defer to them.
    const { apply, cancel } = labelApplier(map, maps, layer.labels, on);
    apply();

    // A deliberate toggle takes the camera to the estate; arriving with the
    // layer already on does not. The map opens on the whole fleet, which for
    // Kasulu's cached positions spans a thousand kilometres — at that zoom the
    // estate is a handful of pixels ~900 km off centre, which is what "the
    // layer is broken" turned out to mean the last time this was wired. The fit
    // itself is the shared one, so switching this on while the plan is up
    // frames both rather than stealing the view from it.
    if (on && zonesRequestedRef.current) fitPlaceLayersRef.current();

    if (!on) return cancel;

    const idleListener = map.addListener("idle", () => apply());
    const zoomListener = map.addListener("zoom_changed", () => apply());
    return () => { zoomListener.remove(); idleListener.remove(); cancel(); };
  }, [showZones, zonesAllowed, mapReady, zones]);

  // The GEOMETRY IS STILL FETCHED FOR EVERY ORG, and deliberately — this layer
  // is a reader of it, not its owner. Two things read the same rows and neither
  // is an overlay: `zoneTestFor` (lib/zoneContainment), which decides whether a
  // stopped unit is inside a fence and therefore whether the stranded-stop flag
  // fires, and `zonesAt` (lib/playbackPath), which names the zones a replayed
  // point passed through. Both must keep working on the orgs that draw nothing.

  /**
   * Frame every place layer that is currently drawn — not just the one that was
   * switched on.
   *
   * Each layer used to fit its own bounds, which is right while it is the only
   * one on and wrong the moment it is not: turning on a site plan while the
   * weighbridges were up flew the camera to the site and left the scales
   * somewhere off the edge. Nothing had hidden them, which is the worst version
   * of this — the switch was still lit, the markers were still there, and they
   * were not on screen.
   *
   * So the fit is over the union of what is on — EXCEPT that a site plan on
   * screen takes the camera on its own, tight and floored.
   *
   * A survey is a kilometre of detail whose own pins need zoom 15, and
   * unioning it with a scale in the next county frames both at a zoom where
   * the drawing is a smudge. The site is what the operator asked to look at;
   * the scales are drawn wherever they are and are still there when the camera
   * moves. This is the one place where framing everything is worse than
   * framing the subject.
   *
   * With TWO surveys on, that argument applies again between them — Kabras and
   * Nzoia are 29 km apart, and framing both is the smudge. So the caller names
   * which one it means: a switch frames the place it just turned on. A caller
   * with nothing to say (the weighbridge or boundary toggles) gets the first
   * survey that is drawn, which is the same answer the single-survey case gave
   * and is at least somewhere the operator asked to be.
   *
   * Read through a ref by its callers so that toggling one layer does not
   * re-run another layer's effect and rebuild its markers.
   */
  const fitPlaceLayers = useCallback((focusId = null) => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!map || !maps) return;

    const b = new maps.LatLngBounds();
    const extendData = (data) =>
      data?.forEach(f => f.getGeometry()?.forEachLatLng(ll => b.extend(ll)));

    // The site plan is the subject whenever it is drawn — see above.
    const drawn = sitePlans.filter(p => siteOn[p.id] && sitesRef.current[p.id]?.data);
    // A GUEST is only ever the subject of a fit the operator asked for BY NAME.
    // It appeared on its own; flying the camera into another tenant's yard
    // because a lorry wandered in would take the screen away from whatever
    // they were reading.
    const subject = (focusId && drawn.find(p => p.id === focusId))
      || drawn.find(p => !p.guest) || null;
    if (subject) {
      extendData(sitesRef.current[subject.id].data);
    } else {
      if (showPlan && planAllowed) extendData(planDataRef.current);
      // The boundaries and the drawing cover the same ground within a
      // kilometre, so unioning them costs no zoom — and when only the
      // boundaries are on, they are what there is to frame.
      if (showZones && hasZones && zoneLayerRef.current
          && !zoneLayerRef.current.bounds.isEmpty()) {
        b.union(zoneLayerRef.current.bounds);
      }
      if (showBridges && hasBridges) {
        for (const m of bridgeMarkersRef.current ?? []) b.extend(m.getPosition());
      }
    }
    if (b.isEmpty()) return;

    // Claim the camera, or the next SSE reconcile pass refits the whole fleet
    // and throws the view straight back out.
    fittedCompanyRef.current = activeCompanyId;
    pendingFitRef.current = false;
    if (subject) {
      // This survey's own camera, not one number for every place on the
      // product: a mill yard and a 6 km estate do not want the same zoom.
      const { min, max } = subject.fit ?? { min: SITE_MIN_ZOOM, max: SITE_MAX_ZOOM };
      fitMapToBounds(map, maps, b, SITE_FIT_PADDING, { min, max });
    } else {
      fitMapToBounds(map, maps, b);
    }
  }, [showPlan, planAllowed, sitePlans, siteOn, showBridges, hasBridges,
      showZones, hasZones, activeCompanyId]);

  const fitPlaceLayersRef = useRef(fitPlaceLayers);
  useEffect(() => { fitPlaceLayersRef.current = fitPlaceLayers; }, [fitPlaceLayers]);

  // ── estate PLAN (CAD drawing) overlay ───────────────────────────────────
  //
  // A google.maps.Data layer rather than 643 hand-built shapes: Data is built
  // for GeoJSON and styles by feature property in one pass. Created and fetched
  // only when the toggle is first switched on — the payload is 0.48 MB and most
  // sessions never open this layer.
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!mapReady || !map || !maps || !showPlan) return;
    if (!planAllowed) return;                       // wrong org — never draw
    // Already built for this org: re-attach rather than re-fetch the 0.48 MB.
    // A toggle still has to take the camera to the drawing — see the site
    // plan's twin of this block for why a second press otherwise does nothing.
    if (planDataRef.current) {
      planDataRef.current.setMap(map);
      if (planRequestedRef.current) fitPlaceLayersRef.current();
      return;
    }

    const data = new maps.Data();
    data.setStyle((feature) => {
      const cls  = feature.getProperty("c");
      const name = feature.getProperty("n");
      const { color, weight, fill } = PLAN_STYLE[cls] ?? PLAN_STYLE.boundary;
      // `s` marks a SHADING region — a land-use area dissolved back out of the
      // drawing's diagonal hatching. The
      // hatch strokes themselves are gone from the data: 2,155 of them were
      // being drawn as linework, which is what made the layer read as scribble.
      // A region is a flat wash with no outline of its own — the block grid on
      // top supplies every edge the eye needs, and an outline here would just
      // reintroduce a second set of lines.
      const shade = feature.getProperty("s") === 1;
      return {
        strokeColor: color,
        strokeWeight: shade ? 0 : weight,
        strokeOpacity: shade ? 0 : 0.95,
        fillColor: color,
        fillOpacity: shade ? 0.42 : fill,
        // Only NAMED shapes take pointer events: the outlines and blocks. The
        // lines (rivers, mains) have nothing to say on hover.
        clickable: Boolean(name),
        // Shading sits under its own block grid, and the whole plan layer stays
        // negative so it can never climb above the authoritative zone layer or
        // the fleet, both of which start at 1.
        zIndex: shade ? -2 : cls === "boundary" || cls === "zone" ? -3 : -1,
      };
    });

    // Hover names the block.
    //
    // The card used to be re-positioned to the cursor on every mousemove, which
    // is the flicker: the card lands under the pointer, the block beneath it
    // loses the pointer, the card closes, and the whole thing starts again. It
    // is placed once now, where the pointer entered, and `hoverWindow` handles
    // the rest.
    const hoverWin = hoverWindow(maps, map);
    data.addListener("mouseover", (e) => {
      const name = e.feature.getProperty("n");
      if (!name) return;
      const cls = e.feature.getProperty("c");
      const ha  = e.feature.getProperty("a");
      hoverWin.open({
        html:
          `<article class="mapcard mapcard--plan">` +
            `<header class="mapcard__head"><h3 class="mapcard__title">${esc(name)}</h3></header>` +
            `<p class="mapcard__class"><i class="mapcard__swatch" style="--swatch:${
               (PLAN_STYLE[cls] ?? PLAN_STYLE.boundary).color
             }"></i>${esc(PLAN_LABEL[cls] ?? cls)}${ha ? ` · ${ha.toLocaleString()} ha` : ""}</p>` +
          `</article>`,
        position: e.latLng,
      });
      data.overrideStyle(e.feature, { strokeWeight: 2.6, fillOpacity: 0.3 });
    });
    data.addListener("mouseout", (e) => {
      hoverWin.leave();
      data.revertStyle(e.feature);
    });
    planHoverRef.current = hoverWin;
    planDataRef.current = data;
    setPlanState("loading");

    let cancelled = false;
    fetch(ESTATE_PLAN_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(fcJson => {
        if (cancelled) return;
        data.addGeoJson(fcJson);
        data.setMap(mapRef.current);
        setPlanState("ready");
        // The plan covers ~20 km and the map opens on the whole fleet, so
        // without a fit it draws into a few pixels 900 km off-screen.
        //
        // CHANGED 2026-08-05: skip the camera move if the company has a
        // defaultView — fitMapToBounds fires async and would override that
        // zoom. (No company carries one today.)
        const planHasDefaultView = Boolean(COMPANIES.find(c => c.id === activeCompanyId)?.defaultView);
        if (!planHasDefaultView) {
          planFittedRef.current = true;
          fitPlaceLayersRef.current();
        }
      })
      .catch(() => { if (!cancelled) setPlanState("error"); });

    return () => { cancelled = true; };
  }, [showPlan, mapReady, planAllowed]);

  // ── the drawing's macro name plates (ZONE 3, ZONE 4, B1-B4) ──────────────
  //
  // Fixed points rather than data: these are the sheet's area names — the
  // labels a reader navigates by, and the ones no geofence carries (see
  // PLAN_LABELS). They ride with the plan layer, not the zone layer, because
  // they are the drawing's names and must never be mistaken for a fence.
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    const DomMarker = DomMarkerRef.current;
    if (!mapReady || !map || !maps || !DomMarker) return;

    if (!planLabelsRef.current) {
      planLabelsRef.current = PLAN_LABELS.map((l) => ({
        marker: new DomMarker({
          position: { lat: l.lat, lng: l.lng },
          html: planLabelHtml(l.text),
          anchor: "center",
          // Above the plan linework, below the zone plates — same order as the
          // layers themselves.
          zIndex: 2,
        }),
        pos: { lat: l.lat, lng: l.lng },
        minZoom: l.minZoom,
        priority: l.priority,
      }));
      planLabelsRef.current.sort((a, b) => b.priority - a.priority);
    }

    const on = showPlan && planAllowed;
    // The plan's macro plates yield to the estate's zone plates, which are the
    // names operators use — where the two collide the fence's name is the one
    // worth reading. Read lazily: the zone plates move as the camera
    // does, and this needs where they are NOW.
    const { apply, cancel } = labelApplier(
      map, maps, planLabelsRef.current, on,
      () => zoneLayerRef.current?.labels,
    );
    apply();
    if (!on) return cancel;

    const idleListener = map.addListener("idle", () => apply());
    const zoomListener = map.addListener("zoom_changed", () => apply());
    return () => { idleListener.remove(); zoomListener.remove(); cancel(); };
  }, [showPlan, planAllowed, mapReady]);

  // Hide without discarding — re-parsing the plan on every toggle would
  // stall the map for seconds.
  useEffect(() => {
    if ((!showPlan || !planAllowed) && planDataRef.current) {
      planDataRef.current.setMap(null);
      planHoverRef.current?.close();
    }
  }, [showPlan, planAllowed]);

  // Switching organisation must DISCARD the plan, not just hide it. It is
  // Kasulu's drawing loaded from a static asset, so a merely-hidden layer would
  // reappear over another org's fleet the moment the toggle was touched.
  useEffect(() => {
    if (planAllowed) return;
    planDataRef.current?.setMap(null);
    planHoverRef.current?.destroy();
    for (const l of planLabelsRef.current ?? []) l.marker.setMap(null);
    planDataRef.current = null;
    planHoverRef.current = null;
    planLabelsRef.current = null;
    setShowPlan(false);
    setPlanState("idle");
  }, [planAllowed]);

  // Drop the layer when the map itself goes away.
  useEffect(() => () => {
    planDataRef.current?.setMap(null);
    planDataRef.current = null;
    for (const l of planLabelsRef.current ?? []) l.marker.setMap(null);
    planLabelsRef.current = null;
  }, []);

  // ── the works-site plan ─────────────────────────────────────────────────
  //
  // Drawn from this org's operations survey (SITE_PLANS). Polygons are the site
  // fence and the distillery; every other feature is a named POINT, which is
  // what the survey actually recorded — a gate is a line across a road and a
  // weighbridge is a machine, and drawing a made-up 50 m box around either
  // would assert a footprint nobody measured. An earlier attempt to infer those
  // footprints from screenshots put four of Scrap Yard's five corners outside
  // the site fence, which is why the rule here is to draw what was surveyed.
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!mapReady || !map || !maps || !siteAllowed) return undefined;

    let cancelled = false;
    const listeners = [];

    /* One survey. Called for each that is switched on; a company may have two
     * and they are entirely separate layers, sharing only this code. */
    const build = (plan) => {
    const slot = siteSlot(plan.id);
    // Already built for this org: re-attach rather than re-fetch. A toggle
    // still has to take the camera to the site, though — the layer is a
    // kilometre or two inside a national fleet, so switching it back on
    // without a fit puts it back where it cannot be seen, and the operator's
    // second press would look like it did nothing.
    if (slot.data) {
      slot.data.setMap(map);
      if (slot.requested) fitPlaceLayersRef.current(plan.id);
      return;
    }

    const data = new maps.Data();

    /* Restyled on zoom, which is how the name plates appear: a Data style
     * function is re-run by setStyle, so the zoom is read at style time rather
     * than captured. */
    const styleFor = (feature) => {
      const category = feature.getProperty("category");
      const kind     = feature.getProperty("kind");
      const name     = feature.getProperty("name");
      // By base map: the site fence is white over satellite and orange over
      // OpenStreetMap, where white vanishes into the pale land. Read through a
      // ref so a base switch restyles the layer — see the effect below it.
      const color    = zoneColor(category, baseMapRef.current);

      if (kind === "point") {
        /* The survey's own weighbridge is not drawn WHERE THE WEIGHBRIDGES
         * LAYER IS DRAWING ONE.
         *
         * Not because the survey is wrong — at Kabras it is 8-12 m from both
         * of the scales that layer draws, which is how those two were checked.
         * It is because the survey recorded the FACILITY as one point and the
         * yard runs two lanes, so this pin sits in the gap between them. A
         * third pin meaning "roughly where the other two are" is worse than no
         * third pin, and one kind of thing wants one switch.
         *
         * The condition used to be absent, and that was wrong the moment a
         * second survey arrived: the weighment feed carries Sukari's four
         * centres and nothing else, so on West Kenya there is no Weighbridges
         * switch at all — and Nzoia's Commerical WB and Cane WB, two of the
         * nineteen places on its sheet, were being hidden in deference to a
         * layer that is not there. Where no scale is drawn, the survey's pin
         * is the only weighbridge on this map and it has to draw.
         *
         * Read through a ref and re-styled when the answer changes — see the
         * effect below — so the pin appears the moment a mill's scales start
         * reporting, without this layer being rebuilt. */
        if (category === "weighing" && hasBridgesRef.current) return { visible: false };
        const shown = (mapRef.current?.getZoom() ?? 0)
          >= (plan.pointMinZoom ?? SITE_POINT_MIN_ZOOM);
        return {
          // No `label`. The name is on hover — see the mouseover handler.
          icon: {
            url: siteIcon(category),
            scaledSize: new maps.Size(26, 26),
            anchor: new maps.Point(13, 13),
          },
          visible: shown,
          // Native tooltip as well as the info window, so the name is reachable
          // by a keyboard user and by anyone whose pointer never settles.
          title: name,
          zIndex: 1,
        };
      }
      // Both polygons carry a real fill. The 4 % the perimeter had was chosen
      // to keep satellite detail legible underneath and instead read as no
      // fill at all — the layer looked like it had failed to load its areas.
      // 18 % still shows the ground through it while making the site read as a
      // filled place rather than as a line someone drew near one.
      return {
        strokeColor: color,
        strokeWeight: kind === "boundary" ? 2.6 : 1.8,
        strokeOpacity: 0.95,
        fillColor: color,
        fillOpacity: kind === "boundary" ? 0.18 : 0.26,
        clickable: true,
        zIndex: -1,
      };
    };
    data.setStyle(styleFor);
    // Kept so the weighbridge effect below can re-run the style when that
    // switch moves, without rebuilding the layer.
    slot.style = styleFor;

    /**
     * Hover tells you what the marker is. It has to, now that the plates are
     * gone — an icon says the CLASS of a place and nothing about which one, so
     * "which gate is that" has to be answerable without a click.
     *
     * `disableAutoPan`, because a window opening near the edge would otherwise
     * pan the map out from under the pointer and start a hover on something
     * else.
     */
    const detail = (feature) => {
      const name = feature.getProperty("name");
      const category = feature.getProperty("category");
      const style = ZONE_STYLE[category] ?? ZONE_FALLBACK;
      const swatch = feature.getProperty("kind") === "point"
        ? style.color                                   // pins keep one colour
        : zoneColor(category, baseMapRef.current);      // shapes follow the base
      // Name, then class. The swatch repeats the marker's colour, which is how
      // you get from a pin you are pointing at back to the row in the layer key.
      //
      // Spoken, not shouted: surveys are traced by different hands and they do
      // not agree about capitals. Of the nine on this map only Molo's does it
      // — "MOLO RIVER", "MOLO RIVER 2" — and one survey shouting while the
      // other eight do not is the card looking broken on one site. Display
      // only; the geojson keeps the surveyor's spelling. See spokenSiteName.
      return (
        `<article class="mapcard mapcard--site">` +
          `<header class="mapcard__head"><h3 class="mapcard__title">${esc(spokenSiteName(name))}</h3></header>` +
          `<p class="mapcard__class">` +
            `<i class="mapcard__swatch" style="--swatch:${swatch}"></i>${esc(style.label)}` +
          `</p>` +
        `</article>`
      );
    };

    // Anchored where the pointer entered the feature and left there. The card
    // used to be re-placed on every hover event at the cursor, which put it
    // under the pointer and started the open/close flicker.
    const hoverWin = hoverWindow(maps, map);
    const openAt = (e, pin = false) => {
      if (!e.feature.getProperty("name")) return;
      hoverWin.open({
        html: detail(e.feature),
        position: e.latLng ?? e.feature.getGeometry()?.get?.(),
        pin,
      });
    };
    data.addListener("mouseover", (e) => openAt(e));
    data.addListener("mouseout", () => hoverWin.leave());
    // Click PINS it. The two polygons are big enough that reading their detail
    // should not depend on the pointer staying inside them.
    data.addListener("click", (e) => openAt(e, true));
    slot.hover = hoverWin;
    slot.data  = data;
    setSiteStatus(st => ({ ...st, [plan.id]: "loading" }));

    // Re-run the style on zoom, which is what shows and hides the pins.
    listeners.push(map.addListener("zoom_changed", () => {
      if (!cancelled && slot.data) slot.data.setStyle(styleFor);
    }));

    fetch(plan.url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(fcJson => {
        if (cancelled) return;
        data.addGeoJson(fcJson);
        data.setMap(mapRef.current);
        setSiteStatus(st => ({ ...st, [plan.id]: "ready" }));
        // The key names what this layer draws, so it is read off the same
        // document rather than hardcoded — a survey that gains a category gains
        // a swatch without an edit here.
        setSiteCats(c => ({ ...c, [plan.id]: [...new Set(
          (fcJson.features ?? []).map(f => f.properties?.category).filter(Boolean),
        )].sort() }));

        // Fit the camera to the site, but ONLY when the operator asked for the
        // layer.
        //
        // The site is 1.2 km inside a fleet that spans the country, so a
        // deliberate toggle without a fit draws into a few pixels off-screen —
        // switching it on has to take you there or it does nothing visible.
        //
        // The DEFAULT-ON case used to be the opposite: drawn, not chased. That
        // reasoning was sound and the behaviour still went wrong, because it
        // was not the whole picture — the provider's zone layer was ALSO
        // default-on for this org, and its own fit flew the camera to the same
        // mill on every load. The site plan was being carried to its subject by
        // a layer it had nothing to do with.
        //
        // Removing the zones removed that ride, and the 29 pins went with it:
        // they are gated at zoom 15 (below it they pile into one blob) and the
        // opening fleet camera sits around zoom 7, so the plan drew its two
        // polygons and not one icon. The layer looked emptied out.
        //
        // So the fit is now the plan's own, and it runs on the first draw for
        // the org whether the layer was switched on or merely already on. That
        // is a deliberate reversal: framing one mill does hide the rest of the
        // fleet, and it is what this org's map did before, all the way back to
        // when the pins were added.
        // !plan.guest: the default-on fit is for a survey this organisation
        // OWNS, which is a place its map is about. A visitor is news, not a
        // destination — it draws where it is and waits to be pressed.
        if (slot.requested || (!slot.fitted && !plan.guest)) {
          slot.fitted = true;
          fitPlaceLayersRef.current(plan.id);
        }
      })
      .catch(() => {
        if (!cancelled) setSiteStatus(st => ({ ...st, [plan.id]: "error" }));
      });
    };

    for (const plan of sitePlans) if (siteOn[plan.id]) build(plan);

    return () => { cancelled = true; for (const l of listeners) l?.remove?.(); };
  }, [mapReady, siteAllowed, sitePlans, siteOn, activeCompanyId]);

  /* The weighbridge switch changes what the site layer draws — see the
   * `weighing` rule in the style above — so the style is re-run when it moves.
   * So does the base map, which decides the fence's colour. Restyling is
   * cheap; rebuilding the layer is not, and would lose the camera. */
  useEffect(() => {
    for (const slot of Object.values(sitesRef.current)) {
      if (slot.data && slot.style) slot.data.setStyle(slot.style);
    }
  }, [hasBridges, baseMap]);

  // The estate zones' outlines, recoloured in place on a base-map switch for
  // the same reason. A layer built after the switch already read the new base.
  useEffect(() => {
    for (const t of zoneLayerRef.current?.tinted ?? []) {
      const color = zoneColor(t.category, baseMap);
      t.shape.setOptions(t.filled ? { strokeColor: color, fillColor: color } : { strokeColor: color });
    }
  }, [baseMap]);

  // Hide without discarding — same reasoning as the plan layer.
  useEffect(() => {
    for (const plan of sitePlans) {
      if (siteOn[plan.id]) continue;
      const slot = sitesRef.current[plan.id];
      if (slot?.data) { slot.data.setMap(null); slot.hover?.close(); }
    }
  }, [siteOn, sitePlans]);

  // Switching organisation DISCARDS it. A merely-hidden static layer would
  // reappear over another org's fleet the moment the toggle was touched.
  //
  // The VISIBILITY is left to the org-restore effect above, which reads this
  // company's own preference — writing it here as well would race that effect
  // and, worse, decide West Kenya's switch from an event on another org.
  useEffect(() => {
    const keep = new Set(sitePlans.map(p => p.id));
    let dropped = false;
    for (const [id, slot] of Object.entries(sitesRef.current)) {
      if (keep.has(id)) continue;
      slot.data?.setMap(null);
      slot.hover?.destroy();
      delete sitesRef.current[id];
      dropped = true;
    }
    if (!dropped) return;
    const onlyKept = (obj) => Object.fromEntries(
      Object.entries(obj).filter(([id]) => keep.has(id)));
    setSiteStatus(onlyKept);
    setSiteCats(onlyKept);
  }, [sitePlans]);

  useEffect(() => () => {
    for (const slot of Object.values(sitesRef.current)) slot.data?.setMap(null);
    sitesRef.current = {};
  }, []);

  // ── reconcile markers against the fleet on every change ─────────────────
  // Runs for: cache hydration, fresh snapshot, every SSE frame, org switch,
  // filter change, search highlight. Adds/moves/updates/removes markers —
  // never rebuilds the map.
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    const DomMarker = DomMarkerRef.current;
    if (!mapReady || !map || !maps || !DomMarker) return;

    const seen = new Set();
    let startedTween = false;

    /**
     * The tracked selection, minus the plates this fleet does not have.
     *
     * The selection is remembered per org and a decommissioned unit leaves its
     * plate behind for good. A stale one that matches NOTHING would hide every
     * marker on the map with nothing on screen saying why — the same failure
     * the focus pill exists to prevent, but with no pill and no way back. So a
     * selection none of whose units exist is treated as no selection at all.
     */
    const liveTracked = trackedSet.size
      ? new Set(vehicles.filter(v => trackedSet.has(v.id)).map(v => v.id))
      : trackedSet;

    // ── camera FIRST, markers second ────────────────────────────────────────
    //
    // Both of these used to sit at the END of this pass, after every marker
    // had been created and drawn. That is what made the icons jump on opening
    // the screen: the map is constructed at DEFAULT_CENTER / zoom 7, the
    // fleet arrives synchronously from the localStorage cache, so 200-odd
    // markers were appended and painted against that default viewport — and
    // only then did fitBounds move the camera, forcing every one of them to
    // redraw at a completely different pixel. The markers were never in the
    // wrong place; the CAMERA was, and they were made visible before it caught
    // up.
    //
    // Moving the camera before any marker exists costs nothing (there is
    // nothing to redraw on the first pass) and there is no jump to smooth over
    // afterwards. On later passes the camera is already fitted and both blocks
    // are no-ops, so this is only a reorder of the first one.
    const located = vehicles.filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lng));

    // Fit the view once per company (deferred while the container is hidden —
    // fitting a 0×0 map produces a nonsense camera). Coordinates must be
    // FINITE, not just non-null: a NaN lat/lng in the localStorage-cached fleet
    // (hydrated on refresh/org switch) would corrupt the bounds — filter it out
    // and only mark the company fitted on success, so a bad cache retries once
    // fresh data lands.
    if (fittedCompanyRef.current !== activeCompanyId && located.length > 0) {
      const el = mapContainerRef.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0) {
        if (resetCamera(located)) {
          fittedCompanyRef.current = activeCompanyId;
          pendingFitRef.current = false;
        }
      } else {
        pendingFitRef.current = true;
      }
    }

    // One-time ?vehicle= deep link. Also a camera move, so it belongs on this
    // side of the marker loop for the same reason — a shared link would
    // otherwise paint the whole fleet at the fitted viewport and then fly.
    if (!deepLinkedRef.current && located.length > 0) {
      deepLinkedRef.current = true;
      const targetId = new URLSearchParams(window.location.search).get("vehicle");
      const match = targetId && located.find(v => v.id === targetId);
      if (match) {
        map.setView({ lat: match.lat, lng: match.lng }, 13);
        setSearchedId(match.id);
        setSelectedVehicleId(match.id);
        setTimeout(() => setSearchedId(null), 4000);
      }
    }

    for (const v of vehicles) {
      // SUKARI's ~600 vehicles come from RaiFactorySuite, which exposes no
      // coordinates at all, so this skips the whole body for most of that
      // fleet rather than doing per-vehicle work that can never produce a
      // marker.
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
      seen.add(v.id);

      let marker = markerMapRef.current[v.id];
      if (!marker) {
        marker = new DomMarker({
          position: { lat: v.lat, lng: v.lng },
          html:     markerIconHtml(markerState(v, alertOpts), { moving: v.onRoad, heading: v.heading, sprite: spriteKind(v),
                                                    dark: isDark(v), darkAge: isDark(v) ? darkAgeLabel(v) : "", name: mapLabel(v, labelCompanyRef.current) }),
          anchor:   "bottom",
          zIndex:   3,
          onClick: (e) => {
            // A tap gives us coordinates here too — on touch this is often the
            // only event that carries them (see onOver).
            notePointer(e);
            // Tapping the marker whose card is already open closes it — touch
            // devices never get a mouseleave, so this (plus tapping empty map
            // / panning) is how the card dismisses on mobile. The age check
            // stops the card closing during the very tap that opened it.
            if (hoveredIdRef.current === v.id && performance.now() - hoverOpenedAtRef.current > 600) {
              clearHover();
            }
            // Clicking a unit selects it: highlight, pinned card, feed.
            // It used to draw BOTH of its lines as well — the route and the
            // trip path — and no longer does (operator, 2026-10-02): the
            // track is asked for from the units list's route switch or the
            // card's Replay. A click that lands while a line is up for some
            // other unit takes that line away with the old selection.
            handleMarkerClick(v.id);
            clearTripPath();
          },
          onOver: (e) => {
            // Position the card from THIS event rather than from a previously
            // observed mouse position. On touch there is no real pointer to
            // have tracked: the browser synthesises a mousemove BEFORE the tap
            // fires mouseenter, so a listener attached in response to the hover
            // opening has already missed it. That left the card pinned at the
            // top-left corner of the screen on every phone — rendered, but
            // nowhere near the truck, which reads as "the modal didn't open".
            notePointer(e);
            hoveredIdRef.current     = v.id;
            hoverOpenedAtRef.current = performance.now();
            setHoveredId(v.id);
          },
          onOut: () => {
            if (hoveredIdRef.current === v.id) hoveredIdRef.current = null;
            setHoveredId(id => (id === v.id ? null : id));
          },
        });
        try {
          marker.setMap(map);
          marker._iconSig   = `${markerState(v, alertOpts)}|false|false|${Boolean(v.onRoad)}|${isDark(v)}`;
          marker._lastFixAt = performance.now();
          markerMapRef.current[v.id] = marker;
        } catch(e) {
          console.warn('[FleetMap] setMap failed for', v.id, e);
        }
      } else {
        // Glide to the new fix instead of teleporting (see startMarkerTween).
        // Skip tween on the very first render so markers appear settled in place
        // rather than flying in from a previous cached position.
        //
        // A unit being REPLAYED is exempt: its marker is being driven along a
        // recorded day by the playback cursor, and letting this pass also write
        // the live fix would drag it back to where the machine is standing now
        // on every SSE frame — the marker would jitter between two places
        // seconds and kilometres apart.
        if (playbackIdRef.current === v.id) {
          // left to the playback effect
        } else if (!isFirstRenderRef.current) {
          startMarkerTween(marker, v.lat, v.lng);
          if (marker._tween) startedTween = true;
        } else {
          // Snap to position silently on first render
          marker.setPosition({ lat: v.lat, lng: v.lng });
          marker._lastFixAt = performance.now();
        }
      }

      // Re-icon only when the visual state actually changed — avoids restarting
      // the pulse animation on every SSE frame. Heading is deliberately NOT in
      // the signature: it changes almost every fix, and a rebuild for it would
      // restart those animations constantly. It is applied separately below,
      // by moving the sprite offset on the element already in the DOM.
      const highlighted = activeRouteRef.current === v.id;
      const searched    = searchedId === v.id;
      const moving      = Boolean(v.onRoad);
      const heading     = markerHeading(marker, v);
      // Marker treatment is the ACTIVITY, not the raw status: an online
      // vehicle is green in transit, blue idling, slate parked. See
      // markerState in lib/vehicleMap.
      const mstate      = markerState(v, alertOpts);
      // Dark is part of the signature: a tracker crossing the 24 h line is a
      // visual state change like any other, and without it the marker would
      // keep its live styling until some unrelated field happened to move.
      // The AGE is deliberately not in the signature — it ticks every minute
      // and would rebuild the icon endlessly for a one-character difference.
      const dark        = isDark(v);
      const sig = `${mstate}|${highlighted}|${searched}|${moving}|${dark}`;
      /**
       * THE FRAME BELONGS TO PLAYBACK while a replay is up, exactly as the
       * position does a few lines above.
       *
       * Without this the unit did not hold its heading: `heading` here is where
       * the machine is pointing NOW, and the `else` branch rewrote the sprite
       * offset to it on every reconcile pass — mid-replay of a morning three
       * hours old. The `if` branch was worse: a live status change rebuilt the
       * marker's innerHTML, which both reset the frame and restarted the CSS
       * animations the playback effect goes out of its way not to disturb.
       *
       * Only the position was ever guarded. This is the same guard, for the
       * other half of what a marker shows.
       */
      if (playbackIdRef.current === v.id) {
        // left to the playback effect
      } else if (marker._iconSig !== sig) {
        // Sprite kind comes off the vehicle's equipment code, which never
        // changes, so it stays out of `sig` — it cannot be what invalidates.
        // CHANGED 2026-08-06: skip HTML rebuild while actively tweening.
        // Rebuilding during a glide resets CSS animations causing visible stutter.
        if (!marker._tween) {
          marker.setHtml(markerIconHtml(mstate, { highlighted, searched, moving, heading, sprite: spriteKind(v),
                                                  dark, darkAge: dark ? darkAgeLabel(v) : "", name: mapLabel(v, labelCompanyRef.current) }));
          marker._iconSig = sig;
          marker._headingFrame = truckFrame(heading);
        }
      } else {
        const frame = truckFrame(heading);
        if (marker._headingFrame !== frame) {
          marker.setTruckFrame(mstate, heading);
          marker._headingFrame = frame;
        }
      }

      /**
       * Visibility, strongest claim first.
       *
       * PLAYBACK outranks everything. A replay is a statement about one unit at
       * one past moment, and every other marker on screen is showing where its
       * machine is RIGHT NOW — two different clocks, drawn identically, on the
       * same map. Worse, the yard is where these units live: a replay of a
       * truck loading at the factory is a blue dot creeping through a crowd of
       * stationary ones it is being confused with. Hiding them is what makes
       * the replay legible.
       *
       * Then isolation, which outranks the status filter: a vehicle focused
       * from the feed is shown even if the active chip would exclude it —
       * "parked" filtered out while you click a parked vehicle's alert would
       * otherwise fly the camera to an empty field.
       */
      /* Type is a SECOND axis, and it narrows the status filter rather than
         competing with it — "offline excavators" is one question, not two.
         Both isolation cases still outrank it, for the reason above: flying
         the camera to a vehicle the funnel then hides is worse than showing
         one row the filter would have excluded. */
      /* Tracking is a THIRD axis, and since 2026-10-15 it is never narrowed:
         a tracked unit shows whatever the status, type or in-transit filter
         says, and a filter adds its matches alongside (operator: side panel
         clicks must not cancel tracked units). Both isolation cases still
         outrank it. matchesMapFilters is the one place all of this composes. */
      marker.setVisible(
        playbackIdRef.current ? v.id === playbackIdRef.current
        : focusedId          ? v.id === focusedId
        : matchesMapFilters(v, {
            filterKey: activeFilter,
            fleetTypes,
            trackedSet: liveTracked,
            inTransitOnly,
          }));

      // Keep an OPEN route growing as the vehicle moves.
      //
      // The track is fetched once, when the route is opened, so the drawn line
      // used to freeze at the last stored fix while the marker drove on ahead
      // of it — the further the truck got, the wider the gap between the truck
      // and the end of its own trail. Every live frame now extends the last
      // segment to the current position, so the breadcrumb stays attached to
      // the vehicle it belongs to.
      //
      // Only the ACTIVE route, and only a real move: a Polyline path write
      // re-rasterises the line, and doing that for GPS jitter on a parked unit
      // would be constant work for no visible change.
      if (activeRouteRef.current === v.id && Number.isFinite(v.lat)) {
        // The last real run of the track — never a dotted gap connector, whose
        // path is two points that must stay where they are. A line Google has
        // not finished building can throw from getPath; skip it for this frame
        // rather than take the whole map down with it.
        const line = routeLayerRef.current[v.id]?.tailLine;
        let path = null;
        try { path = line?.getPath() ?? null; } catch { path = null; }
        if (path) {
          const last = path.getLength() > 0 ? path.getAt(path.getLength() - 1) : null;
          const here = { lat: v.lat, lng: v.lng };
          if (!last || metresBetween({ lat: last.lat(), lng: last.lng() }, here) >= ROUTE_EXTEND_MIN_M) {
            path.push(new maps.LatLng(v.lat, v.lng));
          }
        }
      }
    }

    // Wake the parked tween loop if this pass gave anything to animate.
    if (startedTween) tweenKickRef.current?.();

    // Remove markers for vehicles no longer in this fleet (org switch).
    for (const id of Object.keys(markerMapRef.current)) {
      if (seen.has(id)) continue;
      markerMapRef.current[id].setMap(null);
      delete markerMapRef.current[id];
      hideRoute(id);
      // Cleared directly rather than through setActiveRoute: the marker is
      // already off the map, so the funnel's hideRoute/reIcon pair would be
      // working on something that no longer exists. The render mirror still
      // has to come with it, or a control keeps showing a route that is gone.
      if (activeRouteRef.current === id) { activeRouteRef.current = null; setRouteId(null); }
    }

    // `alertOpts` rather than `showFuelAlerts`: it is what the pass actually
    // reads, and it is memoised on that boolean, so the two re-run together —
    // this is the effect that repaints every flagged marker the moment the
    // toggle flips, instead of waiting for the next SSE frame to invalidate it.
    //
    // `playbackId` is listed even though the pass reads `playbackIdRef`. The
    // ref is what keeps the FRAME logic from rebuilding mid-replay; the STATE
    // is what has to re-run this pass twice — once when a replay starts, to
    // hide the rest of the fleet, and once when it ends, to bring them back.
    // Without it the fleet would linger until the next SSE frame happened to
    // invalidate the pass, which on a quiet night is minutes.
  }, [vehicles, mapReady, searchedId, activeFilter, fleetTypes, trackedSet, inTransitOnly, focusedId, activeCompanyId, alertOpts, playbackId, handleMarkerClick, clearHover, clearTripPath, hideRoute, setSelectedVehicleId, resetCamera, notePointer]);

  /* -- Marker clustering ----------------------------------------------------
   *
   * WHEN it runs: whenever there is more than one unit to look at.
   *
   * This used to require a filter - a tracked selection, a type or status chip,
   * or In transit - on the argument that a zoomed-out unfiltered fleet is a
   * picture of where the work is, and that collapsing it into badges takes
   * that away for a count nobody asked for.
   *
   * That argument was wrong about the unfiltered case, and the fleet's size is
   * why. At 597 units the whole-estate view is not a picture of where the work
   * is; it is a mat of overlapping pins where a yard holding thirty reads
   * exactly like a yard holding three, and the thing the argument was
   * protecting - seeing the distribution - is the first thing the overlap
   * destroys. A badge saying 30 is MORE of that picture than thirty icons
   * stacked on one pixel, not less.
   *
   * So the filter condition is gone and the grid pass runs over whatever is
   * currently shown. It was always written that way: it clusters the markers
   * that survive the filters rather than the whole fleet, so a narrowed view
   * behaves exactly as it did before and an unfiltered one now behaves the
   * same. Zooming in still breaks the badges apart at the same threshold -
   * nothing is hidden, it is grouped until there is room for it.
   *
   * Isolation and playback still switch it off outright: both are already
   * showing exactly one unit, so there is nothing to group.
   */
  const clusteringOn = !focusedId && !playbackId;
  const clusteringOnRef = useRef(false);
  clusteringOnRef.current = clusteringOn;

  /** key -> DomMarker for the badges, and key -> member ids for what they carry. */
  const clusterLayerRef   = useRef({});
  const clusterMembersRef = useRef({});
  /** The hovered cluster's member ids, or null. Drives the list panel. */
  const [hoveredClusterIds, setHoveredClusterIds] = useState(null);
  const clusterTipRef = useRef(null);

  /** vehicle id -> the ms timestamp its clustering exemption runs out. */
  const clusterExemptRef = useRef(new Map());
  /** Pending re-cluster for the moment the next exemption lapses. */
  const exemptTimerRef = useRef(null);

  /** The cluster currently fanned out - { key, ids } - or null. */
  const spiderRef     = useRef(null);
  /** The DomMarker holding that fan's leg lines. */
  const spiderLegsRef = useRef(null);
  /** chunk key -> the badge standing for an unopened chunk of that fan. */
  const spiderBadgesRef = useRef({});
  /** Ids currently hidden BEHIND a chunk badge, so the cluster pass leaves
      their `clustered` flag alone instead of revealing them. */
  const spiderHiddenRef = useRef(new Set());
  /** drillChunk by ref - renderSpider wires it into every chunk badge's
      click, and drillChunk calls renderSpider straight back. */
  const drillChunkRef = useRef(null);
  /* runClusterPass by ref: clearSpider has to re-run the pass to put the
     badge back, and the pass calls clearSpider. One of the two edges has to
     be a ref or the useCallbacks cannot be ordered. */
  const runClusterPassRef = useRef(null);

  /**
   * Zoom in until a cluster's members are separate markers.
   *
   * fitBounds over the members, capped - see CLUSTER_MAX_ZOOM for why the cap
   * exists and what happens to units sharing one coordinate.
   */
  const zoomToCluster = useCallback((ids) => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!map || !maps || !ids?.length) return;

    const bounds = new maps.LatLngBounds();
    let n = 0;
    for (const id of ids) {
      const m = markerMapRef.current[id];
      if (!m) continue;
      const pos = m.getPosition();
      if (!Number.isFinite(pos?.lat) || !Number.isFinite(pos?.lng)) continue;
      bounds.extend({ lat: pos.lat, lng: pos.lng });
      n += 1;
    }
    if (!n) return;

    // The list panel is about a badge that is on its way out of existence.
    setHoveredClusterIds(null);

    // Units on ONE coordinate: fitBounds has nothing to fit, so step in
    // instead. They will not separate - that is the honest outcome for two
    // machines parked in the same bay - and the hover list is how you read
    // them apart.
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    if (ne.equals(sw)) {
      map.setView(ne, Math.min((map.getZoom() ?? 0) + 3, CLUSTER_MAX_ZOOM));
      return;
    }

    map.fitBounds(bounds, 90);
    maps.event.addListenerOnce(map, "idle", () => {
      if ((map.getZoom() ?? 0) > CLUSTER_MAX_ZOOM) map.setZoom(CLUSTER_MAX_ZOOM);
    });
    // Claim the camera, or the next reconcile pass's company fit would fling
    // the view straight back out - the same trap the focus path documents.
    fittedCompanyRef.current = activeCompanyId;
    pendingFitRef.current = false;
  }, [activeCompanyId]);

  /**
   * Fold a fan back up: offsets to zero, chunk badges and legs gone.
   *
   * `rerun: false` for the callers that are mid-pass or about to rebuild the
   * layer themselves - re-entering runClusterPass from inside it would rebuild
   * the layer underneath the loop that is walking it.
   */
  const clearSpider = useCallback(({ rerun = true } = {}) => {
    const sp = spiderRef.current;
    if (!sp) return;
    spiderRef.current = null;
    for (const id of sp.ids) markerMapRef.current[id]?.setOffset(0, 0);
    for (const k of Object.keys(spiderBadgesRef.current)) {
      spiderBadgesRef.current[k].setMap(null);
      delete spiderBadgesRef.current[k];
    }
    spiderHiddenRef.current = new Set();
    spiderLegsRef.current?.setMap(null);
    spiderLegsRef.current = null;
    if (rerun) runClusterPassRef.current?.();
  }, []);

  /**
   * Draw whatever the current fan state says.
   *
   * The fan is ONE ring, always. An opened chunk does not grow a little fan of
   * its own next to its siblings - it is spliced into the same ring in the place
   * its badge occupied, so a fan of eight chunks with the third open is a ring of
   * seven badges and twelve units, laid out by one call to spiderLayout. Nested
   * rings were the obvious design and the wrong one: a sub-ring big enough to
   * separate twelve markers is wider than the gap between its parent's feet, so
   * it lands on top of the neighbouring chunks.
   *
   * Idempotent: it tears down its own previous drawing first, so callers change
   * the state and call it rather than trying to patch the map.
   */
  const renderSpider = useCallback(() => {
    const map = mapRef.current;
    const DomMarker = DomMarkerRef.current;
    const sp = spiderRef.current;
    if (!map || !DomMarker || !sp) return;

    for (const k of Object.keys(spiderBadgesRef.current)) {
      spiderBadgesRef.current[k].setMap(null);
      delete spiderBadgesRef.current[k];
    }
    for (const id of sp.ids) markerMapRef.current[id]?.setOffset(0, 0);

    /* One flat list of feet: a chunk is one foot unless it is the open one, in
       which case its units take its place. */
    const nodes = [];
    for (const c of sp.chunks) {
      if (c.ids.length === 1 || sp.open === c.key) {
        for (const id of c.ids) nodes.push({ unit: id, key: "u:" + id });
      } else {
        nodes.push({ chunk: c });
      }
    }

    const feet = spiderLayout(nodes.length);
    const segments = [];
    const hidden = new Set();

    nodes.forEach((node, i) => {
      const fx = Math.round(feet[i].x);
      const fy = Math.round(feet[i].y);
      segments.push({ x1: 0, y1: 0, x2: fx, y2: fy });

      if (node.unit) {
        const m = markerMapRef.current[node.unit];
        if (!m) return;
        m.setClustered(false);
        m.setOffset(fx, fy);
        return;
      }

      const c = node.chunk;
      for (const id of c.ids) {
        markerMapRef.current[id]?.setClustered(true);
        hidden.add(id);
      }
      /* Same representative rule as a grid badge: the first member's sprite and
         status, with the count saying how many and the hover list saying which. */
      const lead = vehiclesRef.current?.find((v) => v.id === c.ids[0]);
      const html = clusterIconHtml(c.ids.length, {
        sprite: lead ? spriteKind(lead) : "truck",
        status: lead ? markerState(lead, alertOptsRef.current) : "parked",
      });
      const badge = new DomMarker({
        position: sp.at,
        html,
        anchor: "center",
        zIndex: 6,
        onClick: (e) => { notePointer(e); drillChunkRef.current?.(c.key); },
        onOver: (e) => { notePointer(e); setHoveredClusterIds(c.ids); },
        onOut: () => setHoveredClusterIds(null),
      });
      badge.setMap(map);
      badge.setOffset(fx, fy);
      spiderBadgesRef.current[c.key] = badge;
    });

    spiderHiddenRef.current = hidden;

    // Under the vehicle markers (3) and under the badges (6): the legs are
    // furniture, and nothing should be clicking them.
    spiderLegsRef.current?.setMap(null);
    const legs = new DomMarker({ position: sp.at, html: spiderLegsHtml(segments), anchor: "center", zIndex: 2 });
    legs.setMap(map);
    spiderLegsRef.current = legs;
  }, [notePointer]);

  /**
   * Fan a cluster out around the place it stood.
   *
   * Small clusters fan straight into units; big ones fan into chunk badges (see
   * chunkMembers). Either way the original badge goes, because a badge standing
   * for units the reader can already see would be claiming something untrue.
   * Clicking the same cluster again folds it, so the gesture is its own undo.
   */
  const spiderfy = useCallback((key, ids, at) => {
    const map = mapRef.current;
    const DomMarker = DomMarkerRef.current;
    if (!map || !DomMarker || !ids?.length || !at) return;
    if (spiderRef.current?.key === key) { clearSpider(); return; }
    clearSpider({ rerun: false });

    const chunks = chunkMembers(ids).map((g, i) => ({ key: key + "~" + i, ids: g }));
    spiderRef.current = { key, at, ids, chunks, open: null };

    const badge = clusterLayerRef.current[key];
    if (badge) { badge.setMap(null); delete clusterLayerRef.current[key]; }
    // The list panel described the badge that just went away.
    setHoveredClusterIds(null);
    renderSpider();
  }, [clearSpider, renderSpider]);

  /**
   * A click on a CHUNK badge inside an open fan.
   *
   * Small enough to show whole, it opens in place and its siblings stay as they
   * are - one open chunk at a time, so clicking a second closes the first. Still
   * too big, and it becomes the fan's new root and chunks again. That is the
   * 'chunk to chunk' path down to a single vehicle, and it terminates: every
   * chunk is strictly smaller than the cluster it came from.
   */
  const drillChunk = useCallback((chunkKey) => {
    const sp = spiderRef.current;
    if (!sp) return;
    const c = sp.chunks.find((x) => x.key === chunkKey);
    if (!c) return;
    if (c.ids.length > SPIDER_MAX_UNITS) { spiderfy(chunkKey, c.ids, sp.at); return; }
    sp.open = sp.open === chunkKey ? null : chunkKey;
    setHoveredClusterIds(null);
    renderSpider();
  }, [renderSpider, spiderfy]);

  drillChunkRef.current = drillChunk;

  /**
   * What a click on a cluster badge does - zoom, or fan.
   *
   * Zoom FIRST, whenever zooming would actually achieve something, because a
   * camera move that splits six units into a four and a two is the cheaper,
   * more legible step and it leaves the map honest about where things are.
   * The test is exact rather than a guess about zoom levels: project the
   * members onto the grid this map clusters by, at the deepest zoom a cluster
   * click is allowed to reach, and see whether they land in more than one
   * cell. If they do not, no amount of zooming will ever separate them - that
   * is the case the reader was stuck in, clicking a cluster of two and getting
   * nothing but camera - and the fan is what breaks it open.
   */
  const breakCluster = useCallback((key) => {
    const ids  = clusterMembersRef.current[key];
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!ids?.length || !map || !maps) return;

    /* Stamped before either outcome, because both are the same gesture: the
       reader asked to see these units individually, and the clusterer must
       stop arguing with that for a while whichever way it answered. */
    const until = Date.now() + CLUSTER_EXEMPT_MS;
    for (const id of ids) clusterExemptRef.current.set(id, until);

    const proj = map.getProjection();
    const zoom = map.getZoom() ?? 0;
    let splits = false;
    if (proj && zoom < CLUSTER_MAX_ZOOM) {
      const scale = 2 ** CLUSTER_MAX_ZOOM;
      const cells = new Set();
      for (const id of ids) {
        const pos = markerMapRef.current[id]?.getPosition();
        if (!Number.isFinite(pos?.lat) || !Number.isFinite(pos?.lng)) continue;
        const pt = proj.fromLatLngToPoint(new maps.LatLng(pos.lat, pos.lng));
        if (!pt) continue;
        cells.add(`${Math.floor((pt.x * scale) / CLUSTER_CELL_PX)}:${Math.floor((pt.y * scale) / CLUSTER_CELL_PX)}`);
        if (cells.size > 1) { splits = true; break; }
      }
    }

    if (splits) {
      // The camera is about to move, and a fan is a pixel arrangement.
      clearSpider({ rerun: false });
      zoomToCluster(ids);
      return;
    }
    spiderfy(key, ids, clusterLayerRef.current[key]?.getPosition());
  }, [clearSpider, spiderfy, zoomToCluster]);

  /**
   * One clustering pass over the markers that are currently shown.
   *
   * Reads the markers rather than `vehicles` on purpose: the marker map is
   * where the reconcile pass has already applied every visibility rule, so
   * this cannot disagree with it about who is on screen. `wantsVisible` is the
   * filters' answer alone - a marker culled off-screen still belongs to its
   * cluster, or panning would change the counts.
   */
  const runClusterPass = useCallback(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    const DomMarker = DomMarkerRef.current;
    if (!map || !maps || !DomMarker) return;

    const layer = clusterLayerRef.current;
    const dissolve = () => {
      for (const key of Object.keys(layer)) {
        layer[key].setMap(null);
        delete layer[key];
      }
      clusterMembersRef.current = {};
      for (const m of Object.values(markerMapRef.current)) m.setClustered(false);
      /* Offsets are not covered by setClustered(false): a folded-away fan
         would leave its members sitting 48 px off their own coordinates. */
      clearSpider({ rerun: false });
      setHoveredClusterIds(null);
    };

    if (!clusteringOnRef.current) { dissolve(); return; }

    const proj = map.getProjection();
    const zoom = map.getZoom();
    // No projection until the map's first idle, and no sensible grid without a
    // zoom. Leaving the markers alone is the right failure: unclustered is the
    // map working, just not helping yet.
    if (!proj || !Number.isFinite(zoom)) { dissolve(); return; }

    // WORLD pixels - the 256-px projection scaled by the zoom - so the grid is
    // anchored to the earth and not to the viewport. See lib/markerCluster.
    const scale = 2 ** zoom;
    const project = (pt0) => {
      const pt = proj.fromLatLngToPoint(new maps.LatLng(pt0.lat, pt0.lng));
      return pt ? { x: pt.x * scale, y: pt.y * scale } : null;
    };

    const points = [];
    const exempt = clusterExemptRef.current;
    const now = Date.now();
    /* When the earliest live exemption lapses, so the pass can wake itself up
       then instead of waiting for a camera move that may never come. */
    let nextLapse = Infinity;

    for (const [id, m] of Object.entries(markerMapRef.current)) {
      if (!m.wantsVisible()) continue;
      const pos = m.getPosition();
      if (!Number.isFinite(pos?.lat) || !Number.isFinite(pos?.lng)) continue;

      const until = exempt.get(id);
      if (until != null) {
        if (until > now) {
          /* Out of the grid entirely - not merely ungrouped. A unit left in
             `points` would still pull a neighbour into a cell with it and
             reappear as a badge of two, which is the thing being prevented. */
          /* ...but an exempt unit can still be standing behind a CHUNK badge
             in an open fan, and that badge is already speaking for it.
             Revealing it here would draw it twice. */
          if (!spiderHiddenRef.current.has(id)) m.setClustered(false);
          nextLapse = Math.min(nextLapse, until);
          continue;
        }
        exempt.delete(id);
      }
      points.push({ id, lat: pos.lat, lng: pos.lng });
    }

    clearTimeout(exemptTimerRef.current);
    if (Number.isFinite(nextLapse)) {
      // +50ms so the pass it triggers sees the exemption already expired.
      exemptTimerRef.current = setTimeout(() => runClusterPassRef.current?.(), nextLapse - now + 50);
    }

    const groups = clusterByGrid(points, { project });
    const live = new Set();
    let spiderSeen = false;

    for (const g of groups) {
      // A group of one is not a cluster - it is a vehicle, and it stays the
      // marker it already was.
      if (g.members.length < 2) {
        markerMapRef.current[g.members[0]?.id]?.setClustered(false);
        continue;
      }
      live.add(g.key);
      const ids = g.members.map(m => m.id);
      clusterMembersRef.current[g.key] = ids;

      /* A fanned-out cluster has no badge and no hidden members. This pass
         runs on every SSE frame, so without this branch the next frame
         would quietly re-hide the units the reader just spread out. The key
         stays in `live` so the sweep below leaves its member list alone. */
      if (spiderRef.current?.key === g.key) {
        spiderSeen = true;
        /* No setClustered here: which of these units are visible and which
           stand behind a chunk badge is renderSpider's answer, not this
           pass's, and overwriting it would empty every unopened chunk. */
        const stale = layer[g.key];
        if (stale) { stale.setMap(null); delete layer[g.key]; }
        continue;
      }
      for (const id of ids) markerMapRef.current[id]?.setClustered(true);

      /* The badge wears the FIRST member's sprite and status. A representative,
         not a summary: the count says how many, the hover list says which, and
         nothing here claims the group is uniform. */
      const lead = vehiclesRef.current?.find(v => v.id === ids[0]);
      const html = clusterIconHtml(ids.length, {
        sprite: lead ? spriteKind(lead) : "truck",
        status: lead ? markerState(lead, alertOptsRef.current) : "parked",
      });

      let badge = layer[g.key];
      if (!badge) {
        badge = new DomMarker({
          position: { lat: g.lat, lng: g.lng },
          html,
          anchor: "center",
          // Above the vehicle markers (3): a badge standing for six units must
          // not end up under a seventh.
          zIndex: 6,
          onClick: (e) => {
            notePointer(e);
            breakCluster(g.key);
          },
          onOver: (e) => {
            notePointer(e);
            setHoveredClusterIds(clusterMembersRef.current[g.key] ?? null);
          },
          onOut: () => setHoveredClusterIds(null),
        });
        badge.setMap(map);
        layer[g.key] = badge;
        badge._clusterHtml = html;
      } else {
        badge.setPosition({ lat: g.lat, lng: g.lng });
        // Only on a real change: rewriting innerHTML restarts the badge's
        // transition and makes a static cluster flicker on every idle.
        if (badge._clusterHtml !== html) { badge.setHtml(html); badge._clusterHtml = html; }
      }
    }

    for (const key of Object.keys(layer)) {
      if (live.has(key)) continue;
      layer[key].setMap(null);
      delete layer[key];
      delete clusterMembersRef.current[key];
    }

    /* Is the fan still standing for something?

       Not `spiderSeen`: its members are exempt from clustering the moment
       they are fanned, so their cell stops producing a group at all and a
       group-based test would fold the fan on the very next pass. What matters
       is whether the UNITS are still here - a filter can take one away, and a
       fan of one is a leg pointing at a single marker. `spiderSeen` still
       earns its place above: once the ten minutes lapse the group comes back,
       and without that branch a badge would be drawn over an open fan. */
    void spiderSeen;
    if (spiderRef.current) {
      const alive = spiderRef.current.ids.filter((id) => markerMapRef.current[id]?.wantsVisible());
      if (alive.length < 2) clearSpider({ rerun: false });
    }
  }, [notePointer, breakCluster, clearSpider]);

  /* Published for clearSpider, which cannot name runClusterPass directly.
     Assigned during render rather than in an effect so the first click,
     which can land before effects have flushed, still finds a pass to run. */
  runClusterPassRef.current = runClusterPass;

  /**
   * A fan is an arrangement in PIXELS, so it survives nothing that changes
   * what a pixel means. Zooming re-cuts the grid the fan was built from, and
   * clicking empty map is the gesture this app already uses for "never mind".
   *
   * Not `drag`/`idle`: panning does not move a fan relative to its members
   * (the offsets are anchored to each unit's own projected point), and
   * folding it up because the reader nudged the map would be maddening.
   */
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!mapReady || !map || !maps) return undefined;

    let last = map.getZoom() ?? 0;
    const onZoom = () => {
      const z = map.getZoom() ?? 0;
      const out = z < last;
      last = z;
      /* Zooming OUT cancels the ten-minute exemption outright.

         The exemption exists so that following one vehicle is not undone by
         the clusterer, and pulling the camera back is the reader saying they
         are done following it - they want the wider picture, and the wider
         picture is the one clustering is FOR. Left standing, the exemption
         would scatter a few hundred loose markers over a zoomed-out map for
         the rest of its run, which is the state clustering was added to fix.

         Zooming IN does not cancel it: that is still the reader closing in on
         the unit they opened the cluster to find. */
      if (out) clusterExemptRef.current.clear();
      clearSpider();
    };

    const ls = [map.addListener("zoom_changed", onZoom), map.addListener("click", () => clearSpider())];
    return () => { for (const l of ls) maps.event.removeListener(l); };
  }, [mapReady, clearSpider]);

  /**
   * Run it on camera changes and whenever the filtered set moves.
   *
   * `idle` rather than `zoom_changed`: a pass mid-zoom would cluster against a
   * zoom the reader has already left, and `idle` covers pans too - which
   * matter because a marker entering the viewport joins a cell.
   */
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!mapReady || !map || !maps) return undefined;
    runClusterPass();
    const l = map.addListener("idle", runClusterPass);
    return () => maps.event.removeListener(l);
  }, [mapReady, runClusterPass, clusteringOn, vehicles, activeFilter, fleetTypes,
      trackedSet, inTransitOnly, focusedId, playbackId]);

  /** Tear the layer down with the component, so nothing outlives the map. */
  useEffect(() => () => {
    for (const key of Object.keys(clusterLayerRef.current)) {
      clusterLayerRef.current[key].setMap(null);
    }
    clusterLayerRef.current = {};
    clusterMembersRef.current = {};
    spiderLegsRef.current?.setMap(null);
    spiderLegsRef.current = null;
    spiderRef.current = null;
    for (const k of Object.keys(spiderBadgesRef.current)) spiderBadgesRef.current[k].setMap(null);
    spiderBadgesRef.current = {};
    clearTimeout(exemptTimerRef.current);
  }, []);

  /** The hover list follows the cursor, exactly as the vehicle card does. */
  useEffect(() => {
    if (!hoveredClusterIds) return undefined;
    const place = (x, y) => {
      const node = clusterTipRef.current;
      if (!node) return;
      const { left, top } = tooltipOffset(x, y);
      node.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    };
    place(lastPointerRef.current.x, lastPointerRef.current.y);
    /* The badge's own `mouseleave` is not enough to close the list (operator,
       2026-10-20: the card "still follows around" after the cursor leaves the
       cluster). A badge removed or redrawn under the cursor by a cluster pass,
       a zoom or a pan never fires it, so the list went on following the
       pointer. Each move now asks whether the pointer is still on a badge. */
    const onMove = (e) => {
      if (!e.target?.closest?.(".lf-cluster")) { setHoveredClusterIds(null); return; }
      notePointer(e); const p = pointerXY(e); place(p.x, p.y);
    };
    const onLeave = (e) => { if (!e.relatedTarget) setHoveredClusterIds(null); };
    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseout", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseout", onLeave);
    };
  }, [hoveredClusterIds, notePointer]);

  // Release the isolation when the camera pulls back out.
  //
  // Only `zoom_changed` — not `idle`, which also fires on a pan, and panning
  // around a focused vehicle at street zoom is exactly what you do after
  // clicking its alert. The listener is attached only while something is
  // focused, so the common case costs nothing.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !focusedId) return;
    const l = map.addListener("zoom_changed", () => {
      if (map.getZoom() < FOCUS_EXIT_ZOOM) setFocusedId(null);
    });
    return () => l.remove();
  }, [focusedId, mapReady]);

  // An org switch rebuilds the whole marker set. A focus id left over from the
  // previous fleet matches nothing in the new one, which would hide every
  // vehicle on the map with no way to tell why.
  useEffect(() => {
    setFocusedId(null);
  }, [activeCompanyId]);

  // An org switch restores THAT organisation's map, not the last one's.
  //
  // These used to be forced off, which was the only way to stop a pressed
  // switch claiming a layer over a fleet that has none. It also meant the
  // answer to "what do I want to see here" was thrown away every time you
  // looked somewhere else — and with the provider's geofences retired it left
  // Mufindi arriving with nothing drawn at all, since its estate drawing was
  // reachable only by hand.
  //
  // lib/mapPrefs keys the answer by company instead: a layer this org has never
  // been asked about takes the default chosen for it (Mufindi opens on its
  // estate drawing, Kabras on its survey, the weighbridges off everywhere),
  // and one you switched stays switched for that org alone. A layer the new org
  // does not have is still never drawn — every consumer gates on its own
  // `planAllowed` / `siteAllowed` / `hasBridges`, so a stored "on" for a layer
  // that is not offered here is simply never read.
  //
  // The camera requests are cleared: arriving at an org is not the same as
  // asking to be taken to its scales, and the fits below decide for themselves
  // whether a first draw should move the view.
  useEffect(() => {
    const { filter, layers } = readMapPrefs(activeCompanyId);
    setActiveFilterState(filter);
    setShowPlan(layers.plan);
    setSiteOn(siteOnFor(activeCompanyId));
    setShowBridges(layers.bridges);
    setShowZones(layers.zones);
    setShowTraffic(LIVE_TRAFFIC_AVAILABLE && layers.traffic);
    setShowWeather(layers.weather);
    bridgeRequestedRef.current = false;
    zonesRequestedRef.current  = false;
    planRequestedRef.current   = false;
    planFittedRef.current      = false;
    // Every surviving survey's camera state. Arriving at an org is not the
    // same as asking to be taken to its yard, and a slot kept across the
    // switch must not carry a stale "already fitted" into a fresh visit.
    for (const slot of Object.values(sitesRef.current)) {
      slot.requested = false;
      slot.fitted    = false;
    }
  }, [activeCompanyId]);

  // ── tween loop: one rAF drives every marker glide ────────────────────────
  // Advances each active tween linearly (vehicles move at constant speed, so no
  // easing), and keeps an open route's live vertex pinned to the gliding marker.
  // Parks itself when nothing is tweening. It previously ran at 60 fps for the
  // lifetime of the page, walking all 224 markers every frame to discover that
  // none of them were moving — burning a frame's budget continuously and
  // keeping the tab from ever going idle. Telemetry only starts tweens once
  // per poll cycle, so the loop is genuinely idle most of the time.
  useEffect(() => {
    if (!mapReady) return;
    let raf = null;

    const anyTweening = () => {
      for (const m of Object.values(markerMapRef.current)) if (m._tween) return true;
      return false;
    };

    const step = () => {
      const now = performance.now();
      let active = false;
      for (const marker of Object.values(markerMapRef.current)) {
        const t = marker._tween;
        if (!t) continue;
        active = true;
        const k = Math.min(1, (now - t.start) / t.dur);

        marker.setPosition({
          lat: t.fromLat + (t.toLat - t.fromLat) * k,
          lng: t.fromLng + (t.toLng - t.fromLng) * k,
        });

        // ── ADDED 2026-08-05: smooth heading during tween ─────────────────
        // Previously the sprite heading was only updated once per GPS fix
        // (in the reconcile pass), so during the glide between two fixes the
        // icon kept pointing at the OLD heading while the position moved in
        // the NEW direction — causing the sideways-sliding appearance.
        //
        // Fix: during every tween frame, interpolate the heading from the
        // tween's departure bearing (_fromBearing) toward the leg's travel
        // bearing (_travelBearing), using the same progress scalar k.
        // _fromBearing is captured in startMarkerTween at the moment the
        // tween begins, so the rotation starts from wherever the sprite
        // was actually pointing, not from 0.
        //
        // We only update the DOM sprite (setTruckFrame) — not a full icon
        // rebuild — so pulse/ripple animations are never interrupted.
        if (t.fromBearing !== undefined && marker._tween) {
          const from  = t.fromBearing;
          const to    = marker._travelBearing ?? from;
          // Shortest-arc interpolation: always rotate through ≤180°.
          const delta = ((to - from + 540) % 360) - 180;
          const interpolatedHeading = (from + delta * k + 360) % 360;

          // The atlas is baked at TRUCK_HEADINGS discrete columns, so the
          // sprite only needs rewriting when the interpolated heading crosses
          // into a new column — not on every frame.
          const frame = truckFrame(interpolatedHeading);
          if (marker._headingFrame !== frame) {
            marker.setTruckFrame(marker._iconSig?.split('|')[0] ?? 'ok', interpolatedHeading);
            marker._headingFrame = frame;
          }
        }
        // ── END ADDED ─────────────────────────────────────────────────────

        if (k >= 1) marker._tween = null;
      }
      // Park when the last tween finishes. `kick` restarts us when the next
      // batch of fixes lands.
      raf = active ? requestAnimationFrame(step) : null;
    };

    const kick = () => {
      if (raf === null && anyTweening()) raf = requestAnimationFrame(step);
    };
    // The reconcile pass starts tweens outside this effect, so it signals here.
    tweenKickRef.current = kick;
    kick();

    return () => {
      tweenKickRef.current = null;
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [mapReady]);

  // Re-measure when the Fleet tab becomes visible again, and run any bounds
  // fit that was deferred while the container had zero size.
  useEffect(() => {
    if (desktopActiveTab !== "fleet" || !mapRef.current) return;
    const raf = requestAnimationFrame(() => {
      const map  = mapRef.current;
      const maps = mapsLibRef.current;
      if (!map || !maps) return;
      maps.event.trigger(map, "resize");
      if (pendingFitRef.current) {
        // Finite check — same NaN-in-cache hazard as the reconcile-pass fit.
        const located = vehiclesRef.current.filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lng));
        if (resetCamera(located)) {
          fittedCompanyRef.current = activeCompanyId;
          pendingFitRef.current = false;
        }
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [desktopActiveTab, activeCompanyId, resetCamera]);

  useEffect(() => {
    if (!showMobileMap) return;
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!map || !maps) return;
    const t1 = setTimeout(() => maps.event.trigger(map, "resize"), 120);
    const t2 = setTimeout(() => maps.event.trigger(map, "resize"), 350);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [showMobileMap]);

  // Always-on pointer capture. `pointerdown` fires ONCE per tap or click — not
  // continuously — so unlike the old window-level mousemove it costs nothing
  // and never touches React state. It guarantees the position is fresh before
  // any hover opens, covering mouse, touch and pen uniformly.
  useEffect(() => {
    const onDown = (e) => notePointer(e);
    window.addEventListener("pointerdown", onDown, { passive: true, capture: true });
    return () => window.removeEventListener("pointerdown", onDown, { capture: true });
  }, [notePointer]);

  // Follow the cursor by writing transform straight onto the card's node, and
  // ONLY while a card is open. Two things matter here:
  //   • the listener is not attached at all when nothing is hovered, so the
  //     common case costs nothing;
  //   • it never touches React state, so moving the mouse re-renders nothing.
  // Writing `transform` (not left/top) keeps it on the compositor.
  useEffect(() => {
    // PINNED is the hook's business now — it places, drags and remembers the
    // card. This effect is only for the hover card that follows the cursor.
    if (pinnedId || !hoveredId) return undefined;

    // Place it once, wherever the pointer was when it opened.
    const el = tooltipRef.current;
    if (el) {
      const { left, top } = tooltipOffset(lastPointerRef.current.x, lastPointerRef.current.y);
      el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }

    // A PINNED card stops there. Following the cursor is what makes a hover
    // card readable and what makes a clickable one impossible — the button
    // would retreat from the pointer aiming at it.
    if (pinnedId) return undefined;

    const onMove = (e) => {
      notePointer(e);
      const node = tooltipRef.current;
      if (!node) return;
      const p = pointerXY(e);
      const { left, top } = tooltipOffset(p.x, p.y);
      node.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [hoveredId, pinnedId, notePointer]);

  /**
   * Focus one vehicle, isolated — the live-feed notification target.
   *
   * Search uses zoom 13, which at this fleet's density still shows a dozen
   * neighbours; clicking "KTCB 419R is overdue" and getting a cluster defeats
   * the point. FOCUS_ZOOM is four steps in from there, which on this fleet
   * puts the subject alone in frame with the road it is on still visible.
   *
   * Also claims the camera (fittedCompanyRef), or the next SSE reconcile pass
   * would fling the view back out to the whole fleet — the same trap the estate
   * overlay hit.
   */
  /**
   * Put the map on screen.
   *
   * ARRIVE, do not merely aim. FleetMap stays mounted behind the other tabs
   * and on a phone it sits behind a button, so a camera move alone succeeds in
   * every sense except the one that matters: the reader is on Drivers, or
   * Maintenance, and the map they were taken to is not on screen. Being taken
   * to a place you cannot see is not being taken there.
   *
   * Every entry point that changes what the map draws calls this — the status
   * cards, the machine-type and movement filters, the Units list, the layer
   * switches, a vehicle, a scale. They are all sidebar controls, the sidebar
   * is on every page, and none of them mean anything anywhere else.
   *
   * Setting a tab to what it already is costs nothing, so callers do not have
   * to check first.
   */
  const revealMap = useCallback(() => {
    setShowMobileMap(true);
    setDesktopActiveTab("fleet");
    setMobileActiveTab("map");
  }, [setDesktopActiveTab, setMobileActiveTab]);

  // A picked place: frame it, and leave a pin on it until the next pick.
  const placePinRef = useRef(null);
  const handlePickPlace = useCallback((place) => {
    const map = mapRef.current, maps = mapsLibRef.current, DomMarker = DomMarkerRef.current;
    if (!map || !maps || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return;
    revealMap();
    const [south, north, west, east] = place.bbox ?? [];
    if ([south, north, west, east].every(Number.isFinite) && (north - south > 1e-4 || east - west > 1e-4)) {
      map.fitBounds(new maps.LatLngBounds({ lat: south, lng: west }, { lat: north, lng: east }), 40);
      // A building-sized box would zoom past anything useful.
      if (map.getZoom() > 17) map.setZoom(17);
    } else {
      map.setView({ lat: place.lat, lng: place.lng }, 16);
    }
    placePinRef.current?.setMap(null);
    if (DomMarker) {
      const pin = new DomMarker({
        position: { lat: place.lat, lng: place.lng }, anchor: "bottom", zIndex: 890,
        html: `<div class="mtr-place-pin" title="${esc(place.detail ?? place.name)}"><i class="ti ti-map-pin-filled"></i></div>`,
      });
      pin.setMap(map);
      placePinRef.current = pin;
    }
  }, [revealMap]);
  useEffect(() => () => placePinRef.current?.setMap(null), []);


  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { registerReveal(revealMap); }, [revealMap]);

  const handleFocusVehicle = useCallback((vehicleId) => {
    const map = mapRef.current;
    if (!map || !vehicleId) return;
    // Feed events identify a vehicle by CUID (`vehicleId`), but a mapped vehicle
    // is keyed for markers by PLATE (`id`) — see lib/vehicleMap. Match on the
    // cuid first, fall back to the marker key, then use the vehicle's own `id`
    // downstream so the halo and detail panel line up with the marker.
    const v = vehiclesRef.current.find(x => x.vehicleId === vehicleId)
           ?? vehiclesRef.current.find(x => x.id === vehicleId);
    if (!v || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) return false;

    /* Below the early return on purpose: a unit with no coordinates cannot be
       framed, and throwing the reader onto the map to show them nothing is
       worse than leaving them where they are. The pending-focus effect keeps
       retrying until the unit has a position or the TTL runs out. */
    revealMap();

    fittedCompanyRef.current = activeCompanyId;
    pendingFitRef.current = false;

    map.setView({ lat: v.lat, lng: v.lng }, FOCUS_ZOOM);
    setFocusedId(v.id);           // isolate: every other marker goes away
    setSearchedId(v.id);          // reuse the search halo so the subject is obvious
    setSelectedVehicleId(v.id);   // and open its detail panel
    setTimeout(() => setSearchedId(null), 6000);
    return true;
  }, [activeCompanyId, setSelectedVehicleId, revealMap]);

  /**
   * Put back the unit that was selected when the page was reloaded.
   *
   * The way a marker click leaves it — highlighted with its route, its card
   * pinned, the side panel open — with the camera brought to it, since the
   * view itself is not remembered. NOT handleFocusVehicle: that isolates the
   * map to one unit and calls revealMap, and a reload on the Drivers page must
   * stay on the Drivers page.
   *
   * Waits for the unit's marker, which the reconcile pass builds after the
   * fleet lands; a unit no longer in the fleet is let go rather than left
   * selected over an empty panel.
   */
  useEffect(() => {
    if (!restoredVehicleId || !mapReady) return undefined;
    const v = vehicles.find(x => x.id === restoredVehicleId);
    if (!v) {
      if (!vehiclesLoading && vehicles.length) markSelectionRestored(false);
      return undefined;
    }
    // The camera first: inside a cluster the unit has no marker of its own
    // until the map is zoomed in, so waiting for the marker would wait forever.
    //
    // Twice: now, and again when the map next settles. The opening fleet fit
    // has usually run a moment earlier and left a one-off `idle` listener that
    // caps the zoom at FIT_MAX_ZOOM — and the move below is what fires that
    // idle, so on its own the camera arrived at the unit and was zoomed
    // straight back out to fleet level.
    // The settle listener is deliberately not removed on cleanup: marking the
    // restore done re-runs this effect, and that must not cancel the move.
    const map = mapRef.current;
    const maps = mapsLibRef.current;
    if (map && Number.isFinite(v.lat) && Number.isFinite(v.lng)) {
      fittedCompanyRef.current = activeCompanyId;   // claim the camera from the fleet fit
      pendingFitRef.current = false;
      const move = () => {
        map.setView({ lat: v.lat, lng: v.lng }, RESTORE_ZOOM);
      };
      move();
      maps?.event.addListenerOnce(map, "idle", move);
    }
    // Then the highlight and the pinned card, once its marker exists.
    const put = () => {
      if (!markerMapRef.current[v.id]) return false;
      setActiveRoute(v.id, { draw: false });
      if (isCompactRef.current) setPinnedId(v.id);
      markSelectionRestored(true);
      return true;
    };
    if (put()) return undefined;
    const started = Date.now();
    const timer = setInterval(() => {
      if (put() || Date.now() - started > 10_000) { clearInterval(timer); markSelectionRestored(true); }
    }, 250);
    return () => clearInterval(timer);
  // vehicles: once the unit is in the list the timer does the rest.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredVehicleId, mapReady, vehicles.length > 0, vehiclesLoading]);

  /**
   * Take the camera to a unit picked from the fuel-alerts list, for the
   * incident window the list also asks for. Until 2026-10-03 this opened the
   * unit's side panel beside that window too (operator, 2026-09-27); it no
   * longer does — see the last paragraph. The window opens complete: what it
   * shows was read ahead for every open alert — see lib/fuelPrefetch.
   *
   * Still not handleFocusVehicle, which also isolates the unit and hides every
   * other marker; the alert is about one unit, the map stays the fleet's.
   *
   * Centring alone put the unit under the incident window, which sits in the
   * middle of the map (operator, 2026-09-28: "when the modal is opened then we
   * also need to zoom into the vehicle"), so the map then glides it into the
   * clear once the window and the panel have settled — see lib/clearView.
   *
   * Not on a phone. There the side panel is a bottom sheet, so the tap opened
   * two modals at once, the sheet over the incident window (operator,
   * 2026-09-30: "leave only the critical modal on the mobile view"). The
   * incident window alone, and any sheet already open is closed under it.
   *
   * And now not on a desk either (operator, 2026-10-03: "whenever I click on
   * the item in the fuel alerts it opens two modals, the middle one and the
   * side panel"). The incident window carries the unit's card and the alert,
   * so the side panel beside it was the same unit twice. The window alone, at
   * every width, and a panel already open is closed under it.
   */
  const handleShowIncidentUnit = useCallback((vehicleId) => {
    const map = mapRef.current;
    const v = vehiclesRef.current.find(x => x.id === vehicleId)
           ?? vehiclesRef.current.find(x => x.vehicleId === vehicleId);
    if (!map || !v || !Number.isFinite(v.lat) || !Number.isFinite(v.lng)) return;
    revealMap();
    fittedCompanyRef.current = activeCompanyId;
    pendingFitRef.current = false;
    map.setView({ lat: v.lat, lng: v.lng }, FOCUS_ZOOM);
    panClearOfWindows(map, { lat: v.lat, lng: v.lng });
    setSearchedId(v.id);
    setSelectedVehicleId(null);
    setTimeout(() => setSearchedId(null), 6000);
  }, [activeCompanyId, revealMap, setSelectedVehicleId]);


  // Register focus function with context so AppHeader search can trigger zoom
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { registerFocus(handleFocusVehicle); }, [handleFocusVehicle]);

  /**
   * Take the camera to a weighbridge — the sidebar's Weighbridges rows.
   *
   * Turns the LAYER on first. A row that flew to a scale and left the layer off
   * would land on an empty field: the marker the operator asked to see is the
   * thing the switch draws. The toggle is written through to the same prefs the
   * layer's own switch writes, so the two cannot disagree about what is on.
   *
   * Claims the camera the way handleFocusVehicle does, or the next SSE
   * reconcile flings the view back out to the whole fleet.
   */
  const handleFocusBridge = useCallback((bridge) => {
    const map = mapRef.current;
    if (!map || !Number.isFinite(bridge?.lat) || !Number.isFinite(bridge?.lng)) return;

    /* The layer goes on, but WITHOUT `bridgeRequestedRef`.
     *
     * That ref is how a deliberate flick of the layer switch asks the marker
     * effect to frame all the scales at once (see the note beside it below).
     * Here the operator has named one, and fitting the whole set would throw
     * the camera straight back off the scale they clicked. */
    if (!showBridges) {
      writeMapPrefs(activeCompanyId, { layers: { bridges: true } });
      setShowBridges(true);
    }

    // The scale has to be on screen to have been arrived at.
    revealMap();

    fittedCompanyRef.current = activeCompanyId;
    pendingFitRef.current = false;
    map.setView({ lat: bridge.lat, lng: bridge.lng }, BRIDGE_FOCUS_ZOOM);
  }, [activeCompanyId, showBridges, revealMap]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { registerFocusBridge(handleFocusBridge); }, [handleFocusBridge]);

  // Register the playback starter so the vehicle panel's "Playback" button can
  // replay a unit's day — same steps as the vehicle card's own Playback action.
  const startPlaybackFor = useCallback((plate) => {
    if (!plate) return;
    setActiveRoute(null);
    clearTripPath();
    setPlaybackDay(todayFleetDay());
    setPlaybackId(plate);
    closeCardsForReplay();
  }, [setActiveRoute, clearTripPath, closeCardsForReplay]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { registerPlayback(startPlaybackFor); }, [startPlaybackFor]);

  /* The filter registration lives further down, beside `handleFilter`.
   *
   * It used to sit here and register `setActiveFilter` — the raw setter — which
   * is why a sidebar stat card changed the markers and left the camera fitted
   * to the whole estate. See the registration below for what the difference
   * buys, and note that `handleFilter` is declared after this point, so the
   * effect cannot be hoisted back up here. */

  // Watch for external focus requests (e.g. from SensorPanel "View on Map").
  //
  // The request can arrive before the vehicle does. The units list asks for a
  // unit in ANOTHER organisation and switches to it, so this fires while that
  // company's snapshot is still loading and `vehiclesRef` still holds nothing
  // — and the old version cleared the request regardless, which meant the
  // focus was silently dropped exactly when it had been asked for hardest.
  // So the request is held until it can be honoured: the effect re-runs as the
  // fleet arrives, and gives up after PENDING_FOCUS_TTL_MS rather than
  // pouncing on a unit the operator asked for minutes ago.
  /* Take me to that survey.
   *
   * Switches the layer on if it is off and frames it either way — `requested`
   * is what tells the build effect this was asked for, which is the same flag
   * a press on the layers menu sets, so the two routes cannot drift.
   *
   * Guarded on the request COUNT rather than on the id. The effect sets
   * `siteOn`, which it also reads, so an id-guard would re-enter on its own
   * state change and hand React a fresh object every pass.
   *
   * Nothing is written to stored preferences for a GUEST: prefKey is null on
   * one, and a visit must not leave a setting behind it. */
  const sitePlanReqRef = useRef(0);
  useEffect(() => {
    const req = sitePlanRequest;
    if (!req?.id || req.n === sitePlanReqRef.current) return;
    const plan = sitePlans.find((p) => p.id === req.id);
    if (!plan) return;
    // Before mapReady there is nothing to frame; the request is left unmarked
    // so it runs again the moment the map exists.
    if (!mapReady) return;
    sitePlanReqRef.current = req.n;
    revealMap();
    siteSlot(plan.id).requested = true;
    if (siteOn[plan.id] && sitesRef.current[plan.id]?.data) {
      fitPlaceLayersRef.current(plan.id);   // already drawn: just go
      return;
    }
    if (plan.prefKey) writeMapPrefs(activeCompanyId, { layers: { [plan.prefKey]: true } });
    setSiteOn((prev) => ({ ...prev, [plan.id]: true }));   // the build effect frames it
  }, [sitePlanRequest, mapReady, sitePlans, siteOn, activeCompanyId, revealMap]);

  const pendingFocusSince = useRef(0);
  useEffect(() => {
    if (!pendingFocusId) { pendingFocusSince.current = 0; return; }
    if (!pendingFocusSince.current) pendingFocusSince.current = Date.now();
    if (!mapReady) return;
    if (handleFocusVehicle(pendingFocusId) || Date.now() - pendingFocusSince.current > PENDING_FOCUS_TTL_MS) {
      setPendingFocusId(null);
    }
  }, [pendingFocusId, mapReady, vehicles, handleFocusVehicle, setPendingFocusId]);

  // ── weighbridge markers ─────────────────────────────────────────────────
  //
  // A pin per physical SCALE, not per centre. Factory runs two and Oyani two,
  // and a ticket names the scale that took it, so collapsing a centre to one
  // marker would put one bridge's work on the other's pin.
  //
  // Positions are derived rather than supplied — the scale software sends a
  // centre code and a bridge number and no coordinates at all. See the server's
  // `weighbridge.geography` for how they were measured and how tightly the
  // fixes behind each one agreed.
  //
  // Plain Markers rather than a Data layer: there are six of them and they are
  // points, so the GeoJSON machinery the site plan needs would be ceremony
  // around an array of six. They reuse the site plan's `weighing` glyph on
  // purpose — a weighbridge should look the same wherever it is drawn.
  //
  // Placed AFTER `handleFocusVehicle` in this file deliberately: the card's
  // link calls it, so it has to be initialised before this effect's dependency
  // array is evaluated during render.
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!mapReady || !map || !maps || !showBridges || !hasBridges) return undefined;

    const card = hoverWindow(maps, map);
    bridgeWinRef.current = card;

    /**
     * Wire the card's backlink on the node we built, not on one found in the
     * document. The content is an HTML string — that is what an InfoWindow
     * takes — so the button inside cannot carry a React handler; `hoverWindow`
     * hands us the element instead, which is both simpler and correct when two
     * cards are open at once.
     */
    const wire = (el) => {
      const btn = el.querySelector("[data-wb-focus]");
      btn?.addEventListener("click", () => {
        card.close();
        handleFocusVehicle(btn.getAttribute("data-wb-focus"));
      });
    };

    const open = (bridge, marker, pin) =>
      card.open({ html: weighbridgeCard(bridge), anchor: marker, pin, onNode: wire });

    const markers = bridges.map((b) => {
      const marker = new maps.Marker({
        position: { lat: b.lat, lng: b.lng },
        map,
        icon: {
          url: siteIcon("weighing"),
          scaledSize: new maps.Size(26, 26),
          anchor: new maps.Point(13, 13),
        },
        // The native tooltip names the scale for a keyboard user and for anyone
        // whose pointer never settles long enough for the card.
        title: bridgeTitle(b),
        zIndex: 2,
      });

      marker.addListener("mouseover", () => {
        if (card.pinned) return;               // a clicked card holds the window
        card.enter();                          // cancel a close from the last pin
        open(b, marker, false);
      });
      marker.addListener("mouseout", () => card.leave());
      // Click PINS it. The card is hoverable either way now, but a pin is still
      // worth having: it survives the pointer going anywhere at all, which is
      // what you want while reading three weights off it.
      marker.addListener("click", () => open(b, marker, true));
      return marker;
    });

    bridgeMarkersRef.current = markers;

    // Close a pinned card on a click anywhere else, the way the layers menu
    // closes. Without it the only way to dismiss one is to open another.
    const mapClick = map.addListener("click", () => card.close());

    // Switching the layer on has to TAKE YOU THERE.
    //
    // Same rule as the site plan, and for the same reason: the scales are four
    // yards inside a fleet that spans two countries, so at the opening zoom six
    // markers land within a couple of pixels of each other and switching the
    // layer on does nothing an operator can see. A deliberate toggle is a
    // request to look at them; merely having the layer available is not, which
    // is why this reads the request ref rather than `showBridges`.
    if (bridgeRequestedRef.current) {
      fitPlaceLayersRef.current();
      bridgeRequestedRef.current = false;
    }

    return () => {
      mapClick.remove();
      for (const m of markers) { maps.event.clearInstanceListeners(m); m.setMap(null); }
      card.destroy();
      bridgeMarkersRef.current = null;
      bridgeWinRef.current = null;
    };
  }, [showBridges, hasBridges, bridges, mapReady, activeCompanyId, handleFocusVehicle]);

  // ── Live traffic ──────────────────────────────────────────────────────────
  // Google's TrafficLayer as a transparent overlay under every vector and
  // marker (the engine's g-tiles pane), on either base. Redrawn every
  // TRAFFIC_REDRAW_MS to pick up Google's own refresh.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !showTraffic) return undefined;
    let layer = null, gone = false;
    addGoogleTraffic(map)
      .then((l) => { if (gone) l.remove(); else layer = l; })
      .catch((err) => console.warn("Live traffic unavailable:", err.message));
    const timer = setInterval(() => { if (!document.hidden) layer?.refresh(); }, TRAFFIC_REDRAW_MS);
    return () => {
      gone = true;
      clearInterval(timer);
      layer?.remove();
    };
  }, [mapReady, showTraffic]);

  // ── Weather ───────────────────────────────────────────────────────────────
  // Google's current conditions on a grid over the view, re-read as the map
  // settles and every few minutes (lib/weatherLayer).
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !showWeather || !orgId) return undefined;
    setWeatherNote("loading…");
    return addWeatherLayer(map, async (b) => {
      const grid = await getWeatherGrid({ orgId, ...b });
      // Google refusing the key (Weather API off) reads as a bare map
      // otherwise; the rail button's title says why.
      setWeatherNote(!grid.enabled ? "not configured" : grid.refused ? `Google refused: ${grid.refused}` : null);
      return grid;
    }, { onError: () => setWeatherNote("failed") });
  }, [mapReady, showWeather, orgId]);

  // ── The pinned unit's routed line ─────────────────────────────────────────
  // Blue along TomTom's road route to the end of the current leg, with each
  // traffic section over it in the flow tiles' colours. Under the markers and
  // the travelled track (zIndex 0), so it reads as the road AHEAD.
  useEffect(() => {
    const map  = mapRef.current;
    const maps = mapsLibRef.current;
    if (!mapReady || !map || !maps || !(showTraffic || trackedRouting) || !pinnedRoute || !pinnedTarget) return undefined;
    const lines = [];
    const add = (path, color, weight, opacity) => {
      lines.push(new maps.Polyline({ map, path, strokeColor: color, strokeWeight: weight, strokeOpacity: opacity, zIndex: 0 }));
    };
    add(pinnedRoute.points, "#ffffff", 8, 0.9);
    add(pinnedRoute.points, ROUTE_COLOR, 4, 0.85);
    // Google's route carries no traffic sections (jams: null).
    for (const jam of pinnedRoute.jams ?? []) add(jam.points, JAM_COLOR[jam.magnitude] ?? JAM_COLOR[0], 6, 1);
    // The tracked unit's card names where it is going; the pin shows it.
    const DomMarker = DomMarkerRef.current;
    let pin = null;
    if (trackedRouting && DomMarker) {
      pin = new DomMarker({
        position: { lat: pinnedTarget.to.lat, lng: pinnedTarget.to.lng },
        html: routePinHtml("dest", ROUTE_COLOR, pinnedTarget.to.name ?? "Destination"),
        anchor: "center",
        zIndex: 2,
      });
      pin.setMap(map);
    }
    return () => { for (const l of lines) l.setMap(null); pin?.setMap(null); };
    // The target's coordinates, not the object, which is rebuilt every render.
  }, [mapReady, showTraffic, trackedRouting, pinnedRoute, pinnedTarget?.to.lat, pinnedTarget?.to.lng]); // eslint-disable-line react-hooks/exhaustive-deps


  /**
   * Search resolves a query to one vehicle and then focuses it — the SAME
   * isolate treatment a live-feed notification gets, deliberately shared rather
   * than reimplemented. Searching for a plate is an even stronger statement of
   * "show me this one" than clicking an alert, so it would be odd for search to
   * drop you at zoom 13 amid a dozen neighbours while a notification isolated
   * the subject at 17.
   *
   * Exact matches win over substring ones: typing a full plate should never
   * land on some other unit that merely contains it.
   */
  /* `handleSearch` / `handleSearchCleared` lived here.
   *
   * They flew the camera to whatever the left panel's search box resolved, and
   * refitted the fleet when it was cleared. That box filters the live feed now
   * and resolves no vehicle, so nothing raised either one. Flying to a unit is
   * unaffected — `handleFocusVehicle` still does it for marker clicks, feed
   * rows and the Units panel. `searchedId` also stays: the search halo it
   * drives is still raised by those paths. */

  /**
   * Drop the current vehicle selection — raised by the Live Feed's "All units"
   * button, which un-filters the feed back to the whole organisation.
   *
   * It undoes everything selecting a vehicle turned on, not just the panel
   * state: the route breadcrumb and the marker highlight live in refs in here,
   * so clearing only `selectedVehicleId` would leave a highlighted marker with
   * a route drawn under it and no panel explaining why.
   *
   * The camera moves ONLY if the view was isolated. handleSearchCleared always
   * refits because clearing a search always follows a fly-to; this button is
   * just as often pressed after an ordinary marker click, where yanking the
   * viewport back out to the whole fleet would be an unasked-for jump.
   */
  const handleClearVehicle = useCallback(() => {
    const prevId = activeRouteRef.current;
    if (prevId) {
      hideRoute(prevId);
      reIcon(prevId, {});
      activeRouteRef.current = null;
      setRouteId(null);
    }
    setSearchedId(null);
    setSelectedVehicleId(null);
    setFeedVehicleId(null);
    if (focusedId) {
      setFocusedId(null);
      const located = vehiclesRef.current.filter(v => Number.isFinite(v.lat) && Number.isFinite(v.lng));
      resetCamera(located);
    }
  }, [hideRoute, reIcon, setSelectedVehicleId, setFeedVehicleId, focusedId, resetCamera]);

  /* Leaving the map for another page clears it (appSlice tabChosen; operator,
   * 2026-10-20: "when we navigate back we should not see those components
   * until when invoked again"). The store has already dropped the selection,
   * the feed scope, the incident and the side-panel windows; this takes down
   * what the map holds itself. The camera stays where it was. */
  const clearedN = useRef(mapClearN);
  useEffect(() => {
    if (clearedN.current === mapClearN) return;
    clearedN.current = mapClearN;
    const prevId = activeRouteRef.current;
    if (prevId) {
      hideRoute(prevId);
      reIcon(prevId, {});
      activeRouteRef.current = null;
    }
    setRouteId(null);
    clearHover();
    clearTripPath();
    setPinnedId(null);
    setCardMinimized(false);
    setSearchedId(null);
    setFocusedId(null);
    setPlaybackId(null);
    setInvestigateSubject(null);
    setArrivalsOpen(false);
    setCameraId(null);
    setMeasuring(false);
    setMeasurePts([]);
  }, [mapClearN, hideRoute, reIcon, clearHover, clearTripPath]);

  // Visibility is applied inside the reconcile pass (it depends on activeFilter).
  //
  // The camera has to move too. Hiding the other markers is only half of what a
  // chip means: WARNING and CRITICAL usually select ONE unit out of hundreds,
  // and leaving the view fitted to the whole estate put that unit off-screen —
  // or a speck near the edge — so the chip read as "the map just emptied"
  // rather than "here is the vehicle you asked about".
  const handleFilter = useCallback((filterKey) => {
    /* A chip is a request to look at a group. On this fleet CRITICAL and
       WARNING usually select one unit out of hundreds, and the camera move
       below is most of the answer — none of which is visible from the Drivers
       page, where the same cards are on screen. */
    revealMap();
    setActiveFilter(filterKey);
    // Isolation and a group filter are contradictory: while focusedId holds,
    // the reconcile pass shows ONLY that vehicle, so the chip would change the
    // panel's counts and nothing on the map. Picking a chip means "show me this
    // group", which supersedes "show me only this one".
    setFocusedId(null);
    // A chip also ends tracking and takes the pinned card down: the operator
    // has moved on to a group, so the map shows that group alone (operator,
    // 2026-10-15: "the unit card to close… the tracking should be stopped and
    // clear the ui"). Fleet types and In transit do the same, below.
    endTracking();

    // The funnel narrows the candidate set BEFORE either branch, so both the
    // reset and the bounds fit frame what is actually drawn. Skipping it here
    // would fly the camera out to the whole estate to frame vehicles the type
    // filter is hiding.
    const located = vehiclesRef.current.filter(
      v => Number.isFinite(v.lat) && Number.isFinite(v.lng) && matchesMapFilters(v, {
        fleetTypes: fleetTypesRef.current,
        trackedSet: EMPTY_TRACKED,
        inTransitOnly: inTransitRef.current,
      }));
    // ALL is "show me everything again", which is the same camera the map opens
    // on and the same one clearing a search returns to — not a bounds fit.
    if (filterKey === "all") { resetCamera(located); return; }

    // The SAME predicate the reconcile pass uses for marker visibility, so the
    // camera cannot frame a different set than the one left on screen.
    const inFilter = located.filter(v => visibleUnderFilter(v, filterKey));
    // A chip whose units have no fix — or none at all — leaves the camera
    // alone. Fitting an empty set would throw the view somewhere arbitrary,
    // which is worse than not moving.
    if (inFilter.length === 0) return;
    fitTo(inFilter, { animate: true });
  }, [resetCamera, fitTo, setActiveFilter, revealMap, endTracking]);

  /* Hand the camera-moving handler to the shell, not the bare setter.
   *
   * Every out-of-map filter control routes through this: the sidebar stat
   * cards, the mobile status rail, and anything else that later calls
   * `applyFilter`. They then behave exactly like the map's own overlay chips —
   * same predicate, same camera — because they ARE the same function. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { registerFilter(handleFilter); }, [handleFilter]);

  // …and publish the current filter back out, so those controls can highlight
  // the active one no matter which of them (or the overlay chips) set it.
  useEffect(() => { publishFilter(activeFilter); }, [activeFilter, publishFilter]);

  /**
   * Follow the tracked selection with the camera.
   *
   * Hiding the other 594 markers is only half of what ticking four units
   * means: fitted to the whole estate they stay four specks, which reads as
   * "the map just emptied" rather than "here are your units". Same argument
   * the status chips make one function up, and the same two branches — a fit
   * while a selection holds, the opening camera when it is cleared.
   *
   * Skips its first run so a selection restored from storage does not fight
   * the per-company fit that happens as the fleet loads.
   */
  const trackedFitRef = useRef(true);
  useEffect(() => {
    if (!mapReady) return;
    if (trackedFitRef.current) { trackedFitRef.current = false; return; }

    const located = vehiclesRef.current.filter(
      v => Number.isFinite(v.lat) && Number.isFinite(v.lng) && matchesMapFilters(v, {
        fleetTypes: fleetTypesRef.current,
        trackedSet: trackedSetRef.current,
        inTransitOnly: inTransitRef.current,
      }));

    if (trackedSet.size === 0 && !inTransitOnly) { resetCamera(located); return; }
    if (located.length === 0) return;   // nothing to frame — leave the view alone
    // Picked units: framed whole and close (frameUnits). "In transit" alone
    // is a group, framed as the status chips frame theirs.
    if (trackedSet.size > 0) frameUnits(located);
    else fitTo(located, { animate: true });
  }, [inTransitOnly, trackedSet, mapReady, fitTo, frameUnits, resetCamera]);

  /**
   * A route drawn on a unit the selection now hides would be a line over an
   * empty patch of map, with its pins still labelled. Drop it with the marker.
   */
  useEffect(() => {
    if (trackedSet.size === 0 || !routeId) return;
    if (!trackedSet.has(routeId)) setActiveRoute(null);
  }, [trackedSet, routeId, setActiveRoute]);

  return (
    <div className={`fleet-map-body${namesOn ? " fleet-map--names" : ""}${measuring ? " mtr-measuring" : ""}`}>

      <div className={`map-layer${showMobileMap ? " map-layer--visible" : ""}`}>
        <div ref={mapContainerRef} className="gmap-fill" />

        {/* Scale (km over mi), the base map's credit, cursor coordinates.
            OSM's licence requires its attribution wherever its tiles show. */}
        <RouteCoveredCard covered={covered} onClose={() => setCovered(null)} />
        {/* The fuel alert's, halted unit's or picked unit's trip
            investigation, in its own floating window (IncidentInvestigation). */}
        <InvestigationWindow {...investigation} onClose={closeInvestigation} />
        <ArrivalsWindow arrivals={arrivals} onSelectUnit={handleFocusVehicle} onClose={() => setArrivalsOpen(false)} />
        <MapStatusBar
          map={mapReady ? mapRef.current : null}
          attribution={isGoogleBase(baseMap) ? GOOGLE_ATTRIBUTION : OSM_ATTRIBUTION}
          className="map-status--live"
        />

        {/* The base map on a phone or tablet: top left, at the head of the
            status chips' row, where the Map / Satellite toggle first stood
            (operator, 2026-10-10: "on mobile devices we can have the map
            selector on top where it was originally along the stats buttons").
            Below 1024 there is no tool rail, so without it the base map could
            not be changed at all. Google's own pair of icons on a phone, a
            folded map and a globe; their words on a tablet. Desktop keeps the
            choice in the rail's Maps panel. */}
        {baseToggle && (
          <div className="map-type-toggle" role="radiogroup" aria-label="Base map">
            {BASE_MAPS.map((b) => (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={baseMap === b.id}
                className={`map-type-btn${baseMap === b.id ? " map-type-btn--active" : ""}`}
                onClick={() => chooseBase(b.id)}
                // Why Google is not showing, when it could not be loaded.
                title={isGoogleBase(b.id) && baseNote ? baseNote : b.label}
                aria-label={b.label}
              >
                {b.id === "google-terrain" ? (
                  <svg className="map-type-ico" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                    <path d="M2.5 19.5 9 8l4 7 2.5-4 6 8.5Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
                  </svg>
                ) : b.id === "google-satellite" ? (
                  <svg className="map-type-ico" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                    <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6"/>
                    <path d="m4 16 5-5 4 4 2-2 5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
                  </svg>
                ) : b.id === "osm" ? (
                  <svg className="map-type-ico" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
                    <path d="M9 4v14M15 6v14" fill="none" stroke="currentColor" strokeWidth="1.6"/>
                  </svg>
                ) : (
                  <svg className="map-type-ico" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                    <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6"/>
                    <path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
                  </svg>
                )}
                <span className="map-type-txt">{b.short}</span>
              </button>
            ))}
          </div>
        )}

        {/* The status filters, for screens with no room for the sidebar's
            stat grid. This was two chips — CRITICAL and WARNING — which left
            ONLINE, IDLING, OFFLINE and ALL unreachable on a phone; ONLINE in
            particular is the count an operator checks first.

            It calls `handleFilter`, not `setActiveFilter`. The setter alone
            only hides the other markers: it leaves the camera fitted to the
            whole estate, so picking CRITICAL out of 597 units read as "the map
            just emptied" rather than "here is the one you asked about". */}
        {/* The tool rail, beside the sidebar — desktop only, where the sidebar
            exists. Below 1024 the map keeps its own camera rail and no more. */}
        {!isCompact && (
          <MapToolRail
            expanded={toolsExpanded}
            onToggleExpanded={toggleToolsExpanded}
            vehicles={vehicles}
            getBias={getSearchBias}
            onPickVehicle={handleFocusVehicle}
            onPickPlace={handlePickPlace}
            namesOn={namesOn}
            onToggleNames={toggleNames}
            /* Live traffic and weather are rail buttons of their own, so the
               Maps panel lists every layer but those. (The phone's layers menu
               in the camera rail still carries them — there is no rail there.) */
            layers={mapLayers.filter(l => l.id !== "traffic" && l.id !== "weather")}
            traffic={mapLayers.find(l => l.id === "traffic") ?? null}
            weather={mapLayers.find(l => l.id === "weather") ?? null}
            bases={GOOGLE_BASE_AVAILABLE ? BASE_MAPS : null}
            base={baseMap}
            onBase={chooseBase}
            baseNote={baseNote}
            onFitFleet={resetView}
            measuring={measuring}
            measureText={measureText}
            onToggleMeasure={toggleMeasure}
            zones={mapLayers.find(l => l.id === "zones") ?? null}
            halted={canDo("map:filter")
              ? { count: strandedVehicles.length, open: strandedOpen, onOpen: () => setStrandedOpen(v => !v) }
              : null}
          />
        )}

        <StatusRail
          vehicles={vehicles}
          loading={vehiclesLoading}
          activeFilter={activeFilter}
          onFilter={handleFilter}
          afterToggle={baseToggle}
        />

        {mapLibError && (
          <div className="map-load-error-overlay">
            <LoadError label="Map" onRetry={retry} fullSection />
          </div>
        )}


        {/* Zoom, camera reset and the layer menu. Google's own versions of the
            first two can only be anchored to a map edge, and every edge is
            covered here — see the map options. These sit in the free centre
            column instead.

            The layers menu joins them rather than keeping its own cluster: it
            is a map control, this is where an operator looks for one, and a
            fourth button in an existing rail costs no screen space at all. It
            replaced a 241x30 button row and a separate key box, both of which
            were floating in the only clear band the map has. */}
        <div className="map-cam-controls">
          <FuelAlertsMenu
            vehicles={flaggedVehicles}
            showOnMap={showFuelAlerts}
            onToggleMap={() => setShowFuelAlerts(v => { writeCache(FUEL_ALERTS_KEY, !v); return !v; })}
            onSelect={(id) => { handleShowIncidentUnit(id); requestIncident(id); }}
          />
          <MapLayersMenu layers={mapLayers} />
          <FleetsMenu
            vehicles={vehicles}
            inTransitOnly={inTransitOnly}
            onToggleInTransit={() => setInTransitOnly(v => !v)}
            flagged={strandedVehicles}
            onSelectFlagged={handleFocusVehicle}
          />
          <UnitsMenu
            vehicles={vehicles}
            trackedIds={trackedIds}
            onSetTracked={setTrackedIds}
            routeId={routeId}
            onToggleRoute={toggleRoute}
            onOpenDetail={handleOpenUnit}
            /* The same 30-second clock the stranded-stop list runs on. The
               recency column measures against NOW, so with no tick it would
               freeze at whatever "now" was when the panel opened and quietly
               claim every unit was fresh. */
            nowTick={nowTick}
            open={unitsOpen}
            onOpenChange={setUnitsOpen}
            /* A window beside the sidebar where the sidebar exists, the map's
               own popover where it does not — the same 1024 line FleetMap.scss
               hides the rail button on. */
            asWindow={!isCompact}
          />
          {/* Halted: opened from the left tool rail, below geofences
              (operator, 2026-10-07) — it was a sidebar row before. The window is FleetMap's because clicking a row
              in it moves the CAMERA — the sidebar owns the flag, nothing
              more. */}
          <StrandedWindow
            flagged={strandedVehicles}
            open={strandedOpen}
            onOpenChange={setStrandedOpen}
            onSelect={(id) => {
              handleFocusVehicle(id);
              // Draw the halt's investigation: the row's own unit and the
              // moment it stopped, as the window counts it.
              const row = strandedVehicles.find((r) => r.vehicle.id === id);
              const dbId = row?.vehicle?.vehicleId;
              if (row && dbId) setInvestigateSubject({ kind: "halt", vehicleId: dbId, sinceMs: row.why.sinceMs });
            }}
            /* The SAME tracking state the Units panel writes, not a second
               one: ticking a unit here and opening Units must show it already
               ticked, or the map is being narrowed by two lists that disagree
               about what they narrowed it to. */
            trackedIds={trackedIds}
            onSetTracked={setTrackedIds}
          />
          {/* The camera controls turn the corner — below 1024px.
              A single column of seven was 274px of a screen whose free height
              is often 450, which is what forced every menu panel to open into
              a sliver. The three CAMERA buttons are one group and read fine
              side by side, so they become the foot of an L: out, reset, in —
              left to right, ending under the menus. Reset sits BETWEEN the two
              zooms (operator, 2026-10-08), as the camera's centre control.

              At 1024 and up they stand back up into a column. The crowding the
              L solved is gone there: Map layers, Fleets and Units moved to the
              sidebar, so the rail is one menu and the camera rather than four
              and the camera. Zoom controls are a vertical stack everywhere
              else on the web and the reason to break that had expired.
              CSS-only — see the min-width: 1024px block in FleetMap.scss, which
              also re-sizes --rail-panel-max-h for the shorter rail. The order
              is set there too, because the vertical reading is in, reset, out
              while the horizontal one is out, reset, in. */}
          <div className="map-cam-row">
            <button
              type="button"
              className="map-cam-btn map-cam-btn--out"
              onClick={() => nudgeZoom(-1)}
              title="Zoom out"
              aria-label="Zoom out"
            >−</button>
            <button
              type="button"
              className="map-cam-btn map-cam-btn--reset"
              onClick={resetView}
              title="Reset the view, level the camera and go back to the whole estate"
              aria-label="Reset view"
            >⌖</button>
            <button
              type="button"
              className="map-cam-btn map-cam-btn--in"
              onClick={() => nudgeZoom(1)}
              title="Zoom in"
              aria-label="Zoom in"
            >+</button>
          </div>
        </div>


        {/* The top-centre band, which now holds ONE thing.
            It used to carry the two layer buttons and the map key as well —
            three floating boxes in the only clear space the map has, since
            MapOverlay pins a 336px rail down the left and a 340px down the
            right, both full-height at z-index 400. The layers moved into the
            control rail (MapLayersMenu); this is what was actually different
            in kind and had to stay on the map.

            Says why the rest of the fleet is missing. Without it an isolated
            map is indistinguishable from a broken one. Clicking releases the
            isolation, same as zooming out. */}
        {(focusedId || trackedIds.length > 0) && (
          <div className="map-top-band">
            {focusedId ? (
              <button
                type="button"
                className="focus-pill"
                onClick={() => setFocusedId(null)}
                title="Show the rest of the fleet"
              >
                <span className="focus-pill-dot" aria-hidden="true" />
                Showing <strong>{focusedId}</strong> only
                <span className="focus-pill-hint">zoom out to show the fleet</span>
              </button>
            ) : trackedIds.length > 0 ? (
              /* A tracked map is missing most of its fleet for exactly the same
                 reason an isolated one is, and needs the same sentence saying
                 so. Clicking clears the selection, as clicking the focus pill
                 releases the isolation. */
              <div className="focus-pill focus-pill--tracked tracked-pill">
                <span className="focus-pill-dot" aria-hidden="true" />
                {/* One unit is named: "Tracking 1 unit" left the reader to
                    remember which one, and whether it was the one on screen. */}
                <span>
                  {trackedIds.length === 1
                    ? <>Tracking <strong>{trackedIds[0]}</strong></>
                    : <>Tracking <strong>{trackedIds.length}</strong> units</>}
                </span>
                <button
                  type="button"
                  className="tracked-pill__clear"
                  onClick={() => setTrackedIds([])}
                  title="Stop tracking and show the whole fleet"
                >
                  Stop <span aria-hidden="true">{"×"}</span>
                </button>
              </div>
            ) : null}
          </div>
        )}


        {cameraId && (
          <VehicleCamera
            vehicle={vehicles.find(v => v.id === cameraId) ?? null}
            onClose={() => setCameraId(null)}
          />
        )}

        {playbackId && (
          <RoutePlayback
            plate={playbackVehicle?.id ?? playbackId}
            day={playbackDay}
            onDay={setPlaybackDay}
            cursor={pb.cursor}
            subscribe={pbSubscribe}
            events={pbEvents}
            points={pbPoints}
            t0={pb.t0}
            t1={pb.t1}
            playing={pb.playing}
            rate={pb.rate}
            skipped={pb.skipped}
            onToggle={pb.toggle}
            onSeek={pb.seek}
            onRate={pb.setRate}
            onClose={closePlayback}
            loading={pbLoading}
            error={pbError}
            summary={pbData && {
              points: pbData.points?.length ?? 0,
              fixes: pbData.fixes,
              distanceM: pbData.distanceM,
              truncated: pbData.truncated,
              gapSpans: pbGapSpans,
            }}
          />
        )}

        {/* The “✕ Close Map” pill stood here. Removed by request.
            The way out is the tab bar, which sits at z-index 1000 against this
            layer's 700 and so is never covered by it — that is what makes the
            pill removable rather than a trapdoor. Its 42px line is given back
            to --map-bottom-band in FleetMap.scss, which every rail menu clears,
            so the units panel gains 50px of height on a phone. */}
      </div>


      {/* The two floating cards live HERE, beside MapOverlay — not inside
          `.map-layer` where they are drawn from.

          `.map-layer` is `position: absolute; z-index: 0`, which makes it a
          stacking context, and a stacking context is a ceiling: `z-index: 9999`
          on the hover card counted only against the map's own internals and
          could never reach past the 400 the overlay rails sit at. So the card
          followed the cursor correctly, painted correctly, and then slid
          underneath the left rail or the right one the moment the pointer
          approached either — which is most of a map that is 336px of chips and
          feed on one side and 340px of cards on the other.

          Moved rather than portalled to document.body: the light theme hangs
          off `.app--light` on a wrapper div, not on <body>, so a portal would
          escape the stacking context and the theme with it. As a sibling of
          the rails under `.fleet-map-body` — which is `position: relative`
          with no z-index of its own, so no ceiling — 9999 means what it says.

          Nothing about their placement changes: both are `position: fixed`
          and put where they go by a transform written straight onto the node,
          so where they sit in the tree was only ever about paint order. */}
        {/* Pinned wins over hovered: once a card is open for a unit, moving the
            mouse across other markers must not swap what it is describing out
            from under the button you are reaching for. */}
        {/* What a cluster badge is standing for: one row per unit, with what
            it is doing and how old that claim is. See ClusterList — the panel
            takes no pointer (it follows the cursor), so everything it says it
            says at a glance. */}
        {hoveredClusterIds && hoveredClusterIds.length > 0 && (
          <ClusterList
            ids={hoveredClusterIds}
            vehicles={vehicles}
            alertOpts={alertOpts}
            statusColors={STATUS_COLORS}
            nodeRef={clusterTipRef}
          />
        )}

        {(pinnedVehicle || hoveredVehicle) && (
          <VehicleTooltip
            vehicle={pinnedVehicle ?? hoveredVehicle}
            nodeRef={pinnedVehicle ? pinnedCardRef : tooltipRef}
            pinned={Boolean(pinnedVehicle)}
            onPointerDown={onCardPointerDown}
            minimized={cardMinimized}
            onToggleMinimize={() => setCardMinimized(m => !m)}
            zoomedIn={zoomedIn}
            onZoomTo={zoomToPinned}
            onZoomBack={zoomBack}
            cameraOn={cameraId === pinnedId}
            onToggleCamera={() => {
              cameraDetachedRef.current = false;
              setCameraId(id => (id === pinnedId ? null : pinnedId));
            }}
            replaying={Boolean(pinnedId) && playbackId === pinnedId}
            routeOn={Boolean(pinnedId) && routeId === pinnedId}
            // Off keeps the unit selected and highlighted — only the line
            // goes (`draw: false`), since the card is still open on it.
            onToggleRoute={() => {
              if (!pinnedId) return;
              setActiveRoute(pinnedId, routeId === pinnedId ? { draw: false } : undefined);
            }}
            onReplay={() => {
              // The static answers and the replay are answers to the same
              // question; showing both draws the day twice in two colours.
              //
              // BOTH layers, which is two clears rather than one: the
              // origin/destination route lives in routeLayerRef and the trip
              // path — its own polyline, its stop and fuel pins, and its
              // timestamp ticks — lives in tripLayerRef. Only the first was
              // being cleared, so starting a replay left the last twelve
              // hours drawn underneath it, complete with a second set of
              // event pins and a second set of ticks. The replay then drew its
              // path progressively over a path that was already finished,
              // which is the one thing a progressive draw cannot survive.
              setActiveRoute(null);
              clearTripPath();
              setPlaybackDay(todayFleetDay());
              setPlaybackId(pinnedId);
              closeCardsForReplay();
            }}
            onClose={() => {
              // Through the funnel, so the marker's highlight comes off with
              // the line — closing the card used to leave the unit lit up.
              if (activeRouteRef.current === pinnedId) setActiveRoute(null);
              setPinnedId(null);
            }}
            // The card's "Fuel Theft Alert" badge opens the unit's fuel theft
            // window and hands over to it: the window carries the same card,
            // so keeping this one open would show the unit twice (operator,
            // 2026-10-02). Only with an open incident to show — the window
            // renders nothing without one, and the card would close for nothing.
            onOpenTheft={pinnedVehicle?.status === "theft" && pinnedVehicle?.fuelIncident ? () => {
              requestIncident(pinnedVehicle.id);
              if (activeRouteRef.current === pinnedId) setActiveRoute(null);
              setPinnedId(null);
            } : undefined}
          />
        )}

      <MapOverlay
        onFocusVehicle={handleFocusVehicle}
        onClearVehicle={handleClearVehicle}
        onFilter={handleFilter}
        activeFilter={activeFilter}
        onViewMap={showMobileMapOn}
        showMobileMap={showMobileMap}
      />
      <FuelIncidentHost />
    </div>
  );
}

// The replay's drawing pieces, shared with the Logbook's day playback
// (screens/LogbookPlayback) so a day replays there exactly as it does here:
// the unit's own sprite, the trail, event pins, time ticks and minute dots.
export {
  markerIconHtml, makeDomMarkerClass, eventMarkerHtml, playbackTickHtml, minuteMarker,
  truckFrame, DRAWN_EVENT_KINDS, metresBetween,
};
