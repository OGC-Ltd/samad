/* Parsing the emailed set-password link.
 *
 * This is the gate that decides whether an unauthenticated visitor sees the
 * set-password screen at all, so it has to be strict in one direction and
 * forgiving in none: anything that is not a plausible token must read as "no
 * token" and fall through to the normal login screen. */

import { describe, it, expect } from "vitest";
import { readSetupToken } from "./setupLink";

const VALID = "abcdefghijklmnopqrstuvwxyz012345_-";

describe("readSetupToken", () => {
  it("reads a token out of the fragment", () => {
    expect(readSetupToken(`#setup=${VALID}`)).toBe(VALID);
  });

  it("returns null when there is no hash at all", () => {
    expect(readSetupToken("")).toBeNull();
    expect(readSetupToken("#")).toBeNull();
  });

  it("ignores a hash that is not ours", () => {
    expect(readSetupToken("#settings")).toBeNull();
    expect(readSetupToken(`#reset=${VALID}`)).toBeNull();
  });

  it("refuses a token that is too short to be 32 bytes", () => {
    expect(readSetupToken("#setup=abc")).toBeNull();
    expect(readSetupToken("#setup=")).toBeNull();
  });

  it("refuses characters outside base64url", () => {
    // A '+' or '/' means it is not the token we minted; anything with a quote
    // or angle bracket is somebody probing.
    expect(readSetupToken(`#setup=${"a".repeat(20)}+/`)).toBeNull();
    expect(readSetupToken(`#setup=${"a".repeat(20)}<script>`)).toBeNull();
    expect(readSetupToken(`#setup=${"a".repeat(20)}%20`)).toBeNull();
  });

  it("does not accept a token smuggled in a query string", () => {
    // Query strings land in nginx's access log, which is exactly why the link
    // uses a fragment. A token arriving this way is not one of ours.
    expect(readSetupToken(`?setup=${VALID}`)).toBeNull();
  });

  it("treats null and undefined as no token", () => {
    expect(readSetupToken(null)).toBeNull();
    expect(readSetupToken(undefined ?? "")).toBeNull();
  });
});
