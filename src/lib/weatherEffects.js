/**
 * The weather drawn on the map (operator, 2026-10-27: "if it's rain we need to
 * see actual rain drop, if it wind we need to see the wind wave, if it storms
 * we need to see storms rendered").
 *
 * Each weather point stands for its grid cell (the server's `step` degrees
 * square), and the cell is animated with what Google reports there: falling
 * drops for rain, as dense as the rain is heavy and slanted by the wind;
 * travelling wave lines for wind, in the direction it blows, as many and as
 * fast as it is strong; a darkened sky, heavy rain and lightning for a storm.
 * Cells side by side join up, so a band of rain reads as one band.
 *
 * One canvas in the weather pane, redrawn every frame from particles kept in
 * cell-relative coordinates, so panning and zooming move the weather with the
 * ground at no cost. It sleeps while the tab is hidden, and under "reduce
 * motion" it draws one still frame per view instead of animating.
 */
import L from "leaflet";
import { weatherTone } from "./weatherChip";

/** Particles at most per cell, so a country-wide view cannot run away. */
const MAX_DROPS = 140;
const MAX_WAVES = 14;

/** How hard it is raining, 0–1, from Google's type, chance and amount. */
export function rainStrength(p) {
  const t = p?.type ?? "";
  let s = 0;
  if (t.includes("HEAVY") || t.includes("THUNDER")) s = 1;
  else if (t.includes("MODERATE") || t === "RAIN" || t === "RAIN_SHOWERS") s = 0.65;
  else if (t.includes("RAIN") || t.includes("SHOWER") || t === "DRIZZLE") s = 0.35;
  if ((p?.rainMm ?? 0) >= 4) s = Math.max(s, 1);
  else if ((p?.rainMm ?? 0) >= 1) s = Math.max(s, 0.6);
  if (s === 0 && (p?.rainPct ?? 0) >= 60) s = 0.3;
  return s;
}

/** How much wind to draw, 0–1: calm under 10 km/h, full from 50. */
export function windStrength(p) {
  const k = Math.max(p?.windKmh ?? 0, (p?.gustKmh ?? 0) * 0.7);
  return k < 10 ? 0 : Math.min(1, (k - 10) / 40);
}

/** The way the wind blows TO, as a unit screen vector (y down). */
export function windVector(p) {
  if (p?.windDeg == null) return { x: 1, y: 0 };
  const to = ((p.windDeg + 180) * Math.PI) / 180; // Google gives where it comes FROM
  return { x: Math.sin(to), y: -Math.cos(to) };
}

const rand = (a, b) => a + Math.random() * (b - a);

/** How far a cell's weather reaches past its edges, as a share of the cell. */
const BLEED = 0.2;
/** 1 in the middle of the drawn area, easing to 0 at its rim. */
function edgeFade(u, v) {
  const d = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2; // 0 centre, 1 rim
  return d <= 0.6 ? 1 : Math.max(0, 1 - (d - 0.6) / 0.4);
}

function makeCell(p, step) {
  const rain = rainStrength(p);
  const wind = windStrength(p);
  const storm = weatherTone(p) === "storm";
  return {
    south: p.lat - step / 2, north: p.lat + step / 2,
    west: p.lng - step / 2,  east: p.lng + step / 2,
    rain, wind, storm,
    dir: windVector(p),
    drops: Array.from({ length: Math.round(MAX_DROPS * rain) }, () => ({ x: Math.random(), y: Math.random(), v: rand(0.7, 1.3) })),
    waves: Array.from({ length: Math.round(MAX_WAVES * wind) }, () => ({ x: Math.random(), y: Math.random(), ph: rand(0, Math.PI * 2), life: Math.random() })),
    flash: 0,
    nextFlash: rand(1.5, 6),
    bolt: null,
  };
}

/** A jagged bolt from the top of the cell, in cell-relative coordinates. */
function boltPath() {
  const pts = [[rand(0.2, 0.8), 0]];
  let [x, y] = pts[0];
  const end = rand(0.55, 0.9);
  while (y < end) {
    x += rand(-0.08, 0.08);
    y += rand(0.06, 0.12);
    pts.push([x, y]);
  }
  return pts;
}

/**
 * Animate `points` (with the grid `step`) on the Leaflet map `l`, in `pane`.
 * Returns `{ set(points, step), remove() }`.
 */
export function createWeatherEffects(l, pane) {
  const canvas = L.DomUtil.create("canvas", "wx-fx", l.getPane(pane));
  canvas.style.pointerEvents = "none";
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let cells = [];
  let raf = 0;
  let last = 0;
  let dpr = 1;

  const place = () => {
    const size = l.getSize();
    dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    // Keep the canvas over the viewport while the pane moves with the map.
    L.DomUtil.setPosition(canvas, l.containerPointToLayerPoint([0, 0]));
  };

  const draw = (dt) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const size = l.getSize();
    for (const c of cells) {
      if (!c.rain && !c.wind && !c.storm) continue;
      const nw = l.latLngToContainerPoint([c.north, c.west]);
      const se = l.latLngToContainerPoint([c.south, c.east]);
      // Each cell's weather spills a little past its edges and fades out
      // there, so neighbours blend into one band instead of tiling as squares.
      const cw = se.x - nw.x, ch = se.y - nw.y;
      const x0 = nw.x - cw * BLEED, y0 = nw.y - ch * BLEED;
      const w = cw * (1 + 2 * BLEED), h = ch * (1 + 2 * BLEED);
      if (x0 > size.x || y0 > size.y || x0 + w < 0 || y0 + h < 0 || cw < 4) continue;
      const cx = x0 + w / 2, cy = y0 + h / 2, r = Math.max(w, h) / 2;
      ctx.save();

      // A storm darkens its sky; rain gives it a wet tint. Both soft-edged.
      if (c.storm || c.rain) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        const tint = c.storm ? "30, 41, 59" : "59, 130, 246";
        const a = c.storm ? 0.26 : 0.05 + 0.08 * c.rain;
        g.addColorStop(0, `rgba(${tint}, ${a})`);
        g.addColorStop(0.6, `rgba(${tint}, ${a})`);
        g.addColorStop(1, `rgba(${tint}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x0, y0, w, h);
      }

      // Rain: streaks falling, leaning with the wind.
      if (c.drops.length) {
        const len = 7 + 9 * c.rain;
        const lean = c.dir.x * (0.15 + 0.5 * c.wind);
        ctx.strokeStyle = c.storm ? "rgba(191, 219, 254, 0.85)" : "rgba(37, 99, 235, 0.55)";
        ctx.lineWidth = c.rain > 0.6 ? 1.4 : 1;
        ctx.lineCap = "round";
        for (const d of c.drops) {
          d.y += dt * d.v * (0.55 + 0.5 * c.rain) * (300 / Math.max(h, 1));
          d.x += dt * lean * 0.6 * (300 / Math.max(w, 1));
          if (d.y > 1) { d.y -= 1; d.x = Math.random(); }
          if (d.x > 1) d.x -= 1; else if (d.x < 0) d.x += 1;
          const px = x0 + d.x * w, py = y0 + d.y * h;
          ctx.globalAlpha = edgeFade(d.x, d.y);
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - lean * len, py - len);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Wind: short wave lines travelling the way it blows.
      if (c.waves.length) {
        const { x: dx, y: dy } = c.dir;
        const nx = -dy, ny = dx; // across the wind, for the wave's swing
        const speed = 40 + 120 * c.wind; // px a second
        const span = 26 + 26 * c.wind;
        ctx.strokeStyle = "rgba(71, 85, 105, 0.55)";
        ctx.lineWidth = 1.3;
        for (const wv of c.waves) {
          wv.life += dt * 0.35;
          if (wv.life > 1) { wv.life = 0; wv.x = Math.random(); wv.y = Math.random(); }
          wv.ph += dt * 5;
          const run = wv.life * speed * 2.2;
          const bx = x0 + wv.x * w + dx * run, by = y0 + wv.y * h + dy * run;
          // Fade in and out over its run, and towards the cell's edge.
          ctx.globalAlpha = Math.sin(wv.life * Math.PI)
            * edgeFade((bx - x0) / w, (by - y0) / h);
          ctx.beginPath();
          for (let i = 0; i <= 12; i++) {
            const t = i / 12;
            const swing = Math.sin(wv.ph + t * Math.PI * 2) * 3;
            const px = bx + dx * span * t + nx * swing;
            const py = by + dy * span * t + ny * swing;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Storm: lightning now and then, the cell lit for a moment.
      if (c.storm) {
        c.nextFlash -= dt;
        if (c.nextFlash <= 0) {
          c.flash = 1;
          c.bolt = boltPath();
          c.nextFlash = rand(2, 7);
        }
        if (c.flash > 0) {
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, `rgba(255, 255, 255, ${0.4 * c.flash})`);
          g.addColorStop(1, "rgba(255, 255, 255, 0)");
          ctx.fillStyle = g;
          ctx.fillRect(x0, y0, w, h);
          if (c.bolt) {
            ctx.strokeStyle = `rgba(253, 224, 71, ${c.flash})`;
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            c.bolt.forEach(([bx, by], i) => (i ? ctx.lineTo(x0 + bx * w, y0 + by * h) : ctx.moveTo(x0 + bx * w, y0 + by * h)));
            ctx.stroke();
          }
          c.flash = Math.max(0, c.flash - dt * 2.5);
        }
      }
      ctx.restore();
    }
  };

  const frame = (t) => {
    raf = 0;
    if (document.hidden) { last = 0; return; }
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    draw(dt);
    if (cells.some((c) => c.rain || c.wind || c.storm)) raf = requestAnimationFrame(frame);
  };
  const kick = () => {
    if (reduce) { place(); draw(0); return; }
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const onView = () => { place(); if (reduce || !raf) draw(0); kick(); };
  const onVisible = () => { if (!document.hidden) kick(); };

  l.on("move zoom viewreset resize", onView);
  document.addEventListener("visibilitychange", onVisible);
  place();

  return {
    set(points, step) {
      cells = step ? points.map((p) => makeCell(p, step)) : [];
      place();
      draw(0);
      kick();
    },
    remove() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      l.off("move zoom viewreset resize", onView);
      document.removeEventListener("visibilitychange", onVisible);
      canvas.remove();
    },
  };
}
