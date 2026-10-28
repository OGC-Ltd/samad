// The weather layer's words and numbers, in a card at the map's foot (operator,
// 2026-10-28: "should be crystal clear, its windy, cloudy, sunny or
// temperature"). The map itself carries no labels (operator, 2026-10-27), so
// this is where the temperature and the wind's speed and direction are read:
// for the grid cell under the cursor, or under the map's centre.

import { weatherKind, compass } from "../../lib/weatherChip";
import "./WeatherReadout.css";

const round = (v) => (v == null ? null : Math.round(v));

/** @param {{ point: object|null, note?: string|null }} props */
export default function WeatherReadout({ point, note }) {
  if (!point) {
    if (!note) return null;
    return (
      <div className="wx-readout wx-readout--note" role="status">
        <i className="ti ti-cloud-off" aria-hidden="true" />
        <span>Weather {note}</span>
      </div>
    );
  }
  const { kind, label, icon } = weatherKind(point);
  const temp = round(point.tempC);
  const feels = round(point.feelsLikeC);
  const wind = round(point.windKmh);
  const gust = round(point.gustKmh);
  const from = compass(point.windDeg);
  return (
    <div className={`wx-readout wx-readout--${kind}`} role="status" aria-live="polite"
         title={point.text || label}>
      <i className={`ti ${icon} wx-readout__icon`} aria-hidden="true" />
      <div className="wx-readout__body">
        <div className="wx-readout__head">
          <span className="wx-readout__label">{label}</span>
          {temp != null && <span className="wx-readout__temp">{temp}°C</span>}
        </div>
        <div className="wx-readout__wind">
          {wind != null && wind >= 1 ? (
            <>
              {point.windDeg != null && (
                <i className="ti ti-arrow-up wx-readout__arrow" aria-hidden="true"
                   style={{ transform: `rotate(${(point.windDeg + 180) % 360}deg)` }} />
              )}
              <span>
                Wind {wind} km/h{from ? ` from ${from}` : ""}
                {gust != null && gust > wind && <span className="wx-readout__soft">, gusts {gust}</span>}
              </span>
            </>
          ) : <span>Calm</span>}
        </div>
        {(feels != null && feels !== temp) || point.rainPct != null ? (
          <div className="wx-readout__soft">
            {[feels != null && feels !== temp ? `Feels ${feels}°` : null,
              point.rainPct != null ? `Rain chance ${point.rainPct}%` : null].filter(Boolean).join(" · ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
