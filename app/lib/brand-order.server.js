// Keeps every collection arranged by brand, in the admin.
//
// WHY THIS EXISTS
// Brand grouping used to be done in the theme, in JavaScript, after the server
// had already sent the cards: it re-sorted the grid on load and, on every
// infinite-scroll page, inserted the newly arrived cards back up into their
// brand's block and then tried to hold the viewport still with a scrollBy().
// Customers reported the page stalling and jumping back up, and five attempts
// at making that compensation reliable all failed, because adding content above
// the viewport either moves the page or depends on measuring the shift
// perfectly at the same moment the browser's own scroll anchoring is doing the
// same job. It is gone. Product order is a collection setting now, so the
// server sends products already grouped and nothing moves after paint.
//
// THE ORDER
//   1. vendor, ranked by where that vendor first appears in this collection's
//      own best-selling order, so the best-selling brand leads and every
//      product of a brand sits together instead of being scattered.
//   2. size band within the brand: singles, then share and king size, then
//      blocks, then sharepacks, then bags smallest first (family bags up to
//      350g, then the 500g and 800g few, then the 1kg and 2kg bulk bags),
//      then anything unrecognised. This is the part that puts "47g Mars
//      Salted Caramel" beside "50g Bounty": same vendor, same band.
//      Alphabetical never could, since one title starts with a digit and the
//      other with a B.
//   3. title, only so the result is stable and repeatable.
//
// Product titles are never touched. They come from Ostendo and the admin team
// owns them.
//
// WHY IT MUST RE-RUN
// A manual sort order is a fixed list of positions. When a smart collection
// picks up a newly listed product, that product is appended rather than placed,
// so it sits out of position until this runs again.
//
// This module deliberately takes a shop and an access token and uses plain
// fetch, so the same code can run inside the app or from a standalone cron
// script with no framework loaded.

const API = "2026-07";
const MOVE_BATCH = 200;

// New Arrivals is deliberately excluded: brand-grouping it would destroy the
// only thing that collection exists to show.
export const LEAVE_ALONE = ["New Arrivals"];

// Ordering by brand is only as good as the vendor field, and a lot of products
// arrive filed under the house vendor even though the title names a real brand:
// Snickers, Twix, Ajax, Bubble Tea, Candycove, Carefree and so on were all
// sitting under DutchRusk. 69 were corrected by hand on 9 Sept 2026; this keeps
// it that way as new products land.
const HOUSE_VENDORS = ["DutchRusk", "Dutch Rusk"];

// A sub-brand -> the vendor it must carry. This table is AUTHORITATIVE: it is
// applied whatever the product's current vendor is, not only when the product
// sits under the house vendor. That is deliberate, because the gum and mint
// lines were all filed under Mars when they are Wrigley's, which is a wrong
// real vendor rather than a missing one.
//
// Mars keeps the chocolate and the candy: Snickers, Twix, Bounty, Maltesers,
// M&M's and Skittles. Wrigley's takes the gum and mints.
const VENDOR_ALIASES = {
  snickers: "Mars",
  twix: "Mars",
  extra: "Wrigley's",
  eclipse: "Wrigley's",
  "5 gum": "Wrigley's",
  "hubba bubba": "Wrigley's",
  "juicy fruit": "Wrigley's",
  pk: "Wrigley's",
  airwaves: "Wrigley's",
  orbit: "Wrigley's",
  ajax: "Ajax",
  "bubble tea": "LOL",
  candycove: "Candycove",
  carefree: "Carefree",
  libra: "Libra",
  colgate: "Colgate",
  palmolive: "Palmolive",
  dove: "Dove",
  rexona: "Rexona",
  surf: "Surf",
  "o'brien": "O'Brien",
  juicies: "Juicies",
  kandos: "Kandos",
  zess: "Zess",
  newport: "Newport",
  tncc: "TNCC",
  "my toffee": "My Toffee",
};

/**
 * Pack weight in grams, read from the title, or null.
 *
 * The FIRST weight in the title is the pack; a trailing "x 12ct" is the case
 * count, so "Pascall Family Bag Marshmallows 180g x 12ct" is 180g and
 * "Dragon 2kg Gummy Starfish" is 2000g.
 */
export function packGrams(title) {
  const m = String(title || "").match(/(\d+(?:\.\d+)?)\s*(kg|g)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  return /kg/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Size band within a brand. Lower sorts first; anything unrecognised goes last.
 *
 * Bags are banded by actual weight rather than by tag, because the tags
 * disagree with reality: 25 products tagged "Bulk Gummies and Lollies" are
 * 220g family bags, one "Family Bags" is a 1kg, and one "Bulk Bags" is small.
 * Weight is what "small to large" actually means. Per pratham: bags up to
 * ~350g are the small family bags (a 350g party mix still counts), and the
 * 1kg and 2kg ones are the bulk bags. The 500g and 800g few sit between.
 */
export function sizeBand(tags, title) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  const has = (re) => t.some((x) => re.test(x));

  if (has(/single bars?\b/)) return 1;
  if (has(/share bar chocolates/)) return 2;
  if (has(/\bblocks?\b/)) return 3;
  if (has(/^sharepacks$/)) return 4;

  const isBag = has(/family bags|large bags|m&m bags|hi-chew bags|bulk gummies and lollies|^1kg$|^2kg$/) ||
    /\bbag\b|party mix/i.test(String(title || ""));
  if (isBag) {
    const g = packGrams(title);
    if (g === null) return 5;      // a bag with no weight in the title
    if (g <= 350) return 5;        // family bag, small
    if (g < 1000) return 6;        // 500g and 800g, between the two
    return 7;                      // 1kg, 2kg, bulk bag
  }
  return 9;
}

/**
 * The order a collection's products should be in.
 * Pure, so it can be reasoned about and tested without touching Shopify.
 */
export function desiredOrder(productsInBestSellingOrder) {
  const vendorRank = new Map();
  for (const p of productsInBestSellingOrder) {
    const v = p.vendor || "";
    if (!vendorRank.has(v)) vendorRank.set(v, vendorRank.size);
  }
  return productsInBestSellingOrder
    .map((p, i) => ({
      p,
      v: vendorRank.get(p.vendor || ""),
      b: sizeBand(p.tags, p.title),
      t: String(p.title || "").toLowerCase(),
      i,
    }))
    .sort((a, b) => a.v - b.v || a.b - b.b || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0) || a.i - b.i)
    .map((k) => k.p);
}

function adminGql(shop, accessToken) {
  return async (query, variables = {}) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      if (json.errors) {
        const s = JSON.stringify(json.errors);
        // A job this size gets throttled; back off rather than fail the run.
        if (s.includes("THROTTLED") && attempt < 9) {
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw new Error(s.slice(0, 300));
      }
      return json.data;
    }
    throw new Error("throttled out");
  };
}

async function productsInOrder(gql, id, sortKey) {
  const out = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($id:ID!,$c:String,$k:ProductCollectionSortKeys){
        collection(id:$id){ products(first:100, after:$c, sortKey:$k){
          pageInfo{ hasNextPage endCursor }
          nodes{ id title vendor tags } } } }`,
      { id, c: cursor, k: sortKey }
    );
    const page = data?.collection?.products;
    if (!page) break;
    out.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function waitForJob(gql, jobId) {
  for (let i = 0; i < 40; i++) {
    const data = await gql(`query($id:ID!){ job(id:$id){ id done } }`, { id: jobId });
    if (data?.job?.done) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function arrangeCollection(gql, col) {
  const bestSelling = await productsInOrder(gql, col.id, "BEST_SELLING");
  if (bestSelling.length < 2) return { collection: col.title, products: bestSelling.length, changed: false };

  const target = desiredOrder(bestSelling).map((p) => p.id);
  const current = (await productsInOrder(gql, col.id, null)).map((p) => p.id);

  let inPlace = current.length === target.length;
  if (inPlace) {
    for (let i = 0; i < target.length; i++) {
      if (current[i] !== target[i]) { inPlace = false; break; }
    }
  }
  // Nothing new has landed and nothing has shifted, so write nothing at all.
  // This is what makes a scheduled run cheap on a quiet day.
  if (inPlace) return { collection: col.title, products: target.length, changed: false };

  if (col.sortOrder !== "MANUAL") {
    const data = await gql(
      `mutation($i:CollectionInput!){ collectionUpdate(input:$i){ collection{ sortOrder } userErrors{ field message } } }`,
      { i: { id: col.id, sortOrder: "MANUAL" } }
    );
    const errs = data?.collectionUpdate?.userErrors ?? [];
    if (errs.length) throw new Error(`sortOrder: ${errs.map((e) => e.message).join("; ")}`);
  }

  for (let i = 0; i < target.length; i += MOVE_BATCH) {
    const moves = target.slice(i, i + MOVE_BATCH).map((id, k) => ({ id, newPosition: String(i + k) }));
    const data = await gql(
      `mutation($id:ID!,$moves:[MoveInput!]!){ collectionReorderProducts(id:$id, moves:$moves){ job{ id done } userErrors{ field message } } }`,
      { id: col.id, moves }
    );
    const errs = data?.collectionReorderProducts?.userErrors ?? [];
    if (errs.length) throw new Error(`reorder: ${errs.map((e) => e.message).join("; ")}`);
    const job = data?.collectionReorderProducts?.job;
    if (job && !job.done) await waitForJob(gql, job.id);
  }

  // Read the storefront order back rather than trusting the mutation. The
  // reorder runs as a Shopify job, so it can report success before it has
  // finished settling.
  const after = (await productsInOrder(gql, col.id, null)).map((p) => p.id);
  let wrong = 0;
  for (let i = 0; i < target.length; i++) if (after[i] !== target[i]) wrong++;
  return { collection: col.title, products: target.length, changed: true, positionsWrong: wrong };
}

/**
 * Which vendor a title says it is, or null.
 *
 * The brand must be at the START of the title, optionally after a leading size
 * token like "44g" or "2kg". Matching a brand anywhere in the title produced
 * obvious nonsense when tried: "Toy With Candy - Flashing Carousel" became
 * vendor Carousel, "Flat Lollipop Monster" became Monster, "Toy - Sticky Poo
 * Rainbow" became Rainbow, "Toy - Tic Tac Toe" became Tic Tac. Anchoring rules
 * all four out and loses no real case, because the genuine ones all read
 * "Ajax Spray N Wipe", "Musashi Protein Bar", "44g Snickers Honeycomb".
 */
export function detectVendor(title, lookup) {
  let t = String(title || "").toLowerCase().replace(/[^a-z0-9'&\s]/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^(\d+(?:\.\d+)?\s*(?:g|kg|ml|lt|l|pc|pk)\s+)+/, "");
  for (const item of lookup) {
    if (item.needle.length < 2) continue;
    const n = item.needle.replace(/[^a-z0-9'&\s]/g, " ").replace(/\s+/g, " ").trim();
    if (t === n || t.startsWith(n + " ")) return item.vendor;
  }
  return null;
}

/**
 * Move products off the house vendor and onto the brand their title names.
 *
 * Only ever promotes: a product that already carries a real brand is never
 * touched, and a house-vendor product whose title names nothing recognisable is
 * left alone. So the worst case for any product is that nothing happens. A
 * brand is only used if it already exists as a vendor somewhere in the
 * catalogue, or is in VENDOR_ALIASES, so this cannot invent brands.
 */
async function normaliseVendors(gql) {
  const products = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($c:String){ products(first:250, after:$c, query:"status:active"){
        pageInfo{ hasNextPage endCursor }
        nodes{ id title vendor } } }`,
      { c: cursor }
    );
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  const realVendors = new Set(
    products.filter((p) => !HOUSE_VENDORS.includes(p.vendor)).map((p) => String(p.vendor || "").trim()).filter(Boolean)
  );
  const lookup = [];
  for (const v of realVendors) lookup.push({ needle: v.toLowerCase(), vendor: v });
  for (const [needle, vendor] of Object.entries(VENDOR_ALIASES)) lookup.push({ needle, vendor });
  lookup.sort((a, b) => b.needle.length - a.needle.length);

  // Two different strengths of rule:
  //
  //   * the ALIAS table is authoritative, so it applies whatever the product
  //     currently says. That is how the gum and mint lines get moved off Mars
  //     and onto Wrigley's: a wrong real vendor, not a missing one.
  //   * matching against vendors that merely exist elsewhere in the catalogue
  //     only ever PROMOTES a product off the house vendor, never overrides a
  //     real brand someone has set deliberately.
  const aliasLookup = Object.entries(VENDOR_ALIASES)
    .map(([needle, vendor]) => ({ needle, vendor }))
    .sort((a, b) => b.needle.length - a.needle.length);

  const changes = [];
  for (const p of products) {
    const alias = detectVendor(p.title, aliasLookup);
    if (alias) {
      if (alias !== p.vendor) changes.push({ id: p.id, title: p.title, from: p.vendor, to: alias });
      continue;
    }
    if (!HOUSE_VENDORS.includes(p.vendor)) continue;
    const want = detectVendor(p.title, lookup);
    if (want && want !== p.vendor) changes.push({ id: p.id, title: p.title, from: p.vendor, to: want });
  }

  let fixed = 0;
  for (const c of changes) {
    try {
      const data = await gql(
        `mutation($p:ProductUpdateInput!){ productUpdate(product:$p){ product{ id vendor } userErrors{ field message } } }`,
        { p: { id: c.id, vendor: c.to } }
      );
      const errs = data?.productUpdate?.userErrors ?? [];
      if (errs.length) console.error(`[brand-order] vendor ${c.title}: ${errs.map((e) => e.message).join("; ")}`);
      else { fixed++; console.log(`[brand-order] vendor ${c.from} -> ${c.to}: ${c.title}`); }
    } catch (e) {
      console.error(`[brand-order] vendor ${c.title}: ${e.message}`);
    }
  }
  if (changes.length) console.log(`[brand-order] vendors corrected: ${fixed}/${changes.length}`);
  return { vendorsCorrected: fixed, vendorCandidates: changes.length };
}

export async function runBrandOrder(shop, accessToken) {
  const gql = adminGql(shop, accessToken);

  // Vendors first: the ordering below groups by vendor, so a product filed
  // under the house vendor would otherwise be grouped in the wrong place and
  // then need a second pass to move.
  const vendors = await normaliseVendors(gql);

  const collections = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($c:String){ collections(first:100, after:$c){
        pageInfo{ hasNextPage endCursor }
        nodes{ id title handle sortOrder } } }`,
      { c: cursor }
    );
    collections.push(...data.collections.nodes);
    cursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);

  const targets = collections.filter((c) => !LEAVE_ALONE.includes(c.title));
  const rearranged = [];
  const failed = [];
  let alreadyCorrect = 0;

  for (const col of targets) {
    try {
      const r = await arrangeCollection(gql, col);
      if (r.changed) rearranged.push(r);
      else alreadyCorrect++;
      if (r.positionsWrong) {
        console.error(`[brand-order] ${col.title}: ${r.positionsWrong} position(s) had not settled on read-back`);
      }
    } catch (e) {
      failed.push({ collection: col.title, error: e.message });
      console.error(`[brand-order] ${col.title} failed:`, e.message);
    }
  }

  console.log(
    `[brand-order] ${targets.length} collection(s): ${rearranged.length} rearranged, ${alreadyCorrect} already correct, ${failed.length} failed`
  );
  return {
    collections: targets.length,
    rearranged: rearranged.length,
    alreadyCorrect,
    failed,
    ...vendors,
  };
}
