// Live weather card (real Open-Meteo API call).

import { useEffect, useState } from "react";
import { usePlaceName } from "../../hooks/usePlaceName";
import "./WeatherCard.css";

const CONDITIONS = {
  sunny:         { icon: "☀️",  label: "Sunny",          warning: null },
  clear:         { icon: "🌙",  label: "Clear Night",    warning: null },
  partly_cloudy: { icon: "⛅",  label: "Partly Cloudy",  warning: null },
  cloudy:        { icon: "☁️",  label: "Cloudy",         warning: null },
  overcast:      { icon: "🌫️", label: "Overcast",       warning: "Reduced visibility, reduce speed" },
  rain:          { icon: "🌧️", label: "Rain",           warning: "Wet roads, maintain safe following distance" },
  light_rain:    { icon: "🌦️", label: "Light Rain",     warning: "Slippery surface, drive cautiously" },
  heavy_rain:    { icon: "⛈️", label: "Heavy Rain",     warning: "Poor visibility, consider shelter" },
  thunderstorm:  { icon: "🌩️", label: "Thunderstorm",  warning: "Dangerous conditions, pull over safely" },
  fog:           { icon: "🌁",  label: "Fog",            warning: "Very low visibility, use fog lights" },
  mist:          { icon: "🌫️", label: "Mist",           warning: "Reduced visibility ahead" },
  snow:          { icon: "❄️",  label: "Snow",           warning: "Hazardous roads, avoid travel if possible" },
  wind:          { icon: "💨",  label: "Windy",          warning: "High winds, check load security" },
};

function getCondition(key) {
  return CONDITIONS[key] || { icon: "🌡️", label: key, warning: null };
}

const DAY_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export default function WeatherCard({ vehicle }) {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  // Actual named place at the vehicle's coordinates (backend reverse geocoder,
  // per-grid-cell cached) — the static `vehicle.location` string is only the
  // fallback while it resolves.
  const placeName = usePlaceName(vehicle?.lat, vehicle?.lng);
  const location  = placeName ?? vehicle?.location ?? "Current Location";

  useEffect(() => {
    if (!vehicle) return;

    setLoading(true);
    setError(false);

    const lat = vehicle.lat;
    const lng = vehicle.lng;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weathercode,windspeed_10m,relativehumidity_2m&daily=temperature_2m_max,precipitation_probability_max,weathercode&timezone=Africa%2FNairobi&forecast_days=4`;

    fetch(url)
      .then(r => r.json())
      .then(data => {
        const wc   = data.current;
        const daily = data.daily;

        const mapCode = (code) => {
          if (code === 0)              return "sunny";
          if (code <= 2)               return "partly_cloudy";
          if (code <= 3)               return "cloudy";
          if (code <= 49)              return "fog";
          if (code <= 55)              return "light_rain";
          if (code <= 65)              return "rain";
          if (code <= 75)              return "snow";
          if (code <= 82)              return "rain";
          if (code <= 99)              return "thunderstorm";
          return "cloudy";
        };

        setWeather({
          temp:      Math.round(wc.temperature_2m),
          humidity:  wc.relativehumidity_2m,
          wind:      Math.round(wc.windspeed_10m),
          condition: mapCode(wc.weathercode),
          forecast:  daily.time.slice(1, 4).map((date, i) => ({
            day:      DAY_SHORT[new Date(date).getDay()],
            high:     Math.round(daily.temperature_2m_max[i + 1]),
            rain:     daily.precipitation_probability_max[i + 1],
            condition: mapCode(daily.weathercode[i + 1]),
          })),
        });
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, [vehicle?.id]);

  const cond = weather ? getCondition(weather.condition) : null;

  return (
    <div className="weather-card">
      <div className="wc-header">
        <span className="wc-title">Route Weather</span>
        <span className="wc-location">📍 {location}</span>
      </div>

      {loading && (
        <div className="wc-loading">
          <span className="wc-spinner" />
          <span>Fetching conditions…</span>
        </div>
      )}

      {error && !loading && (
        <div className="wc-error">Unable to fetch weather data</div>
      )}

      {weather && !loading && (
        <>
          <div className="wc-current">
            <div className="wc-main">
              <span className="wc-icon">{cond.icon}</span>
              <div className="wc-temps">
                <span className="wc-temp">{weather.temp}°C</span>
                <span className="wc-condition-label">{cond.label}</span>
              </div>
            </div>
            <div className="wc-stats">
              <div className="wc-stat">
                <span className="wc-stat-icon">💧</span>
                <span className="wc-stat-val">{weather.humidity}%</span>
                <span className="wc-stat-lbl">Humidity</span>
              </div>
              <div className="wc-stat">
                <span className="wc-stat-icon">💨</span>
                <span className="wc-stat-val">{weather.wind}</span>
                <span className="wc-stat-lbl">km/h Wind</span>
              </div>
            </div>
          </div>

          {cond.warning && (
            <div className="wc-warning">
              <span className="wc-warning-icon">⚠</span>
              <span>{cond.warning}</span>
            </div>
          )}

          <div className="wc-divider" />
          <div className="wc-forecast">
            {weather.forecast.map((day, i) => (
              <div className="wc-day" key={i}>
                <span className="wc-day-name">{day.day}</span>
                <span className="wc-day-icon">{getCondition(day.condition).icon}</span>
                <span className="wc-day-temp">{day.high}°</span>
                <span className="wc-day-rain">
                  <span className="wc-rain-dot" style={{ opacity: day.rain > 30 ? 1 : 0.3 }}>💧</span>
                  {day.rain}%
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
