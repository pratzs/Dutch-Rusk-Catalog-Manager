// Keeps every catalog's fixed prices and compare-at prices in step with retail.
//
// WHY THIS EXISTS
// Ostendo owns retail. When it changes a product price, only the product moves.
// A catalog price is stored as a fixed dollar amount (say $28.53 = 10% off
// $31.70), so it stayed at the old amount while retail went up: on 5 Oct 2026
// 236 catalog prices were giving 13-18% off instead of 10%, and 175 more had a
// compare-at that no longer matched retail. This puts the percentage back.
//
// THE RULE (stateless: the intent is read from the row itself)
//   While a row is consistent, compareAt == retail and fixed == retail x (1-p).
//   When retail changes, compareAt is still the OLD retail, so
//        p = 1 - fixed / compareAt            (the % the catalog intended)
//        new fixed = round(newRetail x (1-p)), new compareAt = newRetail
//   e.g. 10% off $31.70 = $28.53; retail becomes $33.00 -> $29.70.
//
// WHAT IT LEAVES ALONE
//   - A price that is not a clean 5% step is a negotiated dollar price: keep the
//     price, refresh only the compare-at.
//   - A live monthly deal price (DealSheetPrice row): keep the price, refresh
//     compare-at. The deal engine puts the percentage back on the 1st.
//   - Anything that looks like bad data is HELD, not repriced: retail moving more
//     than 30% against the old compare-at, or a price more than 40% under
//     retail. Those were real findings (a $25 Jack Links case against $376
//     retail, a retail that fell 80% overnight) and repricing them silently
//     would spread the mistake.
//     A held row's compare-at no longer matches retail, so it is a false "was"
//     price. It is CLEARED (the price itself is untouched) and remembered in
//     HeldPriceRow. Once retail is corrected in Ostendo the row resolves on its
//     own: the remembered compare-at is fed back through the same rule and the
//     percentage comes back. If someone changes the price by hand, the memory is
//     dropped. A daily email lists what is held (see sendHeldReport).
//
// Also keeps the PRODUCT-level compareAt equal to price where one is set. The
// catalog price sync reads `compareAt || price` as the standard retail, so a
// stale one poisons standard_retail_price and catalog_savings (248 variants on
// 5 Oct 2026, left behind by the manual compare-price button).
// SCOPE (7 Oct 2026, user rule): only the GENERAL customer price is managed here.
// Every other catalog (TEEG, Night N Day, Metromart, ...) belongs to its key
// account manager: their prices are never repriced or held. What this job does
// for ALL catalogs is keep the compare-at ("was") price equal to retail.
export const GENERAL_PRICE_LIST = "gid://shopify/PriceList/34326708537";

const r2 = (x) => Math.round(x * 100) / 100;
const EPS = 0.005;

export const MAX_RETAIL_MOVE = 0.3; // hold if retail moved more than 30%
export const MAX_DISCOUNT = 0.4; // hold if the fixed price is >40% under retail

export function pctOff(fixed, base) {
  return Math.round((1 - fixed / base) * 1000) / 10;
}

/** A discount that is a clean multiple of 5%, or null. 28.53 vs 31.70 -> 10. */
export function cleanPct(fixed, compareAt) {
  if (!(compareAt > 0) || !(fixed > 0)) return null;
  const d = pctOff(fixed, compareAt);
  const snapped = Math.round(d / 5) * 5;
  if (d > 0 && snapped > 0 && Math.abs(d - snapped) < 0.35) return snapped;
  return null;
}

/**
 * Decide what to do with one fixed-price row.
 * @param {{retail:number, fixed:number, compareAt:number|null, dealActive?:boolean}} row
 * @returns {{action:"none"|"update"|"hold", price?:number, compareAt?:number, pct?:number|null, reason?:string}}
 */
export function decideRow({ retail, fixed, compareAt, dealActive = false }) {
  if (!(retail > 0) || !(fixed > 0)) return { action: "hold", reason: "missing or zero price" };

  if (dealActive) {
    if (compareAt !== null && Math.abs(compareAt - retail) < EPS) return { action: "none" };
    return { action: "update", price: fixed, compareAt: retail, pct: null, reason: "deal price kept, compare-at refreshed" };
  }

  if (compareAt === null) {
    if (fixed >= retail - EPS) return { action: "none" }; // no discount, nothing to compare
    if (1 - fixed / retail > MAX_DISCOUNT) return { action: "hold", reason: "price is more than 40% under retail" };
    return { action: "update", price: fixed, compareAt: retail, pct: null, reason: "compare-at added" };
  }

  if (Math.abs(compareAt - retail) < EPS) return { action: "none" };

  const p = cleanPct(fixed, compareAt);
  if (p !== null) {
    const move = retail / compareAt;
    if (move > 1 + MAX_RETAIL_MOVE || move < 1 - MAX_RETAIL_MOVE) {
      return { action: "hold", reason: `retail moved ${Math.round((move - 1) * 100)}% against the old compare-at` };
    }
    return { action: "update", price: r2(retail * (1 - p / 100)), compareAt: retail, pct: p, reason: `repriced at ${p}% off` };
  }

  // Negotiated dollar price: keep it, refresh the compare-at.
  if (fixed < retail) {
    if (1 - fixed / retail > MAX_DISCOUNT) return { action: "hold", reason: "price is more than 40% under retail" };
    return { action: "update", price: fixed, compareAt: retail, pct: null, reason: "custom price kept, compare-at refreshed" };
  }
  return { action: "hold", reason: "custom price is at or above retail" };
}

/**
 * Compare-at only (every catalog except General). The price is never touched.
 * @returns {{action:"none"|"update"|"clear"}}
 */
export function decideCompareAtOnly({ retail, fixed, compareAt }) {
  if (!(retail > 0)) return compareAt !== null && compareAt !== 0 ? { action: "clear" } : { action: "none" };
  if (compareAt !== null && Math.abs(compareAt - retail) < EPS) return { action: "none" };
  if (compareAt === null && fixed >= retail - EPS) return { action: "none" }; // no discount, nothing to compare
  return { action: "update" }; // compare-at := retail, price kept
}

const PRICE_ROWS = `
  pageInfo { hasNextPage endCursor }
  nodes { price { amount } compareAtPrice { amount } variant { id price title sku product { title } } }`;

async function allPriceLists(gql) {
  const lists = [];
  let after = null;
  do {
    const d = await gql(
      `query($a:String){ priceLists(first:50, after:$a){ pageInfo{hasNextPage endCursor} nodes{ id name } } }`,
      { a: after },
    );
    lists.push(...d.priceLists.nodes);
    after = d.priceLists.pageInfo.hasNextPage ? d.priceLists.pageInfo.endCursor : null;
  } while (after);
  return lists;
}

async function loadRows(gql, listId, variantGids) {
  const rows = [];
  const read = async (query) => {
    let after = null;
    do {
      const d = await gql(
        `query($id:ID!,$a:String,$q:String){ priceList(id:$id){ prices(first:250, after:$a, originType:FIXED, query:$q){ ${PRICE_ROWS} } } }`,
        { id: listId, a: after, q: query },
      );
      const pg = d.priceList.prices;
      rows.push(...pg.nodes);
      after = pg.pageInfo.hasNextPage ? pg.pageInfo.endCursor : null;
    } while (after);
  };
  if (!variantGids) {
    await read(null);
  } else {
    for (let i = 0; i < variantGids.length; i += 20) {
      const q = variantGids.slice(i, i + 20).map((g) => `variant_id:${g.slice(g.lastIndexOf("/") + 1)}`).join(" OR ");
      await read(q);
    }
  }
  return rows;
}

async function writePrices(gql, pl, batch) {
  const d = await gql(
    `mutation($id:ID!,$p:[PriceListPriceInput!]!){ priceListFixedPricesUpdate(priceListId:$id, pricesToAdd:$p, variantIdsToDelete:[]){ userErrors{ field message code } } }`,
    { id: pl.id, p: batch },
  );
  const errs = d.priceListFixedPricesUpdate.userErrors;
  if (errs.length) throw new Error(`priceListFixedPricesUpdate ${pl.name}: ${JSON.stringify(errs).slice(0, 300)}`);
}

/**
 * Reprice catalog rows. `variantGids` null = every row in every catalog (the
 * hourly sweep); otherwise only those variants (the product-update webhook).
 * `dryRun` decides and reports without writing.
 */
export async function repriceVariants(gql, variantGids = null, { dryRun = false, log = console.log } = {}) {
  const { default: prisma } = await import("../db.server.js");
  const lists = await allPriceLists(gql);

  const deals = await prisma.dealSheetPrice.findMany({ where: { kind: "price", revertedAt: null } });
  const dealKey = new Set(deals.map((d) => `${d.priceListId}|${d.variantGid}`));

  const held = await prisma.heldPriceRow.findMany();
  const heldKey = new Map(held.map((h) => [`${h.priceListId}|${h.variantGid}`, h]));
  const sess = await prisma.session.findFirst({ where: { isOnline: false, accessToken: { not: "" } }, orderBy: { id: "desc" } });
  const shop = sess?.shop ?? "";

  const summary = { checked: 0, updated: 0, held: [], cleared: 0, restored: 0, byList: {}, variantCompareAtFixed: 0 };
  const touchedVariants = new Set();
  const visited = new Set();

  for (const pl of lists) {
    const rows = await loadRows(gql, pl.id, variantGids);
    const managePrice = pl.id === GENERAL_PRICE_LIST;
    const updates = [];
    const clears = [];
    const upserts = [];
    const resolved = [];
    for (const x of rows) {
      summary.checked++;
      visited.add(`${pl.id}|${x.variant.id}`);
      const retail = parseFloat(x.variant.price);
      const fixed = parseFloat(x.price.amount);
      const shownCompareAt = x.compareAtPrice ? parseFloat(x.compareAtPrice.amount) : null;
      const key = `${pl.id}|${x.variant.id}`;
      const dealActive = dealKey.has(key);
      const label = `${x.variant.product?.title ?? ""} | ${x.variant.title ?? ""}`.trim();

      if (!managePrice) {
        const stale = heldKey.get(key);
        if (stale) resolved.push({ id: stale.id, variantGid: stale.variantGid }); // not ours to hold
        const c = decideCompareAtOnly({ retail, fixed, compareAt: shownCompareAt });
        if (c.action === "update") {
          updates.push({ variantId: x.variant.id, price: fixed, compareAt: retail });
          touchedVariants.add(x.variant.id);
        } else if (c.action === "clear") {
          clears.push({ variantId: x.variant.id, price: fixed });
          summary.cleared++;
          touchedVariants.add(x.variant.id);
        }
        continue;
      }

      // A held row has had its compare-at cleared; judge it by the one it had.
      let h = heldKey.get(key);
      if (h && Math.abs(h.fixedAtHold - fixed) > EPS) {
        resolved.push({ id: h.id, variantGid: h.variantGid }); // price changed by hand: forget it
        h = undefined;
      }
      const compareAt = shownCompareAt ?? (h?.lastCompareAt ?? null);

      let d = decideRow({ retail, fixed, compareAt, dealActive });
      if (d.action === "none" && shownCompareAt === null && h && compareAt !== null) {
        d = { action: "update", price: fixed, compareAt: retail, pct: null, reason: "compare-at restored" };
      }

      if (d.action === "hold") {
        summary.held.push({ list: pl.name, variant: x.variant.id, label, sku: x.variant.sku, retail, fixed, compareAt, reason: d.reason });
        log(`[catalog-reprice] HOLD ${pl.name} ${x.variant.id} retail ${retail} fixed ${fixed} compareAt ${compareAt}: ${d.reason}`);
        const falseShown = shownCompareAt !== null && Math.abs(shownCompareAt - retail) >= EPS;
        if (falseShown) {
          clears.push({ variantId: x.variant.id, price: fixed });
          summary.cleared++;
          touchedVariants.add(x.variant.id);
        }
        upserts.push({
          variantGid: x.variant.id, label, fixedAtHold: fixed, retailAtHold: retail, reason: d.reason,
          lastCompareAt: compareAt, compareAtCleared: falseShown || (h?.compareAtCleared ?? false),
        });
      } else {
        if (h) { resolved.push({ id: h.id, variantGid: h.variantGid }); summary.restored++; }
        if (d.action === "update") {
          updates.push({ variantId: x.variant.id, price: d.price, compareAt: d.compareAt });
          touchedVariants.add(x.variant.id);
          if (d.pct !== null && d.pct !== undefined) {
            log(`[catalog-reprice] ${pl.name} ${x.variant.id}: ${fixed} -> ${d.price} (${d.pct}% off ${d.compareAt}, was ${compareAt})`);
          }
        }
      }
    }
    summary.byList[pl.name] = updates.length;
    summary.updated += updates.length;
    if (dryRun) continue;

    for (let i = 0; i < updates.length; i += 50) {
      const batch = updates.slice(i, i + 50).map((u) => ({
        variantId: u.variantId,
        price: { amount: u.price.toFixed(2), currencyCode: "NZD" },
        compareAtPrice: { amount: u.compareAt.toFixed(2), currencyCode: "NZD" },
      }));
      await writePrices(gql, pl, batch);
    }
    // Clear the false compare-at, keep the price: compareAtPrice null (omitting it leaves the old one in place).
    for (let i = 0; i < clears.length; i += 50) {
      const batch = clears.slice(i, i + 50).map((u) => ({ variantId: u.variantId, price: { amount: u.price.toFixed(2), currencyCode: "NZD" }, compareAtPrice: null }));
      await writePrices(gql, pl, batch);
    }
    for (const u of upserts) {
      const data = { shop, priceListName: pl.name, label: u.label, fixedAtHold: u.fixedAtHold, retailAtHold: u.retailAtHold, reason: u.reason, lastCompareAt: u.lastCompareAt, compareAtCleared: u.compareAtCleared };
      await prisma.heldPriceRow.upsert({ where: { priceListId_variantGid: { priceListId: pl.id, variantGid: u.variantGid } }, create: { priceListId: pl.id, variantGid: u.variantGid, ...data }, update: data });
    }
    const reHeld = new Set(upserts.map((u) => u.variantGid));
    const gone = resolved.filter((r) => !reHeld.has(r.variantGid)).map((r) => r.id);
    if (gone.length) await prisma.heldPriceRow.deleteMany({ where: { id: { in: gone } } });
  }
  // A full sweep has seen every row: a record whose row no longer exists is dead.
  if (!variantGids && !dryRun) {
    const dead = held.filter((h) => !visited.has(`${h.priceListId}|${h.variantGid}`)).map((h) => h.id);
    if (dead.length) await prisma.heldPriceRow.deleteMany({ where: { id: { in: dead } } });
  }

  summary.variantCompareAtFixed = await fixProductLevelCompareAt(gql, variantGids, { dryRun, log, touchedVariants });
  summary.touchedVariantIds = [...touchedVariants];
  return summary;
}

/** Product-level compareAt must equal price wherever one is set. */
async function fixProductLevelCompareAt(gql, variantGids, { dryRun, log, touchedVariants }) {
  const stale = [];
  const check = (nodes) => {
    for (const v of nodes) {
      if (v?.compareAtPrice != null && Math.abs(parseFloat(v.compareAtPrice) - parseFloat(v.price)) > EPS) {
        stale.push({ id: v.id, price: v.price, product: v.product?.id, status: v.product?.status });
      }
    }
  };
  if (variantGids) {
    for (let i = 0; i < variantGids.length; i += 100) {
      const d = await gql(`query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant{ id price compareAtPrice product{ id status } } } }`, { ids: variantGids.slice(i, i + 100) });
      check(d.nodes.filter(Boolean));
    }
  } else {
    let after = null;
    do {
      const d = await gql(`query($a:String){ productVariants(first:250, after:$a){ pageInfo{hasNextPage endCursor} nodes{ id price compareAtPrice product{ id status } } } }`, { a: after });
      check(d.productVariants.nodes);
      after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
    } while (after);
  }
  if (!stale.length) return 0;
  log(`[catalog-reprice] ${stale.length} variant(s) with a stale product-level compare-at`);
  if (dryRun) return stale.length;

  const byProduct = {};
  for (const s of stale) (byProduct[s.product] ??= []).push({ id: s.id, compareAtPrice: s.price });
  for (const [pid, vs] of Object.entries(byProduct)) {
    const d = await gql(
      `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$p, variants:$v){ userErrors{ field message } } }`,
      { p: pid, v: vs },
    );
    const errs = d.productVariantsBulkUpdate.userErrors;
    if (errs.length) throw new Error(`productVariantsBulkUpdate ${pid}: ${JSON.stringify(errs).slice(0, 300)}`);
  }
  for (const s of stale) touchedVariants.add(s.id);
  return stale.length;
}

const money = (n) => (n === null || n === undefined ? "none" : "$" + Number(n).toFixed(2));

/**
 * Plain-text list of every row currently held, for the daily email. Returns null
 * when nothing is held. Two groups: price looks like a per-unit price on a case
 * (needs a price decision) and retail looks wrong or moved a lot (fix in Ostendo).
 */
export async function buildHeldReport() {
  const { default: prisma } = await import("../db.server.js");
  const rows = await prisma.heldPriceRow.findMany({ orderBy: [{ priceListName: "asc" }, { label: "asc" }] });
  if (!rows.length) return null;
  const nice = (n) => n.replace(/ - [0-9a-f-]{36}$/, "");
  const per = rows.filter((r) => /40% under retail/.test(r.reason));
  const moved = rows.filter((r) => !/40% under retail/.test(r.reason));
  const line = (r) => `  ${nice(r.priceListName)}: ${r.label}
      price ${money(r.fixedAtHold)}, retail now ${money(r.retailAtHold)}, compare-at was ${money(r.lastCompareAt)} (${r.compareAtCleared ? "hidden until fixed" : "none shown"})`;
  const lines = [
    `${rows.length} catalog price(s) are on hold. The price itself has not been changed. Any compare-at ("was") price that no longer matched retail has been hidden so customers are not shown a wrong one. Fix the cause below and the next daily check puts the discount back by itself.`,
    "",
  ];
  if (per.length) lines.push(`PRICE LOOKS WRONG: more than 40% under retail (${per.length}). Often a per-unit price sitting on a whole-case pack. Decide the right price, or fix retail in Ostendo:`, ...per.map(line), "");
  if (moved.length) lines.push(`RETAIL LOOKS WRONG: it moved more than 30% (${moved.length}). Check the retail price in Ostendo:`, ...moved.map(line), "");
  return { count: rows.length, subject: `Dutch Rusk catalog prices on hold: ${rows.length} need a look`, lines };
}

/**
 * Email the held rows. To PRICING_ALERT_EMAIL, cc HELD_REPORT_CC (comma list) so
 * the people who fix Ostendo prices see it too. `to`/`cc` override for a one-off.
 */
export async function sendHeldReport({ to, cc } = {}) {
  const { default: prisma } = await import("../db.server.js");
  const { buildHeldEmail } = await import("./held-report.server.js");
  const email = buildHeldEmail(await prisma.heldPriceRow.findMany());
  if (!email) return { sent: false, count: 0 };
  const recipient = to ?? process.env.PRICING_ALERT_EMAIL;
  if (!recipient) return { sent: false, count: email.count, result: "PRICING_ALERT_EMAIL not set" };
  const ccList = cc ?? (process.env.HELD_REPORT_CC ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const { sendHeldPricesEmail } = await import("./brevo.server.js");
  await sendHeldPricesEmail({ to: recipient, cc: ccList, subject: email.subject, html: email.html, text: email.text });
  return { sent: true, count: email.count, to: recipient, cc: ccList };
}
