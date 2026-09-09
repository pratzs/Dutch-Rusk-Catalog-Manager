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
//   2. size band within the brand, read from the product's tags: singles,
//      then share/king size, then blocks, then bulk bags, then anything
//      untagged. This is the part that puts "47g Mars Salted Caramel" beside
//      "50g Bounty": same vendor, same band. Alphabetical never could, since
//      one title starts with a digit and the other with a B.
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

/** Size band within a brand. Lower sorts first; untagged goes last. */
export function sizeBand(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  const has = (re) => t.some((x) => re.test(x));
  if (has(/single bars?\b/)) return 1;
  if (has(/share bar chocolates/)) return 2;
  if (has(/\bblocks?\b/)) return 3;
  if (has(/family bags|large bags|m&m bags|hi-chew bags|bulk gummies and lollies|sharepacks/)) return 4;
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
      b: sizeBand(p.tags),
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

export async function runBrandOrder(shop, accessToken) {
  const gql = adminGql(shop, accessToken);
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
  return { collections: targets.length, rearranged: rearranged.length, alreadyCorrect, failed };
}
