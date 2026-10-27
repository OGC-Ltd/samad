// The verdict on a route drawn by "Show the route covered": how long the unit
// actually took over the path, split into driving / stopped / no signal, beside
// how long TomTom says the same roads take at that time of day. See
// lib/tomtomTraffic trackJourney + fetchExpectedTime.

import { fmtDuration } from "../../lib/tripProgress";
import "./RouteCoveredCard.css";

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dur = (s) => fmtDuration(Math.round(s / 60)) ?? "0 m";

/** Within this of the expected time the drive is "as expected": 5 min or 10%. */
const slack = (expectedS) => Math.max(300, expectedS * 0.1);

/**
 * @param {object} props
 * @param {null|{plate:string,status:'loading'|'ok'|'error'|'nodrive',journey?:object,expected?:object,error?:string}} props.covered
 * @param {() => void} props.onClose
 */
export default function RouteCoveredCard({ covered, onClose }) {
  if (!covered) return null;
  const { plate, status, journey: j, expected: e } = covered;

  const x = status === "ok" && j && e ? { expectedS: e.expectedS, matched: !e.approx } : null;
  let verdict = null;
  if (x) {
    const diff = j.drivingS - x.expectedS;
    verdict = Math.abs(diff) <= slack(x.expectedS)
      ? { kind: "ok", text: "Driving time as expected" }
      : diff > 0
        ? { kind: "slow", text: `${dur(diff)} slower than expected while driving` }
        : { kind: "fast", text: `${dur(-diff)} faster than expected while driving` };
  }
  const overall = x ? j.spanS - x.expectedS : null;

  return (
    <div className="rcov" role="status" aria-live="polite">
      <div className="rcov__head">
        <span className="rcov__title">Route covered · {plate}</span>
        <button type="button" className="rcov__x" onClick={onClose} aria-label="Close">×</button>
      </div>

      {status === "nodrive" && <div className="rcov__muted">No driving in this track, so there is no journey to time.</div>}

      {j && (
        <>
          <div className="rcov__span">
            {clock(j.startMs)} → {clock(j.endMs)} · <b>{dur(j.spanS)}</b> · {j.km.toFixed(1)} km
          </div>
          <div className="rcov__split">
            <span><i className="rcov__dot rcov__dot--drive" />Driving <b>{dur(j.drivingS)}</b></span>
            <span><i className="rcov__dot rcov__dot--stop" />Stopped <b>{dur(j.stoppedS)}</b></span>
            {j.silentS >= 60 && <span><i className="rcov__dot rcov__dot--gap" />No signal <b>{dur(j.silentS)}</b></span>}
          </div>
        </>
      )}

      {status === "loading" && <div className="rcov__muted">Working out the expected time…</div>}
      {status === "error" && <div className="rcov__err">Expected time unavailable · {covered.error}</div>}

      {x && (
        <>
          <div className="rcov__expect">
            Should have taken <b>{x.matched ? "" : "≈ "}{dur(x.expectedS)}</b>
          </div>
          <div className="rcov__sub">
            {/* Out-and-back and shuttle runs are timed leg by leg, so a
                return trip is two one-way drives, not one route with U-turns. */}
            Timed as {e.legs} leg{e.legs === 1 ? "" : "s"} between stops and turnarounds
            {e.routed < e.legs ? ` (${e.routed} routed, the rest at their average speed)` : ""}
          </div>
          {!x.matched && (
            <div className="rcov__sub">
              Approximate: part of this drive is off the mapped road network (estate or field tracks), so those legs are scaled to the distance actually driven
            </div>
          )}
          <div className={`rcov__verdict rcov__verdict--${verdict.kind}`}>{verdict.text}</div>
          {overall > slack(x.expectedS) && (
            <div className="rcov__sub">
              Whole journey {dur(overall)} over · stops {dur(j.stoppedS)}{j.silentS >= 60 ? ` · no signal ${dur(j.silentS)}` : ""}
            </div>
          )}
          <div className="rcov__src">TomTom, same roads at that time of day</div>
        </>
      )}
    </div>
  );
}
