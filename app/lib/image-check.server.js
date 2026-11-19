// Weekly product image check.
//
// Every live (ACTIVE) Dutch Rusk product should have an image that is a PNG,
// exactly 500x500, on white (standard since July 2026; all 1,780 live products
// were brought to it on 20 Nov 2026). New products arrive from Ostendo with no
// image, or with whatever photo was to hand, so once a week this lists every
// live product that is missing an image or is off-spec and emails it.
//
// Schedule: Monday from 08:00 NZ (any tick that day). One email per week,
// claimed in ReportSendLog so a restart or two instances never send twice.
// Nothing is sent when every live product is fine.
//
// Env: IMAGE_ALERT_TO (comma list), else PRICING_ALERT_EMAIL. IMAGE_CHECK=off
// stops it. Sending uses Brevo, like the other reports. Read-only on Shopify.
// See docs/PRODUCT-IMAGES.md.

const VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-04";
const TAG = "[image-check]";
const STORE_ADMIN = "https://admin.shopify.com/store/dutchrusk/products/";

export function imageIssue(product) {
  const imgs = product.media.nodes.filter((n) => n.mediaContentType === "IMAGE");
  if (!imgs.length) return "No image";
  const m = imgs[0];
  if (!m.image) return m.status === "FAILED" ? "Image failed to process" : null; // still processing: check next week
  const { width, height } = m.image;
  if (width !== 500 || height !== 500 || m.mimeType !== "image/png") {
    return `Wrong size/format (${width}x${height} ${String(m.mimeType || "").replace("image/", "")})`;
  }
  return null;
}

export async function findImageIssues() {
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

  const issues = [];
  let checked = 0;
  let after = null;
  do {
    const d = await gql(
      `query($after:String){products(first:100,after:$after,query:"status:active"){pageInfo{hasNextPage endCursor} nodes{id title createdAt totalInventory variants(first:1){nodes{sku}} media(first:3){nodes{mediaContentType status ... on MediaImage{mimeType image{width height}}}}}}}`,
      { after },
    );
    for (const p of d.products.nodes) {
      checked++;
      const issue = imageIssue(p);
      if (issue) {
        issues.push({
          sku: p.variants.nodes[0]?.sku || "",
          title: p.title,
          stock: p.totalInventory ?? 0,
          issue,
          isNew: Date.now() - Date.parse(p.createdAt) < 8 * 864e5,
          link: STORE_ADMIN + p.id.split("/").pop(),
        });
      }
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);

  issues.sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.stock - a.stock);
  return { checked, issues };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderImageEmail({ checked, issues }) {
  const fresh = issues.filter((i) => i.isNew).length;
  const subject = `Dutch Rusk product images: ${issues.length} need attention${fresh ? ` (${fresh} new this week)` : ""}`;
  const row = (i) =>
    `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${i.isNew ? "<b>NEW</b> " : ""}${esc(i.sku)}</td>` +
    `<td style="padding:6px 8px;border-bottom:1px solid #eee"><a href="${i.link}">${esc(i.title)}</a></td>` +
    `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${i.stock}</td>` +
    `<td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(i.issue)}</td></tr>`;
  const html =
    `<div style="font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#222">` +
    `<p>${issues.length} of ${checked} live products need an image fixed. Standard: PNG, exactly 500x500, white background.</p>` +
    `<table style="border-collapse:collapse;font-size:13px"><tr style="background:#f5f5f5">` +
    `<th style="padding:6px 8px;text-align:left">SKU</th><th style="padding:6px 8px;text-align:left">Product</th>` +
    `<th style="padding:6px 8px;text-align:right">Stock</th><th style="padding:6px 8px;text-align:left">Issue</th></tr>` +
    issues.map(row).join("") +
    `</table></div>`;
  const text =
    `${issues.length} of ${checked} live products need an image fixed (PNG, 500x500, white).\n\n` +
    issues.map((i) => `${i.isNew ? "NEW " : ""}${i.sku} | ${i.title} | stock ${i.stock} | ${i.issue} | ${i.link}`).join("\n");
  return { subject, html, text };
}

/** Monday 00:00 NZ of the week `now` falls in, as YYYY-MM-DD (the send-log key). */
function weekKey(now, nzNow) {
  const t = nzNow(now);
  const back = (t.dow + 6) % 7; // days since Monday
  const d = new Date(Date.UTC(t.y, t.m - 1, t.d - back));
  return d.toISOString().slice(0, 10);
}

export async function runImageCheckSchedule(now = new Date()) {
  const to = process.env.IMAGE_ALERT_TO || process.env.PRICING_ALERT_EMAIL;
  if (!to) return;
  const { nzNow } = await import("./metromart-report.server");
  const t = nzNow(now);
  if (t.dow !== 1 || t.hour < 8) return; // Mondays from 08:00 NZ
  const { default: prisma } = await import("../db.server");
  const key = `image-check-${weekKey(now, nzNow)}`;
  let claimed = false;
  try {
    await prisma.reportSendLog.create({ data: { key, recipient: to } });
    claimed = true;
    console.log(`${TAG} ${key}: start`);
    const result = await findImageIssues();
    if (!result.issues.length) {
      await prisma.reportSendLog.update({ where: { key }, data: { status: "sent", note: `all ${result.checked} fine, no email` } });
      console.log(`${TAG} ${key}: all ${result.checked} live products fine, no email`);
      return;
    }
    const email = renderImageEmail(result);
    const { sendReportEmail } = await import("./brevo.server");
    await sendReportEmail({ to, subject: email.subject, htmlBody: email.html, textBody: email.text, tags: ["image-check"] });
    await prisma.reportSendLog.update({ where: { key }, data: { status: "sent", note: `${result.issues.length} of ${result.checked}` } });
    console.log(`${TAG} ${key}: sent, ${result.issues.length} of ${result.checked} need attention`);
  } catch (err) {
    if (err?.code === "P2002") return; // already sent this week
    console.error(`${TAG} ${key} failed, will retry:`, err?.message ?? err);
    if (claimed) await prisma.reportSendLog.delete({ where: { key } }).catch(() => {});
  }
}

let started = false;
export function startImageCheckTimer() {
  if (started || process.env.IMAGE_CHECK === "off") return;
  started = true;
  const tick = () => runImageCheckSchedule().catch((e) => console.error(`${TAG} tick:`, e?.message ?? e));
  setTimeout(tick, 120_000);
  const h = setInterval(tick, 30 * 60_000);
  if (typeof h.unref === "function") h.unref();
  console.log(`${TAG} timer started, Mondays from 08:00 NZ`);
}
