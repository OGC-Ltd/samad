/**
 * The gate, as a mark rather than a word.
 *
 * A run's serial is the guard's document number, and what it is FOR is the only
 * thing a label could add — "SERIAL 4471" spends eight characters saying a
 * category the number's own shape already gives away. The shield says security
 * checked this, which is the part that is not obvious from four digits.
 *
 * Inherits `currentColor` and sizes off the text it sits in, so it carries
 * whatever contrast its host has already earned rather than introducing a
 * colour of its own.
 */
export default function ShieldIcon({ size = 11, title = "Gate serial" }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      role="img" aria-label={title}
    >
      <title>{title}</title>
      <path d="M12 2.5 4.5 5.8v5.5c0 4.6 3.1 8.9 7.5 10.2 4.4-1.3 7.5-5.6 7.5-10.2V5.8Z" />
    </svg>
  );
}
