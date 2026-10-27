/**
 * Limited access (no map:read): every count in the sidebar trees reads "–",
 * never the figure, and the alert dot beside Movement is not drawn.
 */

import { describe, it, expect } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TreeNode, TreeLink, TreeSwitch, TreeCountsMasked } from "./SideTree";

const tree = (masked) => renderToStaticMarkup(
  h(TreeCountsMasked.Provider, { value: masked },
    h(TreeNode, { label: "Movement", count: 76, alert: true, alertTitle: "7 stopped", defaultOpen: true },
      h(TreeLink, { label: "Stopped in transit", count: 0, countTone: "warn" }),
      h(TreeLink, { label: "Units", count: 218 }),
      h(TreeSwitch, { label: "Kind", count: 12, on: false, onToggle: () => {} }),
    ),
  ),
);

describe("SideTree counts under limited access", () => {
  it("shows the figures normally", () => {
    const html = tree(false);
    expect(html).toContain(">76<");
    expect(html).toContain(">218<");
    expect(html).toContain("side-tree__alertdot");
  });

  it("puts a dash in place of every count and drops the alert dot", () => {
    const html = tree(true);
    for (const n of ["76", "218", "12"]) expect(html).not.toContain(`>${n}<`);
    expect(html.match(/>–</g)).toHaveLength(4);
    expect(html).not.toContain("side-tree__alertdot");
    expect(html).not.toContain("--warn");
  });
});
