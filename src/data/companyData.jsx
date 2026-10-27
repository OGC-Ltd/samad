// The organisation and its branding.
//
// Samad carries one organisation. The backend still keys it by `code`
// (api/org.js ORG_CODE_BY_COMPANY), so the account must hold an organisation
// with code SAMAD for anything to show.

const COMPANIES = [
  {
    id:           "samad",
    name:         "Samad Resources",
    suffix:       "· KE",
    short:        "Samad",
    avatarLetter: "S",
    avatarColor:  "#b91c1c",   // the logo's red
    accentColor:  "#b91c1c",
    vehicleCount: 0,
    tagline:      "Fleet & logistics operations",
  },
];

export default COMPANIES;
