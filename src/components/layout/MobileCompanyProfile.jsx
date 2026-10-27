// MobileCompanyProfile — slide-up sheet showing company info, weather and fleet stats.
// Matches the RN CompanyProfileModal but natural, no AI cards.

import { useCompanies } from '../../context/AppContext';
import { useFleetLiveShared } from '../../context/FleetLiveContext';
import { matchesFilter } from '../../lib/vehicleMap';
import './MobileCompanyProfile.css';

// Weather hook — same as SidePanel
import { useState, useEffect } from 'react';

function useWeather(lat, lng) {
  const [weather, setWeather] = useState(null);
  useEffect(() => {
    if (!lat || !lng) return;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weathercode,windspeed_10m&timezone=Africa%2FNairobi`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const wc = data.current;
        const code = wc.weathercode;
        const desc =
          code === 0 ? 'Sunny' :
          code <= 2  ? 'Partly cloudy' :
          code <= 3  ? 'Cloudy' :
          code <= 49 ? 'Foggy' :
          code <= 65 ? 'Rainy' :
          code <= 75 ? 'Snow' :
          code <= 99 ? 'Thunderstorm' : 'Cloudy';
        setWeather({ temp: Math.round(wc.temperature_2m), desc });
      })
      .catch(() => {});
  }, [lat, lng]);
  return weather;
}

export default function MobileCompanyProfile({ open, onClose }) {
  const { activeCompany } = useCompanies();
  const { vehicles = [] } = useFleetLiveShared();
  const weather  = useWeather(activeCompany?.hqLat, activeCompany?.hqLng);

  const count   = (key) => vehicles.filter(v => matchesFilter(v, key)).length;
  const total   = vehicles.length;
  const moving  = count('transit');
  const idle    = count('idling');
  const alerts  = vehicles.filter(v => v.status === 'speeding' || v.status === 'theft').length;
  const offline = count('offline');

  // Fleet composition from the live vehicleType of each unit
  const TYPE_LABEL = { TRUCK: 'Trucks', LORRY: 'Lorries', TRACTOR: 'Tractors', PLANT: 'Plant', 'BELL LOADER': 'Bell loaders' };
  const byType = vehicles.reduce((acc, v) => {
    const t = v.vehicleType ?? 'OTHER';
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});
  const composition = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => ({
      label: TYPE_LABEL[t] ?? (t.charAt(0) + t.slice(1).toLowerCase()),
      count: n,
      pct: total ? (n / total) * 100 : 0,
    }));

  return (
    <>
      {open && <div className="mcp-backdrop" onClick={onClose} />}
      <div className={`mcp-sheet${open ? ' mcp-sheet--open' : ''}`}>

        {/* Handle */}
        <div className="mcp-handle" />

        {/* Header row */}
        <div className="mcp-header">
          <span className="mcp-title">Company Profile</span>
          <button className="mcp-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="mcp-body">

          {/* Org name + location + weather */}
          <div className="mcp-org">
            <div className="mcp-org-name">{activeCompany?.name ?? 'Fleet Command'}</div>
            <div className="mcp-org-meta">
              {activeCompany?.hqLocation ?? ''}
              {weather && (
                <span className="mcp-org-weather"> · {weather.temp}°C · {weather.desc}</span>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="mcp-divider" />

          {/* Fleet stats — plain numbers */}
          <div className="mcp-stats">
            <div className="mcp-stat">
              <span className="mcp-stat-num">{total}</span>
              <span className="mcp-stat-lbl">Total</span>
            </div>
            <div className="mcp-stat">
              <span className="mcp-stat-num mcp-stat-num--green">{moving}</span>
              <span className="mcp-stat-lbl">Moving</span>
            </div>
            <div className="mcp-stat">
              <span className="mcp-stat-num mcp-stat-num--amber">{idle}</span>
              <span className="mcp-stat-lbl">Idle</span>
            </div>
            <div className="mcp-stat">
              <span className="mcp-stat-num mcp-stat-num--red">{alerts}</span>
              <span className="mcp-stat-lbl">Alerts</span>
            </div>
            <div className="mcp-stat">
              <span className="mcp-stat-num mcp-stat-num--grey">{offline}</span>
              <span className="mcp-stat-lbl">Offline</span>
            </div>
          </div>

          <div className="mcp-divider" />

          {/* Fleet composition — simple bars */}
          <div className="mcp-section-lbl">Fleet composition</div>

          {composition.length === 0 && <div className="mcp-comp-label">No vehicles reported yet</div>}
          {composition.map(c => (
            <div key={c.label} className="mcp-comp-row">
              <div className="mcp-comp-top">
                <span className="mcp-comp-label">{c.label}</span>
                <span className="mcp-comp-count">{c.count}</span>
              </div>
              <div className="mcp-comp-track">
                <div className="mcp-comp-fill" style={{ width: `${c.pct}%` }} />
              </div>
            </div>
          ))}

        </div>
      </div>
    </>
  );
}
