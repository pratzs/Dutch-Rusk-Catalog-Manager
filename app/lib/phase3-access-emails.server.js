// app/lib/phase3-access-emails.server.js
//
// Phase 3 (Night n Day) B2B access email catch-up.
//
// Phase 3 went live 7 Sept 2026 but the access email campaign never ran. On
// 10 Sept 2026 Shopify's own customer timeline showed a send event for only
// 12 of 75 Night n Day contacts, and 10 of those were Worthy/Dutch Rusk staff
// on the internal Worthy Oceania Ltd company from the July pilot. See BUG-068
// in the launch tracker.
//
// Same send mechanism as Phase 1 and Phase 2 (see
// api.send-b2b-access-emails.jsx for the full explanation): Shopify blocks
// companyContactSendWelcomeEmail for third-party app tokens, so we add the
// "invite-ready" tag and the existing "Send B2B Access Email Flows" Shopify
// Flow does the actual send and then clears the tag.
//
// Two differences from the Phase 1/2 endpoints, both learned from BUG-068:
//
//  1. No go-live time gate. This is a catch-up for a launch that has already
//     happened, so it runs on demand behind an explicit confirm flag rather
//     than unlocking at a target timestamp.
//
//  2. It checks Shopify's customer timeline for an existing "B2B access email"
//     event before sending, not just our own B2BAccessEmailLog. Two Night n
//     Day contacts were sent one by hand through Shopify Admin on 6 and 7 Sept
//     and our log knows nothing about those. The timeline is the authoritative
//     record of what Shopify actually sent, so it is what we skip on.

const NIGHT_N_DAY_CATALOG_ID = "gid://shopify/CompanyLocationCatalog/147677315385";
export const INVITE_TAG = "invite-ready";
export const SHOP = "dutchrusk.myshopify.com";
const TAG_DELAY_MS = 300;
const EVENT_BATCH = 10;

// Internal Worthy / Dutch Rusk records that sit on the Night N Day catalog for
// testing. These are staff, not customers, and must never be emailed.
const EXCLUDED_COMPANIES = new Set([
  "worthy oceania ltd",
  "night n day testing",
]);

async function run(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 500));
  return body.data;
}

// Every CompanyContact whose company has a location on the Night N Day catalog.
async function fetchCatalogContacts(admin) {
  const contacts = [];
  let after = null;
  do {
    const data = await run(admin, `
      query($after: String) {
        catalog(id: "${NIGHT_N_DAY_CATALOG_ID}") {
          ... on CompanyLocationCatalog {
            companyLocations(first: 50, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  company {
                    id
                    name
                    contacts(first: 20) {
                      edges {
                        node {
                          id
                          customer {
                            id
                            displayName
                            defaultEmailAddress { emailAddress }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`, { after });

    const conn = data.catalog.companyLocations;
    for (const { node: loc } of conn.edges) {
      for (const { node: contact } of loc.company.contacts.edges) {
        contacts.push({
          companyContactId: contact.id,
          customerId: contact.customer?.id ?? null,
          email: contact.customer?.defaultEmailAddress?.emailAddress ?? null,
          customerName: contact.customer?.displayName ?? null,
          companyName: loc.company.name,
        });
      }
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);

  // A company can hold several locations on the catalog; de-duplicate contacts.
  const seen = new Map();
  for (const c of contacts) {
    if (c.companyContactId && !seen.has(c.companyContactId)) seen.set(c.companyContactId, c);
  }
  return [...seen.values()];
}

// Shopify writes "... sent B2B access email notification to this customer" onto
// the customer timeline for every send, whether it came from Flow or from a
// human in Admin. That is the only reliable record — the invite-ready tag is
// cleared by the Flow after sending, and customer.state is meaningless on a
// store using new customer accounts (BUG-064).
async function fetchExistingSends(admin, contacts) {
  const withCustomer = contacts.filter((c) => c.customerId);
  const sends = new Map();

  for (let i = 0; i < withCustomer.length; i += EVENT_BATCH) {
    const slice = withCustomer.slice(i, i + EVENT_BATCH);
    const aliases = slice
      .map((c, n) => `e${n}: customer(id: "${c.customerId}") {
        events(first: 30, sortKey: CREATED_AT, reverse: true) {
          nodes { createdAt ... on BasicEvent { message } }
        }
      }`)
      .join("\n");
    const data = await run(admin, `query { ${aliases} }`);
    slice.forEach((c, n) => {
      const node = data[`e${n}`];
      const events = node?.events?.nodes ?? [];
      const hit = events.find((e) => /B2B access email/i.test(String(e.message || "")));
      if (hit) sends.set(c.companyContactId, hit.createdAt);
    });
  }
  return sends;
}

/**
 * Work out exactly who should receive a Phase 3 access email.
 * Pure read — never mutates anything.
 */
export async function selectPhase3Recipients(admin, prisma) {
  const all = await fetchCatalogContacts(admin);

  const excludedStaff = [];
  const missingEmail = [];
  const candidates = [];
  for (const c of all) {
    if (EXCLUDED_COMPANIES.has(c.companyName.trim().toLowerCase())) { excludedStaff.push(c); continue; }
    if (!c.customerId || !c.email) { missingEmail.push(c); continue; }
    candidates.push(c);
  }

  const existingSends = await fetchExistingSends(admin, candidates);

  const loggedRows = await prisma.b2BAccessEmailLog.findMany({
    where: { shop: SHOP, companyContactId: { in: candidates.map((c) => c.companyContactId) }, status: "sent" },
    select: { companyContactId: true },
  });
  const logged = new Set(loggedRows.map((r) => r.companyContactId));

  const alreadySent = [];
  const recipients = [];
  for (const c of candidates) {
    const sentAt = existingSends.get(c.companyContactId);
    if (sentAt || logged.has(c.companyContactId)) {
      alreadySent.push({ ...c, sentAt: sentAt ?? "in B2BAccessEmailLog only" });
    } else {
      recipients.push(c);
    }
  }

  recipients.sort((a, b) => a.companyName.localeCompare(b.companyName));
  return {
    totalOnCatalog: all.length,
    excludedStaff,
    missingEmail,
    alreadySent,
    recipients,
  };
}

/**
 * Tag the selected recipients so the "Send B2B Access Email Flows" Flow picks
 * them up. Records each attempt in B2BAccessEmailLog.
 */
export async function tagPhase3Recipients(admin, prisma, recipients) {
  let tagged = 0;
  let failed = 0;
  const failures = [];

  for (const c of recipients) {
    const where = { companyContactId: c.companyContactId };
    try {
      const data = await run(admin, `
        mutation($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`, { id: c.customerId, tags: [INVITE_TAG] });

      const errs = data.tagsAdd.userErrors;
      if (errs.length) throw new Error(JSON.stringify(errs));

      await prisma.b2BAccessEmailLog.upsert({
        where,
        update: { status: "sent", error: null },
        create: {
          shop: SHOP, companyContactId: c.companyContactId, customerId: c.customerId,
          email: c.email, companyName: c.companyName, status: "sent",
        },
      });
      tagged++;
    } catch (err) {
      const message = String(err.message || err);
      await prisma.b2BAccessEmailLog.upsert({
        where,
        update: { status: "failed", error: message },
        create: {
          shop: SHOP, companyContactId: c.companyContactId, customerId: c.customerId ?? "",
          email: c.email ?? "", companyName: c.companyName, status: "failed", error: message,
        },
      });
      failed++;
      failures.push({ company: c.companyName, email: c.email, error: message });
      console.error(`[phase3-access-emails] tag failed for ${c.companyName} <${c.email}>:`, err);
    }
    await new Promise((r) => setTimeout(r, TAG_DELAY_MS));
  }

  return { tagged, failed, failures };
}
