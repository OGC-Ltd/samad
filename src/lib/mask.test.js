import { describe, it, expect } from "vitest";
import { maskEmail, maskPhone } from "./mask";

const DOT = "\u2022";

describe("maskEmail", () => {
  it("keeps the domain and one letter, because that is what recognition needs", () => {
    expect(maskEmail("operations4@ogc-monitoring.com")).toBe(`o${DOT.repeat(3)}@ogc-monitoring.com`);
  });

  it("hides the length of what it hid", () => {
    // Two addresses of very different length mask to the same width. A mask
    // that counted its own dots would hand back the length of the local part.
    expect(maskEmail("jo@x.io").split("@")[0]).toBe(maskEmail("jonathan.mwangi@x.io").split("@")[0]);
  });

  it("masks anything that is not shaped like an address, rather than guessing", () => {
    expect(maskEmail("no-at-sign")).toBe(DOT.repeat(3));
    expect(maskEmail("@nolocalpart.com")).toBe(DOT.repeat(3));
  });

  it("returns nothing for nothing, so a caller can fall through to its own dash", () => {
    expect(maskEmail(null)).toBe("");
    expect(maskEmail(undefined)).toBe("");
    expect(maskEmail("   ")).toBe("");
  });
});

describe("maskPhone", () => {
  it("keeps the last three digits and drops every separator", () => {
    expect(maskPhone("+254 712 345 678")).toBe(`${DOT.repeat(3)} ${DOT.repeat(3)} 678`);
    expect(maskPhone("0712345678")).toBe(`${DOT.repeat(3)} ${DOT.repeat(3)} 678`);
  });

  it("never keeps the country code, which is one to three digits and cannot be guessed at", () => {
    expect(maskPhone("+254712345678")).not.toContain("254");
    expect(maskPhone("+15551234567")).not.toContain("+1");
  });

  it("gives nothing away from a number too short to mask", () => {
    expect(maskPhone("1234")).toBe(`${DOT.repeat(3)} ${DOT.repeat(3)}`);
  });

  it("returns nothing for nothing", () => {
    expect(maskPhone(null)).toBe("");
    expect(maskPhone("n/a")).toBe("");
  });
});
