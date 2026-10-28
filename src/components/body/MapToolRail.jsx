/**
 * The map's left tool rail, beside the sidebar.
 *
 * Eleven tools in three groups — finding (search, names, layers, fit), measuring
 * (ruler, route covered, traffic, geofences, halted, fuel alerts, dashcam alarms) and the rail's own expander. Desktop only:
 * FleetMap renders it where the sidebar exists (not `isCompact`), because a
 * phone already has its own controls and no room for a second column of them.
 *
 * Presentational apart from the search box, which owns its query and its
 * results; everything that touches the map is a callback from FleetMap.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import MapLayersMenu from "./MapLayersMenu";
import { findVehicleByQuery } from "../../lib/vehicleMap";
import { useAppSelector, useAppActions, useCompanies } from "../../context/AppContext";
import { useCrossOrgUnitHandoff } from "../../hooks/useCrossOrgUnits";
import UnitTypeIcon from "../shared/UnitTypeIcon";
import { usePermissions } from "../../hooks/usePermissions";
import "./MapToolRail.scss";

/* OpenStreetMap's geocoder: free, keyless, and limited to one request a second
   per client, which the 600 ms debounce on typing respects. */
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

// `tour`: the first-time tour's mark for this button (lib/productTour).
function RailButton({ icon, label, title, on = false, disabled = false, expanded, onClick, count = null, tone = "warn", tour }) {
  return (
    <button
      type="button"
      className={`mtr-btn${on ? " mtr-btn--on" : ""}`}
      data-tour={tour}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      title={title ?? label}
    >
      {count > 0 ? (
        // The count rides the icon's corner, as on the Maps button.
        <span className="mtr-btn__icon">
          <i className={`ti ${icon}`} aria-hidden="true" />
          <span className={`mtr-btn__count mtr-btn__count--${tone}`} data-digits={String(count).length}>{count}</span>
        </span>
      ) : (
        <i className={`ti ${icon}`} aria-hidden="true" />
      )}
      {expanded && <span className="mtr-btn__label">{label}</span>}
    </button>
  );
}

/** Every unit whose plate, name or DRIVER contains the term — the Units
 *  panel's search (from the first character, no cap), plus the driver, which
 *  the header's retired box (2026-10-07) also matched. An exact plate or name
 *  leads, then plates that start with the term, then the rest by plate. */
function matchUnits(vehicles, term) {
  const t = term.toLowerCase();
  const exact = findVehicleByQuery(vehicles, term);
  const rank = (v) => (v === exact ? 0 : String(v.id ?? "").toLowerCase().startsWith(t) ? 1 : 2);
  return (vehicles ?? [])
    .filter((v) => v === exact || [v.id, v.name, v.driver].some((f) => String(f ?? "").toLowerCase().includes(t)))
    .sort((a, b) => rank(a) - rank(b) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

/** "Online" for a live unit, otherwise when it was last heard from. */
function lastSeenLabel(v) {
  if (v.online) return "Online";
  const ms = v.capturedAtMs;
  if (!Number.isFinite(ms)) return "Never reported";
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "Last seen just now";
  if (mins < 60) return `Last seen ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Last seen ${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `Last seen ${days}d ago`;
  return `Last seen ${new Date(ms).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" })}`;
}

/** Vehicles first (they are what this map is for), then places. */
function SearchPanel({ vehicles, getBias, onPickVehicle, onPickPlace, onClose }) {
  const [q, setQ] = useState("");
  const [places, setPlaces] = useState([]);
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const term = q.trim();
  // Deferred like the Units panel: the match runs over the whole fleet.
  const unitTerm = useDeferredValue(term);
  const units = useMemo(() => (unitTerm ? matchUnits(vehicles, unitTerm) : []), [vehicles, unitTerm]);

  /* A unit in another of the operator's organisations, as in the Units panel:
     asked only once this fleet has no match; one answer switches there and
     focuses it, several are listed to pick from. */
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const { setActiveCompanyId, setPendingFocusId } = useAppActions();
  const { activeCompany, companies } = useCompanies();
  const { companies: elsewhere, loading: lookingElsewhere, move } = useCrossOrgUnitHandoff({
    query: unitTerm,
    enabled: Boolean(unitTerm) && units.length === 0,
    activeCompanyId,
    visibleCompanies: companies,
    setActiveCompanyId,
    setPendingFocusId,
  });

  useEffect(() => {
    if (term.length < 3) { setPlaces([]); setState("idle"); return undefined; }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setState("loading");
      try {
        const params = new URLSearchParams({ format: "jsonv2", limit: "6", q: term, "accept-language": "en" });
        // Biased to what is on screen, not bounded by it: a yard name finds the
        // nearby yard first, and a town two countries away still works.
        const b = getBias?.();
        if (b) params.set("viewbox", `${b.west},${b.north},${b.east},${b.south}`);
        const r = await fetch(`${NOMINATIM}?${params}`, { signal: ctl.signal });
        const rows = r.ok ? await r.json() : [];
        setPlaces(rows.map((row) => ({
          id: row.place_id,
          name: row.name || String(row.display_name).split(",")[0],
          detail: row.display_name,
          lat: Number(row.lat),
          lng: Number(row.lon),
          bbox: row.boundingbox?.map(Number) ?? null,   // [south, north, west, east]
        })));
        setState("done");
      } catch (e) {
        if (e.name !== "AbortError") setState("error");
      }
    }, 600);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [term, getBias]);

  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    if (e.key === "Enter") {
      if (units[0]) onPickVehicle(units[0].id);
      else if (places[0]) onPickPlace(places[0]);
    }
  };

  return (
    <div className="mtr-pop mtr-search" role="dialog" aria-label="Search the map">
      <div className="mtr-search__field">
        <i className="ti ti-search" aria-hidden="true" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Plate, driver, place or road"
          aria-label="Plate, driver, place or road"
        />
        {q && (
          <button type="button" className="mtr-search__clear" onClick={() => setQ("")} aria-label="Clear">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        )}
      </div>

      {units.length > 0 && (
        <div className="mtr-search__group">
          <div className="mtr-search__head">Vehicles</div>
          {units.map((v) => (
            <button type="button" key={v.id} className="mtr-search__row" onClick={() => onPickVehicle(v.id)}>
              <UnitTypeIcon vehicle={v} size={24} />
              <span className="mtr-search__text">
                <span className="mtr-search__name">{v.name || v.id}</span>
                <span className="mtr-search__detail">
                  {[v.name && v.name !== v.id ? v.id : null, v.driver].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className={`mtr-search__seen${v.online ? " mtr-search__seen--on" : ""}`}>{lastSeenLabel(v)}</span>
            </button>
          ))}
        </div>
      )}

      {unitTerm && units.length === 0 && (lookingElsewhere || elsewhere.length > 0) && (
        <div className="mtr-search__group">
          <div className="mtr-search__head">Vehicles</div>
          {lookingElsewhere
            ? <div className="mtr-search__note">Checking your other organisations…</div>
            : (
              <>
                <div className="mtr-search__note">Not in {activeCompany?.short || "this organisation"}. Found in:</div>
                {elsewhere.map(({ company, units: found }) => (
                  <button
                    type="button" key={company.id} className="mtr-search__row"
                    onClick={() => { move(company, found[0]); onClose(); }}
                    title={`Switch to ${company.name} and open ${found[0].plate}`}
                  >
                    <i className="ti ti-building" aria-hidden="true" />
                    <span className="mtr-search__text">
                      <span className="mtr-search__name">{company.short || company.name}</span>
                      <span className="mtr-search__detail">
                        {found.slice(0, 3).map((u) => u.plate).join(", ")}
                        {found.length > 3 ? ` +${found.length - 3}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
        </div>
      )}

      {unitTerm && units.length === 0 && !lookingElsewhere && elsewhere.length === 0 && term.length < 3 && (
        <div className="mtr-search__note">No unit matches that search.</div>
      )}

      {term.length >= 3 && (
        <div className="mtr-search__group">
          <div className="mtr-search__head">Places</div>
          {state === "loading" && places.length === 0 && <div className="mtr-search__note">Searching…</div>}
          {state === "error" && <div className="mtr-search__note">Place search is unavailable right now.</div>}
          {state === "done" && places.length === 0 && <div className="mtr-search__note">No Places Found</div>}
          {places.map((p) => (
            <button type="button" key={p.id} className="mtr-search__row" onClick={() => onPickPlace(p)}>
              <i className="ti ti-map-pin" aria-hidden="true" />
              <span className="mtr-search__text">
                <span className="mtr-search__name">{p.name}</span>
                <span className="mtr-search__detail">{p.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {!term && <div className="mtr-search__note">Type a plate, a driver, a place or a road.</div>}
    </div>
  );
}

export default function MapToolRail({
  expanded, onToggleExpanded,
  vehicles, getBias, onPickVehicle, onPickPlace,
  namesOn, onToggleNames,
  layers,
  bases, base, onBase, baseNote,   // base map choice, shown in the Maps panel
  onFitFleet,
  measuring, measureText, onToggleMeasure,
  route,            // { available, on, onToggle, title }
  traffic,          // the "traffic" map layer ({ on, onToggle }) or null
  weather,          // the "weather" map layer ({ on, onToggle, note }) or null
  zones,            // the "zones" map layer ({ on, onToggle, label }) or null
  halted,           // { count, open, onOpen } or null without map:filter
  fuelAlerts,       // { count, open, onOpen } or null without map:fuel_alerts
  arrivals,         // { open, onOpen } or null while Google routing is off
  dashcam,          // { count, critical, onOpen } or null where there are no VSS cameras
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const wrapRef = useRef(null);
  // Technicians get no route, traffic, geofence or arrivals tools: removed,
  // not drawn disabled (operator, 2026-10-27).
  const { flaggedOnly } = usePermissions();

  // The search panel closes on a press outside the rail, like the layers menu.
  useEffect(() => {
    if (!searchOpen) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setSearchOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [searchOpen]);

  const close = () => setSearchOpen(false);

  return (
    <div className={`mtr${expanded ? " mtr--expanded" : ""}`} ref={wrapRef}>
      <div className="mtr-card" role="toolbar" aria-label="Map tools" aria-orientation="vertical" data-tour="map-tools">
        <div className="mtr-group">
          <RailButton
            icon="ti-search" label="Search" title="Search for a plate, driver, place or road" tour="map-search"
            on={searchOpen} expanded={expanded} onClick={() => setSearchOpen((v) => !v)}
          />
          <RailButton
            icon={namesOn ? "ti-eye" : "ti-eye-off"} label={namesOn ? "Hide names" : "Show names"}
            title={namesOn ? "Hide vehicle names on the map" : "Show vehicle names on the map"}
            on={namesOn} expanded={expanded} onClick={onToggleNames}
          />
          <MapLayersMenu
            layers={layers} rail label={expanded ? "Maps" : null}
            bases={bases} base={base} onBase={onBase} baseNote={baseNote}
          />
          <RailButton
            icon="ti-scan" label="Fit fleet" title="Fit the whole fleet in view"
            expanded={expanded} onClick={onFitFleet}
          />
        </div>

        <div className="mtr-group">
          <RailButton
            icon="ti-ruler-measure" label="Measure"
            title={measuring ? "Stop measuring (Esc)" : "Measure a distance: click points on the map"}
            on={measuring} expanded={expanded} onClick={onToggleMeasure}
          />
          {!flaggedOnly && (<>
          <RailButton
            icon="ti-route" label="Route covered" title={route.title}
            on={route.on} disabled={!route.available} expanded={expanded} onClick={route.onToggle}
          />
          {/* Live traffic: its own tool rather than a row in the Maps panel. */}
          <RailButton
            icon="ti-traffic-lights" label={traffic?.on ? "Hide traffic" : "Live traffic"}
            title={traffic
              ? `${traffic.on ? "Hide" : "Show"} live traffic on the map`
              : "Live traffic is not available"}
            on={Boolean(traffic?.on)} disabled={!traffic} expanded={expanded} onClick={traffic?.onToggle}
          />
          {/* Weather, the same kind of switch (operator, 2026-10-27). */}
          <RailButton
            icon="ti-cloud-rain" label={weather?.on ? "Hide weather" : "Weather"}
            title={weather
              ? (weather.on && weather.note ? `Weather: ${weather.note}` : `${weather.on ? "Hide" : "Show"} live weather on the map`)
              : "Weather is not available"}
            on={Boolean(weather?.on)} disabled={!weather} expanded={expanded} onClick={weather?.onToggle}
          />
          {/* Drawn for every company, disabled where no geofence layer is
              offered — a tool that comes and goes between companies reads as
              a broken rail. */}
          <RailButton
            icon="ti-map-pins" label={zones?.on ? "Hide geofences" : "Show geofences"}
            title={zones
              ? `${zones.on ? "Hide" : "Show"} geofences (${zones.label})`
              : "No geofences are drawn for this company"}
            on={Boolean(zones?.on)} disabled={!zones} expanded={expanded} onClick={zones?.onToggle}
          />
          </>)}
          {/* Halted (operator, 2026-10-07: "right below geofences"): units
              that stopped mid-journey — on the highway or outside their
              geofences. Opens the same window the sidebar row used to. */}
          {halted && (
            <RailButton
              icon="ti-alert-triangle" label="Halted" tour="map-halted"
              title={halted.count
                ? `Halted: ${halted.count} ${halted.count === 1 ? "unit" : "units"} stopped mid-journey, on the highway or outside their geofences`
                : "Halted: no unit has stopped mid-journey, open the list anyway"}
              on={halted.open} count={halted.count} expanded={expanded} onClick={halted.onOpen}
            />
          )}
          {/* Fuel alerts, below Halted: open theft cases, in the alert red. */}
          {fuelAlerts && (
            <RailButton
              icon="ti-gas-station" label="Fuel alerts" tour="map-fuel"
              title={fuelAlerts.count
                ? `Fuel alerts: ${fuelAlerts.count} ${fuelAlerts.count === 1 ? "unit" : "units"} with an open fuel theft alert`
                : "Fuel alerts: none open, open the list anyway"}
              on={fuelAlerts.open} count={fuelAlerts.count} tone="alert" expanded={expanded} onClick={fuelAlerts.onOpen}
            />
          )}
          {/* Dashcam alarms, below Fuel alerts (operator, 2026-10-27): opens
              the Alarms page with each alarm's clip. Only where the
              organisation's vehicles carry VSS cameras. The count is today's
              warning and critical alarms not yet reviewed, red while one of
              them is critical. */}
          {dashcam && (
            <RailButton
              icon="ti-video" label="Dashcam alarms" tour="map-dashcam"
              title={dashcam.count
                ? `Dashcam alarms: ${dashcam.count} today not yet reviewed${dashcam.critical ? `, ${dashcam.critical} critical` : ""}`
                : "Dashcam alarms: nothing waiting today, open the list anyway"}
              count={dashcam.count} tone={dashcam.critical ? "alert" : "warn"}
              expanded={expanded} onClick={dashcam.onOpen}
            />
          )}
          {/* Arrivals at a hub: every unit's live drive time in. */}
          {arrivals && !flaggedOnly && (
            <RailButton
              icon="ti-target-arrow" label="Arrivals" tour="map-arrivals"
              title="Arrivals: who can reach a hub, and when, with live traffic"
              on={arrivals.open} expanded={expanded} onClick={arrivals.onOpen}
            />
          )}
        </div>

        <div className="mtr-group">
          <RailButton
            icon={expanded ? "ti-chevron-left" : "ti-chevron-right"} label={expanded ? "Collapse" : "Expand"}
            title={expanded ? "Collapse the tools" : "Show tool names"}
            expanded={expanded} onClick={onToggleExpanded}
          />
        </div>
      </div>

      {searchOpen && (
        <SearchPanel
          vehicles={vehicles}
          getBias={getBias}
          onPickVehicle={(id) => { close(); onPickVehicle(id); }}
          onPickPlace={(p) => { close(); onPickPlace(p); }}
          onClose={close}
        />
      )}

      {measuring && (
        <div className="mtr-pop mtr-measure" role="status" aria-live="polite">
          <i className="ti ti-ruler-measure" aria-hidden="true" />
          <span className="mtr-measure__value">{measureText ?? "Click the map to start"}</span>
          <span className="mtr-measure__hint">Backspace undoes · Esc ends</span>
        </div>
      )}
    </div>
  );
}
