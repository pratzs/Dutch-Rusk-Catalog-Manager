// Run: node --test app/lib/redirects.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { queueRedirect, flushRedirects, SPECIAL_DEALS_PATH } from "./redirects.server.js";

/** A tiny fake Shopify: one metafield holds the queue; urlRedirectCreate behaviour is injected. */
function fake(create) {
  const state = { queue: "[]", calls: [] };
  const gql = async (q, v) => {
    if (q.includes("metafield(namespace")) return { shop: { id: "gid://shop/1", metafield: { value: state.queue } } };
    if (q.includes("metafieldsSet")) { state.queue = v.m[0].value; return { metafieldsSet: { userErrors: [] } }; }
    if (q.includes("urlRedirectCreate")) { state.calls.push(v.r); return create(v.r); }
    throw new Error("unexpected query");
  };
  return { gql, state };
}
const ok = () => ({ urlRedirectCreate: { urlRedirect: { id: "1" }, userErrors: [] } });
const quiet = { log: () => {} };

test("a queued redirect is created and then leaves the queue", async () => {
  const { gql, state } = fake(ok);
  await queueRedirect(gql, "/collections/deal-musashi-10-1");
  const r = await flushRedirects(gql, quiet);
  assert.deepEqual([r.created, r.pending, r.denied], [1, 0, false]);
  assert.deepEqual(state.calls, [{ path: "/collections/deal-musashi-10-1", target: SPECIAL_DEALS_PATH }]);
  assert.equal(JSON.parse(state.queue).length, 0);
});
test("queueing the same address twice does not duplicate it", async () => {
  const { gql, state } = fake(ok);
  await queueRedirect(gql, "/collections/deal-a");
  const again = await queueRedirect(gql, "/collections/deal-a");
  assert.equal(again.queued, false);
  assert.equal(JSON.parse(state.queue).length, 1);
});
test("no permission yet: nothing is lost, and it stops trying", async () => {
  const { gql, state } = fake(() => { throw new Error('Access denied for urlRedirectCreate field. [{"extensions":{"code":"ACCESS_DENIED"}}]'); });
  await queueRedirect(gql, "/collections/deal-a");
  await queueRedirect(gql, "/collections/deal-b");
  const r = await flushRedirects(gql, quiet);
  assert.deepEqual([r.created, r.pending, r.denied], [0, 2, true]);
  assert.equal(state.calls.length, 1); // stopped after the first denial
  assert.equal(JSON.parse(state.queue).length, 2);
});
test("an address that already redirects counts as done", async () => {
  const { gql, state } = fake(() => ({ urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: "Path has already been taken" }] } }));
  await queueRedirect(gql, "/collections/deal-a");
  const r = await flushRedirects(gql, quiet);
  assert.deepEqual([r.created, r.pending], [0, 0]);
  assert.equal(JSON.parse(state.queue).length, 0);
});
test("any other error keeps it queued to retry", async () => {
  const { gql, state } = fake(() => ({ urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: "Something else" }] } }));
  await queueRedirect(gql, "/collections/deal-a");
  const r = await flushRedirects(gql, quiet);
  assert.equal(r.pending, 1);
  assert.equal(JSON.parse(state.queue).length, 1);
});
test("empty queue is a no-op", async () => {
  const { gql } = fake(ok);
  assert.deepEqual(await flushRedirects(gql, quiet), { created: 0, pending: 0, denied: false });
});
