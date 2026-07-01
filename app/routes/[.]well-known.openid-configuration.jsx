import { buildDiscoveryDocument } from "../lib/oidc.server";

export const loader = async () => {
  const doc = buildDiscoveryDocument();
  return new Response(JSON.stringify(doc, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
};
