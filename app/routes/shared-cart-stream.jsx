// Live stream for the shared cart: GET /shared-cart-stream?t=<token>
//
// Served straight from the app (not the app proxy, which cannot stream). The
// token comes from the proxied /apps/dr-account/shared-cart?stream=1 call, so
// Shopify has already verified the customer and their store before one is
// issued. Each message is the store's new cart version and its lines, so the
// device can apply it without another round trip.
// See app/lib/shared-cart-events.server.js.

import { readStreamToken, subscribe, channelKey } from "../lib/shared-cart-events.server.js";

const ALLOWED_ORIGIN = "https://b2b.dutchrusk.co.nz";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const who = readStreamToken(url.searchParams.get("t"));
  if (!who) {
    return new Response("invalid token", { status: 401, headers: { "access-control-allow-origin": ALLOWED_ORIGIN } });
  }

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let ping;
  const stream = new ReadableStream({
    start(controller) {
      const write = (text) => controller.enqueue(encoder.encode(text));
      write(": connected\n\nretry: 3000\n\n");
      unsubscribe = subscribe(channelKey(who.shop, who.locationGid), (msg) => write(`data: ${JSON.stringify(msg)}\n\n`));
      // Keeps proxies from closing an idle connection.
      ping = setInterval(() => { try { write(": ping\n\n"); } catch { /* closed */ } }, 25000);
      request.signal.addEventListener("abort", () => {
        clearInterval(ping);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      clearInterval(ping);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      // no-transform stops the server's compression middleware buffering
      // the stream, which would delay every message until it closed.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": ALLOWED_ORIGIN,
    },
  });
};
