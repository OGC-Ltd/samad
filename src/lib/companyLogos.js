// Company logos, keyed by company id (the same ids as data/companyData and
// api/org ORG_CODE_BY_COMPANY).
//
//   companyMark(c) — the logo's symbol only, square. Readable at 24–32px, so
//                    it's what the header and switchers use.
//   companyLogo(c) — the full logo with wordmark, for larger spots
//                    (profile sheets, reports, login screen).
//
// A company with no entry returns null and callers fall back to its letter.
// Samad Resources: public/samad-logo*.svg, vectors redrawn from the supplied logo.

const LOGOS = { samad: '/samad-logo-full.svg' };
const MARKS = { samad: '/samad-logo.svg' };

const keyOf = (c) => (c ? (c.id in LOGOS ? c.id : String(c.code ?? '').toLowerCase()) : null);

export function companyLogo(company) { return LOGOS[keyOf(company)] ?? null; }
export function companyMark(company) { return MARKS[keyOf(company)] ?? null; }
