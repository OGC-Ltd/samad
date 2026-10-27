import { describe, it, expect } from "vitest";
import { harshEvents, harshCountWords } from "./harshDriving";

const item = (id, alertType, ts, text, extra = {}) => ({ id, alertType, ts, text, plate: "FT 13", vehicleId: "v1", type: "warning", ...extra });

describe("harshEvents", () => {
  it("reads the day's harsh events, newest first, once each", () => {
    const items = [
      item("a", "HARSH_BRAKING", "2026-10-21T08:15:30Z", "Harsh braking — FT 13 at FARM#212 38 km/h (3.1 m/s²)"),
      item("b", "HARSH_ACCELERATION", "2026-10-21T09:00:00Z", "Harsh acceleration — FT 13"),
      item("a", "HARSH_BRAKING", "2026-10-21T08:15:30Z", "Harsh braking — FT 13 at FARM#212 38 km/h (3.1 m/s²)"),
      item("c", null, "2026-10-21T09:30:00Z", "Arrived at the factory"),
      item("d", "HARSH_BRAKING", "2026-10-21T10:00:00Z", "Harsh braking — CTR 07", { vehicleId: "v2", plate: "CTR 07" }),
    ];
    const ev = harshEvents(items, "v1");
    expect(ev.map((e) => e.id)).toEqual(["b", "a"]);
    expect(ev[1]).toMatchObject({ title: "Harsh braking", where: "At FARM#212 38 km/h", force: 3.1 });
    expect(ev[0]).toMatchObject({ title: "Harsh acceleration", where: null, force: null });
  });

  it("counts them in words", () => {
    const ev = harshEvents([
      item("a", "HARSH_BRAKING", "2026-10-21T08:00:00Z", "Harsh braking — FT 13"),
      item("b", "HARSH_BRAKING", "2026-10-21T08:10:00Z", "Harsh braking — FT 13"),
      item("c", "HARSH_ACCELERATION", "2026-10-21T08:20:00Z", "Harsh acceleration — FT 13"),
    ], "v1");
    expect(harshCountWords(ev)).toBe("2 harsh brakes · 1 harsh acceleration");
    expect(harshCountWords([])).toBeNull();
  });
});
