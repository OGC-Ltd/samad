// The two pixel scales, pinned.
//
// Three-line functions, tested because the failure they prevent is invisible in
// review and unmistakable on screen: a window that jumps out from under the
// cursor the moment it is grabbed. The drift is exactly the zoom factor, so the
// same bug reads as a twitch at 90% and as a broken app at 50%.
//
// No DOM here — the scale is passed in. vite.config.js keeps this suite on
// `node` deliberately, and these are arithmetic.

import { describe, it, expect } from "vitest";
import { appZoom, toLayoutPx, pointerXY, rectXY, layoutViewport } from "./appZoom";

describe("reading the scale", () => {
  it("is 1 with no document, rather than NaN", () => {
    // NaN is the worst outcome available here: a NaN in a style attribute does
    // not misplace the element, it removes it.
    expect(appZoom()).toBe(1);
  });
});

describe("screen px to layout px", () => {
  it("converts a pointer position", () => {
    expect(pointerXY({ clientX: 360, clientY: 270 }, 0.9)).toEqual({ x: 400, y: 300 });
  });

  it("converts every edge of a rect, not only its origin", () => {
    // A width left unconverted is a clamp that stops the window 10% early.
    expect(rectXY(
      { left: 360, top: 270, right: 468, bottom: 324, width: 108, height: 54 }, 0.9,
    )).toEqual({ left: 400, top: 300, right: 520, bottom: 360, width: 120, height: 60 });
  });

  it("is the exact inverse of what the browser did to the rect", () => {
    // The measured case: an element written to left:400px inside a 0.9 tree
    // reports a client left of 360.
    expect(toLayoutPx(400 * 0.9, 0.9)).toBeCloseTo(400, 10);
  });

  it("gives the viewport the app actually lays out in", () => {
    // 1440x900 of screen is 1600x1000 of room — the whole point of the change.
    expect(layoutViewport(0.9, 1440, 900)).toEqual({ width: 1600, height: 1000 });
  });

  it("passes a null rect through instead of returning an object of NaN", () => {
    expect(rectXY(null, 0.9)).toBe(null);
  });
});

describe("at zoom 1", () => {
  it("every conversion is the identity, so the scale can be switched off", () => {
    expect(pointerXY({ clientX: 360, clientY: 270 }, 1)).toEqual({ x: 360, y: 270 });
    expect(toLayoutPx(360, 1)).toBe(360);
    expect(layoutViewport(1, 1440, 900)).toEqual({ width: 1440, height: 900 });
  });
});
