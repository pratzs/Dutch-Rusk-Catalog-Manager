// Online trade account application (public, called from the storefront form).
//
// POST /api/trade-application   body: JSON { brand, ...answers, signatures }
//   -> 200 { ok: true }
//   -> 422 { ok: false, errors: { field: message } }  when answers are missing
//   -> 429 when one visitor sends too many, 403 from an unknown site
//
// The brand (Worthy Products or Dutch Rusk) is decided by the site the
// request comes from, never by the request body.
// It fills the team's own PDF forms (app/lib/trade-forms.server.js), emails
// both PDFs to the brand's team address, and sends the applicant a copy.
// Nothing is saved: bank details exist only in the emailed PDFs.
//
// The storefront posts with content-type text/plain so the browser sends no
// CORS preflight; OPTIONS is answered anyway for clients that do.

import { BRANDS, validateApplication, buildApplicationPdfs, summaryRows } from "../lib/trade-forms.server.js";

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const MAX_BODY = 1_800_000; // four signature images plus the answers
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map(); // ip -> [timestamps]; resets when the server restarts

function brandForOrigin(origin) {
  return Object.entries(BRANDS).find(([, b]) => b.origins.includes(origin)) ?? null;
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(origin ? cors(origin) : {}) },
  });
}

function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  return false;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function emailHtml({ heading, intro, rows, footer, accent }) {
  const tr = rows.map(([k, v]) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555;width:220px;vertical-align:top">${esc(k)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#111">${esc(v)}</td></tr>`).join("");
  return `<div style="background:#f5f6f8;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:10px;padding:28px">
<h1 style="font-size:20px;margin:0 0 8px;color:${accent || "#2156C3"}">${esc(heading)}</h1>
<p style="margin:0 0 18px;color:#333">${intro}</p>
<table style="border-collapse:collapse;width:100%">${tr}</table>
<p style="margin:18px 0 0;color:#666;font-size:13px">${footer}</p>
</div></div>`;
}

async function send({ brand, to, replyTo, subject, html, files, tag }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("BREVO_API_KEY missing");
  const resp = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: brand.senderEmail, name: brand.senderName },
      to: [{ email: to }],
      replyTo: { email: replyTo },
      subject,
      htmlContent: html,
      attachment: files.map((f) => ({ name: f.name, content: f.content.toString("base64") })),
      tags: [tag],
    }),
  });
  if (!resp.ok) throw new Error(`Brevo ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
}

export const loader = async ({ request }) => {
  const origin = request.headers.get("origin") || "";
  if (request.method === "OPTIONS" && brandForOrigin(origin)) return new Response(null, { status: 204, headers: cors(origin) });
  return reply({ error: "method" }, 405);
};

export const action = async ({ request }) => {
  const origin = request.headers.get("origin") || "";
  const match = brandForOrigin(origin);
  if (request.method === "OPTIONS") return match ? new Response(null, { status: 204, headers: cors(origin) }) : reply({ error: "origin" }, 403);
  if (!match) return reply({ error: "origin" }, 403);
  if (request.method !== "POST") return reply({ error: "method" }, 405, origin);
  const [brandKey, brand] = match;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply({ ok: false, error: "too_large" }, 413, origin);
    let input;
    try { input = JSON.parse(raw); } catch { return reply({ ok: false, error: "bad_json" }, 400, origin); }

    // Honeypot: a hidden field people never fill in. Bots do; tell them it worked.
    if (typeof input?.website === "string" && input.website.trim()) return reply({ ok: true }, 200, origin);

    const { ok, errors, data } = validateApplication(input, brandKey);
    if (!ok) return reply({ ok: false, errors }, 422, origin);

    const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    if (tooMany(ip)) return reply({ ok: false, error: "rate_limited" }, 429, origin);

    const { files, date } = await buildApplicationPdfs(brandKey, data);
    const rows = summaryRows(brandKey, data);

    await send({
      brand, to: brand.teamEmail, replyTo: data.email, files, tag: "trade_application",
      subject: `New trade account application: ${data.companyName}`,
      html: emailHtml({
        accent: brand.accent,
        heading: `New trade account application`,
        intro: `<strong>${esc(data.companyName)}</strong> applied online on ${esc(date.text)}. The signed application form and Direct Debit Authority are attached.`,
        rows,
        footer: `Sent from the online form on ${esc(origin.replace("https://", ""))}. Reply to this email to contact the applicant.`,
      }),
    });

    // The applicant's copy. The team already has theirs, so a failure here
    // must not tell the applicant their application was lost.
    try {
      await send({
        brand, to: data.email, replyTo: brand.teamEmail, files, tag: "trade_application_copy",
        subject: `We've received your ${brand.label} account application`,
        html: emailHtml({
          accent: brand.accent,
          heading: `Thanks, we've received your application`,
          intro: `Thank you for applying for a trade account with ${esc(brand.label)}. A copy of your signed forms is attached for your records. Our team will be in touch shortly.`,
          rows,
          footer: `Questions? Reply to this email or call ${esc(brand.phone)}.`,
        }),
      });
    } catch (err) {
      console.error("[trade-application] applicant copy failed:", err?.message ?? err);
    }

    console.log(`[trade-application] ${brandKey} application sent for "${data.companyName}"`);
    return reply({ ok: true }, 200, origin);
  } catch (err) {
    console.error("[trade-application] failed:", err?.message ?? err);
    return reply({ ok: false, error: "server" }, 500, origin);
  }
};
