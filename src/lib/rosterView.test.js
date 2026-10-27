import { describe, it, expect } from "vitest";
import {
  sortRows, nextSort, paginate, pageWindow,
  selectionState, toggleSelected, toggleAllVisible, pruneSelection,
} from "./rosterView";

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}` }));
const ids = (list) => list.map((r) => r.id);

const people = [
  { id: "a", name: "Zawadi", changed: 3 },
  { id: "b", name: "amina",  changed: 1 },
  { id: "c", name: "Mwangi", changed: null },
];
const by = { name: (r) => r.name, changed: (r) => r.changed };

describe("sortRows", () => {
  it("sorts case-insensitively, so 'amina' is not exiled below 'Zawadi'", () => {
    expect(ids(sortRows(people, { key: "name", dir: "asc" }, by))).toEqual(["b", "c", "a"]);
  });

  it("keeps empty values last in BOTH directions", () => {
    // A null password date is not "the earliest change" — it is no value at
    // all, and it must never win the top of the table.
    expect(ids(sortRows(people, { key: "changed", dir: "asc" }, by)).at(-1)).toBe("c");
    expect(ids(sortRows(people, { key: "changed", dir: "desc" }, by)).at(-1)).toBe("c");
  });

  it("returns the list untouched for no sort or an unknown column", () => {
    expect(ids(sortRows(people, null, by))).toEqual(["a", "b", "c"]);
    expect(ids(sortRows(people, { key: "nope", dir: "asc" }, by))).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const original = [...people];
    sortRows(people, { key: "name", dir: "asc" }, by);
    expect(people).toEqual(original);
  });
});

describe("nextSort", () => {
  it("cycles asc then desc then off on the same column", () => {
    let s = nextSort(null, "name");
    expect(s).toEqual({ key: "name", dir: "asc" });
    s = nextSort(s, "name");
    expect(s).toEqual({ key: "name", dir: "desc" });
    expect(nextSort(s, "name")).toBeNull();
  });

  it("starts fresh at asc when a different column is clicked", () => {
    expect(nextSort({ key: "name", dir: "desc" }, "changed")).toEqual({ key: "changed", dir: "asc" });
  });
});

describe("paginate", () => {
  it("reports the range a footer needs", () => {
    const p = paginate(rows(380), 2, 15);
    expect([p.from, p.to, p.total, p.pageCount]).toEqual([16, 30, 380, 26]);
    expect(p.slice).toHaveLength(15);
  });

  it("clamps a page that no longer exists after filtering", () => {
    // The ordinary case: sitting on page 20, then narrowing to 12 rows. The
    // honest answer is the last page, not an empty table under a live pager.
    const p = paginate(rows(12), 20, 15);
    expect(p.page).toBe(1);
    expect(p.slice).toHaveLength(12);
  });

  it("says 0 to 0 on an empty roster, never 1 to 0", () => {
    const p = paginate([], 1, 15);
    expect([p.from, p.to, p.total, p.pageCount]).toEqual([0, 0, 0, 1]);
  });

  it("survives a junk page number", () => {
    expect(paginate(rows(30), 0, 15).page).toBe(1);
    expect(paginate(rows(30), -4, 15).page).toBe(1);
    expect(paginate(rows(30), NaN, 15).page).toBe(1);
  });

  it("does not divide by a zero page size", () => {
    expect(paginate(rows(30), 1, 0).slice).toHaveLength(15);
  });
});

describe("pageWindow", () => {
  it("elides the middle with nulls the caller renders as gaps", () => {
    expect(pageWindow(1, 26)).toEqual([1, 2, null, 26]);
    expect(pageWindow(13, 26)).toEqual([1, null, 12, 13, 14, null, 26]);
    expect(pageWindow(26, 26)).toEqual([1, null, 25, 26]);
  });

  it("never elides a single missing page", () => {
    // [1, 2, null, 4] would be an ellipsis standing in for one number — wider
    // than the number it replaced, and a click to find nothing behind it.
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(4, 4)).toEqual([1, 2, 3, 4]);
    // Two or more missing still collapses.
    expect(pageWindow(1, 5)).toEqual([1, 2, null, 5]);
  });

  it("collapses to one button for a single page", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 0)).toEqual([1]);
  });
});

describe("selection", () => {
  const visible = ["a", "b", "c"];

  it("reports none, some and all against what is ON SCREEN", () => {
    expect(selectionState(new Set(), visible)).toBe("none");
    expect(selectionState(new Set(["a"]), visible)).toBe("some");
    expect(selectionState(new Set(["a", "b", "c"]), visible)).toBe("all");
  });

  it("is 'none' when there is nothing to select", () => {
    expect(selectionState(new Set(["a"]), [])).toBe("none");
  });

  it("toggles without mutating the set in state", () => {
    const before = new Set(["a"]);
    const after = toggleSelected(before, "b");
    expect([...before]).toEqual(["a"]);
    expect([...after].sort()).toEqual(["a", "b"]);
    expect([...toggleSelected(after, "a")]).toEqual(["b"]);
  });

  it("select-all touches only the visible page", () => {
    // Someone selected on page 2; selecting page 1 must not drop them, and
    // clearing page 1 must not clear them either.
    const held = new Set(["offscreen"]);
    const all = toggleAllVisible(held, visible);
    expect([...all].sort()).toEqual(["a", "b", "c", "offscreen"]);
    const cleared = toggleAllVisible(all, visible);
    expect([...cleared]).toEqual(["offscreen"]);
  });

  it("prunes selections that filtering has taken off the list", () => {
    // A bulk action must never operate on people the admin can no longer see.
    expect([...pruneSelection(new Set(["a", "gone"]), ["a", "b"])]).toEqual(["a"]);
  });
});
