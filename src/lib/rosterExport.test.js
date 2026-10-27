import { describe, it, expect } from "vitest";
import { csvField, toCsv, exportFilename } from "./rosterExport";

const TAB = "\t";

describe("csvField", () => {
  it("quotes and doubles the things RFC 4180 says to", () => {
    expect(csvField('He said "go"')).toBe('"He said ""go"""');
    expect(csvField("Nairobi, Kenya")).toBe('"Nairobi, Kenya"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("defuses a formula hiding in a display name", () => {
    // A person can type their own name. Without this, that name runs as a
    // formula in every administrator's spreadsheet that opens the export.
    expect(csvField("=1+1")).toBe(TAB + "=1+1");
    expect(csvField("+1 700 000")).toBe(TAB + "+1 700 000");
    expect(csvField("-5")).toBe(TAB + "-5");
    expect(csvField("@handle")).toBe(TAB + "@handle");
  });

  it("leaves ordinary values alone", () => {
    expect(csvField("Silas Elisha")).toBe("Silas Elisha");
    expect(csvField(3)).toBe("3");
  });

  it("writes an empty field for nothing at all", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  const columns = [
    { key: "name", label: "Full name", value: (r) => r.name },
    { key: "email", label: "Email", value: (r) => r.email },
  ];

  it("writes a header then CRLF-separated rows", () => {
    const csv = toCsv([{ name: "Silas Elisha", email: "s@example.com" }], columns);
    expect(csv).toBe("Full name,Email\r\nSilas Elisha,s@example.com");
  });

  it("writes just the header for an empty roster", () => {
    expect(toCsv([], columns)).toBe("Full name,Email");
  });

  it("exports only the columns it was given", () => {
    // The export follows the VISIBLE columns — a file that disagrees with the
    // page it came from is worse than no export at all.
    const csv = toCsv([{ name: "A", email: "a@b.c" }], [columns[0]]);
    expect(csv).toBe("Full name\r\nA");
  });
});

describe("exportFilename", () => {
  const day = new Date("2026-09-21T10:00:00Z");

  it("carries the scope and the date", () => {
    expect(exportFilename("Sukari", day)).toBe("people-sukari-2026-09-21.csv");
  });

  it("slugs a name with spaces and punctuation", () => {
    expect(exportFilename("West Sugar Ltd.", day)).toBe("people-west-sugar-ltd-2026-09-21.csv");
  });

  it("falls back rather than producing a nameless file", () => {
    expect(exportFilename("", day)).toBe("people-roster-2026-09-21.csv");
    expect(exportFilename("***", day)).toBe("people-roster-2026-09-21.csv");
  });
});
