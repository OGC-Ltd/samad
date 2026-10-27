import { describe, it, expect } from "vitest";
import {
  confirmPhraseFor, confirmMatches, confirmState, skipsTypedConfirmation,
} from "./deleteConfirmation";

describe("confirmPhraseFor", () => {
  it("is the email when there is one", () => {
    expect(confirmPhraseFor({ email: "a@b.com", fullName: "A B" })).toBe("a@b.com");
  });

  it("falls back to the name when there is no email", () => {
    expect(confirmPhraseFor({ email: null, fullName: "Samuel Mbugua" })).toBe("Samuel Mbugua");
  });

  it("is empty when the row has neither", () => {
    expect(confirmPhraseFor({})).toBe("");
    expect(confirmPhraseFor(null)).toBe("");
  });

  it("trims, so a stored stray space cannot make the phrase untypeable", () => {
    expect(confirmPhraseFor({ email: "  a@b.com " })).toBe("a@b.com");
  });
});

describe("confirmMatches", () => {
  const phrase = "analyst-2@ogc-monitoring.com";

  it("accepts the address exactly", () => {
    expect(confirmMatches(phrase, phrase)).toBe(true);
  });

  // The reason this function exists: an administrator writes an address the way
  // they write it, and got a dead button for it.
  it("accepts it in any case", () => {
    expect(confirmMatches("Analyst-2@OGC-Monitoring.COM", phrase)).toBe(true);
  });

  it("accepts it with whitespace either side, as a paste leaves it", () => {
    expect(confirmMatches("  analyst-2@ogc-monitoring.com\n", phrase)).toBe(true);
  });

  it("collapses inner whitespace, for the name fallback", () => {
    expect(confirmMatches("Samuel   Mbugua", "Samuel Mbugua")).toBe(true);
  });

  it("still refuses a different address", () => {
    expect(confirmMatches("analyst-3@ogc-monitoring.com", phrase)).toBe(false);
  });

  it("still refuses a prefix, the whole thing has to be typed", () => {
    expect(confirmMatches("analyst-2", phrase)).toBe(false);
    expect(confirmMatches("analyst-2@ogc-monitoring.co", phrase)).toBe(false);
  });

  it("refuses a near miss inside the address", () => {
    expect(confirmMatches("analyst2@ogc-monitoring.com", phrase)).toBe(false);
  });

  it("never arms on an empty phrase, whatever is typed", () => {
    expect(confirmMatches("", "")).toBe(false);
    expect(confirmMatches("anything", "")).toBe(false);
    expect(confirmMatches("  ", undefined)).toBe(false);
  });

  it("never arms on an empty box", () => {
    expect(confirmMatches("", phrase)).toBe(false);
    expect(confirmMatches("   ", phrase)).toBe(false);
  });
});

describe("confirmState", () => {
  const phrase = "a@b.com";

  it("says empty before anything is typed", () => {
    expect(confirmState("", phrase)).toBe("empty");
    expect(confirmState("   ", phrase)).toBe("empty");
  });

  it("says partial part way through, which is not the same as wrong", () => {
    expect(confirmState("a@b", phrase)).toBe("partial");
  });

  it("says match when it matches, case and all", () => {
    expect(confirmState("A@B.COM", phrase)).toBe("match");
  });
});

describe("skipsTypedConfirmation", () => {
  const withAll = (slugs) => (slug) => slugs.includes(slug);

  it("lets a platform administrator through whatever else they hold", () => {
    expect(skipsTypedConfirmation({ isPlatform: true, can: () => false })).toBe(true);
  });

  it("lets an organisation's System Administrator through", () => {
    const can = withAll(["user:create", "user:update", "user:delete", "user:assign_role"]);
    expect(skipsTypedConfirmation({ isPlatform: false, can })).toBe(true);
  });

  // The case the whole-set rule exists for: a role somebody assembled by hand
  // that carries the delete bit and nothing else around it.
  it("still asks a role holding only user:delete to type it", () => {
    expect(skipsTypedConfirmation({ isPlatform: false, can: withAll(["user:delete"]) })).toBe(false);
  });

  it("still asks when one of the four is missing", () => {
    const can = withAll(["user:create", "user:update", "user:delete"]);
    expect(skipsTypedConfirmation({ isPlatform: false, can })).toBe(false);
  });

  it("does not throw when there is no can()", () => {
    expect(skipsTypedConfirmation({ isPlatform: false })).toBe(false);
    expect(skipsTypedConfirmation({})).toBe(false);
  });
});
