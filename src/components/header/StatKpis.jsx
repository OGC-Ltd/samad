// Header KPI buttons — port of fleetdash's Topbar StatButton/StatIcon onto
// fleettrack's theme tokens. One button per PRODUCT the org ferries (from the
// trailing-30d delivery analytics catalog) plus the live IN TRANSIT total;
// clicking a button expands the FilterStrip ticker below the header with the
// underlying assets.

const fmt = (n) => (n ?? 0).toLocaleString("en-US");

// Distinct accents for the product buttons. Picked by a stable hash of the
// product name (not list position): the button list now churns as products
// enter/leave transit, and a product should keep its accent across churn.
const PRODUCT_COLORS = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316"];

function productColor(name) {
  const key = productKey(name);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PRODUCT_COLORS[h % PRODUCT_COLORS.length];
}

/** "Processed Sugar" / "Processed sugar" / "processed-sugar" → same key. */
export function productKey(name) {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Vehicles ferrying `product` right now (cargo matched fuzzily) — the
 *  product-bucket slice of the active fleet, i.e. mid-journey AND loaded.
 *  Docked vehicles belong to EMPTY even while they still hold cargo, so they
 *  are excluded here; that exclusion is what keeps the buttons balancing
 *  (IN TRANSIT = Σ products + EMPTY). */
export function vehiclesCarrying(summary, product) {
  const key = productKey(product);
  return (summary?.inTransit?.vehicles ?? []).filter(
    (v) => v.bucket !== "empty" && productKey(v.cargo) === key
  );
}

/** The empty-bucket slice of the active fleet — driving with nothing on
 *  board, or docked at an operational stop (loading / offloading / garage).
 *  Built by SukariHeader's bucketing (summary.emptyFleet). */
export function emptyVehicles(summary) {
  return summary?.emptyFleet ?? [];
}

/** Working machines that carry nothing by design — dozers, excavators,
 *  backhoes, compactors, wheel loaders, graders. Out working, so they count in
 *  IN TRANSIT; never "empty", which is meant to mean idle capacity. */
export function plantVehicles(summary) {
  return summary?.plantFleet ?? [];
}

/**
 * KPI buttons for the org, in display-priority order: the live in-transit
 * total first, then one button per product CURRENTLY being ferried (the
 * caller filters the catalog down to those), then the EMPTY button for
 * active vehicles with nothing to ferry — driving empty or at an operational
 * stop. The three always balance: IN TRANSIT = Σ products + EMPTY. Products
 * not on the road right now get no button — that's what keeps the topbar
 * from cluttering.
 */
/**
 * Is any cargo weight actually being reported?
 *
 * No provider sends one today, which is why EMPTY currently equals IN TRANSIT
 * and every product button sits at 0 — with nothing to split on, the whole
 * active fleet falls into EMPTY. The button stays visible regardless; this
 * only decides whether it can claim the vehicles are EMPTY (measured) or
 * merely that their cargo is unknown.
 */
function hasCargoData(summary) {
  return (summary?.emptyFleet ?? []).some((c) => (c.tonnes ?? 0) > 0)
    || (summary?.inTransit?.sugarTonnes ?? 0) > 0;
}

export function statMeta(summary, products = []) {
  const plant = plantVehicles(summary).length;
  return [
    { key: "inTransit", label: "IN TRANSIT", color: "#22c55e", icon: "truck" },
    ...products.map((p) => ({
      key: `product:${p.product}`,
      label: p.product,
      color: productColor(p.product),
      // Raw sugarcane gets its own icon (public/sugar-cane-svgrepo-com.svg);
      // every other product keeps the generic crate.
      icon: /sugar\s*cane|sugarcane/i.test(p.product) ? "sugarcane" : "product",
    })),
    // Only when there is plant on the move — same rule as the product buttons,
    // and it keeps the topbar from carrying a permanent 0 for fleets that have
    // no earthmoving equipment.
    ...(plant > 0
      ? [{ key: "plant", label: "PLANT", color: "#38bdf8", icon: "plant" }]
      : []),
    { key: "empty", label: "EMPTY", color: "#94a3b8", icon: "empty" },
  ];
}

export function statValues(key, summary, cargoWord) {
  if (!summary) return { value: "-", unit: "", sub: "" };
  if (key === "inTransit") {
    // The VEHICLE COUNT always leads. This button answers "how much of my fleet
    // is out right now", and that is a count of vehicles — tonnage is what they
    // happen to be carrying, so it rides in the sub line when there is any.
    // (It used to lead with tonnes, which no provider sends, so the button read
    // "0 t sugar" over a real vehicle count: a fabricated zero standing where
    // "not measured" belongs.)
    const tonnes = summary.inTransit.sugarTonnes ?? 0;
    const count  = summary.inTransit.vehicleCount ?? 0;
    // The sub line carries a MEASUREMENT or nothing at all.
    //
    // It used to carry filler whenever there was no tonnage — "(cargo not
    // reported · 2 plant)" — which is the permanent state of this fleet, since
    // no provider sends load weights. So the topbar's headline number wore a
    // parenthetical apology at all times, explaining an absence nobody had
    // asked about and burying the count it was attached to. The button answers
    // "how many are out"; that is the whole answer.
    //
    // Tonnage survives for the day a provider does start weighing loads: a real
    // figure is worth showing beside the count. Everything that was not a
    // measurement — the not-reported wording, the no-load-aboard wording and
    // the plant tally — is gone. Plant still has its own KPI button.
    return {
      value: String(count),
      unit: count === 1 ? " vehicle" : " vehicles",
      sub: tonnes > 0 ? `${fmt(tonnes)}t ${cargoWord}` : "",
    };
  }
  // Machines that carry nothing by design. No tonnage line at all — a "0 t"
  // here would invite the question of where the load went.
  if (key === "plant") {
    const plant = plantVehicles(summary);
    return { value: String(plant.length), unit: "", sub: "no load expected" };
  }
  // "no cargo" is a MEASUREMENT, and only claimable when something is actually
  // weighing the loads. Until then the count is every active vehicle (so it
  // equals IN TRANSIT) and the sub says why, rather than asserting the fleet is
  // running empty when nothing has told us that.
  if (key === "empty") return {
    value: String(emptyVehicles(summary).length),
    unit: "",
    sub: hasCargoData(summary) ? "no cargo" : "cargo not reported",
  };
  if (key.startsWith("product:")) {
    const name = key.slice("product:".length);
    const live = vehiclesCarrying(summary, name);
    // Tonnes currently ON THE ROAD for this product — not the trailing-30d
    // catalog total. Two lorries each hauling 10 t show "20 t (2 in transit)".
    const liveTonnes = +live.reduce((s, v) => s + (v.tonnes ?? 0), 0).toFixed(1);
    return {
      value: fmt(liveTonnes),
      unit: "t",
      sub: `${live.length} in transit`,
    };
  }
  return { value: "-", unit: "", sub: "" };
}

export function StatButton({ label, value, unit, sub, color, icon, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        background: active ? `rgba(${hexToRgb(color)},0.12)` : "var(--color-card)",
        border: `1px solid ${active ? color : "var(--color-border)"}`,
        borderRadius: 10, padding: "6px 12px",
        cursor: "pointer", flexShrink: 0, fontFamily: "inherit",
        transition: "border-color 0.2s, background 0.2s",
        position: "relative",
      }}
    >
      <StatIcon type={icon} color={color} />
      <div style={{ textAlign: "left" }}>
        <div style={{ fontSize: 8, fontWeight: 600, color: "var(--color-text-sec)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 1 }}>
          {label}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
          {unit && <span style={{ fontSize: 10, color: "var(--color-text-sec)" }}>{unit}</span>}
          {/* Same treatment as the live feed's message text (primary at 0.78)
              — the muted palette colour was near-invisible. */}
          {sub && <span style={{ fontSize: 10, color: "var(--text-primary, #f0f4f8)", opacity: 0.78 }}>({sub})</span>}
        </div>
      </div>
      {active && (
        <div style={{ position: "absolute", top: 6, right: 8, fontSize: 11, color: "var(--color-text-sec)" }}>×</div>
      )}
    </button>
  );
}

function StatIcon({ type, color }) {
  const size = 28;
  const box = {
    width: size, height: size, borderRadius: 7,
    background: `rgba(${hexToRgb(color)},0.15)`,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  };
  if (type === "sugar") return (
    <div style={box}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M6 9 Q12 4 18 9" fill={color} fillOpacity="0.25" stroke={color} strokeWidth="1.4" />
        <rect x="6" y="9" width="12" height="11" rx="1" fill={color} fillOpacity="0.2" stroke={color} strokeWidth="1.4" />
        <line x1="12" y1="9" x2="12" y2="20" stroke={color} strokeWidth="1" strokeOpacity="0.5" />
      </svg>
    </div>
  );
  if (type === "truck") return (
    <div style={box}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <rect x="2" y="8" width="11" height="8" rx="1" fill={color} fillOpacity="0.2" stroke={color} strokeWidth="1.4" />
        <path d="M13 10h4l3 3v3h-7z" fill={color} fillOpacity="0.2" stroke={color} strokeWidth="1.4" />
        <circle cx="7" cy="17.5" r="1.8" fill={color} />
        <circle cx="16.5" cy="17.5" r="1.8" fill={color} />
      </svg>
    </div>
  );
  if (type === "sugarcane") return (
    <div style={box}>
      <img src="/sugar-cane-svgrepo-com.svg" width="19" height="19" alt="" style={{ display: "block", filter: "invert(70%) sepia(60%) saturate(450%) hue-rotate(60deg) brightness(1.1)" }} />
    </div>
  );
  if (type === "empty") return (
    <div style={box}>
      {/* Dashed open crate — a vehicle moving with nothing on board */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeDasharray="2.6 2.2" />
        <path d="M4 7.5l8 4.5 8-4.5" stroke={color} strokeWidth="1.2" strokeLinejoin="round" strokeOpacity="0.55" strokeDasharray="2.6 2.2" />
      </svg>
    </div>
  );
  if (type === "plant") return (
    <div style={box}>
      {/* Dozer in profile — blade, cab, tracks. Reads as "machine, not lorry"
          at 18 px, which is the whole job of this icon. */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M4 9v7" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
        <path d="M8 7h5l1.6 3.2H8z" fill={color} fillOpacity="0.2" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
        <rect x="6.5" y="11" width="12" height="3.4" rx="0.8" fill={color} fillOpacity="0.2" stroke={color} strokeWidth="1.3" />
        <rect x="6" y="15.6" width="13" height="3.4" rx="1.7" stroke={color} strokeWidth="1.4" />
        <circle cx="9" cy="17.3" r="0.9" fill={color} />
        <circle cx="16" cy="17.3" r="0.9" fill={color} />
      </svg>
    </div>
  );
  if (type === "product") return (
    <div style={box}>
      {/* Crate/package — a ferried product */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" fill={color} fillOpacity="0.2" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M4 7.5l8 4.5 8-4.5" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M12 12v9" stroke={color} strokeWidth="1.4" />
      </svg>
    </div>
  );
  return (
    <div style={box}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M5 13a7 7 0 0 1 7-6 7 7 0 0 1 7 6" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <path d="M8 15a4 4 0 0 1 4-3 4 4 0 0 1 4 3" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="12" cy="18" r="1.6" fill={color} />
      </svg>
    </div>
  );
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}
