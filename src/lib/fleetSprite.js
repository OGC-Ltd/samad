// The live map's unit artwork as a Google Maps marker icon.
//
// FleetMap draws each unit from a baked atlas — public/<kind>-atlas.png, 24
// heading columns (clockwise from north) by 5 status rows — as a CSS
// background. A google.maps.Marker icon can cut the same cell out of the same
// image with `origin` + `scaledSize`, so any other map shows the very truck,
// tractor or excavator the operator knows from the live map, pointing the way
// it was going. The layout constants MUST stay in step with FleetMap's
// TRUCK_HEADINGS / TRUCK_STATUS_ROWS and scripts/bake-vehicle-atlas.mjs.

export const SPRITE_HEADINGS = 24;
export const SPRITE_ROWS = ["ok", "speeding", "theft", "parked", "idling"];

/** Compass heading → atlas column. */
export function spriteColumn(headingDeg) {
  const h = Number.isFinite(headingDeg) ? headingDeg : 0;
  return ((Math.round((h % 360) / (360 / SPRITE_HEADINGS)) % SPRITE_HEADINGS) + SPRITE_HEADINGS) % SPRITE_HEADINGS;
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

/**
 * The marker icon for `kind` (lib/vehicleMap spriteKind) drawn at `px`, facing
 * `heading`, in the colours of `status`.
 */
export function spriteIcon(maps, kind, { heading = 0, status = "ok", px = 40 } = {}) {
  const row = Math.max(0, SPRITE_ROWS.indexOf(status));
  return {
    url: `/${kind || "truck"}-atlas.png`,
    size: new maps.Size(px, px),
    origin: new maps.Point(spriteColumn(heading) * px, row * px),
    scaledSize: new maps.Size(px * SPRITE_HEADINGS, px * SPRITE_ROWS.length),
    anchor: new maps.Point(px / 2, px / 2),
  };
}
