// Monthly deal sheet pricing: apply it, remember what it replaced, put it back.
//
// The deal sheet arrives at the end of each month for General Catalog buyers.
// Its prices are written as fixed prices on the Shopify price list (and
// quantity breaks for "Buy 4+" style lines); nothing about them lives in the
// app except the DealSheetPrice register below. On the 1st every deal price
// goes back to what it was, and the next sheet is applied.
//
// "WHAT IT WAS" IS AN INTENT, NOT A DOLLAR AMOUNT
// Retail moves during the month. Restoring last month's $28.53 after retail has
// gone to $33 would bring back exactly the stale price this whole system
// exists to prevent. So the register stores how the price was derived:
//   pct    10% off retail  -> on revert: round(retail now x 0.90)
//   none   no fixed price  -> on revert: delete the row (list is 0%, retail applies)
//   custom a negotiated $  -> on revert: that dollar price comes back
import { cleanPct, pctOff } from "./catalog-reprice.server.js";

const r2 = (x) => Math.round(x * 100) / 100;
const EPS = 0.005;

/** What a live row was, so it can be restored. `row` is null when none existed. */
export function inferBase(row) {
  if (!row) return { baseKind: "none", basePct: null, baseCustomPrice: null };
  const { price, compareAt } = row;
  if (compareAt != null && Math.abs(compareAt - price) < EPS) return { baseKind: "none", basePct: null, baseCustomPrice: null };
  const p = compareAt != null ? cleanPct(price, compareAt) : null;
  if (p !== null) return { baseKind: "pct", basePct: p, baseCustomPrice: null };
  return { baseKind: "custom", basePct: null, baseCustomPrice: price };
}

/** 00:00 NZ on the 1st of the month after `month` ("2026-10"), as a UTC Date. */
export function endsAtForMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  // Find the UTC instant at which Pacific/Auckland reads nm-01 00:00.
  const guess = Date.UTC(ny, nm - 1, 1, 0, 0, 0);
  for (const offsetH of [13, 12]) {
    const t = new Date(guess - offsetH * 3600 * 1000);
    const nz = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(t);
    const get = (k) => nz.find((p) => p.type === k)?.value;
    if (get("year") == String(ny) && get("month") == String(nm).padStart(2, "0") && get("day") === "01" && (get("hour") === "00" || get("hour") === "24")) return t;
  }
  throw new Error(`could not work out the NZ month end for ${month}`);
}

async function liveRows(gql, listId, variantGids) {
  const out = {};
  for (let i = 0; i < variantGids.length; i += 20) {
    const q = variantGids.slice(i, i + 20).map((g) => `variant_id:${g.slice(g.lastIndexOf("/") + 1)}`).join(" OR ");
    let after = null;
    do {
      const d = await gql(
        `query($id:ID!,$a:String,$q:String){ priceList(id:$id){ prices(first:250, after:$a, originType:FIXED, query:$q){ pageInfo{hasNextPage endCursor} nodes{ price{amount} compareAtPrice{amount} variant{ id price } } } } }`,
        { id: listId, a: after, q },
      );
      const pg = d.priceList.prices;
      for (const n of pg.nodes) out[n.variant.id] = { price: parseFloat(n.price.amount), compareAt: n.compareAtPrice ? parseFloat(n.compareAtPrice.amount) : null, retail: parseFloat(n.variant.price) };
      after = pg.pageInfo.hasNextPage ? pg.pageInfo.endCursor : null;
    } while (after);
  }
  return out;
}

async function variantRetail(gql, variantGids) {
  const out = {};
  for (let i = 0; i < variantGids.length; i += 100) {
    const d = await gql(`query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant{ id price } } }`, { ids: variantGids.slice(i, i + 100) });
    for (const n of d.nodes) if (n) out[n.id] = parseFloat(n.price);
  }
  return out;
}

/**
 * Apply deal rows and register them.
 * rows: [{ kind:"price", variantGid, dealPrice, label } | { kind:"break", variantGid, dealPrice, minQty, label }]
 * Re-applying the same variant (same or later month) KEEPS the original base, so
 * a sheet applied before the 1st never mistakes last month's deal for "normal".
 */
export async function applyDealRows(gql, { shop, priceListId, month, rows, dryRun = false, log = console.log }) {
  const { default: prisma } = await import("../db.server.js");
  const endsAt = endsAtForMonth(month);
  const priceRows = rows.filter((r) => r.kind === "price");
  const breakRows = rows.filter((r) => r.kind === "break");

  const existing = await prisma.dealSheetPrice.findMany({ where: { priceListId, variantGid: { in: rows.map((r) => r.variantGid) } } });
  const reg = Object.fromEntries(existing.map((e) => [`${e.variantGid}|${e.kind}`, e]));
  const live = await liveRows(gql, priceListId, priceRows.map((r) => r.variantGid));
  const retail = await variantRetail(gql, rows.map((r) => r.variantGid));

  const plan = [];
  for (const r of priceRows) {
    const prior = reg[`${r.variantGid}|price`];
    const base = prior && !prior.revertedAt
      ? { baseKind: prior.baseKind, basePct: prior.basePct, baseCustomPrice: prior.baseCustomPrice }
      : inferBase(live[r.variantGid] ? { price: live[r.variantGid].price, compareAt: live[r.variantGid].compareAt } : null);
    plan.push({ ...r, ...base, retail: retail[r.variantGid] });
  }
  log(`[deal-sheet] ${month}: ${priceRows.length} price row(s), ${breakRows.length} break(s), ends ${endsAt.toISOString()}`);
  if (dryRun) return { plan, breakRows, endsAt };

  for (let i = 0; i < plan.length; i += 50) {
    const batch = plan.slice(i, i + 50).map((p) => ({
      variantId: p.variantGid,
      price: { amount: r2(p.dealPrice).toFixed(2), currencyCode: "NZD" },
      compareAtPrice: { amount: p.retail.toFixed(2), currencyCode: "NZD" },
    }));
    const d = await gql(
      `mutation($id:ID!,$p:[PriceListPriceInput!]!){ priceListFixedPricesUpdate(priceListId:$id, pricesToAdd:$p, variantIdsToDelete:[]){ userErrors{ field message code } } }`,
      { id: priceListId, p: batch },
    );
    const errs = d.priceListFixedPricesUpdate.userErrors;
    if (errs.length) throw new Error(`deal prices: ${JSON.stringify(errs).slice(0, 300)}`);
  }
  if (breakRows.length) {
    const d = await gql(
      `mutation($id:ID!,$in:QuantityPricingByVariantUpdateInput!){ quantityPricingByVariantUpdate(priceListId:$id, input:$in){ userErrors{ field message code } } }`,
      {
        id: priceListId,
        in: {
          quantityPriceBreaksToAdd: breakRows.map((b) => ({ variantId: b.variantGid, minimumQuantity: b.minQty, price: { amount: r2(b.dealPrice).toFixed(2), currencyCode: "NZD" } })),
          quantityPriceBreaksToDelete: [], quantityRulesToAdd: [], quantityRulesToDeleteByVariantId: [], pricesToAdd: [], pricesToDeleteByVariantId: [],
        },
      },
    );
    const errs = d.quantityPricingByVariantUpdate.userErrors;
    if (errs.length) throw new Error(`deal breaks: ${JSON.stringify(errs).slice(0, 300)}`);
  }

  // Register only after the writes succeeded.
  for (const p of plan) {
    const data = { shop, month, dealPrice: r2(p.dealPrice), baseKind: p.baseKind, basePct: p.basePct, baseCustomPrice: p.baseCustomPrice, label: p.label ?? null, endsAt, revertedAt: null, revertNote: null, minQty: null };
    await prisma.dealSheetPrice.upsert({ where: { priceListId_variantGid_kind: { priceListId, variantGid: p.variantGid, kind: "price" } }, create: { priceListId, variantGid: p.variantGid, kind: "price", ...data }, update: { ...data, appliedAt: new Date() } });
  }
  for (const b of breakRows) {
    const data = { shop, month, dealPrice: r2(b.dealPrice), minQty: b.minQty, baseKind: "none", label: b.label ?? null, endsAt, revertedAt: null, revertNote: null };
    await prisma.dealSheetPrice.upsert({ where: { priceListId_variantGid_kind: { priceListId, variantGid: b.variantGid, kind: "break" } }, create: { priceListId, variantGid: b.variantGid, kind: "break", ...data }, update: { ...data, appliedAt: new Date() } });
  }
  return { plan, breakRows, endsAt, applied: plan.length + breakRows.length };
}

/**
 * Put back every deal whose month has ended. Safe to run every hour.
 * A deal price that someone changed by hand since is NOT touched: it is marked
 * reverted with a note so a person can look, rather than overwritten blindly.
 */
export async function revertDueDeals(gql, { now = new Date(), dryRun = false, log = console.log } = {}) {
  const { default: prisma } = await import("../db.server.js");
  const due = await prisma.dealSheetPrice.findMany({ where: { revertedAt: null, endsAt: { lte: now } } });
  const result = { due: due.length, restored: 0, deleted: 0, breaksRemoved: 0, skipped: [] };
  if (!due.length) return result;
  log(`[deal-sheet] ${due.length} deal row(s) are past their end date`);

  const byList = {};
  for (const d of due) (byList[d.priceListId] ??= []).push(d);

  for (const [listId, rows] of Object.entries(byList)) {
    const priceRows = rows.filter((r) => r.kind === "price");
    const breakRows = rows.filter((r) => r.kind === "break");
    const live = await liveRows(gql, listId, priceRows.map((r) => r.variantGid));
    const restore = []; const remove = []; const done = [];

    for (const r of priceRows) {
      const l = live[r.variantGid];
      if (!l) { done.push([r, "fixed price was already gone"]); continue; }
      if (Math.abs(l.price - r.dealPrice) > EPS) { result.skipped.push({ variant: r.variantGid, expected: r.dealPrice, found: l.price }); done.push([r, `not reverted: price is ${l.price}, deal was ${r.dealPrice}; changed by hand`]); continue; }
      if (r.baseKind === "pct") {
        restore.push({ variantId: r.variantGid, price: r2(l.retail * (1 - r.basePct / 100)), compareAt: l.retail });
        done.push([r, `restored ${r.basePct}% off ${l.retail}`]);
      } else if (r.baseKind === "custom" && r.baseCustomPrice != null && r.baseCustomPrice < l.retail) {
        restore.push({ variantId: r.variantGid, price: r.baseCustomPrice, compareAt: l.retail });
        done.push([r, `restored custom price ${r.baseCustomPrice}`]);
      } else {
        remove.push(r.variantGid);
        done.push([r, "fixed price removed (retail applies)"]);
      }
    }

    if (!dryRun) {
      for (let i = 0; i < restore.length; i += 50) {
        const batch = restore.slice(i, i + 50).map((u) => ({ variantId: u.variantId, price: { amount: u.price.toFixed(2), currencyCode: "NZD" }, compareAtPrice: { amount: u.compareAt.toFixed(2), currencyCode: "NZD" } }));
        const d = await gql(`mutation($id:ID!,$p:[PriceListPriceInput!]!){ priceListFixedPricesUpdate(priceListId:$id, pricesToAdd:$p, variantIdsToDelete:[]){ userErrors{ field message code } } }`, { id: listId, p: batch });
        const errs = d.priceListFixedPricesUpdate.userErrors;
        if (errs.length) throw new Error(`revert prices: ${JSON.stringify(errs).slice(0, 300)}`);
      }
      for (let i = 0; i < remove.length; i += 50) {
        const d = await gql(`mutation($id:ID!,$v:[ID!]!){ priceListFixedPricesUpdate(priceListId:$id, pricesToAdd:[], variantIdsToDelete:$v){ userErrors{ field message code } } }`, { id: listId, v: remove.slice(i, i + 50) });
        const errs = d.priceListFixedPricesUpdate.userErrors;
        if (errs.length) throw new Error(`revert deletes: ${JSON.stringify(errs).slice(0, 300)}`);
      }
      if (breakRows.length) {
        const d = await gql(
          `mutation($id:ID!,$in:QuantityPricingByVariantUpdateInput!){ quantityPricingByVariantUpdate(priceListId:$id, input:$in){ userErrors{ field message code } } }`,
          { id: listId, in: { quantityPriceBreaksToAdd: [], quantityPriceBreaksToDelete: [], quantityRulesToAdd: [], quantityRulesToDeleteByVariantId: [], pricesToAdd: [], pricesToDeleteByVariantId: [] , quantityPriceBreaksToDeleteByVariantId: breakRows.map((b) => b.variantGid) } },
        );
        const errs = d.quantityPricingByVariantUpdate.userErrors;
        if (errs.length) throw new Error(`revert breaks: ${JSON.stringify(errs).slice(0, 300)}`);
      }
      for (const [r, note] of done) await prisma.dealSheetPrice.update({ where: { id: r.id }, data: { revertedAt: new Date(), revertNote: note } });
      for (const b of breakRows) await prisma.dealSheetPrice.update({ where: { id: b.id }, data: { revertedAt: new Date(), revertNote: "quantity break removed" } });
    }
    result.restored += restore.length;
    result.deleted += remove.length;
    result.breaksRemoved += breakRows.length;
  }
  log(`[deal-sheet] reverted: ${result.restored} restored, ${result.deleted} removed, ${result.breaksRemoved} break(s) removed, ${result.skipped.length} left alone`);
  return result;
}
