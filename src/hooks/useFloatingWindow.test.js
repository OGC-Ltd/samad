/**
 * The free-area geometry every window over the map is placed and clamped into.
 *
 * The numbers in `DESKTOP` are not invented — they were read off the running
 * app at 1280x720: the map at (0,56) 1280x664, MapOverlay's rails 336px and
 * 340px wide, and the fixed footer nav 64px tall with its top at y=656. So a
 * failure here is a failure against the layout that actually ships.
 *
 * `computeSafeArea` and `clampInto` are separated from the DOM reads precisely
 * so this file can exist: the project has no DOM test environment, and the
 * arithmetic is where "the window ended up behind the right rail" lives.
 */

import { describe, it, expect } from 'vitest'
import { computeSafeArea, clampInto, DOCKS } from './useFloatingWindow.js'

/** A DOMRect-shaped literal — computeSafeArea reads only the four edges. */
const rect = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h })

/** The measured production desktop layout. */
const DESKTOP = {
  base:      rect(0, 56, 1280, 664),
  leftRail:  rect(0, 56, 336, 664),
  rightRail: rect(940, 56, 340, 664),
  footer:    rect(0, 656, 1280, 64),
}

/** The mobile shell hides both rails outright, so they measure 0 and read null. */
const PHONE = { base: rect(0, 0, 375, 812), leftRail: null, rightRail: null, footer: rect(0, 748, 375, 64) }

describe('the free area', () => {
  it('starts after the left rail and stops before the right one', () => {
    const a = computeSafeArea(DESKTOP)

    // 336 + 12 of clearance, and 940 - 12.
    expect(a.left).toBe(348)
    expect(a.right).toBe(928)
    expect(a.width).toBe(580)

    // Which is the whole point: the viewport is 1280 wide and only 580 of it
    // can hold a window.
    expect(a.width).toBeLessThan(DESKTOP.base.width / 2)
  })

  it('floors at the FIXED nav, not at where the map says it ends', () => {
    const a = computeSafeArea(DESKTOP)
    // The map's box runs to 720, under a nav whose top is 656.
    expect(DESKTOP.base.bottom).toBe(720)
    expect(a.bottom).toBe(644)
    expect(a.bottom).toBeLessThanOrEqual(DESKTOP.footer.top)
  })

  it('falls back to a fixed inset when there is no nav to measure', () => {
    const a = computeSafeArea({ ...DESKTOP, footer: null })
    expect(a.bottom).toBe(720 - 80 - 12)
  })

  it('gives a phone its whole width, because there are no rails to avoid', () => {
    const a = computeSafeArea(PHONE)
    expect(a.left).toBe(12)
    expect(a.right).toBe(363)
    // Hardcoding 336/340 here would have left a 351px-wide phone with a 0px
    // column and every window stranded in the middle.
    expect(a.width).toBe(351)
  })

  it('abandons the rails rather than return a sliver', () => {
    // Rails do not shrink with the window, so below roughly 900px they leave
    // less than a window's worth between them. Overlapping a rail beats being
    // unreadable, so the area reverts to the map's own box.
    const narrow = {
      base:      rect(0, 56, 860, 664),
      leftRail:  rect(0, 56, 336, 664),
      rightRail: rect(520, 56, 340, 664),
      footer:    rect(0, 656, 860, 64),
    }
    const a = computeSafeArea(narrow)
    expect(a.width).toBe(860 - 24)
    expect(a.left).toBe(12)
  })

  /**
   * A zero-sized map is a real state, not a hypothetical: an element in a
   * laid-out document before it has been given a size, and a host reporting a
   * zero viewport. The old arithmetic returned 12 .. -12 — a width of MINUS 24
   * — which, published as `--safe-w`, satisfies every `var(--safe-w, fallback)`
   * and collapses every floating window to nothing.
   */
  it('does not return a negative width for a zero-sized map', () => {
    const a = computeSafeArea({ base: rect(0, 0, 0, 0) })
    expect(a.width).toBeGreaterThanOrEqual(0)
    expect(a.height).toBeGreaterThanOrEqual(0)
  })

  it('never returns a negative rectangle', () => {
    for (const w of [200, 320, 480, 768, 1024, 1280, 1920]) {
      const a = computeSafeArea({
        base: rect(0, 56, w, 664),
        leftRail: rect(0, 56, 336, 664),
        rightRail: rect(Math.max(0, w - 340), 56, 340, 664),
        footer: rect(0, 656, w, 64),
      })
      expect(a.width).toBeGreaterThan(0)
      expect(a.height).toBeGreaterThan(0)
    }
  })
})

describe('clamping into it', () => {
  const A = computeSafeArea(DESKTOP)
  const PLAYBACK = { w: 560, h: 120 }

  it('pulls a window dragged at the left rail back out from behind it', () => {
    const { x } = clampInto(A, -500, 300, PLAYBACK.w, PLAYBACK.h)
    expect(x).toBe(A.left)
  })

  it('stops a window before the right rail, not at the screen edge', () => {
    const { x } = clampInto(A, 5000, 300, PLAYBACK.w, PLAYBACK.h)
    expect(x).toBe(A.right - PLAYBACK.w)
    // The old viewport clamp would have allowed 1280 - 560 - 12 = 708, which
    // is 368px of window behind the right rail.
    expect(x).toBeLessThan(708)
  })

  it('keeps it clear of the header band and the footer nav', () => {
    expect(clampInto(A, 400, -200, PLAYBACK.w, PLAYBACK.h).y).toBe(A.top)
    expect(clampInto(A, 400, 5000, PLAYBACK.w, PLAYBACK.h).y).toBe(A.bottom - PLAYBACK.h)
    expect(clampInto(A, 400, 5000, PLAYBACK.w, PLAYBACK.h).y + PLAYBACK.h)
      .toBeLessThanOrEqual(DESKTOP.footer.top)
  })

  it('leaves a position that is already inside alone', () => {
    // The pinned vehicle card, 264px — at 500 it ends at 764, well inside the
    // column's 928. Using the 560px transport here would NOT have been an
    // interior position (500 + 560 = 1060), and the clamp moving it would have
    // looked like a bug in the clamp rather than in the fixture.
    expect(clampInto(A, 500, 300, 264, 200)).toEqual({ x: 500, y: 300 })
  })

  it('clamps by the window\'s far edge, not its origin', () => {
    // x = 500 is inside the column; a 560px window placed there is not.
    expect(500).toBeGreaterThan(A.left)
    expect(500).toBeLessThan(A.right)
    expect(clampInto(A, 500, 300, PLAYBACK.w, PLAYBACK.h).x).toBe(A.right - PLAYBACK.w)
  })

  /**
   * The bug this whole change exists for. A window placed at the right of a
   * 1920px monitor is remembered in localStorage; the same operator opens the
   * laptop and it is restored at a coordinate that is now behind the rail.
   */
  it('rescues a position remembered on a bigger monitor', () => {
    const wide = computeSafeArea({
      base: rect(0, 56, 1920, 1024), leftRail: rect(0, 56, 336, 968),
      rightRail: rect(1580, 56, 340, 968), footer: rect(0, 1016, 1920, 64),
    })
    const parked = clampInto(wide, 1000, 700, PLAYBACK.w, PLAYBACK.h)
    expect(parked.x).toBe(1000)

    const restored = clampInto(A, parked.x, parked.y, PLAYBACK.w, PLAYBACK.h)
    expect(restored.x).toBe(A.right - PLAYBACK.w)
    expect(restored.y).toBe(A.bottom - PLAYBACK.h)
  })

  /**
   * The pinned incident window is 680px against 580px of column, so it cannot
   * fit. Clamping must pin it to the LEFT edge — the naive `min(max(...))`
   * without the inner guard sends it to `right - 680`, which is 100px to the
   * left of the area and straight back under the left rail.
   */
  it('pins a window too wide for the column to the left edge, not off it', () => {
    const { x } = clampInto(A, 600, 300, 680, 400)
    expect(x).toBe(A.left)
    expect(x).toBeGreaterThan(DESKTOP.leftRail.right)
    expect(A.right - 680).toBeLessThan(A.left)   // what it would have been
  })
})

describe('docks land inside the area', () => {
  const A = computeSafeArea(DESKTOP)

  it.each(Object.keys(DOCKS))('%s', (name) => {
    const w = 420, h = 160
    const { x, y } = DOCKS[name](A, w, h)
    expect(x).toBeGreaterThanOrEqual(A.left)
    expect(y).toBeGreaterThanOrEqual(A.top)
    expect(x + w).toBeLessThanOrEqual(A.right)
    expect(y + h).toBeLessThanOrEqual(A.bottom)
  })

  it('centres the two centred docks on the COLUMN, not on the screen', () => {
    const w = 420
    const { x } = DOCKS['bottom-center'](A, w, 160)
    expect(x + w / 2).toBe(A.left + A.width / 2)
    // The screen's centre is 640; the column's is 638. Small here, and 170px
    // out on a layout where only one rail is showing.
    expect(x + w / 2).not.toBe(DESKTOP.base.width / 2)
  })
})
