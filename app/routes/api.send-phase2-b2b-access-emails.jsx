// app/routes/api.send-phase2-b2b-access-emails.jsx
//
// One-time go-live trigger for the 10 Aug 2026 09:00 Pacific/Auckland Phase 2
// go-live (TEEG/Timezone umbrella, Archie Brothers, Hampshire Vending, Holey
// Moley). Same mechanism as api.send-b2b-access-emails.jsx (the Phase 1
// General Catalog go-live trigger) — see that file for why we tag rather than
// call companyContactSendWelcomeEmail directly. This endpoint's job is just
// to add the "invite-ready" tag via tagsAdd; the existing "Send B2B Access
// Email Flows" Shopify Flow does the actual send.
//
// Difference from the Phase 1 endpoint: fetches contacts across all Phase 2
// catalogs, not just one. Deliberately EXCLUDES General Catalog (Phase 1,
// already live), Metromart (not part of any Dutch Rusk launch phase), and
// Night N Day (Phase 3, not yet launching).
//
// Designed to be polled repeatedly (e.g. every minute by a scheduled GitHub
// Action) rather than fired once — it is a no-op before the target time and
// idempotent afterward, so timing jitter in the caller can never cause an
// early or duplicate send.
//
// Target: 2026-08-10 09:00 Pacific/Auckland (NZST, UTC+12, no DST in August)
// = 2026-08-09T21:00:00Z.
//
// Safe to delete this file (and the matching workflow) after 10 Aug 2026.

import { unauthenticated } from "../shopify.server";

const TARGET_TIME_UTC = "2026-08-09T21:00:00.000Z";
const PHASE2_CATALOGS = [
  { id: "gid://shopify/CompanyLocationCatalog/147677675833", title: "TEEG" },
  { id: "gid://shopify/CompanyLocationCatalog/147677708601", title: "Timezone F&B" },
  { id: "gid://shopify/CompanyLocationCatalog/147677217081", title: "Kingpin Queenstown" },
  { id: "gid://shopify/CompanyLocationCatalog/147677741369", title: "Xtreme Wairau" },
  { id: "gid://shopify/CompanyLocationCatalog/147677774137", title: "Zone Bowling Henderson" },
  { id: "gid://shopify/CompanyLocationCatalog/147677806905", title: "Zone Bowling Manukau" },
  { id: "gid://shopify/CompanyLocationCatalog/147677118777", title: "Archie Brothers" },
  { id: "gid://shopify/CompanyLocationCatalog/147677151545", title: "Hampshire Vending" },
  { id: "gid://shopify/CompanyLocationCatalog/147677184313", title: "Holey Moley" },
];
const INVITE_TAG = "invite-ready";
const TAG_DELAY_MS = 300; // throttle between mutation calls
const SHOP = "dutchrusk.myshopify.com";

async function fetchCatalogContacts(admin, catalogId) {
  const contacts = [];
  let after = null;
  do {
    const response = await admin.graphql(`
      query($after: String) {
        catalog(id: "${catalogId}") {
          ... on CompanyLocationCatalog {
            companyLocations(first: 50, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  company {
                    id
                    name
                    contacts(first: 10) {
                      edges {
                        node {
                          id
                          customer { id defaultEmailAddress { emailAddress } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`, { variables: { after } });
    const data = await response.json();
    const conn = data.data.catalog.companyLocations;
    for (const { node: loc } of conn.edges) {
      for (const { node: contact } of loc.company.contacts.edges) {
        contacts.push({
          companyContactId: contact.id,
          customerId: contact.customer?.id ?? null,
          email: contact.customer?.defaultEmailAddress?.emailAddress ?? null,
          companyName: loc.company.name,
        });
      }
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return contacts;
}

async function fetchPhase2Contacts(admin) {
  const all = [];
  for (const catalog of PHASE2_CATALOGS) {
    const contacts = await fetchCatalogContacts(admin, catalog.id);
    all.push(...contacts);
  }
  const seen = new Map();
  for (const c of all) if (!seen.has(c.companyContactId)) seen.set(c.companyContactId, c);
  return [...seen.values()];
}

export async function action({ request }) {
  const cronSecret = process.env.B2B_EMAIL_CRON_SECRET ?? "";
  const incomingSecret = request.headers.get("x-cron-secret") ?? "";
  if (!cronSecret || incomingSecret !== cronSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const dryRun = body.dryRun === true;
  const testContactId = body.contactId ?? null;

  const { default: prisma } = await import("../db.server");

  const now = new Date();
  const target = new Date(TARGET_TIME_UTC);

  if (!dryRun && !testContactId && now < target) {
    return Response.json({ status: "too-early", now: now.toISOString(), target: target.toISOString() });
  }

  let admin;
  try {
    const result = await unauthenticated.admin(SHOP);
    admin = result.admin;
  } catch (err) {
    console.error("[send-phase2-b2b-access-emails] failed to get admin client:", err);
    return Response.json({ error: "Failed to get admin client: " + err.message }, { status: 500 });
  }

  let contacts;
  try {
    contacts = await fetchPhase2Contacts(admin);
  } catch (err) {
    console.error("[send-phase2-b2b-access-emails] fetch failed:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }

  if (testContactId) {
    contacts = contacts.filter(c => c.companyContactId === testContactId);
    if (!contacts.length) {
      return Response.json({ error: "contactId not found in Phase 2 catalogs" }, { status: 404 });
    }
  }

  const alreadyTagged = await prisma.b2BAccessEmailLog.findMany({
    where: { shop: SHOP, companyContactId: { in: contacts.map(c => c.companyContactId) }, status: "sent" },
    select: { companyContactId: true },
  });
  const taggedSet = new Set(alreadyTagged.map(r => r.companyContactId));
  const pending = contacts.filter(c => c.companyContactId && !taggedSet.has(c.companyContactId));

  if (dryRun) {
    return Response.json({
      status: "dry-run",
      now: now.toISOString(),
      target: target.toISOString(),
      totalContacts: contacts.length,
      alreadyTagged: taggedSet.size,
      pending: pending.length,
    });
  }

  let tagged = 0, failed = 0;
  for (const c of pending) {
    const logWhere = { companyContactId: c.companyContactId };
    if (!c.customerId || !c.email) {
      await prisma.b2BAccessEmailLog.upsert({
        where: logWhere,
        update: { status: "failed", error: "missing customer/email" },
        create: { shop: SHOP, companyContactId: c.companyContactId, customerId: c.customerId ?? "", email: c.email ?? "", companyName: c.companyName, status: "failed", error: "missing customer/email" },
      });
      failed++;
      continue;
    }
    try {
      const response = await admin.graphql(`
        mutation($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`, { variables: { id: c.customerId, tags: [INVITE_TAG] } });
      const data = await response.json();
      const errs = data.data.tagsAdd.userErrors;
      if (errs.length) throw new Error(JSON.stringify(errs));
      await prisma.b2BAccessEmailLog.upsert({
        where: logWhere,
        update: { status: "sent", error: null },
        create: { shop: SHOP, companyContactId: c.companyContactId, customerId: c.customerId, email: c.email, companyName: c.companyName, status: "sent" },
      });
      tagged++;
    } catch (err) {
      await prisma.b2BAccessEmailLog.upsert({
        where: logWhere,
        update: { status: "failed", error: String(err.message || err) },
        create: { shop: SHOP, companyContactId: c.companyContactId, customerId: c.customerId ?? "", email: c.email ?? "", companyName: c.companyName, status: "failed", error: String(err.message || err) },
      });
      failed++;
      console.error(`[send-phase2-b2b-access-emails] tag failed for ${c.companyName} <${c.email}>:`, err);
    }
    await new Promise(r => setTimeout(r, TAG_DELAY_MS));
  }

  return Response.json({
    status: "tagged",
    now: now.toISOString(),
    target: target.toISOString(),
    totalContacts: contacts.length,
    alreadyTaggedBefore: taggedSet.size,
    taggedThisRun: tagged,
    failedThisRun: failed,
  });
}
