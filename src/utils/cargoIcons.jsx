// Cargo type → icon lookup. Most cargo types map to an emoji; processed sugar
// gets a drawn sugar-package SVG (there is no sugar emoji). Lookup is
// case-insensitive because backend cargoDesc casing ("Processed sugar") differs
// from the original mock labels ("Processed Sugar").

// A paper sugar bag: pinched fold on top, label band reading SUGAR, crystals.
// Sized in em so it scales with the surrounding text exactly like the emoji.
export function SugarPackIcon() {
  return (
    <svg
      width="1.15em"
      height="1.15em"
      viewBox="0 0 24 24"
      style={{ verticalAlign: "-0.15em" }}
      aria-label="Sugar package"
      role="img"
    >
      {/* bag body */}
      <path d="M5 8.5 L19 8.5 L18.2 21 Q18.1 22 17.1 22 L6.9 22 Q5.9 22 5.8 21 Z" fill="#f5efe0" stroke="#c9bfa4" strokeWidth="0.8" />
      {/* pinched top fold */}
      <path d="M7.2 8.5 L8.2 4.8 Q8.4 4 9.2 4 L14.8 4 Q15.6 4 15.8 4.8 L16.8 8.5 Z" fill="#e9e1cc" stroke="#c9bfa4" strokeWidth="0.8" />
      <line x1="7.2" y1="8.5" x2="16.8" y2="8.5" stroke="#c9bfa4" strokeWidth="0.8" />
      {/* label band */}
      <rect x="5.55" y="12" width="12.9" height="5.2" fill="#2563eb" />
      <text
        x="12" y="15.9"
        textAnchor="middle"
        fontFamily="Arial, sans-serif"
        fontSize="3.6"
        fontWeight="800"
        letterSpacing="0.45"
        fill="#ffffff"
      >
        SUGAR
      </text>
      {/* sugar crystals */}
      <circle cx="9"    cy="10.3" r="0.55" fill="#ffffff" stroke="#c9bfa4" strokeWidth="0.3" />
      <circle cx="12.1" cy="9.9"  r="0.55" fill="#ffffff" stroke="#c9bfa4" strokeWidth="0.3" />
      <circle cx="15"   cy="10.4" r="0.55" fill="#ffffff" stroke="#c9bfa4" strokeWidth="0.3" />
      <circle cx="10.5" cy="19.3" r="0.55" fill="#ffffff" stroke="#c9bfa4" strokeWidth="0.3" />
      <circle cx="13.7" cy="19.6" r="0.55" fill="#ffffff" stroke="#c9bfa4" strokeWidth="0.3" />
    </svg>
  );
}

// Sugarcane stalks — the real icon asset (public/sugar-cane-svgrepo-com.svg),
// sized in em so it scales with the surrounding text like the emoji.
export function SugarcaneIcon() {
  return (
    <img
      src="/sugar-cane-svgrepo-com.svg"
      width="1.15em"
      height="1.15em"
      // The asset is solid black — the filter re-tints it cane-green so it
      // reads on the dashboard's dark cards.
      style={{ width: "1.15em", height: "1.15em", verticalAlign: "-0.15em", filter: "invert(70%) sepia(60%) saturate(450%) hue-rotate(60deg) brightness(1.1)" }}
      alt="Raw sugarcane"
    />
  );
}

// Keys are lowercase — see iconForCargo.
const CARGO_ICONS = {
  "raw sugarcane":         <SugarcaneIcon />,
  "raw sugar cane":        <SugarcaneIcon />,
  "sugarcane":             <SugarcaneIcon />,
  "processed sugar":       <SugarPackIcon />,
  "bottled water (18.9l)": "💧",
  "still water, 5l bottles": "💧",
  "sparkling water":       "🫧",
  "juice cartons":         "🧃",
  "juice, 300 ml bottles": "🧃",
  "cooking oil":           "🫙",
  "cooking fats":          "🧈",
  "bar soap":              "🧼",
  "timber":                "🪵",
  "plywood":               "🪵",
};

export const DEFAULT_CARGO_ICON = "📦";

export function iconForCargo(cargoName) {
  const key = String(cargoName ?? "").trim().toLowerCase();
  if (CARGO_ICONS[key]) return CARGO_ICONS[key];
  // Substring fallback so variants like "38t Processed Sugar" still match.
  if (key) {
    for (const [k, icon] of Object.entries(CARGO_ICONS)) {
      if (key.includes(k)) return icon;
    }
  }
  return DEFAULT_CARGO_ICON;
}
