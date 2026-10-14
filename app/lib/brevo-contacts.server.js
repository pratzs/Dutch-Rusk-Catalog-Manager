// Brevo contact health + Shopify -> Brevo sync, used by the /app/brevo dashboard.
// Rules (see memory): a blacklisted Brevo contact whose Shopify state is NOT_SUBSCRIBED is the
// Ostendo push default, not an opt-out. A Brevo userUnsubscription click or Shopify UNSUBSCRIBED
// is a real opt-out and is never cleared.

const API = "https://api.brevo.com/v3";

export function brevoKeyFor(brand) {
  return brand === "worthy" ? process.env.BREVO_API_KEY_WORTHY : process.env.BREVO_API_KEY;
}

function hdr(key) {
  return { "api-key": key, accept: "application/json", "content-type": "application/json" };
}

export async function fetchBrevoContacts(key) {
  const all = [];
  for (let o = 0; ; o += 1000) {
    const r = await fetch(`${API}/contacts?limit=1000&offset=${o}`, { headers: hdr(key) });
    if (!r.ok) throw new Error(`Brevo contacts ${r.status}`);
    const j = await r.json();
    all.push(...j.contacts);
    if (j.contacts.length < 1000) break;
  }
  return all;
}

export async function fetchBrevoLists(key) {
  const r = await fetch(`${API}/contacts/lists?limit=50`, { headers: hdr(key) });
  const j = await r.json();
  return j.lists || [];
}

export async function fetchShopifyCustomers(admin) {
  const out = [];
  let after = null;
  for (;;) {
    const res = await admin.graphql(
      `query($after:String){customers(first:250,after:$after){pageInfo{hasNextPage endCursor}nodes{id email firstName lastName tags numberOfOrders amountSpent{amount} emailMarketingConsent{marketingState}}}}`,
      { variables: { after } },
    );
    const j = await res.json();
    out.push(...j.data.customers.nodes);
    if (!j.data.customers.pageInfo.hasNextPage) break;
    after = j.data.customers.pageInfo.endCursor;
  }
  return out;
}

export function buildAudit(brevo, shopify) {
  const withEmail = brevo.filter((c) => c.email);
  const phoneOnly = brevo.length - withEmail.length;
  const bMap = new Map(withEmail.map((c) => [c.email.toLowerCase(), c]));
  const sMap = new Map(shopify.filter((c) => c.email).map((c) => [c.email.toLowerCase(), c]));
  const state = (c) => c.emailMarketingConsent?.marketingState || "NONE";

  const missingInBrevo = [...sMap.values()].filter((c) => !bMap.has(c.email.toLowerCase()));
  const orphans = withEmail.filter((c) => !sMap.has(c.email.toLowerCase()));
  const blacklisted = withEmail.filter((c) => c.emailBlacklisted);
  const clearable = blacklisted.filter((c) => state(sMap.get(c.email.toLowerCase()) || {}) === "NOT_SUBSCRIBED");
  const realOptOut = blacklisted.filter((c) => state(sMap.get(c.email.toLowerCase()) || {}) === "UNSUBSCRIBED");
  const blacklistedNoShopify = blacklisted.filter((c) => !sMap.has(c.email.toLowerCase()));
  const subscribedButBlacklisted = blacklisted.filter((c) => state(sMap.get(c.email.toLowerCase()) || {}) === "SUBSCRIBED");
  const roleRe = /^(info|admin|accounts?|sales|office|orders?|reception|enquir)/i;
  const roleAddresses = withEmail.filter((c) => roleRe.test(c.email));
  const noName = withEmail.filter((c) => !c.attributes?.FIRSTNAME && !c.attributes?.NAME);

  const consent = {};
  for (const c of shopify) consent[state(c)] = (consent[state(c)] || 0) + 1;

  return {
    totals: {
      brevoEmail: withEmail.length,
      brevoPhoneOnly: phoneOnly,
      shopify: shopify.length,
      shopifyNoEmail: shopify.filter((c) => !c.email).length,
      blacklisted: blacklisted.length,
    },
    consent,
    missingInBrevo: missingInBrevo.map((c) => ({ id: c.id, email: c.email, firstName: c.firstName, lastName: c.lastName })),
    orphans: orphans.map((c) => c.email),
    clearable: clearable.map((c) => c.email),
    realOptOut: realOptOut.map((c) => c.email),
    blacklistedNoShopify: blacklistedNoShopify.map((c) => c.email),
    subscribedButBlacklisted: subscribedButBlacklisted.map((c) => c.email),
    roleAddresses: roleAddresses.length,
    noName: noName.length,
  };
}

// Push missing Shopify customers into Brevo (consent respected: only SUBSCRIBED go on the main list).
export async function createMissingContacts(key, customers, listId) {
  let ok = 0;
  const failed = [];
  for (const c of customers) {
    const body = {
      email: c.email,
      updateEnabled: true,
      attributes: { FIRSTNAME: c.firstName || "", LASTNAME: c.lastName || "", SHOPIFY_GID: c.id },
      ...(listId ? { listIds: [Number(listId)] } : {}),
    };
    const r = await fetch(`${API}/contacts`, { method: "POST", headers: hdr(key), body: JSON.stringify(body) });
    if (r.ok) ok++; else failed.push(c.email);
  }
  return { ok, failed };
}

// Clear the default blacklist for contacts whose Shopify state is NOT_SUBSCRIBED, and set Shopify to
// SUBSCRIBED so the next sync does not re-blacklist them. Skips anyone with a real Brevo unsubscribe click.
export async function clearDefaultBlacklists(key, admin, emails) {
  let cleared = 0;
  const skipped = [];
  const failed = [];
  for (const email of emails) {
    const d = await (await fetch(`${API}/contacts/${encodeURIComponent(email)}`, { headers: hdr(key) })).json();
    if (d.statistics?.unsubscriptions?.userUnsubscription?.length) { skipped.push(email); continue; }
    const q = await (await admin.graphql(
      `query($q:String!){customers(first:1,query:$q){nodes{id emailMarketingConsent{marketingState}}}}`,
      { variables: { q: `email:"${email}"` } },
    )).json();
    const n = q.data.customers.nodes[0];
    if (!n || n.emailMarketingConsent?.marketingState !== "NOT_SUBSCRIBED") { skipped.push(email); continue; }
    const m = await (await admin.graphql(
      `mutation($i:CustomerEmailMarketingConsentUpdateInput!){customerEmailMarketingConsentUpdate(input:$i){userErrors{message}}}`,
      { variables: { i: { customerId: n.id, emailMarketingConsent: { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN", consentUpdatedAt: new Date().toISOString() } } } },
    )).json();
    if (m.data?.customerEmailMarketingConsentUpdate?.userErrors?.length) { failed.push(email); continue; }
    const r = await fetch(`${API}/contacts/${encodeURIComponent(email)}`, { method: "PUT", headers: hdr(key), body: JSON.stringify({ emailBlacklisted: false }) });
    if (r.ok) cleared++; else failed.push(email);
  }
  return { cleared, skipped, failed };
}
