import prisma from "../db.server";

export async function loader({ request }) {
  const url = new URL(request.url);
  const catalogId = url.searchParams.get("catalogId");
  const productId = url.searchParams.get("productId");

  if (!catalogId) {
    return new Response(JSON.stringify({ error: "Missing catalogId" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const rule = await prisma.catalogRule.findUnique({
    where: { catalogId },
  });

  let override = null;
  if (productId) {
    override = await prisma.productOverride.findUnique({
      where: { catalogId_productId: { catalogId, productId } },
    });
  }

  return new Response(
    JSON.stringify({
      hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
      hiddenVariantIds: override ? override.hiddenVariantIds : null,
      hasOverride: !!override,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
      },
    }
  );
}