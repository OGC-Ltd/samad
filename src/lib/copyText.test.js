import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyText, formatCoords } from "./copyText";

// No jsdom — see the note in vite.config.js. What is worth pinning here is
// WHICH path runs and that neither throws, and a fake document the size of the
// three calls copyText makes says that more precisely than a real one would.
let appended;

function fakeDocument(execResult) {
  appended = [];
  return {
    createElement: () => ({
      style: {},
      setAttribute: () => {},
      select: () => {},
      setSelectionRange: () => {},
    }),
    body: {
      appendChild: (n) => appended.push(n),
      removeChild: (n) => { appended = appended.filter((x) => x !== n); },
    },
    execCommand:
      typeof execResult === "function" ? execResult : () => execResult,
  };
}

beforeEach(() => {
  vi.stubGlobal("document", fakeDocument(true));
  vi.stubGlobal("navigator", {});
});

afterEach(() => vi.unstubAllGlobals());

describe("copyText", () => {
  it("uses the Clipboard API when the context is secure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = vi.fn(() => true);
    vi.stubGlobal("document", fakeDocument(exec));

    expect(await copyText("-0.823400, 34.384490")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("-0.823400, 34.384490");
    expect(exec).not.toHaveBeenCalled();
  });

  // THE regression this file exists for. Plain HTTP leaves navigator.clipboard
  // undefined, and the old call site read `.then` straight off the optional
  // chain's undefined — so the handler threw before copying anything, on every
  // machine an operator uses and on none that a developer does.
  it("falls back when there is no clipboard object at all", async () => {
    const exec = vi.fn(() => true);
    vi.stubGlobal("document", fakeDocument(exec));

    expect(await copyText("-0.823400, 34.384490")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("falls back when writeText rejects, denied, or document not focused", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    expect(await copyText("x")).toBe(true);
  });

  it("reports failure rather than throwing when both paths are gone", async () => {
    vi.stubGlobal("document", fakeDocument(() => { throw new Error("nope"); }));
    await expect(copyText("x")).resolves.toBe(false);
  });

  it("returns false, not true, when execCommand quietly declines", async () => {
    expect(await copyText("x")).toBe(true);
    vi.stubGlobal("document", fakeDocument(false));
    expect(await copyText("x")).toBe(false);
  });

  it("leaves no textarea behind", async () => {
    await copyText("x");
    expect(appended).toHaveLength(0);
  });

  it("refuses an empty or non-string payload", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("")).toBe(false);
    expect(await copyText(null)).toBe(false);
    expect(await copyText(undefined)).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("formatCoords", () => {
  it("pairs them at six places", () => {
    expect(formatCoords(-0.8234, 34.38449)).toBe("-0.823400, 34.384490");
  });

  // A unit whose marker is drawn from a last-known position can arrive with
  // one half missing; the button is disabled rather than copying "NaN".
  it("is null when either half is missing", () => {
    expect(formatCoords(null, 34.38449)).toBeNull();
    expect(formatCoords(-0.8234, undefined)).toBeNull();
    expect(formatCoords(NaN, NaN)).toBeNull();
  });

  it("keeps a genuine zero", () => {
    expect(formatCoords(0, 0)).toBe("0.000000, 0.000000");
  });
});
