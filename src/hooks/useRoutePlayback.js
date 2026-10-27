// The playback clock.
//
// Drives a cursor across a recorded day at 1x-100x and reports where the unit
// was. Deliberately separate from both the fetch and the map: the map consumes
// `sample` and knows nothing about time, and this knows nothing about Google.
//
// ## Why requestAnimationFrame and not setInterval
//
// A timer that fires every 16 ms and adds `16 * rate` accumulates every late
// wake-up as permanent drift, and browsers throttle background tabs to one tick
// a second — so a tab left playing at 50x comes back having advanced by an
// amount that depends on how long it was hidden. rAF is paced by the compositor
// and, more importantly, we advance by MEASURED elapsed time rather than by an
// assumed frame length, so a dropped frame costs smoothness and never accuracy.
//
// ## Gaps are skipped, and said so
//
// A day here carries 7-64 reporting silences, some half an hour long. Played in
// real time at 50x, a 30-minute hole is 36 seconds of a marker sitting
// motionless — which reads as a frozen UI, not as missing data. The cursor
// jumps the silence instead and raises `skippedGap`, so the interface can say
// what it skipped rather than quietly erasing it. Set `skipGaps: false` and the
// clock runs straight through, which is the honest-but-tedious reading.

import { useCallback, useEffect, useRef, useState } from "react";
import { sampleAt, gapsOf } from "../lib/playbackPath";

/** Rates the control offers. Logarithmic — the useful range is not linear. */
export const PLAYBACK_RATES = [1, 2, 5, 10, 25, 50, 100];

/**
 * A silence shorter than this is played rather than skipped.
 *
 * Below about a minute the jump is more disruptive than the wait: at 25x a 45 s
 * hole is under two seconds of stillness, which reads as the machine pausing —
 * because that is usually what it was doing.
 */
const SKIPPABLE_GAP_MS = 60_000;

/**
 * How often the cursor is published to REACT, as opposed to to the subscribers.
 *
 * The cursor moves 60 times a second. It used to be React state and nothing
 * else, so every one of those frames re-rendered FleetMap — 3,200 lines — and
 * with it MapOverlay, which is not memoised: both rails, the live feed list and
 * every card in the vehicle panel, sixty times a second. That, not the clock,
 * is what made 100x stutter; the clock has always advanced by measured elapsed
 * time and never drifted.
 *
 * So the hot path is now a subscription — the marker, the trail, the scrubber
 * and the read-out are all written straight to the DOM or to Google's overlay —
 * and React sees the cursor at this rate, for the things that genuinely need a
 * render (the seek input's `min`/`max`, the skipped-gap notice).
 *
 * 8 Hz rather than 60: fast enough that a paused-then-seeked frame lands
 * promptly, slow enough that the re-render cost stops mattering.
 */
const UI_PUBLISH_MS = 125;

export function useRoutePlayback(points, { skipGaps = true } = {}) {
  const t0 = points.length ? points[0].t : 0;
  const t1 = points.length ? points[points.length - 1].t : 0;

  const [cursor,  setCursor]  = useState(t0);
  const [playing, setPlaying] = useState(false);
  const [rate,    setRate]    = useState(10);
  const [skipped, setSkipped] = useState(null);

  // Read inside the rAF loop, which must not re-subscribe every time one of
  // them changes — a loop torn down and rebuilt on each rate change drops the
  // frame it was mid-way through and stutters audibly at high rates.
  const rateRef   = useRef(rate);
  const cursorRef = useRef(cursor);
  const gapsRef   = useRef([]);
  const pointsRef = useRef(points);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { gapsRef.current = gapsOf(points); }, [points]);
  useEffect(() => { pointsRef.current = points; }, [points]);

  /**
   * Everything that wants the cursor at full rate.
   *
   * A Set rather than a single callback: the map drives a marker and a trail
   * with it, and the transport drives a clock and a scrubber, and neither
   * should have to know the other exists.
   */
  const subsRef  = useRef(new Set());
  const lastUiRef = useRef(0);

  /**
   * Move the cursor and tell everyone.
   *
   * `force` publishes to React immediately regardless of the throttle — for
   * anything the operator did on purpose (seek, play, pause, a new day), where
   * a delay of up to 125 ms would read as the control being unresponsive.
   */
  const publish = useCallback((t, { force = false } = {}) => {
    cursorRef.current = t;
    const sample = sampleAt(pointsRef.current, t);
    for (const fn of subsRef.current) fn(t, sample);

    const now = performance.now();
    if (force || now - lastUiRef.current >= UI_PUBLISH_MS) {
      lastUiRef.current = now;
      setCursor(t);
    }
  }, []);

  /**
   * Subscribe to the cursor. Returns an unsubscribe.
   *
   * Stable — no dependencies — so an effect that subscribes does not tear the
   * subscription down and rebuild it on every render, which would defeat the
   * point of not rendering.
   */
  const subscribe = useCallback((fn) => {
    subsRef.current.add(fn);
    // Fire once on subscribe, so a marker painted by a newly-mounted effect
    // starts at the cursor rather than waiting for the next frame — which,
    // while paused, never comes.
    fn(cursorRef.current, sampleAt(pointsRef.current, cursorRef.current));
    return () => { subsRef.current.delete(fn); };
  }, []);

  // A new day resets the clock. Keyed on the endpoints rather than on the array
  // identity, so a re-render that rebuilds an equal array does not rewind a
  // playback in progress.
  useEffect(() => {
    cursorRef.current = t0;
    setCursor(t0);
    setPlaying(false);
    setSkipped(null);
  }, [t0, t1]);

  // A fresh path at an unchanged cursor still has to reach the subscribers, or
  // the marker sits at a position sampled from the PREVIOUS day's points.
  useEffect(() => { publish(cursorRef.current, { force: true }); }, [points, publish]);

  useEffect(() => {
    if (!playing || t1 <= t0) return undefined;

    let raf = 0;
    let last = performance.now();

    const step = (now) => {
      // MEASURED elapsed time, so a long frame advances the cursor correctly
      // instead of losing the difference.
      const dt = now - last;
      last = now;

      let next = cursorRef.current + dt * rateRef.current;

      if (skipGaps) {
        // At high rates one frame can cross a whole silence, so this tests
        // containment of the STEP rather than of the new cursor — a gap the
        // cursor jumped clean over would otherwise never be noticed.
        const gap = gapsRef.current.find(
          g => g.to - g.from >= SKIPPABLE_GAP_MS && next > g.from && cursorRef.current < g.to,
        );
        if (gap) {
          // Land ON the far edge rather than carrying the frame's remaining
          // time past it. The remainder is time that belongs to the silence,
          // and spending it after the gap would run the next leg slightly
          // ahead of the clock the scrubber is showing.
          next = gap.to;
          setSkipped({ from: gap.from, to: gap.to, ms: gap.to - gap.from });
        }
      }

      if (next >= t1) {
        // The end is a state change, not a frame — publish it immediately or
        // the last 125 ms of the day never reaches the read-out.
        publish(t1, { force: true });
        setPlaying(false);
        return;
      }
      publish(next);
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, skipGaps, t0, t1, publish]);

  const seek = useCallback((t) => {
    publish(Math.max(t0, Math.min(t1, t)), { force: true });
    setSkipped(null);
  }, [t0, t1, publish]);

  const toggle = useCallback(() => {
    setPlaying((p) => {
      // Restarting from the end replays rather than sitting on the last frame,
      // which is what a second press of Play plainly means.
      if (!p && cursorRef.current >= t1) publish(t0, { force: true });
      return !p;
    });
  }, [t0, t1, publish]);

  return {
    cursor, playing, rate, skipped,
    setRate, seek, toggle,
    setPlaying,
    t0, t1,
    /**
     * The cursor at full rate, for anything that can write to the DOM itself.
     * `fn(t, sample)`, called on every animation frame and once on subscribe.
     * See UI_PUBLISH_MS for why this exists rather than everyone reading
     * `cursor`.
     */
    subscribe,
    /** Live cursor, for imperative reads outside a render. */
    cursorRef,
    /** Where the unit was at `cursor` — null on an empty track. */
    sample: sampleAt(points, cursor),
  };
}
