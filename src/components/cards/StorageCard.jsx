// Current cargo card for the vehicle detail panel.

import "./StorageCard.scss";
import { iconForCargo } from "../../utils/cargoIcons";

/**
 * The load, in the two units it is talked about in.
 *
 * TONNES is what the weighbridge and the sales paperwork use; 50 kg BAGS is
 * what the yard counts and what the customer receives. The bag count is not an
 * independent measurement — it is the same tonnage restated — so it sits in the
 * subtitle beside the grade rather than competing with the headline figure.
 *
 * `bags` is null on anything but a sales run (a cane load is tipped loose, and
 * an idle unit is carrying nothing), and the line simply omits it.
 */
export default function StorageCard({ storage }) {
  const sub = [
    storage.grade,
    storage.stored > 0 ? `${storage.stored} tonnes on board` : "no load",
    storage.bags != null ? `${storage.bags.toLocaleString("en-GB")} × 50 kg bags` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="sc-card">
      <div className="sc-title">Current Cargo</div>
      <div className="sc-row">
        <span className="sc-icon">{iconForCargo(storage.commodity)}</span>
        <div className="sc-info">
          <div className="sc-name">{storage.commodity}</div>
          <div className="sc-sub">{sub}</div>
        </div>
        <div className="sc-count-wrap">
          <span className="sc-count">{storage.stored}</span>
          <span className="sc-unit">TONNES</span>
        </div>
      </div>
    </div>
  );
}
