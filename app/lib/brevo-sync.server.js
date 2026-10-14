// Shopify -> Brevo contact sync (Dutch Rusk).
//
// Every few minutes this copies customer changes from Shopify into Brevo:
//   - the contact is created or updated (name, company, catalog, sales rep, tags)
//   - it is kept in the MASTER list and in the one "Catalog: ..." list that matches its Shopify catalog
//   - a customer Brevo has never seen before is also dropped into the NEW list so Isabel can see it
//     and move it where she wants. SYNC_ADDED marks contacts already handled, so removing someone
//     from the NEW list never puts them back.
// Consent is not handled here, see consent-default.server.js.

const API = "https://api.brevo.com/v3";
const VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-07";

export const MASTER_LIST_NAME = "MASTER: Dutch Rusk customers (synced from Shopify)";
export const NEW_LIST_NAME = "NEW from Shopify: sort me (auto)";
const CATALOG_PREFIX = "Catalog: ";

function hdr(key) {
  return { "api-key": key, accept: "application/json", "content-type": "application/json" };
}

async function brevo(key, path, opts = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      return await fetch(API + path, { headers: hdr(key), ...opts });
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("Brevo unreachable: " + path);
}

export function catalogListName(catalog) {
  return CATALOG_PREFIX + (catalog || "none (no company yet)");
}

async function listIdsByName(key) {
  const j = await (await brevo(key, "/contacts/lists?limit=50")).json();
  const map = new Map((j.lists || []).map((l) => [l.name, l.id]));
  let folderId = (j.lists || []).find((l) => l.name === MASTER_LIST_NAME)?.folderId;
  if (!folderId) {
    const f = await (await brevo(key, "/contacts/folders?limit=20")).json();
    folderId = f.folders?.[0]?.id;
  }
  return { map, folderId };
}

async function ensureList(key, ctx, name) {
  if (ctx.map.has(name)) return ctx.map.get(name);
  const r = await (await brevo(key, "/contacts/lists", { method: "POST", body: JSON.stringify({ name, folderId: ctx.folderId }) })).json();
  if (r.id) ctx.map.set(name, r.id);
  return r.id;
}

async function adminGql(query, variables) {
  const { getAdminToken } = await import("./admin-token.server");
  const session = await getAdminToken();
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`https://${session.shop}/admin/api/${VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
        body: JSON.stringify({ query, variables }),
      });
      return JSON.parse(await res.text());
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("Shopify unreachable");
}

const CUSTOMER_FIELDS = `id email firstName lastName tags createdAt
  rep: metafield(namespace: "custom", key: "sales_reps") { value }
  companyContactProfiles { company { name locations(first: 5) { nodes { catalogs(first: 5) { nodes { title } } } } } }`;

async function fetchCustomers(sinceIso) {
  const out = [];
  let after = null;
  const q = sinceIso ? `updated_at:>=${sinceIso}` : "";
  for (;;) {
    const r = await adminGql(
      `query($a:String,$q:String){customers(first:100,after:$a,query:$q){pageInfo{hasNextPage endCursor}nodes{${CUSTOMER_FIELDS}}}}`,
      { a: after, q },
    );
    if (!r.data) throw new Error(JSON.stringify(r.errors || r).slice(0, 200));
    out.push(...r.data.customers.nodes);
    if (!r.data.customers.pageInfo.hasNextPage) break;
    after = r.data.customers.pageInfo.endCursor;
  }
  return out;
}

export function buildAttributes(c, repNames) {
  const prof = c.companyContactProfiles?.[0];
  const company = prof?.company?.name || "";
  const cats = [...new Set((prof?.company?.locations?.nodes || []).flatMap((l) => l.catalogs.nodes.map((n) => n.title)))];
  const catalog = cats[0] || "";
  const code = c.rep?.value?.trim() || "";
  const first = (c.firstName || "").trim();
  const attrs = {
    SHOPIFY_GID: c.id,
    FIRSTNAME: first,
    LASTNAME: (c.lastName || "").trim(),
    COMPANY_NAME: company,
    CATALOG: catalog,
    SALES_PERSON: code,
    SALES_REP_NAME: repNames.get(code) || "",
    TAGS: (c.tags || []).join(", "),
    GREETING: first || "there",
  };
  // Never blank out something Brevo already holds, only fill or change to a real value.
  for (const k of Object.keys(attrs)) if (attrs[k] === "") delete attrs[k];
  return { attrs, catalog };
}

/**
 * @param {{sinceMinutes?: number, full?: boolean}} opts  full = every customer, nobody is added to the NEW list.
 */
export async function runShopifyBrevoSync({ sinceMinutes = 60, full = false, source = "timer" } = {}) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return { skipped: "no BREVO_API_KEY" };
  try {
    const { default: prisma } = await import("../db.server");
    const { getAdminToken } = await import("./admin-token.server");
    const session = await getAdminToken();
    const reps = await prisma.salesRep.findMany({ where: { shop: session.shop } });
    const repNames = new Map(reps.map((r) => [r.repCode, r.name]));

    const since = full ? null : new Date(Date.now() - sinceMinutes * 60_000).toISOString();
    const customers = (await fetchCustomers(since)).filter((c) => c.email);
    if (!customers.length) return { customers: 0 };

    for (const a of ["SYNC_ADDED", "GREETING", "CATALOG", "SALES_REP_NAME"]) {
      await brevo(key, `/contacts/attributes/normal/${a}`, { method: "POST", body: JSON.stringify({ type: "text" }) });
    }
    const ctx = await listIdsByName(key);
    const masterId = await ensureList(key, ctx, MASTER_LIST_NAME);
    const newId = await ensureList(key, ctx, NEW_LIST_NAME);
    const catalogListIds = [...ctx.map.entries()].filter(([n]) => n.startsWith(CATALOG_PREFIX)).map(([, id]) => id);

    let created = 0, updated = 0, newlyQueued = 0, failed = 0;
    for (const c of customers) {
      const email = c.email.toLowerCase();
      const { attrs, catalog } = buildAttributes(c, repNames);
      const catId = await ensureList(key, ctx, catalogListName(catalog));
      const existing = await brevo(key, `/contacts/${encodeURIComponent(email)}`);
      const isNew = existing.status === 404;
      const cur = existing.ok ? await existing.json() : null;
      const handled = !!cur?.attributes?.SYNC_ADDED;

      const body = {
        email,
        updateEnabled: true,
        attributes: { ...attrs },
        listIds: [masterId, catId],
      };
      let addToNew = false;
      if (!full && !handled) { addToNew = true; }
      body.attributes.SYNC_ADDED = "yes";
      if (addToNew) body.listIds.push(newId);
      // Moving catalog: leave the other catalog lists.
      const unlink = catalogListIds.filter((id) => id !== catId && cur?.listIds?.includes(id));

      let r;
      if (isNew) {
        r = await brevo(key, "/contacts", { method: "POST", body: JSON.stringify(body) });
      } else {
        const { email: _e, updateEnabled: _u, ...rest } = body;
        r = await brevo(key, `/contacts/${encodeURIComponent(email)}`, { method: "PUT", body: JSON.stringify({ ...rest, ...(unlink.length ? { unlinkListIds: unlink } : {}) }) });
      }
      if (!r.ok && r.status !== 204) { failed++; continue; }
      if (isNew) created++; else updated++;
      if (addToNew) newlyQueued++;
    }
    const result = { customers: customers.length, created, updated, newlyQueued, failed };
    if (created || newlyQueued || failed || full) console.log(`[brevo-sync] ${source}:`, JSON.stringify(result));
    return result;
  } catch (err) {
    console.error("[brevo-sync] failed:", err?.message ?? err);
    return { error: String(err?.message ?? err) };
  }
}

let started = false;
export function startBrevoSyncTimer() {
  if (started || process.env.BREVO_SYNC_TIMER === "off") return;
  started = true;
  const minutes = Number(process.env.BREVO_SYNC_INTERVAL_MIN || 10);
  console.log(`[brevo-sync] timer started, every ${minutes} min`);
  setTimeout(() => { runShopifyBrevoSync({ source: "startup" }); }, 90_000);
  const h = setInterval(() => { runShopifyBrevoSync({ source: "timer" }); }, minutes * 60_000);
  if (typeof h.unref === "function") h.unref();
}
