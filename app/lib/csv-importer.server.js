import Papa from "papaparse";
import prisma from "../db.server";

// Expected CSV headers:
//   id, username, email, first_name, last_name, is_active, is_staff,
//   is_superuser, date_joined, last_login, customer_id, customer_name
export function parseCsv(text) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const rows = (parsed.data || [])
    .filter((r) => r.username && r.email)
    .map((r) => ({
      djangoId: String(r.id || "").trim(),
      username: String(r.username || "").trim().toLowerCase(),
      email: String(r.email || "").trim().toLowerCase(),
      storeDisplayName: String(r.first_name || "").trim(),
      lastName: String(r.last_name || "").trim(),
      isActive: String(r.is_active || "").trim() === "1",
      catalogId: String(r.customer_id || "").trim(),
      catalogGroup: String(r.customer_name || "").trim(),
      lastLoginRaw: String(r.last_login || "").trim(),
    }));

  const skippedBlankGroup = rows.filter((r) => !r.catalogId || !r.catalogGroup);
  const usable = rows.filter((r) => r.catalogId && r.catalogGroup);
  return { rows: usable, skippedBlankGroup, parseErrors: parsed.errors || [] };
}

// GraphQL wrapper — uses the offline admin token stored in Session.
async function shopifyGraphql(shop, query, variables) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) throw new Error(`No offline session found for shop ${shop}`);
  const resp = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await resp.json();
  if (data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

const CUSTOMER_QUERY = `
  query FindCustomer($q: String!) {
    customers(first: 5, query: $q) {
      edges {
        node {
          id
          email
          firstName
          lastName
          companyContactProfiles {
            id
            company {
              id
              name
              locations(first: 25) {
                edges { node { id name } }
              }
            }
          }
        }
      }
    }
  }
`;

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function pickLocation(customer, targetName) {
  const target = normalizeName(targetName);
  const matches = [];
  for (const contact of customer.companyContactProfiles || []) {
    for (const edge of contact.company?.locations?.edges || []) {
      const loc = edge.node;
      if (normalizeName(loc.name) === target) {
        matches.push({ contact, company: contact.company, location: loc });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { ambiguous: matches.length, first: matches[0] };
  // Fallback: try startsWith match
  const partial = [];
  for (const contact of customer.companyContactProfiles || []) {
    for (const edge of contact.company?.locations?.edges || []) {
      const loc = edge.node;
      if (normalizeName(loc.name).startsWith(target) || target.startsWith(normalizeName(loc.name))) {
        partial.push({ contact, company: contact.company, location: loc });
      }
    }
  }
  if (partial.length === 1) return { ...partial[0], partial: true };
  return null;
}

export async function resolveRow(shop, row) {
  const q = `email:"${row.email}"`;
  const data = await shopifyGraphql(shop, CUSTOMER_QUERY, { q });
  const edges = data?.customers?.edges || [];
  if (edges.length === 0) {
    return { row, status: "no_customer", reason: `No Shopify Customer with email ${row.email}` };
  }
  // If multiple customers match the email, try to disambiguate by looking at each
  for (const edge of edges) {
    const customer = edge.node;
    const picked = pickLocation(customer, row.storeDisplayName);
    if (picked && !picked.ambiguous) {
      return {
        row,
        status: picked.partial ? "matched_partial" : "matched",
        customerGid: customer.id,
        companyContactGid: picked.contact.id,
        companyGid: picked.company.id,
        companyLocationGid: picked.location.id,
        matchedLocationName: picked.location.name,
      };
    }
    if (picked && picked.ambiguous) {
      return {
        row,
        status: "ambiguous_location",
        reason: `${picked.ambiguous} CompanyLocations under customer match "${row.storeDisplayName}"`,
      };
    }
  }
  return {
    row,
    status: "no_location_match",
    reason: `Customer(s) found for ${row.email} but no CompanyLocation matches "${row.storeDisplayName}"`,
  };
}

export async function resolveAll(shop, rows, { onProgress } = {}) {
  const results = [];
  const CONCURRENCY = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      try {
        const r = await resolveRow(shop, rows[i]);
        results[i] = r;
      } catch (err) {
        results[i] = { row: rows[i], status: "error", reason: err.message };
      }
      if (onProgress) onProgress(results.filter(Boolean).length, rows.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

export async function persistResolved(shop, results) {
  const matched = results.filter((r) => r && (r.status === "matched" || r.status === "matched_partial"));
  const now = new Date();
  let inserted = 0, updated = 0;

  for (const r of matched) {
    const data = {
      shop,
      username: r.row.username,
      email: r.row.email,
      customerGid: r.customerGid,
      companyContactGid: r.companyContactGid,
      companyGid: r.companyGid,
      companyLocationGid: r.companyLocationGid,
      storeDisplayName: r.row.storeDisplayName || r.matchedLocationName || r.row.username,
      catalogGroup: r.row.catalogGroup,
      status: "invited",
      updatedAt: now,
    };
    const existing = await prisma.b2BUser.findUnique({
      where: { shop_username: { shop, username: r.row.username } },
    });
    if (existing) {
      await prisma.b2BUser.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.b2BUser.create({ data });
      inserted++;
    }
  }
  return { inserted, updated, matched: matched.length, total: results.length };
}
