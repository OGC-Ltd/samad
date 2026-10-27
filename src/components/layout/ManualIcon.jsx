/**
 * The Guide's icon: a guide holding up a flag, as on a guided tour. Drawn
 * here because Tabler has no such glyph. It sits in an <i> and fills with
 * currentColor at 1em, so the menus' own `.…-user-item i` rules size and
 * colour it like the Tabler icons beside it.
 */
export default function ManualIcon() {
  return (
    <i aria-hidden="true">
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" style={{ display: "block" }}>
        <circle cx="8.5" cy="10" r="3.6" />
        <path d="M1.5 23v-2.4c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5V23z" />
        <path d="M12.6 16.6l3.6-5.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        <path d="M16.9 2v14.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
        <path d="M17.4 2.4l5.2 2.7-5.2 2.7z" />
      </svg>
    </i>
  );
}
