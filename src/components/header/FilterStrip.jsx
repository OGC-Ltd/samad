/* Expandable asset strip shown when a header KPI button is selected — port of
   fleetdash's FilterStrip onto fleettrack's theme tokens. Renders the live
   assets behind whichever stat is active:
     inTransit  → the whole active fleet (mid-journey + operational stops)
     product:*  → vehicles mid-journey carrying that product
     empty      → active vehicles with nothing to ferry (driving empty, or
                  docked loading / offloading / at the garage)
   Items render inline in a single row and auto-scroll in a continuous,
   non-interactive loop (like a news ticker). */
import { useLayoutEffect, useRef, useState } from "react";
import "./FilterStrip.scss";
import { productKey, vehiclesCarrying, emptyVehicles, plantVehicles } from "./StatKpis";

const COLOR = { ok: "#22c55e", warn: "#f59e0b", warning: "#f59e0b", crit: "#ef4444", critical: "#ef4444" };

const fmt = (n) => (n ?? 0).toLocaleString("en-US");

/**
 * The load figure on a chip — three distinct states, not one dash for all.
 *
 *   12t       carrying, measured
 *   no load   plant: carries nothing by design, and that is the full answer
 *   —         a carrier with nothing reported: we do not know, and say so
 *
 * The middle case is the whole point. A dozer showing "—" reads as a gap in the
 * data about a vehicle that should have had a load.
 */
function loadValue(v) {
  if ((v.tonnes ?? 0) > 0) return `${v.tonnes}t`;
  return v.bucket === "plant" ? "no load" : "-";
}

// Normalise each stat's payload into a common chip shape.
function buildStrip(stat, summary, cargoWord, products) {
  if (stat.startsWith("product:")) {
    const name = stat.slice("product:".length);
    const live = vehiclesCarrying(summary, name);
    const liveTonnes = +live.reduce((s, v) => s + (v.tonnes ?? 0), 0).toFixed(1);
    const catalog = products.find((p) => productKey(p.product) === productKey(name));
    return {
      title: `${name.toUpperCase()}: ${fmt(catalog?.tonnes ?? liveTonnes)} t FERRIED IN 30 DAYS, ${fmt(liveTonnes)} t IN TRANSIT`,
      items: live.map((v) => ({
        id: v.vehicleId, primary: v.plate, secondary: `${v.driver} · ${v.cargo}`,
        value: loadValue(v), status: v.status,
      })),
    };
  }
  if (stat === "plant") {
    const plant = plantVehicles(summary);
    return {
      title: `PLANT: ${plant.length} MACHINE${plant.length === 1 ? "" : "S"} WORKING`,
      items: plant.map((v) => ({
        id: v.vehicleId, primary: v.plate,
        // The machine, not the cargo: "Dozer" is the useful fact here, and
        // `cargo` on these units is the "No load expected" placeholder.
        secondary: `${v.driver} · ${v.machine ?? "plant"}`,
        value: loadValue(v), status: v.status,
      })),
    };
  }
  if (stat === "empty") {
    const empty = emptyVehicles(summary);
    // Why the vehicle is empty right now — its operational stop, or en route.
    const PHASE_WORD = { LOADING: "loading", UNLOADING: "offloading", OFFLOADING: "offloading", AT_GARAGE: "at garage" };
    return {
      title: `EMPTY: ${empty.length} VEHICLE${empty.length === 1 ? "" : "S"} WITHOUT CARGO`,
      items: empty.map((v) => ({
        id: v.vehicleId, primary: v.plate,
        secondary: `${v.driver} · ${PHASE_WORD[v.phase] ?? "en route"}`,
        // Docked vehicles show live load progress: what's come aboard so far
        // while loading, what's still on board while offloading.
        value: v.tonnes > 0 ? `${v.tonnes}t ${v.phase === "LOADING" ? "on" : "left"}` : "-",
        status: v.status,
      })),
    };
  }
  // inTransit — every vehicle out working, carriers and plant alike.
  const s = summary.inTransit;
  const plantCount = plantVehicles(summary).length;
  // Tonnage only claims the fleet is hauling when it is. Plant is named in the
  // title so the vehicle count is not read as "carriers with nothing loaded".
  const load = s.sugarTonnes > 0
    ? `${fmt(s.sugarTonnes)} t ${cargoWord.toUpperCase()}`
    : "CARGO NOT REPORTED";
  return {
    title: `IN TRANSIT: ${s.vehicleCount} VEHICLES, ${load}`
         + (plantCount > 0 ? `, ${plantCount} PLANT` : ""),
    items: s.vehicles.map((v) => ({
      id: v.vehicleId, primary: v.plate,
      // Plant says what it is; a carrier says what it holds.
      secondary: `${v.driver} · ${v.bucket === "plant" ? (v.machine ?? "plant") : v.cargo}`,
      value: loadValue(v), status: v.status,
    })),
  };
}

function AssetChip({ a }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 4,
      background: "var(--color-card)", border: "1px solid var(--color-border)",
      borderRadius: 6, padding: "3px 8px", flexShrink: 0,
      // Spacing as a margin, not the track's gap: every chip then carries its
      // own 5px, so two equal halves are exactly 50% of the track each and
      // the loop's jump back to 0 lands on the same pixel.
      marginRight: 5,
      cursor: "default", whiteSpace: "nowrap",
    }}>
      <div style={{ width: 5, height: 5, borderRadius: "50%", background: COLOR[a.status] ?? "#94a3b8", flexShrink: 0 }} />
      <span style={{ fontSize: 10, fontWeight: 600, color: "var(--color-text-primary)" }}>{a.primary}</span>
      {a.secondary && <span style={{ fontSize: 9, color: "var(--color-text-sec)" }}>{a.secondary}</span>}
      <span style={{ fontSize: 10, fontWeight: 700, color: COLOR[a.status] ?? "#9ca3af" }}>{a.value}</span>
    </div>
  );
}

export default function FilterStrip({ stat, summary, cargoWord = "cargo", products = [], onClose }) {
  const viewportRef = useRef(null);
  const setRef = useRef(null);
  // How many times the list is laid end to end in each half of the loop.
  const [reps, setReps] = useState(1);

  const strip = summary ? buildStrip(stat, summary, cargoWord, products) : null;
  const items = strip?.items ?? [];
  const itemKey = items.map((a) => a.id).join(",");

  /* The strip is always full, end to end (operator, 2026-10-15). With the
   * list drawn only twice, five units on a 1900px header left most of the row
   * blank. Each half of the loop now repeats the list until it is at least as
   * wide as the strip, so whatever point the loop has reached, chips fill the
   * whole width. Measured on the first copy of the list; re-measured when the
   * units change and when the window does. */
  useLayoutEffect(() => {
    const measure = () => {
      const vw = viewportRef.current?.clientWidth ?? 0;
      const one = setRef.current?.scrollWidth ?? 0;
      if (!vw || !one) return;
      const next = Math.max(1, Math.ceil(vw / one));
      setReps((prev) => (prev === next ? prev : next));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [itemKey]);

  if (!strip) return null;
  const { title } = strip;

  // Roughly constant per-chip speed, however many chips one half holds.
  const duration = Math.max(10, items.length * reps * 2.2);
  const half = (copy) => Array.from({ length: reps }, (_, r) => (
    <div key={`${copy}-${r}`} ref={copy === "a" && r === 0 ? setRef : undefined} style={{ display: "flex", flexShrink: 0 }}>
      {items.map((a) => <AssetChip key={a.id} a={a} />)}
    </div>
  ));

  return (
    <div style={{
      background: "var(--color-surface)",
      borderBottom: "1px solid var(--color-border)",
      padding: "5px 14px",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--color-text-sec)", letterSpacing: "0.1em" }}>
          {title}
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none", cursor: "pointer",
          color: "var(--color-text-sec)", fontSize: 13, lineHeight: 1, padding: "0 2px",
        }}>×</button>
      </div>

      {items.length === 0 ? (
        <span style={{ fontSize: 10, color: "var(--color-text-muted)" }}>No assets right now.</span>
      ) : (
        <div className="filterstrip-viewport" ref={viewportRef}>
          <div className="filterstrip-track" style={{ "--filterstrip-duration": `${duration}s`, paddingBottom: 2 }}>
            {/* Two identical halves back-to-back, so the loop (0 → -50%) is
                seamless; the second is decoration for screen readers. */}
            {half("a")}
            <div aria-hidden="true" style={{ display: "flex", flexShrink: 0 }}>{half("b")}</div>
          </div>
        </div>
      )}
    </div>
  );
}
