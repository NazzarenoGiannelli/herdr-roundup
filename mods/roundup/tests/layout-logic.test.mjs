import { test } from "node:test";
import assert from "node:assert/strict";
import { isShown } from "../layout-logic.js";

const block = (id, mod) => ({ id, type: "block", content: { mod } });
// A right column with a stack of panels, as a layout could have it.
const layout = ({ columnHidden = false, active = "files" } = {}) => ({
  id: "root", type: "row", children: [
    block("main"),
    { id: "side", type: "column", hidden: columnHidden, children: [
      { id: "side-body", type: "stack", active, children: [block("files", "browser"), block("gh", "roundup")] },
    ] },
  ],
});

test("isShown: the panel is the active child of a stack in a column that is shown", () => {
  assert.equal(isShown(layout({ active: "gh" }), "roundup"), true);
});

test("isShown: not while another child of its stack is active", () => {
  assert.equal(isShown(layout({ active: "files" }), "roundup"), false);
});

test("isShown: not while a column above it is hidden", () => {
  assert.equal(isShown(layout({ active: "gh", columnHidden: true }), "roundup"), false);
});

test("isShown: the block's own ids and the other mods' do not matter, only the mod's folder name", () => {
  assert.equal(isShown(layout({ active: "files" }), "browser"), true);
  assert.equal(isShown({ id: "r", type: "row", children: [block("anything-at-all", "roundup")] }, "roundup"), true);
});

test("isShown: a block that is hidden itself, or a node that is a plain row or column, behaves as expected", () => {
  assert.equal(isShown({ id: "r", type: "row", children: [{ ...block("a", "roundup"), hidden: true }] }, "roundup"), false);
  assert.equal(isShown({ id: "r", type: "row", children: [{ id: "c", type: "column", children: [block("a", "roundup"), block("b", "other")] }] }, "roundup"), true);
});

test("isShown: hosted twice, it is shown when any copy is", () => {
  const root = { id: "r", type: "row", children: [
    { id: "c1", type: "column", hidden: true, children: [block("a", "roundup")] },
    { id: "c2", type: "column", children: [block("b", "roundup")] },
  ] };
  assert.equal(isShown(root, "roundup"), true);
});

test("isShown: when no block hosts it, there is no way to tell, so it counts as shown", () => {
  assert.equal(isShown(layout(), "roundup-dry"), true);
  assert.equal(isShown({ id: "r", type: "row", children: [] }, "roundup"), true);
  assert.equal(isShown(null, "roundup"), true);
  assert.equal(isShown(undefined, "roundup"), true);
  assert.equal(isShown("not a layout", "roundup"), true);
});

test("isShown: a stack with no `active` shows its first child", () => {
  const stack = { id: "body", type: "stack", children: [block("files", "browser"), block("gh", "roundup")] };
  const tree = (s) => ({ id: "root", type: "row", children: [block("main"), { id: "side", type: "column", children: [s] }] });
  assert.equal(isShown(tree(stack), "browser"), true);
  assert.equal(isShown(tree(stack), "roundup"), false);
  const first = { ...stack, children: [block("gh", "roundup"), block("files", "browser")] };
  assert.equal(isShown(tree(first), "roundup"), true);
  assert.equal(isShown(tree({ ...first, active: "files" }), "roundup"), false, "an explicit active still wins");
});
