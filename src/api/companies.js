

// Company list and cargo group lookups.

import COMPANIES from "../data/companyData";

export async function getCompanies() {

  return COMPANIES;
}

export async function getCompanyById(id) {

  return COMPANIES.find((c) => c.id === id);
}
