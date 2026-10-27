/**
 * The repair ladder is sequential: Pending -> Spare outsourced -> Fixing ->
 * Fixed, always all four. Rungs below the job's stage are done, the one it is
 * on is current, the rest are to come — decided by the stage, never by which
 * stages happen to appear in the history.
 *
 * The case this file guards: a job moved BACK (Fixing -> Spare outsourced,
 * the part was wrong) used to keep Fixing drawn done above a current Spare
 * rung, so a filled line sat above an unfilled one.
 */

import { describe, it, expect } from "vitest";
import { trackingLine, STAGE_ORDER } from "./repairs";

/** A history entry as the server writes it. */
const at = (stage, iso = "2026-09-20T08:00:00.000Z") => ({ stage, at: iso, byName: "Tech" });

const keys = (item) => trackingLine(item).map((n) => n.key);
const states = (item) => trackingLine(item).map((n) => n.state);
/** Which connectors RepairTrackingLine fills: the one into a reached rung. */
const filled = (item) => {
  const n = trackingLine(item);
  return n.slice(0, -1).map((_, i) => n[i + 1].state !== "todo");
};

describe("trackingLine, sequential", () => {
  it("always draws all four rungs in order", () => {
    for (const stage of ["pending", "spare_outsourced", "fixing", "fixed"]) {
      expect(keys({ stage, stageHistory: [] })).toEqual(STAGE_ORDER);
    }
    expect(keys({ stage: "failed", stageHistory: [] })).toEqual(["pending", "spare_outsourced", "fixing", "failed"]);
    expect(keys(null)).toEqual(STAGE_ORDER);
  });

  it("marks every rung below the stage done and every rung above it to come", () => {
    expect(states({ stage: "pending", stageHistory: [] })).toEqual(["current", "todo", "todo", "todo"]);
    expect(states({ stage: "spare_outsourced", stageHistory: [at("spare_outsourced")] })).toEqual(["done", "current", "todo", "todo"]);
    expect(states({ stage: "fixing", stageHistory: [at("spare_outsourced"), at("fixing")] })).toEqual(["done", "done", "current", "todo"]);
    expect(states({ stage: "fixed", stageHistory: [at("fixed")] })).toEqual(["done", "done", "done", "current"]);
  });

  it("fills a connector only once the rung it leads to is reached", () => {
    expect(filled({ stage: "pending", stageHistory: [] })).toEqual([false, false, false]);
    expect(filled({ stage: "spare_outsourced", stageHistory: [] })).toEqual([true, false, false]);
    expect(filled({ stage: "fixing", stageHistory: [] })).toEqual([true, true, false]);
    expect(filled({ stage: "fixed", stageHistory: [] })).toEqual([true, true, true]);
  });

  it("never fills a line above an unfilled one", () => {
    for (const stage of ["pending", "spare_outsourced", "fixing", "fixed", "failed"]) {
      const f = filled({ stage, stageHistory: [at("fixing"), at("fixed")] });
      expect(f.indexOf(false) === -1 || f.slice(f.indexOf(false)).every((x) => !x)).toBe(true);
    }
  });
});

describe("trackingLine, going back", () => {
  it("puts a later rung back to 'to come' when the job returns below it", () => {
    const item = {
      stage: "spare_outsourced",
      stageHistory: [at("spare_outsourced"), at("fixing"), at("spare_outsourced", "2026-09-21T08:00:00.000Z")],
    };
    expect(states(item)).toEqual(["done", "current", "todo", "todo"]);
    expect(filled(item)).toEqual([true, false, false]);
    // The date shown is the one it came back on.
    expect(trackingLine(item)[1].at).toBe("2026-09-21T08:00:00.000Z");
    // A rung still to come shows no date, even though it was once reached.
    expect(trackingLine(item)[2].at).toBeNull();
  });
});

describe("trackingLine, a rung passed without standing on it", () => {
  it("draws the spare rung done, with no date, for a job that needed no part", () => {
    const spare = trackingLine({ stage: "fixing", stageHistory: [at("fixing")] })[1];
    expect(spare.state).toBe("done");
    expect(spare.passedWithout).toBe(true);
    expect(spare.at).toBeNull();
  });

  it("does not flag pending, which has its own wording", () => {
    const pending = trackingLine({ stage: "fixing", stageHistory: [] })[0];
    expect(pending.implied).toBe(true);
    expect(pending.passedWithout).toBe(false);
  });

  it("treats an unrecognised stage as nothing passed", () => {
    expect(states({ stage: "quarantined", stageHistory: [] })).toEqual(["todo", "todo", "todo", "todo"]);
  });
});

describe("stageChipState, both chips lit", () => {
  const h = (stage) => ({ stage, at: "2026-09-30T08:00:00.000Z" });
  it("lights Spare outsourced beside Fixing when a spare was outsourced", async () => {
    const { stageChipState } = await import("./repairs");
    const job = { stage: "fixing", stageHistory: [h("spare_outsourced"), h("fixing")] };
    expect(stageChipState(job, "fixing")).toBe("on");
    expect(stageChipState(job, "spare_outsourced")).toBe("passed");
  });
  it("lights it amber when the job went to Fixing without one", async () => {
    const { stageChipState } = await import("./repairs");
    expect(stageChipState({ stage: "fixing", stageHistory: [h("fixing")] }, "spare_outsourced")).toBe("skipped");
  });
  it("leaves a stage still ahead unlit", async () => {
    const { stageChipState } = await import("./repairs");
    expect(stageChipState({ stage: "spare_outsourced", stageHistory: [] }, "fixing")).toBeNull();
  });
});

describe("mayWorkJob, a technician works only an accepted job of their own", () => {
  const job = (over = {}) => ({ id: "j", resolvedAt: null, assignedToId: "me", assignmentStatus: "accepted", ...over });
  it("lets a technician work their accepted job, and nothing else", async () => {
    const { mayWorkJob } = await import("./repairs");
    const tech = { canResolve: true, canWorkAny: false, userId: "me" };
    expect(mayWorkJob(job(), tech)).toBe(true);
    expect(mayWorkJob(job({ assignmentStatus: "pending" }), tech)).toBe(false);
    expect(mayWorkJob(job({ assignedToId: "other" }), tech)).toBe(false);
    expect(mayWorkJob(job({ assignedToId: null }), tech)).toBe(false);
  });
  it("lets repair:work_any work any open job, and nobody a signed-off one", async () => {
    const { mayWorkJob } = await import("./repairs");
    const mgr = { canResolve: true, canWorkAny: true, userId: "me" };
    expect(mayWorkJob(job({ assignedToId: "other", assignmentStatus: "pending" }), mgr)).toBe(true);
    expect(mayWorkJob(job({ resolvedAt: "2026-10-01T00:00:00Z" }), mgr)).toBe(false);
  });
});
