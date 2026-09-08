// Enforces each catalog's pack-size policy using Shopify's own variant-level
// publishing, instead of hiding variants in the storefront with JavaScript.
//
// WHY THIS EXISTS
// The Catalog Manager rules ("Night N Day may not order Shipper") used to be
// applied at runtime by the catalog-variant-hider theme extension: fetch the
// rules on every page view, then hide the matching variant pickers. That was
// fragile in a way customers felt. It depended on a call to this app for every
// product card, the database is in Oregon while the app runs in Singapore, and
// any slow or failed answer left the card reading unavailable -- which stuck
// until the shopper reloaded. Stocked product showed "Back Soon" for months.
//
// Shopify now supports variant-level publishing: ProductVariant implements the
// Publishable interface, so a variant can be excluded from a catalog and
// Shopify enforces it server-side. A variant is visible only when the product
// is active, the product is published to the catalog, AND the variant is
// published to it. Verified on the live storefront as a TEEG buyer: an excluded
// pack size does not appear, and a product with every variant excluded returns
// a 404 rather than an unbuyable card.
//
// The catch this job solves: a rule covered every product automatically,
// including ones added later. A native exclusion covers one variant. So the
// rules stay as the policy, and this job keeps Shopify's exclusions matching
// them -- applying them to newly published products, and removing them when a
// rule is relaxed.
//
// SAFETY
// Report-only unless `apply=1`. A run that wants to change more than
// MAX_CHANGES refuses and reports instead, so a mistaken rule cannot empty a
// catalog unattended: Xtreme Wairau's rule hid every pack size its 16 products
// come in, which would have left it nothing to sell.
//
// Variant publishing exists only on API 2026-07 and later. The app pins
// 2026-04, so this talks to 2026-07 directly.

const API_VERSION = "2026-07";
const MAX_CHANGES = 400;

async function gql(shop, token, query, variables = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) {
      const text = JSON.stringify(json.errors);
      if (text.includes("THROTTLED") && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error(text.slice(0, 300));
    }
    return json.data;
  }
}

const cleanId = (v) => (String(v).includes("/") ? String(v).split("/").pop() : String(v));

/** The publication for a catalog, whichever catalog type it turns out to be. */
async function publicationFor(shop, token, catalogId) {
  for (const kind of ["CompanyLocationCatalog", "MarketCatalog", "AppCatalog"]) {
    try {
      const d = await gql(shop, token, `query($id: ID!) { catalog(id: $id) { publication { id } } }`, {
        id: `gid://shopify/${kind}/${cleanId(catalogId)}`,
      });
      if (d?.catalog?.publication?.id) return d.catalog.publication.id;
    } catch {
      // wrong catalog type for this id, try the next
    }
  }
  return null;
}

/** Every product in a publication, with each variant's publish state for it. */
async function productsInPublication(shop, token, publicationId) {
  const out = [];
  let cursor = null;
  do {
    const d = await gql(
      shop,
      token,
      `query($p: ID!, $c: String, $pub: ID!) {
        publication(id: $p) {
          products(first: 100, after: $c) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              title
              variants(first: 60) {
                nodes { id sku title publishedOnPublication(publicationId: $pub) }
              }
            }
          }
        }
      }`,
      { p: publicationId, c: cursor, pub: publicationId }
    );
    const page = d?.publication?.products;
    if (!page) break;
    out.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

export async function loader({ request }) {
  return handle(request);
}

export async function action({ request }) {
  return handle(request);
}

async function handle(request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? "";
  if (!secret || given !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const apply = url.searchParams.get("apply") === "1";
  const onlyCatalog = url.searchParams.get("catalogId");

  const { default: prisma } = await import("../db.server");
  const shop = process.env.SHOP_DOMAIN;
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) return json({ error: "no offline session" }, 500);
  const token = session.accessToken;

  const rules = await prisma.catalogRule.findMany();
  const report = [];
  let toExclude = 0;
  let toRestore = 0;

  for (const rule of rules) {
    const cid = cleanId(rule.catalogId);
    if (onlyCatalog && cid !== cleanId(onlyCatalog)) continue;

    const types = (rule.hiddenVariantTypes ?? []).map((t) => String(t).toLowerCase());
    const ids = new Set((rule.hiddenVariantIds ?? []).map((i) => String(i).toLowerCase()));

    const publicationId = await publicationFor(shop, token, cid);
    if (!publicationId) {
      report.push({ catalog: cid, name: rule.catalogName, skipped: "no publication" });
      continue;
    }

    const products = await productsInPublication(shop, token, publicationId);
    const exclude = [];
    const restore = [];

    for (const product of products) {
      for (const variant of product.variants?.nodes ?? []) {
        const title = String(variant.title ?? "").toLowerCase();
        const sku = String(variant.sku ?? "").toLowerCase();
        const shouldHide = types.some((t) => title.startsWith(t)) || ids.has(sku) || ids.has(title);
        const isPublished = variant.publishedOnPublication !== false;

        if (shouldHide && isPublished) {
          exclude.push(variant);
        } else if (!shouldHide && !isPublished && (types.length > 0 || ids.size > 0)) {
          // Only put a variant back when the rule no longer covers it, and only
          // for a catalog that still has a rule. A variant excluded by hand in
          // the admin looks identical to one of ours, so a catalog with no rule
          // at all is left completely alone rather than having hand-made
          // exclusions undone.
          restore.push(variant);
        }
      }
    }

    toExclude += exclude.length;
    toRestore += restore.length;
    report.push({
      catalog: cid,
      name: rule.catalogName,
      hides: rule.hiddenVariantTypes ?? [],
      publicationId,
      products: products.length,
      toExclude: exclude.length,
      toRestore: restore.length,
      examples: {
        exclude: exclude.slice(0, 5).map((v) => v.sku),
        restore: restore.slice(0, 5).map((v) => v.sku),
      },
      _exclude: exclude,
      _restore: restore,
    });
  }

  const total = toExclude + toRestore;
  const strip = (rows) => rows.map(({ _exclude, _restore, ...rest }) => rest);

  if (!apply) {
    return json({ mode: "report", toExclude, toRestore, catalogs: strip(report) }, 200);
  }

  if (total > MAX_CHANGES) {
    console.error(`[variant-sync] refusing: ${total} changes exceeds MAX_CHANGES ${MAX_CHANGES}`);
    return json(
      {
        error: "too_many_changes",
        message: `${total} changes exceeds the ${MAX_CHANGES} limit. Review the report, then re-run one catalog at a time with catalogId=...`,
        toExclude,
        toRestore,
        catalogs: strip(report),
      },
      409
    );
  }

  let excluded = 0;
  let restored = 0;
  const failures = [];

  for (const entry of report) {
    if (entry.skipped) continue;
    const work = [
      { list: entry._exclude, mutation: "publishableUnpublish", kind: "exclude" },
      { list: entry._restore, mutation: "publishablePublish", kind: "restore" },
    ];
    for (const { list, mutation, kind } of work) {
      for (const variant of list) {
        try {
          const d = await gql(
            shop,
            token,
            `mutation($id: ID!, $input: [PublicationInput!]!) {
              ${mutation}(id: $id, input: $input) { userErrors { field message } }
            }`,
            { id: variant.id, input: [{ publicationId: entry.publicationId }] }
          );
          const errs = d?.[mutation]?.userErrors ?? [];
          if (errs.length) failures.push(`${variant.sku}: ${errs.map((e) => e.message).join("; ")}`);
          else if (kind === "exclude") excluded++;
          else restored++;
        } catch (e) {
          failures.push(`${variant.sku}: ${e.message}`);
        }
      }
    }
  }

  console.log(`[variant-sync] excluded ${excluded}, restored ${restored}, failures ${failures.length}`);
  return json({ mode: "apply", excluded, restored, failures, catalogs: strip(report) }, failures.length ? 207 : 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
