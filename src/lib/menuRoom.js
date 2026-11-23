// A page asks the left menu (layout/SidePanel) to fold out of the way while
// it shows a side panel beside its table, and lets it back when the panel
// closes (operator, 2026-11-23, the Compliance page: "the left panel should
// collapse too so we have enough screen"). The menu folds only if it was
// open, and opens again only if it was this that folded it.

export const MENU_ROOM_EVENT = 'samad:menu-room';

/** need: true while the page's side panel is open, false once it closes. */
export function askMenuRoom(need) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MENU_ROOM_EVENT, { detail: { need: Boolean(need) } }));
}
