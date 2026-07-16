// app/routes/api.send-b2b-access-emails.jsx
//
// One-time go-live trigger for Shopify's native "Send B2B access email"
// (companyContactSendWelcomeEmail), sent to every CompanyContact on the
// General Catalog. Designed to be polled repeatedly (e.g. every minute by a
// scheduled GitHub Action) rather than fired once — it is a no-op before the
// target time and idempotent afterward, so timing jitter in the caller can
// never cause an early or duplicate send.
//
// Target: 2026-07-20 09:00 Pacific/Auckland (NZST, UTC+12, no DST in July)
// = 2026-07-19T21:00:00Z.

const TARGET_TIME_UTC = "2026-07-19T21:00:00.000Z";
const GENERAL_CATALOG_ID = "gid://shopify/CompanyLocationCatalog/147676922169";
const SEND_DELAY_MS = 300; // throttle between mutation calls

async function gql(shop, token, query, variables = {}) {
  const res = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchGeneralCatalogContacts(shop, token) {
  const contacts = [];
  let after = null;
  do {
    const data = await gql(shop, token, `
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
      }`, { after });
    const conn = data.catalog.companyLocations;
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
  // Dedupe by companyContactId (a company can have >1 location under General Catalog)
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
  const session = await prisma.session.findFirst({ where: { isOnline: false, accessToken: { not: "" } }, orderBy: { id: "desc" } });
  if (!session) return Response.json({ error: "No session" }, { status: 500 });
  const { shop, accessToken } = session;

  const now = new Date();
  const target = new Date(TARGET_TIME_UTC);

  if (!dryRun && !testContactId && now < target) {
    return Response.json({ status: "too-early", now: now.toISOString(), target: target.toISOString() });
  }

  let contacts;
  try {
    contacts = await fetchGeneralCatalogContacts(shop, accessToken);
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

  const alreadySent = await prisma.b2BAccessEmailLog.findMany({
    where: { shop, companyContactId: { in: contacts.map(c => c.companyContactId) }, status: "sent" },
    select: { companyContactId: true },
  });
  const sentSet = new Set(alreadySent.map(r => r.companyContactId));
  const pending = contacts.filter(c => c.companyContactId && !sentSet.has(c.companyContactId));

  if (dryRun) {
    return Response.json({
      status: "dry-run",
      now: now.toISOString(),
      target: target.toISOString(),
      totalContacts: contacts.length,
      alreadySent: sentSet.size,
      pending: pending.length,
    });
  }

  let sent = 0, failed = 0;
  for (const c of pending) {
    const logWhere = { companyContactId: c.companyContactId };
    if (!c.customerId || !c.email) {
      await prisma.b2BAccessEmailLog.upsert({
        where: logWhere,
        update: { status: "failed", error: "missing customer/email" },
        create: { shop, companyContactId: c.companyContactId, customerId: c.customerId ?? "", email: c.email ?? "", companyName: c.companyName, status: "failed", error: "missing customer/email" },
      });
      failed++;
      continue;
    }
    try {
      const r = await gql(shop, accessToken, `
        mutation($id: ID!) {
          companyContactSendWelcomeEmail(companyContactId: $id) {
            companyContact { id }
            userErrors { field message }
          }
        }`, { id: c.companyContactId });
      const errs = r.companyContactSendWelcomeEmail.userErrors;
      if (errs.length) throw new Error(JSON.stringify(errs));
      await prisma.b2BAccessEmailLog.upsert({
        where: logWhere,
        update: { status: "sent", error: null },
        create: { shop, companyContactId: c.companyContactId, customerId: c.customerId, email: c.email, companyName: c.companyName, status: "sent" },
      });
      sent++;
    } catch (err) {
      await prisma.b2BAccessEmailLog.upsert({
        where: logWhere,
        update: { status: "failed", error: String(err.message || err) },
        create: { shop, companyContactId: c.companyContactId, customerId: c.customerId ?? "", email: c.email ?? "", companyName: c.companyName, status: "failed", error: String(err.message || err) },
      });
      failed++;
      console.error(`[send-b2b-access-emails] failed for ${c.companyName} <${c.email}>:`, err);
    }
    await new Promise(r => setTimeout(r, SEND_DELAY_MS));
  }

  return Response.json({
    status: "sent",
    now: now.toISOString(),
    target: target.toISOString(),
    totalContacts: contacts.length,
    alreadySentBefore: sentSet.size,
    sentThisRun: sent,
    failedThisRun: failed,
  });
}
