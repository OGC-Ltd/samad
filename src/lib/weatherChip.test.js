import { describe, it, expect } from "vitest";
import { weatherTone } from "./weatherChip";

describe("weather cells", () => {
  it("tells storms and rain from fair weather", () => {
    expect(weatherTone({ type: "THUNDERSTORM" })).toBe("storm");
    expect(weatherTone({ type: "CLOUDY", thunderPct: 60 })).toBe("storm");
    expect(weatherTone({ type: "LIGHT_RAIN" })).toBe("rain");
    expect(weatherTone({ type: "CLOUDY", rainPct: 70 })).toBe("rain");
    expect(weatherTone({ type: "PARTLY_CLOUDY", rainPct: 5 })).toBeNull();
  });
});
