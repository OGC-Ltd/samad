/**
 * A clock, so time-derived state re-evaluates without new telemetry.
 *
 * Most of this dashboard changes when a frame arrives. A few things change
 * because time passed: a unit that stopped nine minutes ago becomes a
 * ten-minute stop while nothing at all is reported about it. Those need a
 * heartbeat, and this is it — one shared tick rather than a setInterval in
 * every component that prints a duration.
 *
 * ## Paused while the tab is hidden
 *
 * A backgrounded dashboard has nobody reading it, and an interval that survives
 * a night of sleep is a battery cost with no reader. It resyncs the instant the
 * tab comes back, so returning never shows a stale duration — the alternative
 * (leaving it running) buys nothing, because nothing was on screen to be stale.
 */

import { useEffect, useState } from "react";

export function useNowTick(periodMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let id = null;
    const start = () => {
      if (id != null) return;
      // Resync on the way in, so a tab restored after ten minutes is correct
      // immediately rather than at the end of the first new period.
      setNow(Date.now());
      id = setInterval(() => setNow(Date.now()), periodMs);
    };
    const stop = () => {
      if (id == null) return;
      clearInterval(id);
      id = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [periodMs]);

  return now;
}

export default useNowTick;
