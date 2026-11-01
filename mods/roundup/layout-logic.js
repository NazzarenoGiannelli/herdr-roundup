// Is the panel on screen? Pure: reads the layout tree that herdr's layout() returns. Loaded by Node
// tests and by the Herdr runtime, so no imports.
//
// The panel finds the block that hosts it (`content.mod` is the mod's folder name) and walks down
// to it: a node with `hidden` hides everything under it, and a stack only shows its `active` child
// (a stack with no `active` shows its first child; Herdr's docs name no other default).
// When no block hosts it (it was opened another way, or the tree is not what is expected) there is
// no way to tell, so it counts as shown: fetching a little too often beats never fetching.

function hostPaths(node, mod, trail = []) {
  if (!node || typeof node !== "object") return [];
  const here = [...trail, node];
  if (node.content?.mod === mod) return [here];
  return (node.children ?? []).flatMap((child) => hostPaths(child, mod, here));
}

const showing = (path) => path.every((node, i) => {
  if (node.hidden) return false;
  const child = path[i + 1];
  if (node.type !== "stack" || !child) return true;
  return (node.active ?? node.children?.[0]?.id) === child.id;
});

export function isShown(layoutRoot, mod) {
  const paths = hostPaths(layoutRoot, mod);
  return paths.length === 0 || paths.some(showing);
}
