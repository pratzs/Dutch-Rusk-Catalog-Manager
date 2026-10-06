// app/routes/api.catalog-reprice.jsx
//
// Two callers, one secret (x-cron-secret = CRON_SECRET):
//
//   { variantIds: [...] }       from webhooks.products.update when Ostendo moves
//                               a price. Reprices only those variants.
//   { mode: "maintenance" }     from the hourly Render cron. Puts back any deal
//                               whose month has ended, switches BOGO deals on/off
//                               for the month, sinks sold-out products on the
//                               Deals page, then sweeps every catalog row as a
//                               backstop for a missed webhook.
//
// Both finish by asking the catalog price sync to rebuild the metafields the
// pricing Functions and the theme read, but only when there is something to
// rebuild: a price or compare-at was changed, or a variant's stored
// standard_retail_price no longer matches its price (a retail change on a
// variant with no catalog row still needs that refreshed). An unrelated product
// edit (a title, an image) therefore costs nothing.
// That sync is called from HERE, after the prices are right, rather than from
// the webhook in parallel: run in parallel it read the old prices, and its
// 8-minute lock then refused the second run. See docs/CATALOG-PRICING.md.
import { adminGql, arrangeOneCollection, SOLD_OUT_LAST_HANDLES } from "../lib/brand-order.server";
import { reconcileBogo } from "../lib/bogo-schedule.server";
import { getAdminToken } from "../lib/admin-token.server";
import { repriceVariants } from "../lib/catalog-reprice.server";
import { revertDueDeals } from "../lib/deal-sheet.server";
import { flushRedirects } from "../lib/redirects.server";

async function triggerSync(variantIds) {
  const url = `${process.env.SHOPIFY_APP_URL ?? "https://dutch-rusk-catalog-manager.onrender.com"}/api/catalog-price-sync`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": process.env.CRON_SECRET ?? "" },
        body: JSON.stringify({ variantIds }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.message !== "Locked") return j;
    } catch (e) {
      console.error("[catalog-reprice] sync trigger failed:", e.message);
    }
    await new Promise((r) => setTimeout(r, 30000)); // another sync is running; wait it out
  }
  return { message: "sync stayed locked" };
}

/** Variants whose stored standard_retail_price differs from their price. */
async function staleRetailMetafields(gql, variantIds) {
  const stale = [];
  for (let i = 0; i < variantIds.length; i += 100) {
    const d = await gql(
      `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant{ id price srp: metafield(namespace:"custom", key:"standard_retail_price"){ value } } } }`,
      { ids: variantIds.slice(i, i + 100) },
    );
    for (const n of d.nodes) {
      if (!n) continue;
      const stored = n.srp ? parseFloat(n.srp.value) : null;
      if (stored === null || Math.abs(stored - parseFloat(n.price)) > 0.005) stale.push(n.id);
    }
  }
  return stale;
}

export async function action({ request }) {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const maintenance = body.mode === "maintenance";
  const variantIds = Array.isArray(body.variantIds) ? body.variantIds : null;
  if (!maintenance && !variantIds?.length) return Response.json({ error: "nothing to do" }, { status: 400 });

  try {
    const { shop, accessToken } = await getAdminToken();
    const gql = adminGql(shop, accessToken);

    let reverted = null;
    let bogo = null;
    let ordered = null;
    let redirects = null;
    if (maintenance) {
      // 301s for pages the app has retired (removed BOGO deals), queued until the
      // app is allowed to create them.
      try {
        redirects = await flushRedirects(gql);
      } catch (e) {
        console.error("[catalog-reprice] redirects:", e.message);
        redirects = { error: e.message };
      }
      reverted = await revertDueDeals(gql);
      // BOGO deals run only in the months a deal sheet lists them (Dragon and
      // Bundaberg all year). This is what ends a deal when the month turns.
      bogo = await reconcileBogo(gql);
      ordered = {};
      for (const handle of SOLD_OUT_LAST_HANDLES) {
        try {
          ordered[handle] = await arrangeOneCollection(gql, handle);
        } catch (e) {
          console.error(`[catalog-reprice] could not arrange ${handle}:`, e.message);
          ordered[handle] = { error: e.message };
        }
      }
    }
    const summary = await repriceVariants(gql, maintenance ? null : variantIds);

    const stale = maintenance ? [] : await staleRetailMetafields(gql, variantIds);
    const changed = summary.updated > 0 || summary.variantCompareAtFixed > 0 || stale.length > 0 || (reverted && (reverted.restored || reverted.deleted || reverted.breaksRemoved)) || bogo?.changed;
    if (changed) {
      // Don't make the caller wait for the sync; it can take minutes.
      const ids = maintenance ? null : [...new Set([...variantIds, ...(summary.touchedVariantIds ?? [])])];
      triggerSync(ids).then((r) => console.log("[catalog-reprice] sync:", JSON.stringify(r).slice(0, 200)));
    }
    console.log(`[catalog-reprice] ${maintenance ? "sweep" : "webhook"}: checked ${summary.checked}, updated ${summary.updated}, held ${summary.held.length}, product compare-at fixed ${summary.variantCompareAtFixed}`);
    return Response.json({ success: true, checked: summary.checked, updated: summary.updated, held: summary.held.length, variantCompareAtFixed: summary.variantCompareAtFixed, reverted, bogo, ordered, redirects, syncTriggered: !!changed });
  } catch (err) {
    console.error("[catalog-reprice] failed:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
