/* Turning a failed mutation into a sentence.
 *
 * Every shape here is one the app actually produces: an ApiError carrying the
 * server's field map, an ApiError with only a message, and a bare TypeError
 * from fetch when the network is gone. The last one matters most — it has no
 * body at all, and a helper that assumed one would throw inside the catch
 * block that was meant to handle the failure. */

import { describe, it, expect } from "vitest";
import { fieldErrors, firstMessage } from "./formErrors";

/** What services/api.js throws: message + status + the whole parsed body. */
const apiError = (message, body) => Object.assign(new Error(message), { body, status: 400 });

describe("fieldErrors", () => {
  it("returns the server's field map", () => {
    const err = apiError("Validation failed", {
      errors: { newPassword: ["Use at least 12 characters"] },
    });
    expect(fieldErrors(err)).toEqual({ newPassword: ["Use at least 12 characters"] });
  });

  it("returns null when the body carries no field map", () => {
    expect(fieldErrors(apiError("Current password is incorrect", { message: "…" }))).toBeNull();
  });

  it("survives an error with no body at all", () => {
    expect(fieldErrors(new TypeError("Failed to fetch"))).toBeNull();
    expect(fieldErrors(null)).toBeNull();
    expect(fieldErrors(undefined)).toBeNull();
  });
});

describe("firstMessage", () => {
  it("prefers the named field's own message", () => {
    const err = apiError("Validation failed", {
      errors: { newPassword: ["Use at least 12 characters"], fullName: ["Too short"] },
    });
    expect(firstMessage(err, "newPassword")).toBe("Use at least 12 characters");
  });

  it("falls back to any field when the named one is absent", () => {
    const err = apiError("Validation failed", { errors: { email: ["Not an email"] } });
    // Better to say something specific about a field the form did not ask
    // about than to say "validation failed".
    expect(firstMessage(err, "fullName")).toBe("Not an email");
  });

  it("falls back to the top-level message", () => {
    const err = apiError("Current password is incorrect", { message: "Current password is incorrect" });
    expect(firstMessage(err, "currentPassword")).toBe("Current password is incorrect");
  });

  it("falls back to the caller's default for a bare network failure", () => {
    expect(firstMessage(new TypeError(""), "fullName", "Could not save.")).toBe("Could not save.");
  });

  it("uses the default when there is no error object at all", () => {
    expect(firstMessage(null, "fullName", "Could not save.")).toBe("Could not save.");
  });

  it("ignores an empty field array rather than showing undefined", () => {
    const err = apiError("Validation failed", { errors: { fullName: [] } });
    expect(firstMessage(err, "fullName", "Could not save.")).toBe("Validation failed");
  });
});
