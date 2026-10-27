// Avatars across the app: two letters and a colour of their own per name,
// so the same person reads the same in the header and on a driver card.

const HUES = ['#1d4ed8', '#0f766e', '#7c3aed', '#b45309', '#be185d', '#0369a1', '#4d7c0f', '#9f1239'];

/**
 * Two letters for a name — first and last word, or its first two letters.
 * Without a name, from the email's local part ("jane.doe@…" → "JD").
 */
export function initialsOf(name = '', email = '') {
  let src = String(name ?? '').trim();
  if (!src && email) src = String(email).split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!src) return '?';
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/** The same colour for the same name, every time. */
export function avatarHue(name = '') {
  let h = 0;
  for (const c of String(name ?? '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
