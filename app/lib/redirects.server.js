// 301 redirects for storefront addresses the app retires.
//
// RULE (6 Oct 2026): whenever a page or collection address changes or goes away,
// the old address gets a 301 to where visitors should land. For a BOGO deal that
// is removed on the BOGO Bundles page, the old /collections/deal-<id> address
// redirects to the Special Deals page.
//
// ORDER MATTERS. Shopify ignores a redirect on a path that still has a live
// collection, so the redirect is created AFTER the collection is deleted.
//
// WHY A QUEUE. Creating a redirect needs the navigation access scope, which the
// app only has once the merchant approves it. Rather than lose the redirect when
// a deal is removed before that approval (or while Shopify is erroring), each one
// is queued in the shop metafield custom.pending_redirects and flushed whenever
// possible: straight after the removal, and again every hour from the Catalog
// Pricing job. An address that already has a redirect counts as done.
const NS = "custom";
const KEY = "pending_redirects";
export const SPECIAL_DEALS_PATH = "/pages/special-deals";

function parse(value) {
  try {
    const v = JSON.parse(value || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function readQueue(gql) {
  const d = await gql(`query { shop { id metafield(namespace: "${NS}", key: "${KEY}") { value } } }`);
  return { shopId: d.shop.id, queue: parse(d.shop.metafield?.value) };
}

async function writeQueue(gql, shopId, queue) {
  const d = await gql(
    `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
    { m: [{ ownerId: shopId, namespace: NS, key: KEY, type: "json", value: JSON.stringify(queue) }] },
  );
  const errs = d?.metafieldsSet?.userErrors ?? [];
  if (errs.length) throw new Error(`could not save the redirect queue: ${errs.map((e) => e.message).join(", ")}`);
}

/** Remember that `from` must 301 to `to`. Safe to call twice. */
export async function queueRedirect(gql, from, to = SPECIAL_DEALS_PATH) {
  const { shopId, queue } = await readQueue(gql);
  if (queue.some((r) => r.from === from)) return { queued: false, pending: queue.length };
  queue.push({ from, to, queuedAt: new Date().toISOString() });
  await writeQueue(gql, shopId, queue);
  return { queued: true, pending: queue.length };
}

/**
 * Create every queued redirect it can. Returns { created, pending, denied }.
 * `denied` is true when the app does not have the navigation scope yet; the
 * queue is left alone so a later run, after the merchant approves, completes it.
 */
export async function flushRedirects(gql, { log = console.log } = {}) {
  const { shopId, queue } = await readQueue(gql);
  if (!queue.length) return { created: 0, pending: 0, denied: false };

  const remaining = [];
  let created = 0;
  let denied = false;

  for (const r of queue) {
    if (denied) { remaining.push(r); continue; }
    try {
      const d = await gql(
        `mutation($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) { urlRedirect { id } userErrors { field message } } }`,
        { r: { path: r.from, target: r.to } },
      );
      const errs = d?.urlRedirectCreate?.userErrors ?? [];
      if (!errs.length) {
        created++;
        log(`[redirects] 301 ${r.from} -> ${r.to}`);
      } else if (errs.some((e) => /already|taken|exist/i.test(e.message))) {
        log(`[redirects] ${r.from} already redirects, done`);
      } else {
        log(`[redirects] could not create ${r.from}: ${errs.map((e) => e.message).join(", ")}`);
        remaining.push(r);
      }
    } catch (e) {
      if (/access denied|ACCESS_DENIED|scope/i.test(e.message)) {
        denied = true;
        remaining.push(r);
        log("[redirects] the app does not have the navigation permission yet; redirects stay queued");
      } else {
        log(`[redirects] ${r.from} failed, will retry: ${e.message}`);
        remaining.push(r);
      }
    }
  }

  if (remaining.length !== queue.length) await writeQueue(gql, shopId, remaining);
  return { created, pending: remaining.length, denied };
}
