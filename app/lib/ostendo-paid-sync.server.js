// Ostendo paid -> Shopify paid.
//
// B2B orders land in Shopify as "Payment pending" (account terms). Ostendo is
// where the invoice is raised and the payment is recorded, so customers looked
// at their portal and saw every order unpaid. Every 15 minutes this marks a
// Shopify order paid once Ostendo says it is paid.
//
// Link: Ostendo SALESHEADER rows created by the Shopify connector (XQS) carry the
// Shopify order id in ADDITIONALFIELD_4. Invoices point back at the sales order
// through SALESINVOICEHEADER.GROUPORDERNUMBERS.
//
// An order is marked paid only when ALL of these hold:
//   - the Shopify order is not cancelled and is pending / partially paid / authorized
//   - its Ostendo sales order exists and is Closed
//   - every invoice on it (credits and reversed invoices ignored) is "Fully Paid"
//     with no balance due, OR it has no invoice at all: staff cancel the online
//     order (Closed, nothing invoiced) and re-create it, e.g. to put it under a
//     rep, and Dutch Rusk counts those as paid
// Short shipments (invoiced less than the Shopify total) are still marked paid:
// Ostendo is the ledger. Nothing is ever written to Ostendo.
//
// Env: OSTENDO_BASE_URL, OSTENDO_API_KEY. OSTENDO_PAID_SYNC=off stops it,
// OSTENDO_PAID_SYNC=dry logs what it would do without marking anything,
// OSTENDO_PAID_SYNC_INTERVAL_MIN (default 15). Only the app's own orders/create
// webhook exists, so marking paid sets nothing else off in this app.
// Started 19 Nov 2026; see docs/OSTENDO-PAID-SYNC.md.

import https from "https";

const VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-04";
const TAG = "[ostendo-paid]";
const insecureAgent = new https.Agent({ rejectUnauthorized: false }); // Ostendo uses a self-signed cert

function ostendo(sql) {
  const url = new URL(process.env.OSTENDO_BASE_URL.replace(/\/$/, "") + "/sqlquery");
  url.searchParams.set("apikey", process.env.OSTENDO_API_KEY);
  url.searchParams.set("format", "json");
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", agent: insecureAgent, headers: { "Content-Type": "text/plain" } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const rows = JSON.parse(body);
          if (!Array.isArray(rows)) throw new Error("not a list");
          // Ostendo answers "no rows" with one row of empty strings.
          resolve(rows.filter((r) => Object.values(r).some((v) => v !== "")));
        } catch {
          reject(new Error(`Ostendo: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("Ostendo timeout")));
    req.end(sql);
  });
}

const sqlList = (xs) => xs.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(",");
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Pure decision, exported for tests. */
export function decide(order, salesOrders, invoices) {
  if (order.cancelledAt) return "cancelled";
  if (!salesOrders.length) return "not in Ostendo";
  if (salesOrders.some((s) => s.ORDERSTATUS !== "Closed")) return "Ostendo order not finished";
  const real = invoices.filter((i) => i.INVOICEORCREDIT === "Invoice" && !Number(i.INVOICEREVERSED));
  // Closed with nothing invoiced = staff cancelled the online order and re-created it
  // (usually to put it under a rep). Dutch Rusk treats these as paid (Pratham, 19 Nov 2026).
  if (!real.length) return "PAID";
  const paid = real.every((i) => i.INVOICESTATUS === "Fully Paid" && Math.abs(Number(i.BALANCEDUE) || 0) < 0.01);
  return paid ? "PAID" : "invoice not paid";
}

let running = false;
export async function runOstendoPaidSync(source = "timer", { dryRun = process.env.OSTENDO_PAID_SYNC === "dry" } = {}) {
  if (running) return { skipped: "already running" };
  running = true;
  const t0 = Date.now();
  console.log(`${TAG} ${source}: start${dryRun ? " (dry run)" : ""}`);
  try {
    const { getAdminToken } = await import("./admin-token.server");
    const session = await getAdminToken();
    const gql = async (query, variables) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await fetch(`https://${session.shop}/admin/api/${VERSION}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
          body: JSON.stringify({ query, variables }),
        });
        const json = await res.json().catch(() => null);
        if (json?.errors && JSON.stringify(json.errors).includes("THROTTLED")) {
          await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
          continue;
        }
        if (!json?.data) throw new Error(JSON.stringify(json?.errors || json).slice(0, 300));
        return json.data;
      }
      throw new Error("Shopify throttled 6 times");
    };

    // 1. Shopify orders still waiting on payment.
    const orders = [];
    let after = null;
    do {
      const d = await gql(
        `query($after:String){orders(first:250,after:$after,query:"(financial_status:pending OR financial_status:partially_paid OR financial_status:authorized) -status:cancelled"){pageInfo{hasNextPage endCursor} nodes{id name createdAt cancelledAt displayFinancialStatus}}}`,
        { after },
      );
      orders.push(...d.orders.nodes);
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (after);
    if (!orders.length) {
      console.log(`${TAG} ${source}: nothing unpaid in Shopify`);
      return { checked: 0, marked: 0 };
    }

    // 2. Their Ostendo sales orders, by Shopify order id.
    const ids = orders.map((o) => o.id.split("/").pop());
    const soByShopifyId = {};
    for (const part of chunks(ids, 500)) {
      const rows = await ostendo(
        `SELECT ORDERNUMBER, ORDERSTATUS, ADDITIONALFIELD_4 SHID FROM SALESHEADER WHERE ADDITIONALFIELD_4 IN (${sqlList(part)})`,
      );
      for (const r of rows) (soByShopifyId[String(r.SHID).trim()] ||= []).push(r);
    }

    // 3. Invoices for those sales orders. GROUPORDERNUMBERS can list several orders,
    //    so read every invoice since the oldest unpaid order and split the field.
    const oldest = orders.reduce((m, o) => (o.createdAt < m ? o.createdAt : m), orders[0].createdAt);
    const since = new Date(Date.parse(oldest) - 3 * 864e5).toISOString().slice(0, 10);
    const invRows = await ostendo(
      `SELECT INVOICENUMBER, INVOICESTATUS, INVOICEORCREDIT, INVOICEREVERSED, BALANCEDUE, GROUPORDERNUMBERS FROM SALESINVOICEHEADER WHERE SYSDATECREATED >= '${since}'`,
    );
    const invBySo = {};
    for (const i of invRows) for (const n of String(i.GROUPORDERNUMBERS).split(/[\s,;]+/).filter(Boolean)) (invBySo[n] ||= []).push(i);

    // 4. Decide and mark.
    const tally = {};
    const marked = [];
    const failed = [];
    for (const o of orders) {
      const sos = soByShopifyId[o.id.split("/").pop()] || [];
      const verdict = decide(o, sos, sos.flatMap((s) => invBySo[s.ORDERNUMBER] || []));
      tally[verdict] = (tally[verdict] || 0) + 1;
      if (verdict !== "PAID" || dryRun) continue;
      try {
        const d = await gql(
          `mutation($id:ID!){orderMarkAsPaid(input:{id:$id}){order{displayFinancialStatus} userErrors{message}}}`,
          { id: o.id },
        );
        const errs = d.orderMarkAsPaid.userErrors;
        if (errs.length) failed.push(`${o.name}: ${errs.map((e) => e.message).join("; ")}`);
        else marked.push(`${o.name} (${sos.map((s) => s.ORDERNUMBER).join("+")})`);
      } catch (e) {
        failed.push(`${o.name}: ${e.message}`);
      }
    }

    console.log(
      `${TAG} ${source}: checked ${orders.length} unpaid, ${dryRun ? "would mark" : "marked"} ${dryRun ? tally.PAID || 0 : marked.length} paid, ${failed.length} failed in ${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify(tally)}`,
    );
    if (marked.length) console.log(`${TAG} marked paid: ${marked.join(", ")}`);
    if (failed.length) console.error(`${TAG} failed: ${failed.join(" | ")}`);
    return { checked: orders.length, marked: marked.length, failed, tally };
  } catch (err) {
    console.error(`${TAG} ${source}: failed:`, err?.message ?? err);
    return { error: String(err?.message ?? err) };
  } finally {
    running = false;
  }
}

let started = false;
export function startOstendoPaidSyncTimer() {
  if (started || process.env.OSTENDO_PAID_SYNC === "off") return;
  if (!process.env.OSTENDO_BASE_URL || !process.env.OSTENDO_API_KEY) {
    console.log(`${TAG} not started: OSTENDO_BASE_URL / OSTENDO_API_KEY missing`);
    return;
  }
  started = true;
  const minutes = Number(process.env.OSTENDO_PAID_SYNC_INTERVAL_MIN || 15);
  console.log(`${TAG} timer started, every ${minutes} min`);
  setTimeout(() => { runOstendoPaidSync("startup"); }, 90_000);
  const h = setInterval(() => { runOstendoPaidSync("timer"); }, minutes * 60_000);
  if (typeof h.unref === "function") h.unref();
}
