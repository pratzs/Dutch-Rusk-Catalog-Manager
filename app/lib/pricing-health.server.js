// Continuous guard on the two things that must always be true for a B2B order
// to show its saving, and self-healing when one of them breaks.
//
// Why this exists: catalog pricing here is produced by a PAIR of Functions —
// b2b-price-transformer raises each line to retail, and the "B2B Wholesale
// Custom Pricing" product discount brings it back to the catalog price. The gap
// between them is the struck-through "was" price and the "B2B Wholesale Price"
// rows the business runs on. If either half stops:
//
//   transform missing, discount active  -> correct price, NO strikethrough
//   transform active, discount inactive -> buyer OVERCHARGED at full retail
//
// The second is what happened on 2 Sept 2026 (orders #1867-#1870) and it went
// unnoticed for roughly 15 hours. The orders/create webhook now catches both,
// but only AFTER an order exists. At hundreds of orders a day that is too late,
// so this runs on a timer and puts the pair back itself.
//
// Set PRICING_SELF_HEAL=off to make this report without changing anything.

const ADMIN_API_VERSION = "2026-04";

// The transform's Function. Overridable in case the extension is ever
// re-created with a new id.
const EXPECTED_FUNCTION_ID =
  process.env.CART_TRANSFORM_FUNCTION_ID || "019e4e0e-301d-71db-9c05-72b75bac5e39";
const WHOLESALE_DISCOUNT_TITLE = "B2B Wholesale Custom Pricing";

async function adminClient() {
  const { default: prisma } = await import("../db.server");
  const session = await prisma.session.findFirst({
    where: { isOnline: false, accessToken: { not: "" } },
    orderBy: { id: "desc" },
  });
  if (!session?.accessToken) throw new Error("no offline session available");

  return async function gql(query, variables = {}) {
    const res = await fetch(`https://${session.shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 500));
    return json.data;
  };
}

/**
 * Inspect the pricing pair and, unless disabled, repair it.
 * Never throws for a business problem — it reports. Only infrastructure
 * failures (no session, Shopify unreachable) propagate.
 */
export async function checkAndHealPricing({ heal = true } = {}) {
  const selfHealEnabled = heal && process.env.PRICING_SELF_HEAL !== "off";
  const gql = await adminClient();

  const ok = [];
  const healed = [];
  const problems = [];

  // ── 1. The cart transform must be registered, exactly once ────────────────
  const ctData = await gql(`{ cartTransforms(first: 10) { nodes { id functionId blockOnFailure } } }`);
  const transforms = ctData.cartTransforms?.nodes ?? [];

  if (transforms.length === 0) {
    // Without this nothing raises a line, so no order can show a discount row.
    if (!selfHealEnabled) {
      problems.push("cart transform is NOT registered — orders will show no discount rows (self-heal disabled)");
    } else {
      const created = await gql(
        `mutation Heal($fn: String!) {
          cartTransformCreate(functionId: $fn, blockOnFailure: false) {
            cartTransform { id functionId }
            userErrors { field message code }
          }
        }`,
        { fn: EXPECTED_FUNCTION_ID }
      );
      const errs = created.cartTransformCreate?.userErrors ?? [];
      if (errs.length) {
        problems.push(`cart transform was missing and could NOT be recreated: ${JSON.stringify(errs)}`);
      } else {
        healed.push(`cart transform was missing — recreated as ${created.cartTransformCreate.cartTransform.id}`);
        // Belt and braces: a misread of the query above must never be able to
        // leave two transforms registered, which would change pricing.
        const after = await gql(`{ cartTransforms(first: 10) { nodes { id } } }`);
        const count = after.cartTransforms?.nodes?.length ?? 0;
        if (count !== 1) {
          problems.push(`after recreating, ${count} cart transforms are registered — expected 1. Remove the extras in Admin immediately.`);
        }
      }
    }
  } else if (transforms.length > 1) {
    // Deleting the wrong one would change pricing, so this needs a human.
    problems.push(`${transforms.length} cart transforms registered, expected 1: ${transforms.map((t) => t.id).join(", ")}`);
  } else if (transforms[0].functionId !== EXPECTED_FUNCTION_ID) {
    problems.push(`cart transform points at an unexpected function ${transforms[0].functionId} (expected ${EXPECTED_FUNCTION_ID})`);
  } else {
    ok.push(`cart transform registered (${transforms[0].id})`);
  }

  // ── 2. The wholesale discount must be ACTIVE ──────────────────────────────
  const dnData = await gql(`{
    discountNodes(first: 50) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticApp { title status }
        }
      }
    }
  }`);
  const wholesale = (dnData.discountNodes?.nodes ?? []).find(
    (n) => n.discount?.title === WHOLESALE_DISCOUNT_TITLE
  );

  if (!wholesale) {
    // Recreating this needs the function id and a title/starts-at; doing that
    // blind risks a second, conflicting discount. Escalate instead.
    problems.push(`"${WHOLESALE_DISCOUNT_TITLE}" discount does not exist — buyers are being charged FULL RETAIL. Recreate it in Admin.`);
  } else if (wholesale.discount.status !== "ACTIVE") {
    if (!selfHealEnabled) {
      problems.push(`"${WHOLESALE_DISCOUNT_TITLE}" is ${wholesale.discount.status} — buyers are being charged FULL RETAIL (self-heal disabled)`);
    } else {
      const act = await gql(
        `mutation Activate($id: ID!) {
          discountAutomaticActivate(id: $id) {
            userErrors { field message code }
          }
        }`,
        { id: wholesale.id }
      );
      const errs = act.discountAutomaticActivate?.userErrors ?? [];
      if (errs.length) {
        problems.push(`"${WHOLESALE_DISCOUNT_TITLE}" was ${wholesale.discount.status} and could NOT be reactivated: ${JSON.stringify(errs)}`);
      } else {
        healed.push(`"${WHOLESALE_DISCOUNT_TITLE}" was ${wholesale.discount.status} — reactivated`);
      }
    }
  } else {
    ok.push(`"${WHOLESALE_DISCOUNT_TITLE}" ACTIVE`);
  }

  // ── 3. BOGO deals: report only ────────────────────────────────────────────
  // An empty bogo_bundles is a legitimate merchant choice (deals off) and does
  // not affect the strikethrough, so it is never auto-restored.
  try {
    const mf = await gql(`{ shop { metafield(namespace: "custom", key: "bogo_bundles") { value } } }`);
    const deals = JSON.parse(mf.shop?.metafield?.value ?? "[]");
    ok.push(`${Array.isArray(deals) ? deals.length : 0} BOGO deal(s) configured`);
  } catch {
    ok.push("BOGO config unreadable (not treated as a fault)");
  }

  const healthy = problems.length === 0 && healed.length === 0;
  return { healthy, ok, healed, problems, selfHealEnabled, checkedAt: new Date().toISOString() };
}

/** Run the check and email if anything was repaired or is broken. */
export async function runPricingHealthCheck(source = "timer") {
  try {
    const r = await checkAndHealPricing();

    if (r.healthy) {
      console.log(`[pricing-health/${source}] healthy — ${r.ok.join("; ")}`);
      return r;
    }

    const level = r.problems.length ? "PROBLEM" : "SELF-HEALED";
    console.error(`[pricing-health/${source}] ${level}`, JSON.stringify({ healed: r.healed, problems: r.problems }));

    const { sendPricingAlert } = await import("./brevo.server");
    await sendPricingAlert({
      subject: r.problems.length
        ? `Dutch Rusk PRICING PROBLEM — needs a human`
        : `Dutch Rusk pricing self-healed`,
      lines: [
        r.problems.length
          ? `The B2B pricing pair is broken and could not be fully repaired automatically.`
          : `The B2B pricing pair had broken and was repaired automatically.`,
        ``,
        ...(r.healed.length ? ["REPAIRED:", ...r.healed.map((h) => `  - ${h}`), ``] : []),
        ...(r.problems.length ? ["NEEDS ATTENTION:", ...r.problems.map((p) => `  - ${p}`), ``] : []),
        `Still fine: ${r.ok.length ? r.ok.join("; ") : "(nothing)"}`,
        ``,
        `Reminder of what the pair does:`,
        `  transform missing  -> correct prices but NO strikethrough / discount rows`,
        `  discount inactive  -> buyers OVERCHARGED at full retail`,
        ``,
        `checked at ${r.checkedAt} (source: ${source})`,
      ],
    }).catch((e) => console.error("[pricing-health] alert send failed:", e?.message ?? e));

    return r;
  } catch (err) {
    // Infrastructure failure: log loudly but never crash the caller.
    console.error(`[pricing-health/${source}] check itself failed —`, err?.message ?? err);
    return { healthy: false, error: String(err?.message ?? err) };
  }
}

// ── Timer ───────────────────────────────────────────────────────────────────
// Runs inside the web service, so there is no extra cron service to pay for or
// keep in sync. The module-level flag makes it start once per process even
// though this file may be imported from several routes.
let started = false;

export function startPricingHealthTimer() {
  if (started) return;
  if (process.env.PRICING_HEALTH_TIMER === "off") {
    console.log("[pricing-health] timer disabled by PRICING_HEALTH_TIMER=off");
    return;
  }
  started = true;

  const minutes = Number(process.env.PRICING_HEALTH_INTERVAL_MIN || 15);
  console.log(`[pricing-health] timer started, every ${minutes} min`);

  // A short delay so a cold boot finishes before the first check.
  setTimeout(() => { runPricingHealthCheck("startup"); }, 30_000);

  const handle = setInterval(() => { runPricingHealthCheck("timer"); }, minutes * 60_000);
  if (typeof handle.unref === "function") handle.unref();
}
