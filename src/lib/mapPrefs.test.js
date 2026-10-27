/**
 * Per-organisation map state.
 *
 * What these pin is that an organisation's state is ITS OWN — the bug being
 * fixed is one fleet's narrowing following you to another fleet, which renders
 * perfectly and is wrong — and that a company nobody has visited opens on a
 * default chosen for it rather than on whatever the last one was left in.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  readMapPrefs, writeMapPrefs, defaultPrefs, LAYER_DEFAULTS, DEFAULT_FILTER,
} from "./mapPrefs";

// These tests run under `environment: node` (see vite.config), which is the
// repo's standing choice — the logic under test is decisions, not DOM. It does
// reach localStorage through services/cache, so stub the one API it uses rather
// than pull in jsdom for it.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

beforeEach(() => localStorage.clear());

describe("defaults", () => {
  it("opens Mufindi on its planting plan", () => {
    // The Estate areas layer was removed 2026-10-20; the plan is what is left.
    expect(defaultPrefs("kasulu").layers.plan).toBe(true);
    expect(LAYER_DEFAULTS.kasulu.plan).toBe(true);
    expect(LAYER_DEFAULTS.kasulu.zones).toBeUndefined();
  });

  it("leaves the estate areas off for every other company", () => {
    // `zones` is drawn from provider geofences every org has rows in, and it
    // is gated in FleetMap by ZONE_AREAS_COMPANY. A default here would be the
    // wrong kind of insurance: two places to say "not this org".
    for (const id of ["westsugar", "sukari", "menengai"]) {
      expect(defaultPrefs(id).layers.zones, id).toBe(false);
    }
  });

  it("opens Kabras and Nzoia each on its own survey", () => {
    expect(defaultPrefs("kabras").layers.site).toBe(true);
    expect(defaultPrefs("nzoia").layers.site).toBe(true);
  });

  it("leaves the weighbridges off everywhere", () => {
    // Six pins inside a national fleet: a genuine "take me there" rather than
    // something to arrive already looking at.
    for (const id of ["kasulu", "westsugar", "sukari", "menengai"]) {
      expect(defaultPrefs(id).layers.bridges, id).toBe(false);
    }
  });

  it("gives a company this build has never heard of a working map", () => {
    const p = defaultPrefs("somewhere-new");
    expect(p.filter).toBe(DEFAULT_FILTER);
    // Every org layer off; live traffic is roads, not org data, and opens on.
    const { traffic, ...orgLayers } = p.layers;
    expect(traffic).toBe(true);
    expect(Object.values(orgLayers).every(v => v === false)).toBe(true);
  });
});

describe("per organisation", () => {
  it("does not carry one fleet's filter to another", () => {
    // The bug: "moving only", chosen on a fleet of 800, silently applied to a
    // fleet of 20 — a map that looks empty for a reason nobody can see.
    writeMapPrefs("sukari", { filter: "moving" });
    expect(readMapPrefs("sukari").filter).toBe("moving");
    expect(readMapPrefs("kasulu").filter).toBe("all");
  });

  it("keeps each company's layers apart", () => {
    writeMapPrefs("kasulu", { layers: { plan: false } });
    expect(readMapPrefs("kasulu").layers.plan).toBe(false);
    // Closing Mufindi's drawing says nothing about Kabras's survey.
    expect(readMapPrefs("kabras").layers.site).toBe(true);
  });

  it("remembers a layer switched OFF against its own default", () => {
    // The harder half: a default-on layer must stay closed once closed, which
    // a "store only what is on" scheme gets wrong.
    writeMapPrefs("kabras", { layers: { site: false } });
    expect(readMapPrefs("kabras").layers.site).toBe(false);
  });
});

describe("writing", () => {
  it("patches one control without needing to know the others", () => {
    // The chips and the layer switches are different controls in different
    // corners of the screen; neither should have to carry the other's state.
    writeMapPrefs("sukari", { layers: { bridges: true } });
    writeMapPrefs("sukari", { filter: "parked" });
    const p = readMapPrefs("sukari");
    expect(p.layers.bridges).toBe(true);
    expect(p.filter).toBe("parked");
  });

  it("lets two layers be on at once", () => {
    // Nothing here may treat the layers as alternatives: switching one on must
    // never be what switches another off.
    writeMapPrefs("sukari", { layers: { bridges: true, site: true } });
    const { layers } = readMapPrefs("sukari");
    expect(layers.bridges).toBe(true);
    expect(layers.site).toBe(true);
  });

  it("returns what it stored, so a caller need not re-read", () => {
    expect(writeMapPrefs("sukari", { filter: "moving" }).filter).toBe("moving");
  });
});

describe("bad storage", () => {
  it("falls back to the default rather than propagating junk", () => {
    localStorage.setItem("ft-map-prefs:sukari::v2", "{not json");
    expect(readMapPrefs("sukari")).toEqual(defaultPrefs("sukari"));
  });

  it("ignores a stored value of the wrong type", () => {
    // A layer that is a string is not a layer that is on.
    writeMapPrefs("sukari", {});
    localStorage.setItem("ft-map-prefs:sukari::v2",
      JSON.stringify({ filter: 7, layers: { bridges: "yes", plan: true } }));
    const p = readMapPrefs("sukari");
    expect(p.filter).toBe("all");
    expect(p.layers.bridges).toBe(false);
    expect(p.layers.plan).toBe(true);
  });

  it("drops a layer this build no longer has", () => {
    // `heatmap` stands in for any retired key. It used to be `zones` — which
    // came back on 2026-09-14 as Mufindi's estate-boundary layer, so a stored
    // `zones` is now read rather than discarded. That is the point of the
    // merge: adding a layer needs no migration, and removing one needs no
    // cleanup.
    localStorage.setItem("ft-map-prefs:sukari::v2",
      JSON.stringify({ layers: { heatmap: true, bridges: true } }));
    const p = readMapPrefs("sukari");
    expect(p.layers.heatmap).toBeUndefined();
    expect(p.layers.bridges).toBe(true);
  });

  it("survives having no company at all", () => {
    expect(readMapPrefs(null)).toEqual(defaultPrefs(null));
    expect(() => writeMapPrefs(null, { filter: "moving" })).not.toThrow();
  });
});

describe("the works-site surveys", () => {
  it("opens Sukari on its own plant survey", () => {
    expect(defaultPrefs("sukari").layers.site).toBe(true);
  });

  it("does not hand Sukari's survey to an org that has none", () => {
    expect(defaultPrefs("menengai").layers.site).toBe(false);
  });

  it("keeps the two surveys' preferences apart", () => {
    writeMapPrefs("sukari", { layers: { site: false } });
    expect(readMapPrefs("sukari").layers.site).toBe(false);
    expect(readMapPrefs("kabras").layers.site).toBe(true);
  });
});

describe("an organisation with more than one survey", () => {
  it("opens West Kenya on neither of its surveys", () => {
    const { layers } = defaultPrefs("westsugar");
    expect(layers["site:naitiri"]).toBe(false);
    expect(layers["site:raiply"]).toBe(false);
  });

  it("offers Menengai both of its surveys, and opens on neither", () => {
    const { layers } = defaultPrefs("menengai");
    expect(layers["site:bigfarm"]).toBe(false);
    expect(layers["site:molo"]).toBe(false);
  });

  it("remembers the two West Kenya surveys separately", () => {
    writeMapPrefs("westsugar", { layers: { "site:naitiri": true } });
    const { layers } = readMapPrefs("westsugar");
    expect(layers["site:naitiri"]).toBe(true);
    expect(layers["site:raiply"]).toBe(false);   // untouched by the patch
  });

  it("still reads a blob stored when Kabras and Nzoia were West Kenya's", () => {
    writeMapPrefs("westsugar", { layers: { site: false, "site:nzoia": true } });
    const { layers } = readMapPrefs("westsugar");
    expect(layers.site).toBe(false);
    expect(layers["site:nzoia"]).toBe(true);
  });
});
