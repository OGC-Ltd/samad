// Driver stat card for the vehicle detail panel (live driver + duty status).

import "./AssetCard.scss";
import { ONLINE_COLORS } from "../../lib/vehicleMap";

// Amber here read as "speeding" on a vehicle that is standing still. Driving
// and Resting are the green's two ends; Idling keeps its own sky blue, which
// is the state worth spotting on this fleet — see ONLINE_COLORS.
const STATUS_COLORS = { Driving: ONLINE_COLORS.transit, Idling: ONLINE_COLORS.idling, Resting: ONLINE_COLORS.stationary };

// Longest "FIRST LAST" the name row can hold beside the duty badge.
//
// The card sits in the 340 px right panel: minus the panel and card padding and
// the 52 px avatar, .ac-info gets ~244 px, and "● Driving" at 9px takes ~60 of
// them. That leaves ~177 px for the name, which at 15px/800 uppercase is about
// 18 characters. Names here are uppercase three-part Kenyan/Tanzanian names —
// FREDRICK NYAMWATA OMUKATIA is 26 characters — so the middle name has to go
// first, and a long first+last has to go too.
const NAME_MAX_CHARS = 18;

/**
 * Name that fits: full name if it is short, else FIRST LAST, else FIRST.
 *
 * The point is the badge. `.ac-name-row` is a flex row, so a long name used to
 * squeeze "Driving" down to "Driv…" — or stretch the row and push the badge off
 * the card — which made the duty status, the one thing on this card that changes
 * minute to minute, the least readable thing on it. The badge now never gives up
 * a pixel; the name yields instead. Ellipsis in CSS is the last resort for a
 * single name longer than the row.
 */
function fittedName(raw) {
  const tokens = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const full = tokens.join(" ");
  if (full.length <= NAME_MAX_CHARS) return full;
  const firstLast = tokens.length > 2 ? `${tokens[0]} ${tokens[tokens.length - 1]}` : full;
  return firstLast.length <= NAME_MAX_CHARS ? firstLast : tokens[0];
}

function Stars({ value }) {
  // One decimal, floats tidied (4.399999999999999 → 4.4, 5 stays 5).
  const display = +(+value).toFixed(1);
  return (
    <div className="ac-stars">
      {[1,2,3,4,5].map(i => (
        <span key={i} className={`ac-star${i <= Math.floor(value) ? " on" : ""}`}>★</span>
      ))}
      <span className="ac-star-val">{display}/5</span>
    </div>
  );
}

export default function AssetCard({ asset }) {
  // Initials of the name as SHOWN — first and last. Taking the first two tokens
  // gave FREDRICK NYAMWATA OMUKATIA an "FN" avatar beside a "FREDRICK OMUKATIA"
  // name, which reads as a mismatch.
  const tokens = String(asset.name ?? "").trim().split(/\s+/).filter(Boolean);
  const initials = (tokens.length > 1
    ? `${tokens[0][0]}${tokens[tokens.length - 1][0]}`
    : (tokens[0] ?? "").slice(0, 2)
  ).toUpperCase();
  const statusColor = STATUS_COLORS[asset.status] ?? "#22c55e";
  return (
    <div className="ac-card">
      <div className="ac-avatar">{initials}</div>
      <div className="ac-info">
        <div className="ac-name-row">
          {/* Full name on hover — shortening it for the layout should not lose it. */}
          <span className="ac-name" title={asset.name}>{fittedName(asset.name)}</span>
          <span className="ac-badge" style={{ color: statusColor }}>● {asset.status}</span>
        </div>
        <div className="ac-sub"><span style={{ color: statusColor }}>●</span> &nbsp;{asset.siteId} | {asset.role}</div>
        <div className="ac-farm">{asset.farm}</div>
        <Stars value={asset.rating} />
      </div>
    </div>
  );
}
