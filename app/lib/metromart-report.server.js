// Metromart North vs South report (Jira SUP-45, requested by Nish Jha).
//
// North Island Metromarts are Worthy Products customers in Odoo (company 4,
// contact tag "Metromart"). South Island Metromarts are Dutch Rusk customers,
// invoiced in Ostendo. This module reads both, side by side, for a week or a
// month, and builds one email.
//
// Sales basis (agreed with Pratham, 7 Oct 2026):
//   North = Odoo posted customer invoices less credit notes, PRODUCT LINES ONLY,
//           excl GST (same basis as the finance team's sales-rep report).
//   South = Ostendo invoiced (SALESINVOICELINES.EXTENDEDNETTPRICE, excl GST,
//           credit notes are already negative).
//
// Env: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASSWORD, OSTENDO_BASE_URL,
//      OSTENDO_API_KEY. Sending uses Brevo (BREVO_API_KEY).

import https from "node:https";

const NZ_TZ = "Pacific/Auckland";
const ODOO_COMPANY_ID = 4;
const ODOO_TAG_NAME = "Metromart";

// ── NZ dates ────────────────────────────────────────────────────────────────

/** Today's calendar date in NZ as {y, m, d, dow (0=Sun), hour}. */
export function nzNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-NZ", {
      timeZone: NZ_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  const dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +parts.year, m: +parts.month, d: +parts.day, dow: dows[parts.weekday], hour: +parts.hour % 24 };
}

// Plain calendar-date helpers on "YYYY-MM-DD" strings (no time zones involved).
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const addDays = (s, n) => { const t = new Date(s + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const fmtDay = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtMonth = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-NZ", { month: "long", year: "numeric", timeZone: "UTC" });

/** NZ financial year start (1 April) for a date. */
const fyStart = (s) => { const [y, m] = s.split("-").map(Number); return iso(m >= 4 ? y : y - 1, 4, 1); };

/**
 * Periods for a report.
 * week:  Sunday run = that Mon-Sun; any other day = last completed Mon-Sun.
 * month: the previous calendar month.
 */
export function reportPeriods(kind, now = new Date()) {
  const t = nzNow(now);
  const today = iso(t.y, t.m, t.d);
  let start, end, prevStart, prevEnd, label, prevLabel;
  if (kind === "week") {
    end = t.dow === 0 ? today : addDays(today, -t.dow); // Sunday
    start = addDays(end, -6);
    prevEnd = addDays(start, -1);
    prevStart = addDays(prevEnd, -6);
    label = `${fmtDay(start)} to ${fmtDay(end)}`;
    prevLabel = `Previous week (${fmtDay(prevStart)} to ${fmtDay(prevEnd)})`;
  } else {
    const firstThis = iso(t.y, t.m, 1);
    end = addDays(firstThis, -1);
    start = end.slice(0, 8) + "01";
    prevEnd = addDays(start, -1);
    prevStart = prevEnd.slice(0, 8) + "01";
    label = fmtMonth(start);
    prevLabel = fmtMonth(prevStart);
  }
  const fy = fyStart(end);
  return { kind, start, end, prevStart, prevEnd, fyStart: fy, label, prevLabel, fyLabel: `${fmtDay(fy)} to ${fmtDay(end)}` };
}

// ── Odoo (North Island) ─────────────────────────────────────────────────────

async function odooRpc(service, method, args) {
  const url = `${process.env.ODOO_URL.replace(/\/$/, "")}/jsonrpc`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`Odoo ${method}: ${json.error.data?.message || json.error.message}`);
  return json.result;
}

let odooUidCache = null;
async function odoo(model, method, args, kwargs = {}) {
  const { ODOO_DB: db, ODOO_USER: user, ODOO_PASSWORD: pass } = process.env;
  if (!odooUidCache) odooUidCache = await odooRpc("common", "login", [db, user, pass]);
  if (!odooUidCache) throw new Error("Odoo login failed");
  return odooRpc("object", "execute_kw", [db, odooUidCache, pass, model, method, args, kwargs]);
}

/** Short store name: "Shrina Limited T/A Metromart Nawton" -> "Metromart Nawton". */
function shortName(name) {
  const m = String(name || "").match(/T\/A\s+(.+)$/i);
  return (m ? m[1] : String(name || "")).trim();
}

/** All North Island Metromart stores (tagged contacts) -> Map(id, name). */
async function northStores() {
  const tags = await odoo("res.partner.category", "search", [[["name", "=", ODOO_TAG_NAME]]]);
  if (!tags.length) throw new Error(`Odoo tag "${ODOO_TAG_NAME}" not found`);
  const partners = await odoo("res.partner", "search_read",
    [[["category_id", "in", tags], ["company_id", "in", [ODOO_COMPANY_ID, false]]]],
    { fields: ["commercial_partner_id"], context: { active_test: true } });
  const ids = [...new Set(partners.map((p) => p.commercial_partner_id[0]))];
  const rows = await odoo("res.partner", "read", [ids], { fields: ["name"] });
  return new Map(rows.map((r) => [r.id, shortName(r.name)]));
}

/** North sales per store between two dates (inclusive). */
async function northSales(storeIds, start, end) {
  const moves = await odoo("account.move", "search_read", [[
    ["company_id", "=", ODOO_COMPANY_ID], ["state", "=", "posted"],
    ["move_type", "in", ["out_invoice", "out_refund"]],
    ["invoice_date", ">=", start], ["invoice_date", "<=", end],
    ["partner_id.commercial_partner_id", "in", storeIds],
  ]], { fields: ["move_type", "partner_id"] });
  const out = new Map();
  if (!moves.length) return out;
  const moveInfo = new Map();
  const partnerIds = [...new Set(moves.map((m) => m.partner_id[0]))];
  const partners = await odoo("res.partner", "read", [partnerIds], { fields: ["commercial_partner_id"] });
  const commercial = new Map(partners.map((p) => [p.id, p.commercial_partner_id[0]]));
  for (const m of moves) moveInfo.set(m.id, { store: commercial.get(m.partner_id[0]), sign: m.move_type === "out_refund" ? -1 : 1, invoice: m.move_type === "out_invoice" });
  const lines = await odoo("account.move.line", "search_read", [[
    ["move_id", "in", [...moveInfo.keys()]], ["display_type", "=", "product"], ["product_id", "!=", false],
  ]], { fields: ["move_id", "price_subtotal"] });
  const invoiced = new Map(); // store -> Set(invoice ids) for the invoice count
  for (const l of lines) {
    const info = moveInfo.get(l.move_id[0]);
    out.set(info.store, (out.get(info.store) || 0) + l.price_subtotal * info.sign);
    if (info.invoice) { if (!invoiced.has(info.store)) invoiced.set(info.store, new Set()); invoiced.get(info.store).add(l.move_id[0]); }
  }
  for (const [store, set] of invoiced) out.set(`${store}:count`, set.size);
  return out;
}

// ── Ostendo (South Island) ──────────────────────────────────────────────────

const insecureAgent = new https.Agent({ rejectUnauthorized: false }); // Ostendo uses a self-signed cert

function ostendo(sql) {
  const base = process.env.OSTENDO_BASE_URL.replace(/\/$/, "");
  const url = new URL(`${base}/sqlquery`);
  url.searchParams.set("apikey", process.env.OSTENDO_API_KEY);
  url.searchParams.set("format", "json");
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", agent: insecureAgent, headers: { "content-type": "text/plain" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`Ostendo: ${body.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("Ostendo timeout")));
    req.end(sql);
  });
}

/** Same store can appear as "MetroMart Hereford" and "MetroMart Hereford 2025". */
const southKey = (name) => String(name || "").replace(/\s+20\d\d\s*$/, "").replace(/metro\s*mart/i, "Metromart").trim();

/** South sales per store between two dates (inclusive). */
async function southSales(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("bad date");
  const rows = await ostendo(
    `SELECT H.DELIVERYCUSTOMER AS STORE, H.INVOICEORCREDIT AS KIND, H.INVOICENUMBER AS INV, SUM(L.EXTENDEDNETTPRICE) AS NETT ` +
    `FROM SALESINVOICEHEADER H JOIN SALESINVOICELINES L ON L.INVOICENUMBER = H.INVOICENUMBER ` +
    `WHERE UPPER(H.DELIVERYCUSTOMER) LIKE '%METRO%MART%' AND H.INVOICEDATE >= '${start}' AND H.INVOICEDATE <= '${end}' ` +
    `GROUP BY H.DELIVERYCUSTOMER, H.INVOICEORCREDIT, H.INVOICENUMBER`
  );
  if (!Array.isArray(rows)) throw new Error(`Ostendo returned ${typeof rows}`);
  const out = new Map();
  for (const r of rows) {
    const k = southKey(r.STORE);
    out.set(k, (out.get(k) || 0) + Number(r.NETT || 0));
    if (r.KIND === "Invoice") out.set(`${k}:count`, (out.get(`${k}:count`) || 0) + 1);
  }
  return out;
}

// ── Assemble ────────────────────────────────────────────────────────────────

export async function buildMetromartData(kind, now = new Date(), { skipSouth = false } = {}) {
  const p = reportPeriods(kind, now);
  const stores = await northStores();
  const ids = [...stores.keys()];
  const [nCur, nPrev, nFy, sCur, sPrev, sFy] = await Promise.all([
    northSales(ids, p.start, p.end), northSales(ids, p.prevStart, p.prevEnd), northSales(ids, p.fyStart, p.end),
    ...(skipSouth ? [new Map(), new Map(), new Map()] : [southSales(p.start, p.end), southSales(p.prevStart, p.prevEnd), southSales(p.fyStart, p.end)]),
  ]);

  const north = ids.map((id) => ({
    name: stores.get(id),
    cur: nCur.get(id) || 0, invoices: nCur.get(`${id}:count`) || 0,
    prev: nPrev.get(id) || 0, fy: nFy.get(id) || 0,
  }));

  // South store list = every Metromart invoiced this financial year.
  const southNames = new Set([...sFy.keys(), ...sCur.keys(), ...sPrev.keys()].filter((k) => !k.endsWith(":count")));
  const south = [...southNames].map((name) => ({
    name,
    cur: sCur.get(name) || 0, invoices: sCur.get(`${name}:count`) || 0,
    prev: sPrev.get(name) || 0, fy: sFy.get(name) || 0,
  }));

  const sort = (a, b) => b.cur - a.cur || b.fy - a.fy || a.name.localeCompare(b.name);
  north.sort(sort); south.sort(sort);
  const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
  const totals = (rows) => ({ cur: sum(rows, "cur"), prev: sum(rows, "prev"), fy: sum(rows, "fy"), invoices: sum(rows, "invoices"), ordered: rows.filter((r) => r.invoices > 0).length, stores: rows.length });
  return { period: p, north, south, northTotal: totals(north), southTotal: totals(south) };
}

// ── Email (Worthy Products house style, email-client safe) ──────────────────

const BRAND = "#2156C3", BRAND_DARK = "#16337a", INK = "#111827", MUTED = "#1f2937", SOFT = "#374151";
const GOOD = "#166534", BAD = "#b91c1c", LINE = "#e5e7eb", BG = "#eef2f9";
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (v) => (Math.abs(v) < 0.5 ? "$0" : `${v < 0 ? "-" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-NZ")}`);

function change(cur, prev) {
  if (Math.abs(prev) < 0.5) return Math.abs(cur) < 0.5 ? `<span style="color:${SOFT};">&ndash;</span>` : `<span style="color:${GOOD};font-weight:700;">New</span>`;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return `<span style="color:${up ? GOOD : BAD};font-weight:700;">${up ? "&#9650;" : "&#9660;"} ${Math.abs(pct).toFixed(0)}%</span>`;
}

function kpi(label, value, sub, accent) {
  return `<td width="33%" style="padding:6px;vertical-align:top;">
    <div style="background:#ffffff;border:1px solid ${LINE};border-top:5px solid ${accent};border-radius:12px;padding:16px 18px;">
      <div style="font-size:14px;font-weight:700;color:${SOFT};text-transform:uppercase;letter-spacing:.4px;">${label}</div>
      <div style="font-size:28px;font-weight:800;color:${INK};margin-top:6px;">${value}</div>
      <div style="font-size:15px;color:${MUTED};margin-top:4px;">${sub}</div>
    </div></td>`;
}

function storeTable(title, island, rows, total, p, accent) {
  const th = `padding:10px 10px;font-size:14px;font-weight:700;color:#ffffff;background-color:${BRAND_DARK};`;
  const td = `padding:10px 10px;font-size:16px;color:${INK};border-bottom:1px solid ${LINE};`;
  const num = "white-space:nowrap;";
  const curHead = p.kind === "week" ? "This Week" : esc(p.label);
  const prevHead = p.kind === "week" ? "Last Week" : esc(p.prevLabel);
  let h = `<div style="font-size:21px;font-weight:800;color:${INK};margin:26px 0 4px;">${title}</div>
    <div style="font-size:15px;color:${MUTED};margin-bottom:10px;">${island}. ${total.ordered} of ${total.stores} stores invoiced in this period.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#ffffff;">
    <tr><th style="${th}text-align:left;">Store</th><th style="${th}text-align:right;">${curHead}</th><th style="${th}text-align:right;">Invoices</th>
    <th style="${th}text-align:right;">${prevHead}</th><th style="${th}text-align:right;">Change</th><th style="${th}text-align:right;">FY to Date</th></tr>`;
  rows.forEach((r, i) => {
    const bg = i % 2 ? "#f8fafc" : "#ffffff";
    const none = r.invoices === 0 && Math.abs(r.cur) < 0.5;
    h += `<tr style="background:${bg};">
      <td style="${td}font-weight:700;">${esc(r.name)}${none ? ` <span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:#fef3c7;color:#92400e;font-size:12px;font-weight:700;">No order</span>` : ""}</td>
      <td style="${td}${num}text-align:right;font-weight:700;">${money(r.cur)}</td>
      <td style="${td}${num}text-align:right;">${r.invoices}</td>
      <td style="${td}${num}text-align:right;color:${MUTED};">${money(r.prev)}</td>
      <td style="${td}${num}text-align:right;">${change(r.cur, r.prev)}</td>
      <td style="${td}${num}text-align:right;">${money(r.fy)}</td></tr>`;
  });
  const tt = `padding:11px 10px;font-size:16px;font-weight:800;color:#ffffff;background-color:${accent};white-space:nowrap;`;
  h += `<tr><td style="${tt}">${title} Total</td><td style="${tt}text-align:right;">${money(total.cur)}</td><td style="${tt}text-align:right;">${total.invoices}</td>
    <td style="${tt}text-align:right;">${money(total.prev)}</td><td style="${tt}text-align:right;">${Math.abs(total.prev) < 0.5 ? "" : `${total.cur >= total.prev ? "&#9650;" : "&#9660;"} ${Math.abs(((total.cur - total.prev) / Math.abs(total.prev)) * 100).toFixed(0)}%`}</td>
    <td style="${tt}text-align:right;">${money(total.fy)}</td></tr></table>`;
  return h;
}

export function renderMetromartEmail(data, { recipientName = "Nish", southError = null } = {}) {
  const { period: p, north, south, northTotal: nt, southTotal: st } = data;
  const all = southError ? nt.cur : nt.cur + st.cur;
  const kindWord = p.kind === "week" ? "Weekly" : "Monthly";
  const subject = `${kindWord} Metromart Report: North vs South Island (${p.label})`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${BG};font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="760" cellpadding="0" cellspacing="0" style="max-width:760px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;">
  <tr><td style="background-color:${BRAND_DARK};background-image:linear-gradient(135deg,${BRAND} 0%,${BRAND_DARK} 100%);padding:30px 32px;color:#ffffff;">
    <div style="display:inline-block;background:#ffffff;color:${BRAND_DARK};font-size:13px;font-weight:800;padding:4px 12px;border-radius:999px;letter-spacing:.5px;">WORTHY PRODUCTS &middot; DUTCH RUSK</div>
    <h1 style="margin:14px 0 6px;font-size:30px;line-height:1.2;color:#ffffff;">${kindWord} Metromart Report</h1>
    <div style="font-size:17px;color:#ffffff;">${esc(p.label)} &middot; North Island vs South Island</div>
    <div style="font-size:40px;font-weight:800;margin-top:14px;color:#ffffff;">${money(all)}</div>
    <div style="font-size:15px;color:#ffffff;">${southError ? "Metromart sales, North Island only (South Island missing, see below), excl GST" : "Metromart sales, both islands, excl GST"}</div>
  </td></tr>
  <tr><td style="padding:22px 26px 6px;font-size:17px;line-height:1.55;color:${MUTED};">
    Hi ${esc(recipientName)},<br><br>Here is Metromart invoiced sales for <strong style="color:${INK};">${esc(p.label)}</strong>, North Island (Worthy Products) next to South Island (Dutch Rusk), compared with ${p.kind === "week" ? "the previous week" : esc(p.prevLabel)} and the financial year to date (${esc(p.fyLabel)}).
  </td></tr>
  <tr><td style="padding:8px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${kpi("North Island", money(nt.cur), `${nt.ordered} of ${nt.stores} stores &middot; ${change(nt.cur, nt.prev)}`, BRAND)}
    ${southError ? kpi("South Island", `<span style="font-size:20px;">Not available</span>`, "Ostendo was down when this ran", "#f59e0b") : kpi("South Island", money(st.cur), `${st.ordered} of ${st.stores} stores &middot; ${change(st.cur, st.prev)}`, "#f59e0b")}
    ${southError ? kpi("FY to Date (North)", money(nt.fy), esc(p.fyLabel), GOOD) : kpi("FY to Date", money(nt.fy + st.fy), `North ${money(nt.fy)} &middot; South ${money(st.fy)}`, GOOD)}
  </tr></table></td></tr>
  <tr><td style="padding:0 26px 10px;">
    ${storeTable("North Island", "Worthy Products, invoiced in Odoo", north, nt, p, BRAND_DARK)}
    ${southError
      ? `<div style="margin-top:26px;padding:16px 18px;border-radius:12px;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-size:16px;line-height:1.5;"><strong>South Island figures are missing from this report.</strong> The connection to Dutch Rusk's Ostendo system was down when it ran, so only North Island is shown. They will be in next ${p.kind === "week" ? "week's" : "month's"} report, or ask Pratham for them now.</div>`
      : storeTable("South Island", "Dutch Rusk, invoiced in Ostendo", south, st, p, "#92400e")}
  </td></tr>
  <tr><td style="padding:18px 26px 26px;font-size:14px;line-height:1.6;color:${SOFT};border-top:1px solid ${LINE};">
    Sales are invoiced sales excluding GST, less credit notes. North Island counts product lines only (freight and other charges left out). Stores marked "No order" were not invoiced in this period.
    South Island lists every Metromart invoiced by Dutch Rusk this financial year.<br>Automated report &middot; Jira SUP-45
  </td></tr>
  </table></td></tr></table></body></html>`;

  const lines = (rows) => rows.map((r) => `  ${r.name}: ${money(r.cur)} (${r.invoices} inv) | prev ${money(r.prev)} | FY ${money(r.fy)}`).join("\n");
  const text = `${subject}\n\nNorth Island: ${money(nt.cur)} (${nt.ordered}/${nt.stores} stores)\n${lines(north)}\n\nSouth Island: ${money(st.cur)} (${st.ordered}/${st.stores} stores)\n${lines(south)}\n\nFY to date: ${money(nt.fy + st.fy)}`;
  return { subject, html, text };
}

// ── Send + schedule ─────────────────────────────────────────────────────────
//
// Weekly: Sunday from 4pm NZ (catch-up all Monday, e.g. after a restart).
// Monthly: the 1st from 8am NZ (catch-up all of the 2nd).
// Recipients come from METROMART_REPORT_TO (comma-separated). If it is not
// set, nothing is scheduled. METROMART_REPORT_TIMER=off disables the timer.
//
// Each report claims a ReportSendLog key before sending, so two processes or
// a restart can never send it twice. If Ostendo (South Island) is down the
// claim is released and the next tick retries; late on the catch-up day the
// report goes out with North only and a clear note, rather than not at all.

export async function sendMetromartReport(kind, { to, now = new Date(), allowSouthFailure = false } = {}) {
  let data;
  let southError = null;
  try {
    data = await buildMetromartData(kind, now);
  } catch (err) {
    if (!allowSouthFailure || !/Ostendo/i.test(String(err?.message))) throw err;
    southError = String(err.message);
    data = await buildMetromartData(kind, now, { skipSouth: true });
  }
  const email = renderMetromartEmail(data, { southError });
  const { sendReportEmail } = await import("./brevo.server");
  await sendReportEmail({ to, subject: email.subject, htmlBody: email.html, textBody: email.text, tags: ["metromart-report"] });
  return { subject: email.subject, period: data.period, northTotal: data.northTotal, southTotal: data.southTotal, southError };
}

function dueReport(now = new Date()) {
  const t = nzNow(now);
  const due = [];
  if ((t.dow === 0 && t.hour >= 16) || t.dow === 1) due.push({ kind: "week", lastChance: t.dow === 1 && t.hour >= 18 });
  if ((t.d === 1 && t.hour >= 8) || t.d === 2) due.push({ kind: "month", lastChance: t.d === 2 && t.hour >= 18 });
  return due;
}

export async function runMetromartSchedule(now = new Date()) {
  const to = process.env.METROMART_REPORT_TO;
  if (!to) return;
  const { default: prisma } = await import("../db.server");
  for (const { kind, lastChance } of dueReport(now)) {
    const p = reportPeriods(kind, now);
    const key = `metromart-${kind}-${p.start}`;
    let claimed = false;
    try {
      // Claim first. A unique-key clash means it was already sent (or is being sent).
      await prisma.reportSendLog.create({ data: { key, recipient: to } });
      claimed = true;
      const r = await sendMetromartReport(kind, { to, now, allowSouthFailure: lastChance });
      await prisma.reportSendLog.update({ where: { key }, data: { status: "sent", note: r.southError ? `South missing: ${r.southError}` : null } });
      console.log(`[metromart-report] sent ${key} to ${to}`);
    } catch (err) {
      if (err?.code === "P2002") continue; // already claimed
      console.error(`[metromart-report] ${key} failed, will retry:`, err?.message ?? err);
      if (claimed) await prisma.reportSendLog.delete({ where: { key } }).catch(() => {});
    }
  }
}

let timerStarted = false;
export function startMetromartReportTimer() {
  if (timerStarted || process.env.METROMART_REPORT_TIMER === "off") return;
  timerStarted = true;
  const tick = () => runMetromartSchedule().catch((e) => console.error("[metromart-report] tick:", e?.message ?? e));
  setTimeout(tick, 60_000);
  const handle = setInterval(tick, 15 * 60_000);
  if (typeof handle.unref === "function") handle.unref();
  console.log("[metromart-report] timer started, every 15 min");
}
