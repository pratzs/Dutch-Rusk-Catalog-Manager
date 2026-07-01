import { getPublicJwks } from "../lib/oidc.server";

export const loader = async () => {
  const jwks = await getPublicJwks();
  return new Response(JSON.stringify(jwks), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "access-control-allow-origin": "*",
    },
  });
};
