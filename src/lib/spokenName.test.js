import { describe, it, expect } from "vitest";
import { spokenSiteName } from "./spokenName";

describe("spokenSiteName", () => {
  // The provider shouts. These are the actual spellings that arrive.
  it("lowers a name that is all capitals", () => {
    expect(spokenSiteName("OPAPO")).toBe("Opapo");
    expect(spokenSiteName("WESTERN MILL")).toBe("Western Mill");
    expect(spokenSiteName("NAITIRI")).toBe("Naitiri");
  });

  // The point is to stop SHOUTING, not to impose a house style. A centre whose
  // name already arrives readable is somebody's deliberate spelling.
  it("leaves mixed case exactly as it came", () => {
    expect(spokenSiteName("Western Mill")).toBe("Western Mill");
    expect(spokenSiteName("McKinnon")).toBe("McKinnon");
  });

  // A bridge number or a code beside the name is not a word and must survive
  // whole — lowering "NO2" to "No2" is fine, mangling "2" is not.
  it("never touches digits", () => {
    expect(spokenSiteName("MILL 2")).toBe("Mill 2");
    expect(spokenSiteName("SITE 101")).toBe("Site 101");
  });

  it("survives what the feed can actually send", () => {
    expect(spokenSiteName("")).toBe("");
    expect(spokenSiteName(null)).toBe("");
    expect(spokenSiteName(undefined)).toBe("");
  });
});
