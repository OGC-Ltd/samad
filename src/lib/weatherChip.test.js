import { describe, it, expect } from "vitest";
import { weatherTone, cloudCover, weatherKind, compass } from "./weatherChip";

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

describe("weatherKind", () => {
  it("names the weather in one word", () => {
    expect(weatherKind({ type: "CLEAR", isDay: true }).kind).toBe("sunny");
    expect(weatherKind({ type: "CLEAR", isDay: false }).kind).toBe("clear");
    expect(weatherKind({ type: "PARTLY_CLOUDY" }).kind).toBe("partly");
    expect(weatherKind({ type: "CLOUDY" }).kind).toBe("cloudy");
    expect(weatherKind({ type: "LIGHT_RAIN", windKmh: 40 }).kind).toBe("rain");
    expect(weatherKind({ type: "THUNDERSTORM" }).kind).toBe("storm");
  });

  it("calls a sunny or cloudy cell windy once the wind is strong", () => {
    expect(weatherKind({ type: "CLEAR", windKmh: 30 }).kind).toBe("windy");
    expect(weatherKind({ type: "CLOUDY", gustKmh: 40 }).kind).toBe("windy");
    expect(weatherKind({ type: "CLEAR", windKmh: 12 }).kind).toBe("sunny");
  });

  it("gives the compass point the wind comes from", () => {
    expect(compass(0)).toBe("N");
    expect(compass(91)).toBe("E");
    expect(compass(225)).toBe("SW");
    expect(compass(350)).toBe("N");
    expect(compass(null)).toBeNull();
  });
});
