import { describe, it, expect } from "vitest";
import { weatherTone, cloudCover } from "./weatherChip";

describe("weather cells", () => {
  it("tells storms and rain from fair weather", () => {
    expect(weatherTone({ type: "THUNDERSTORM" })).toBe("storm");
    expect(weatherTone({ type: "CLOUDY", thunderPct: 60 })).toBe("storm");
    expect(weatherTone({ type: "LIGHT_RAIN" })).toBe("rain");
    expect(weatherTone({ type: "CLOUDY", rainPct: 70 })).toBe("rain");
    expect(weatherTone({ type: "PARTLY_CLOUDY", rainPct: 5 })).toBeNull();
  });

  it("draws what is happening now, not a chance of it, under a clear sky", () => {
    expect(weatherTone({ type: "CLEAR", rainPct: 80 })).toBeNull();
    expect(weatherTone({ type: "MOSTLY_CLEAR", thunderPct: 70 })).toBeNull();
    expect(weatherTone({ type: "WIND_AND_RAIN" })).toBe("rain");
  });

  it("greys cloudy skies by how cloudy", () => {
    expect(cloudCover({ type: "CLEAR" })).toBe(0);
    expect(cloudCover({ type: "PARTLY_CLOUDY" })).toBeLessThan(cloudCover({ type: "CLOUDY" }));
    expect(cloudCover({ type: "LIGHT_RAIN" })).toBeGreaterThan(0);
  });
});
