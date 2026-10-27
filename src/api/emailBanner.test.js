/**
 * What the technician is told about the mail — and the one word it must never
 * use loosely.
 *
 * `emailBanner`'s own header promises it "only says 'emailed' when a mail
 * actually left". The server now hands mail to BullMQ and returns before SMTP
 * is attempted, which introduced an outcome that is neither sent nor failed.
 * These pin that it lands in neither of the old buckets: a tick would tell
 * somebody the handlers know when they do not yet, and a warning would send
 * them chasing a mail that is simply in flight with retries behind it.
 */

import { describe, it, expect } from "vitest";
import { emailBanner, assignmentToast } from "./repairs";

describe("emailBanner", () => {
  it("does not claim anything was emailed when the mail is only queued", () => {
    const b = emailBanner({ status: "queued", recipients: ["a@b.c", "d@e.f"], sent: ["a@b.c", "d@e.f"], failed: [] });
    expect(b.text).not.toMatch(/emailed/i);
    expect(b.text).toMatch(/queued/i);
  });

  it("does not raise a warning for a queued mail", () => {
    // Nothing has gone wrong and there is nothing for the technician to do.
    expect(emailBanner({ status: "queued", recipients: ["a@b.c"], sent: ["a@b.c"], failed: [] }).tone).toBe("ok");
  });

  it("counts the recipients it will reach, not the ones it has", () => {
    // `sent` is an acceptance list here, so counting it would be counting the
    // same thing twice under a name that implies delivery.
    expect(emailBanner({ status: "queued", recipients: ["a@b.c", "d@e.f", "g@h.i"], sent: [], failed: [] }).text)
      .toMatch(/3 handlers/);
  });

  it("still says the report is filed, which is the fact that matters most", () => {
    // The report is durable whatever the mail did. That was true before the
    // queue and must stay true for the new status.
    expect(emailBanner({ status: "queued", recipients: ["a@b.c"], sent: [], failed: [] }).text)
      .toMatch(/^Report filed\./);
  });

  it("leaves the outcomes that were already honest alone", () => {
    expect(emailBanner({ status: "sent", recipients: ["a@b.c"], sent: ["a@b.c"], failed: [] }).text)
      .toMatch(/Emailed to 1 handler/);
    expect(emailBanner({ status: "unconfigured", recipients: ["a@b.c"], sent: [], failed: [] }).tone).toBe("warn");
    expect(emailBanner({ status: "failed", recipients: ["a@b.c"], sent: [], failed: ["a@b.c"] }).tone).toBe("warn");
    expect(emailBanner(undefined).text).toBe("Report filed.");
  });
});

describe("assignmentToast", () => {
  it("does not say the email was sent when it is only queued", () => {
    // The one the server can no longer promise: it hands the mail to BullMQ
    // and returns before SMTP is attempted.
    const t = assignmentToast({ sent: false, reason: "queued" }, "Ada");
    expect(t.text).not.toMatch(/Email sent/);
    expect(t.text).toBe("Triage assigned to Ada. Email queued for delivery.");
  });

  it("does not warn about a queued email either", () => {
    // Three attempts sit behind it. A warning would send the assigner chasing
    // a mail that is simply in flight.
    expect(assignmentToast({ sent: false, reason: "queued" }, "Ada").tone).toBe("ok");
  });

  it("still names the assignee, which is the part the assigner acts on", () => {
    expect(assignmentToast({ sent: false, reason: "queued" }, "Ada").text).toMatch(/assigned to Ada/);
  });

  it("keeps saying sent when the server actually sent it", () => {
    // With no REDIS_URL the server sends inline and reports sent, so this
    // branch is not dead — it is the current production answer.
    expect(assignmentToast({ sent: true }, "Ada")).toEqual({
      tone: "ok", text: "Triage assigned to Ada. Email sent.",
    });
  });

  it("keeps the self-assignment and failure answers unchanged", () => {
    expect(assignmentToast({ sent: false, reason: "self-assignment" }, "Ada").text)
      .toBe("Task assigned to you. No email was sent.");
    expect(assignmentToast({ sent: false, reason: "send-failed" }, "Ada").tone).toBe("warn");
    expect(assignmentToast({ sent: false, reason: "unconfigured" }, "Ada").tone).toBe("warn");
  });

  it("falls back rather than printing undefined when the server says nothing", () => {
    expect(assignmentToast(undefined).text).toMatch(/the selected person/);
  });
});
