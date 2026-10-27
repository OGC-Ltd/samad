import { describe, it, expect } from "vitest";
import { channelLabel } from "./vehicleCamera";

describe("channelLabel", () => {
  it("calms the installers' capitals", () => {
    expect(channelLabel("ROAD")).toBe("Road");
    expect(channelLabel("IN CABIN")).toBe("In cabin");
  });
  it("keeps channel numbers as they are", () => {
    expect(channelLabel("ch1")).toBe("CH1");
    expect(channelLabel("CH 2")).toBe("CH2");
  });
  it("names a blank channel", () => {
    expect(channelLabel("")).toBe("Camera");
    expect(channelLabel(null)).toBe("Camera");
  });
});
