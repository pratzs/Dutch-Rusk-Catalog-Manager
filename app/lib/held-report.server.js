// The "catalog prices on hold" email, written for people who do not live in the
// app: plain words, one job per group, one table per job. Built from the
// HeldPriceRow table (see catalog-reprice.server.js). Pure functions so it can be
// previewed without sending.
import { cleanPct } from "./catalog-reprice.server.js";

const NAVY = "#181344";
const GOLD = "#FDB714";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => (n === null || n === undefined ? "none" : "$" + Number(n).toFixed(2));
const niceList = (n) => n.replace(/ - [0-9a-f-]{36}$/, "").replace(/^General Catalog$/, "General");
const split = (label) => {
  const i = label.lastIndexOf(" | ");
  return i < 0 ? [label, ""] : [label.slice(0, i), label.slice(i + 3)];
};
const wholeCase = (r) => /40% under retail/.test(r.reason);

const th = `style="text-align:left;font:600 12px Arial,sans-serif;color:#6b6b7b;padding:8px 10px;border-bottom:2px solid #eceaf2;"`;
const td = `style="font:14px/1.4 Arial,sans-serif;color:#222;padding:10px;border-bottom:1px solid #f0eef5;vertical-align:top;"`;
const tdr = `style="font:14px/1.4 Arial,sans-serif;color:#222;padding:10px;border-bottom:1px solid #f0eef5;vertical-align:top;white-space:nowrap;"`;

function table(headers, rows) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:12px 0 4px;">
<tr>${headers.map((h) => `<th ${th}>${h}</th>`).join("")}</tr>
${rows.map((cells) => `<tr>${cells.map((c, i) => `<td ${i === 0 ? td : tdr}>${c}</td>`).join("")}</tr>`).join("\n")}
</table>`;
}

const product = (r) => {
  const [name, pack] = split(r.label);
  return `<strong>${esc(name)}</strong>${pack ? `<br><span style="color:#6b6b7b;font-size:12px;">${esc(pack)}</span>` : ""}`;
};

function byList(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = niceList(r.priceListName);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()];
}

function card(num, title, body) {
  return `<div style="border:1px solid #eceaf2;border-radius:12px;padding:20px 22px;margin:18px 0;background:#fff;">
<table role="presentation" cellspacing="0" cellpadding="0"><tr>
<td style="vertical-align:top;padding-right:12px;"><div style="width:34px;height:34px;line-height:34px;border-radius:17px;background:${NAVY};color:#fff;text-align:center;font:700 16px Arial,sans-serif;">${num}</div></td>
<td style="vertical-align:middle;font:700 18px/1.3 Arial,sans-serif;color:${NAVY};">${title}</td></tr></table>
${body}</div>`;
}

const p = (t, extra = "") => `<p style="font:15px/1.6 Arial,sans-serif;color:#333;margin:12px 0;${extra}">${t}</p>`;
const listHead = (name) => `<p style="font:700 13px Arial,sans-serif;color:${NAVY};margin:18px 0 0;text-transform:uppercase;letter-spacing:.5px;">${esc(name)} catalog</p>`;

const steps = (items) => `<ol style="font:15px/1.65 Arial,sans-serif;color:#333;margin:10px 0 6px;padding-left:22px;">${items.map((i) => `<li style="margin:6px 0;">${i}</li>`).join("")}</ol>`;

/** The price the website should show if Ostendo's new retail is correct: same % off as before. */
function targetPrice(r) {
  if (!(r.retailAtHold > 0) || !r.lastCompareAt) return null;
  const pct = cleanPct(r.fixedAtHold, r.lastCompareAt);
  return pct === null ? null : Math.round(r.retailAtHold * (1 - pct / 100) * 100) / 100;
}

/** @param rows HeldPriceRow[]  @returns {{subject, html, text, count}|null} */
export function buildHeldEmail(rows) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.label.localeCompare(b.label));
  const deepRows = sorted.filter(wholeCase);
  const retailRows = sorted.filter((r) => !wholeCase(r));
  const n = rows.length;

  let jobs = "";
  if (retailRows.length) {
    const body =
      p(`For these products the <strong>retail price in Ostendo suddenly jumped or dropped</strong>. That is often a typing mistake, like a missing digit or the price of a different pack size. Please do these steps for <strong>each product</strong> in the tables below.`) +
      steps([
        `Open <strong>Ostendo</strong> and find the product (use the name and pack size in the table).`,
        `Look at its <strong>retail (selling) price</strong>. Compare it with <em>Ostendo used to say</em> in the table.`,
        `<strong>If the new Ostendo price is a mistake:</strong> type the correct price and save. That is all. The website puts the crossed-out price back by itself overnight.`,
        `<strong>If the new Ostendo price is correct</strong> (a real price change): leave Ostendo alone and change the website price instead. Open <strong>Shopify admin</strong>, then <strong>Catalogs</strong>, open the catalog named in the table, click <strong>Edit prices</strong>, search for the product, type the amount from the last column (<em>Set website price to</em>) and save. The crossed-out price comes back overnight.`,
      ]) +
      byList(retailRows).map(([list, rs]) =>
        listHead(list) +
        table(["Product", "Customers pay", "Ostendo used to say", "Ostendo says now", "Set website price to (only if Ostendo is right)"], rs.map((r) => {
          const tp = targetPrice(r);
          return [
            product(r),
            money(r.fixedAtHold),
            r.lastCompareAt ? money(r.lastCompareAt) : "n/a",
            r.retailAtHold > 0 ? `<strong style="color:#B13924;">${money(r.retailAtHold)}</strong>` : `<strong style="color:#B13924;">$0.00 (no price set)</strong>`,
            r.retailAtHold > 0 ? (tp !== null ? `<strong>${money(tp)}</strong>` : "keep the same") : "Ostendo needs a price first",
          ];
        })),
      ).join("");
    jobs += card(1, `Check ${retailRows.length} retail price${retailRows.length === 1 ? "" : "s"} in Ostendo`, body);
  }
  if (deepRows.length) {
    const body =
      p(`For these products the <strong>website price is much lower than Ostendo's retail price</strong> (more than 40% lower). That is fine if it is a special deal on purpose. It is a problem if it is a typing mistake.`) +
      steps([
        `Look at the table: what customers pay now, and what Ostendo's retail price is.`,
        `<strong>If the website price is on purpose:</strong> you do not need to do anything.`,
        `<strong>If the website price is a mistake:</strong> open <strong>Shopify admin</strong>, then <strong>Catalogs</strong>, open the catalog named in the table, click <strong>Edit prices</strong>, search for the product, type the correct price and save. Its crossed-out price comes back overnight.`,
      ]) +
      byList(deepRows).map(([list, rs]) =>
        listHead(list) +
        table(["Product", "Customers pay now", "Ostendo retail price"], rs.map((r) => [
          product(r), money(r.fixedAtHold), `<strong>${money(r.retailAtHold)}</strong>`,
        ])),
      ).join("");
    jobs += card(retailRows.length ? 2 : 1, `Double-check ${deepRows.length} deal price${deepRows.length === 1 ? "" : "s"}`, body);
  }

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#FAF8F5;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FAF8F5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;">
<tr><td style="padding:0 4px 14px;font:700 13px Arial,sans-serif;color:${NAVY};letter-spacing:1px;text-transform:uppercase;">Dutch Rusk &middot; Website prices</td></tr>
<tr><td style="background:#fff;border-radius:14px;box-shadow:0 4px 12px rgba(0,0,0,.04);overflow:hidden;">
<div style="height:6px;background:${GOLD};"></div>
<div style="padding:28px 26px 22px;">
<h1 style="font:700 26px/1.25 Arial,sans-serif;color:${NAVY};margin:0 0 6px;">${n} price${n === 1 ? "" : "s"} need a quick look</h1>
<p style="font:15px/1.5 Arial,sans-serif;color:#6b6b7b;margin:0 0 18px;">A short job for whoever looks after prices in Ostendo.</p>

<div style="background:#FFF8E5;border-radius:10px;padding:16px 18px;margin:0 0 6px;">
<p style="font:700 15px Arial,sans-serif;color:${NAVY};margin:0 0 6px;">What is this about?</p>
<p style="font:15px/1.6 Arial,sans-serif;color:#333;margin:0;">Our website shows a price, and sometimes a crossed-out &ldquo;was&rdquo; price next to it. The system checks that these match what Ostendo says. For <strong>${n} products</strong> the numbers did not make sense, so the system <strong>stopped and did not guess</strong>.</p>
</div>
${p(`<strong>Nothing is broken and no customer was overcharged.</strong> Customers pay the same price as before. We only hid the crossed-out &ldquo;was&rdquo; price on these products, so nobody sees a wrong one.`)}

${jobs}

<div style="border-radius:12px;background:#F5F5F7;padding:18px 22px;margin:18px 0 0;">
<p style="font:700 16px Arial,sans-serif;color:${NAVY};margin:0 0 8px;">What happens after you fix one?</p>
<p style="font:15px/1.6 Arial,sans-serif;color:#333;margin:0;">Nothing else to do. The system checks again every night around 3am (and sends this email once a week, on Monday). When a product is fixed, its crossed-out price comes back on its own and it drops off this list. This email stops when the list is empty.</p>
</div>

<p style="font:15px/1.6 Arial,sans-serif;color:#333;margin:22px 0 0;">Stuck on one? Message Pratham at <a href="mailto:pratham@worthy.nz" style="color:${NAVY};font-weight:700;">pratham@worthy.nz</a>.</p>
</div></td></tr>
<tr><td align="center" style="padding:16px 8px;font:12px Arial,sans-serif;color:#8a8a99;">Sent automatically by the Dutch Rusk catalog pricing check.</td></tr>
</table></td></tr></table></body></html>`;

  const t = (r) => `  ${niceList(r.priceListName)}: ${r.label}\n      customers pay ${money(r.fixedAtHold)}, Ostendo says ${money(r.retailAtHold)}${r.lastCompareAt ? `, used to say ${money(r.lastCompareAt)}` : ""}${targetPrice(r) !== null ? `, set website price to ${money(targetPrice(r))} if Ostendo is right` : ""}`;
  const text = [
    `${n} website price(s) need a quick look.`,
    "",
    "Nothing is broken and no customer was overcharged. For these products the numbers from Ostendo did not make sense, so the system stopped and did not guess. We only hid the crossed-out 'was' price so nobody sees a wrong one.",
    "",
    ...(retailRows.length ? [
      `JOB 1: Check ${retailRows.length} retail price(s) in Ostendo. For each product:`,
      "  1. Open Ostendo and find the product.",
      "  2. Look at the retail price and compare it with what it used to say.",
      "  3. If the new Ostendo price is a mistake, type the correct price and save. The website fixes itself overnight.",
      "  4. If the new Ostendo price is correct, leave Ostendo alone. In Shopify admin go to Catalogs, open the catalog, Edit prices, search the product, type the 'set website price to' amount and save.",
      ...retailRows.map(t), ""] : []),
    ...(deepRows.length ? [
      `JOB ${retailRows.length ? 2 : 1}: Double-check ${deepRows.length} deal price(s). Website price is more than 40% under Ostendo retail.`,
      "  If it is on purpose, do nothing. If it is a mistake, in Shopify admin go to Catalogs, open the catalog, Edit prices, search the product, type the correct price and save.",
      ...deepRows.map(t), ""] : []),
    "The system checks again every night around 3am and sends this email once a week (Monday). Fixed products drop off this list. Stuck? Message pratham@worthy.nz",
  ].join("\n");

  return { count: n, subject: `Dutch Rusk website prices: ${n} need a quick check`, html, text };
}
