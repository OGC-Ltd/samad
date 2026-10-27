// The strip along the foot of a map: a two-unit scale bar and the base map's
// attribution on the left, the cursor's coordinates on the right.
//
// Operator, 2026-10-04, with a screenshot of the look wanted: "2000 km" over
// "1000 mi" bars, "© OpenStreetMap contributors" under them, and
// "S -19° 09.3775' : W -026° 21.0386'" at the right.
//
// Nothing here is React state. The scale moves with every camera change and
// the coordinates with every mouse move; both are written straight into the
// DOM through refs, so the map's owner (FleetMap is 7k lines and re-renders
// MapOverlay with it) never re-renders for them.

import { useEffect, useRef } from "react";
import "./MapStatusBar.css";

/** Longest a scale bar may be, in px. */
const BAR_MAX = 110;

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

/** The largest 1 / 2 / 5 × 10ⁿ not above `v`. */
function niceFloor(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

/** One bar: its width in px and its label, for `mpp` metres per pixel. */
function metricBar(mpp) {
  const m = niceFloor(mpp * BAR_MAX);
  return { px: m / mpp, label: m >= 1000 ? `${m / 1000} km` : `${m} m` };
}
function imperialBar(mpp) {
  const maxMi = (mpp * BAR_MAX) / M_PER_MI;
  if (maxMi >= 1) {
    const mi = niceFloor(maxMi);
    return { px: (mi * M_PER_MI) / mpp, label: `${mi} mi` };
  }
  const ft = niceFloor((mpp * BAR_MAX) / M_PER_FT);
  return { px: (ft * M_PER_FT) / mpp, label: `${ft} ft` };
}

/** Degrees and decimal minutes, as in the operator's screenshot:
 *  hemisphere, signed zero-padded degrees, minutes to four places. */
function dm(value, pos, neg, degWidth) {
  const hemi = value < 0 ? neg : pos;
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = (abs - deg) * 60;
  if (Number(min.toFixed(4)) >= 60) { deg += 1; min = 0; }
  const d = String(deg).padStart(degWidth, "0");
  const mm = min.toFixed(4).padStart(7, "0");
  return `${hemi} ${value < 0 ? "-" : ""}${d}° ${mm}'`;
}
export const formatLatLng = (lat, lng) => `${dm(lat, "N", "S", 2)} : ${dm(lng, "E", "W", 3)}`;

/**
 * @param {object}  props
 * @param {google.maps.Map|null} props.map   the map to follow (null until it exists)
 * @param {{text:string,href:string}[]} [props.attribution]  base-map credit, if any
 * @param {string}  [props.className]        placement, per screen
 */
export default function MapStatusBar({ map, attribution = [], className = "" }) {
  const kmBar = useRef(null), kmTxt = useRef(null);
  const miBar = useRef(null), miTxt = useRef(null);
  const coords = useRef(null);

  useEffect(() => {
    if (!map) return undefined;

    let frame = 0;
    const drawScale = () => {
      frame = 0;
      const c = map.getCenter();
      const z = map.getZoom();
      if (!c || z == null) return;
      const mpp = (156543.03392 * Math.cos((c.lat() * Math.PI) / 180)) / 2 ** z;
      const k = metricBar(mpp), i = imperialBar(mpp);
      if (kmBar.current) { kmBar.current.style.width = `${k.px}px`; kmTxt.current.textContent = k.label; }
      if (miBar.current) { miBar.current.style.width = `${i.px}px`; miTxt.current.textContent = i.label; }
    };
    const queueScale = () => { if (!frame) frame = requestAnimationFrame(drawScale); };

    const showAt = (ll) => { if (ll && coords.current) coords.current.textContent = formatLatLng(ll.lat(), ll.lng()); };

    // The cursor's position while it is over the map; the map's centre
    // otherwise, so the readout never names a place the camera has left.
    let hovering = false;
    drawScale();
    showAt(map.getCenter());
    const ls = [
      map.addListener("zoom_changed", queueScale),
      map.addListener("center_changed", queueScale),
      map.addListener("mousemove", (e) => { hovering = true; showAt(e.latLng); }),
      map.addListener("mouseout", () => { hovering = false; }),
      map.addListener("idle", () => { if (!hovering) showAt(map.getCenter()); }),
    ];
    return () => {
      ls.forEach((l) => l.remove());
      if (frame) cancelAnimationFrame(frame);
    };
  }, [map]);

  return (
    <div className={`map-status ${className}`}>
      <div className="map-status__left">
        <div className="map-status__scale" aria-hidden="true">
          <div className="map-status__bar map-status__bar--km" ref={kmBar}>
            <span className="map-status__lbl" ref={kmTxt} />
          </div>
          <div className="map-status__bar map-status__bar--mi" ref={miBar}>
            <span className="map-status__lbl" ref={miTxt} />
          </div>
        </div>
        {attribution.length > 0 && (
          <div className="map-status__attrib">
            {attribution.map((a) => (
              <a key={a.href} href={a.href} target="_blank" rel="noopener noreferrer">{a.text}</a>
            ))}
          </div>
        )}
      </div>
      <div className="map-status__coords" ref={coords} />
    </div>
  );
}
