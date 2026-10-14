// Default-subscribe sweep. Dutch Rusk has verbal marketing consent from every customer, but new
// customers arrive in Shopify as NOT_SUBSCRIBED (Ostendo push default) and Brevo then blacklists them.
// Every few minutes this flips NOT_SUBSCRIBED customers with an email to SUBSCRIBED and clears the
// matching Brevo blacklist. UNSUBSCRIBED (a real opt-out) is never touched, and neither is anyone who
// clicked unsubscribe in Brevo. Runs inside the web service like the pricing health timer.

const API = "https://api.brevo.com/v3";
const VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || "2026-07";

export async function runConsentSweep(source = "timer") {
  try {
    const { getAdminToken } = await import("./admin-token.server");
    const session = await getAdminToken();
    const gql = async (query, variables) => {
      const res = await fetch(`https://${session.shop}/admin/api/${VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
        body: JSON.stringify({ query, variables }),
      });
      return JSON.parse(await res.text());
    };
    const key = process.env.BREVO_API_KEY;
    let fixed = 0, brevoCleared = 0, skipped = 0, after = null;
    for (;;) {
      const r = await gql(
        `query($after:String){customers(first:100,after:$after,query:"email_subscription_status:not_subscribed"){pageInfo{hasNextPage endCursor}nodes{id email emailMarketingConsent{marketingState}}}}`,
        { after },
      );
      if (!r.data) throw new Error(JSON.stringify(r.errors || r).slice(0, 200));
      for (const c of r.data.customers.nodes) {
        if (!c.email || c.emailMarketingConsent?.marketingState !== "NOT_SUBSCRIBED") continue;
        let clickedUnsub = false;
        if (key) {
          const d = await fetch(`${API}/contacts/${encodeURIComponent(c.email)}`, { headers: { "api-key": key, accept: "application/json" } });
          if (d.ok) { const st = (await d.json()).statistics || {}; clickedUnsub = !!(st.unsubscriptions?.userUnsubscription?.length || st.hardBounces?.length); }
        }
        if (clickedUnsub) { skipped++; continue; }
        const m = await gql(
          `mutation($i:CustomerEmailMarketingConsentUpdateInput!){customerEmailMarketingConsentUpdate(input:$i){userErrors{message}}}`,
          { i: { customerId: c.id, emailMarketingConsent: { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" } } },
        );
        if (m.data?.customerEmailMarketingConsentUpdate?.userErrors?.length) continue;
        fixed++;
        if (key) {
          const p = await fetch(`${API}/contacts/${encodeURIComponent(c.email)}`, {
            method: "PUT", headers: { "api-key": key, "content-type": "application/json" }, body: JSON.stringify({ emailBlacklisted: false }),
          });
          if (p.ok || p.status === 204) brevoCleared++;
        }
      }
      if (!r.data.customers.pageInfo.hasNextPage) break;
      after = r.data.customers.pageInfo.endCursor;
    }
    if (fixed || skipped) console.log(`[consent-default] ${source}: subscribed ${fixed}, brevo cleared ${brevoCleared}, kept ${skipped}`);
    return { fixed, brevoCleared, skipped };
  } catch (err) {
    console.error("[consent-default] failed:", err?.message ?? err);
    return { error: String(err?.message ?? err) };
  }
}

let started = false;
export function startConsentSweepTimer() {
  if (started || process.env.CONSENT_SWEEP_TIMER === "off") return;
  started = true;
  const minutes = Number(process.env.CONSENT_SWEEP_INTERVAL_MIN || 10);
  console.log(`[consent-default] timer started, every ${minutes} min`);
  setTimeout(() => { runConsentSweep("startup"); }, 60_000);
  const h = setInterval(() => { runConsentSweep("timer"); }, minutes * 60_000);
  if (typeof h.unref === "function") h.unref();
}
