/**
 * The Guide's icon: a guide holding up a flag, as on a guided tour. Drawn
 * here because Tabler has no such glyph. It sits in an <i> and fills with
 * currentColor at 1em, so the menus' own `.…-user-item i` rules size and
 * colour it like the Tabler icons beside it.
 */
export default function ManualIcon() {
  return (
    <i aria-hidden="true">
      {/* Outline at Tabler's own weight (2 on a 24 grid, round ends): the
          filled figure it replaced read heavier than every icon beside it. */}
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
        <circle cx="8" cy="10" r="3" />
        <path d="M3 21v-1a5 5 0 0 1 10 0v1" />
        <path d="M11.5 15.5l4-4.5" />
        <path d="M17 3v12" />
        <path d="M17 3.5l4 2-4 2" />
      </svg>
    </i>
  );
}
