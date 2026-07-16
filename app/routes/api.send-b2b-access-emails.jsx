// app/routes/api.send-b2b-access-emails.jsx
//
// One-time go-live trigger for the 20 Jul 2026 09:00 Pacific/Auckland go-live.
// Sends every CompanyContact on the General Catalog Shopify's native "Send B2B
// access email" — but NOT via the companyContactSendWelcomeEmail mutation
// directly. Shopify blocks that mutation for third-party/custom app API
// clients even with correct write_customers/write_companies scopes (confirmed
// via direct testing — the same mutation works fine from the Shopify Admin
// UI, which uses a staff session rather than an app API token).
//
// Workaround: a Shopify Flow ("Send B2B Access Email Flows") triggers on the
// native "Customer tags added" event, checks for the "invite-ready" tag, and
// if present calls Flow's own built-in "Send B2B access email to company
// contact" action (which runs under Shopify's internal permissions, not our
// app's token) before removing the tag. This endpoint's job is just to add
// the "invite-ready" tag via tagsAdd (a mutation our app CAN call) — Flow
// handles the actual send.
//
// Designed to be polled repeatedly (e.g. every minute by a scheduled GitHub
// Action) rather than fired once — it is a no-op before the target time and
// idempotent afterward, so timing jitter in the caller can never cause an
// early or duplicate tag application.
//
// Target: 2026-07-20 09:00 Pacific/Auckland (NZST, UTC+12, no DST in July)
// = 2026-07-19T21:00:00Z.

import { unauthenticated } from "../shopify.server";

const TARGET_TIME_UTC = "2026-07-19T21:00:00.000Z";
const GENERAL_CATALOG_ID = "gid://shopify/CompanyLocationCatalog/147676922169";
const INVITE_TAG = "invite-ready";
const TAG_DELAY_MS = 300; // throttle between mutation calls
const SHOP = "dutchrusk.myshopify.com";

async function fetchGeneralCatalogContacts(admin) {
  const contacts = [];
  let after = null;
  do {
    const response = await admin.graphql(`
      query($after: String) {
        catalog(id: "${GENERAL_CATALOG_ID}") {
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
  const seen = new Map();
  for (const c of contacts) if (!seen.has(c.companyContactId)) seen.set(c.companyContactId, c);
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
    console.error("[send-b2b-access-emails] failed to get admin client:", err);
    return Response.json({ error: "Failed to get admin client: " + err.message }, { status: 500 });
  }

  let contacts;
  try {
    contacts = await fetchGeneralCatalogContacts(admin);
  } catch (err) {
    console.error("[send-b2b-access-emails] fetch failed:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }

  if (testContactId) {
    contacts = contacts.filter(c => c.companyContactId === testContactId);
    if (!contacts.length) {
      return Response.json({ error: "contactId not found in General Catalog" }, { status: 404 });
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
      console.error(`[send-b2b-access-emails] tag failed for ${c.companyName} <${c.email}>:`, err);
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
