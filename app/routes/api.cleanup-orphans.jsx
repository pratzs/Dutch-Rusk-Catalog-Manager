import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const SYSTEM_CHANNEL_KEYWORDS = [
  "channel catalog", "point of sale", "hydrogen", "graphiql",
  "online store", "buy button", "facebook", "instagram", "google", "pinterest",
];

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  const activeCatalogIds = new Set();
  let hasNext = true;
  let cursor = null;

  while (hasNext) {
    const args = cursor ? `first: 250, after: "${cursor}"` : `first: 250`;
    const res = await admin.graphql(`query { catalogs(${args}) { pageInfo { hasNextPage endCursor } nodes { id title } } }`);
    const d = await res.json();
    const nodes = d.data.catalogs.nodes || [];
    nodes.forEach(c => {
      const lower = c.title.toLowerCase();
      if (!SYSTEM_CHANNEL_KEYWORDS.some(kw => lower.includes(kw))) {
        activeCatalogIds.add(c.id.split("/").pop());
      }
    });
    hasNext = d.data.catalogs.pageInfo.hasNextPage;
    cursor = d.data.catalogs.pageInfo.endCursor;
  }

  const [allRules, allOverrides] = await Promise.all([
    prisma.catalogRule.findMany({ select: { id: true, catalogId: true, catalogName: true } }),
    prisma.productOverride.groupBy({ by: ["catalogId"], _count: { catalogId: true } }),
  ]);

  const orphanedRules = allRules.filter(r => !activeCatalogIds.has(r.catalogId));
  const orphanedOverrideCatalogs = allOverrides.filter(o => !activeCatalogIds.has(o.catalogId));

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";

  if (dryRun) {
    return {
      dryRun: true,
      orphanedRuleCount: orphanedRules.length,
      orphanedRules: orphanedRules.map(r => ({ catalogId: r.catalogId, catalogName: r.catalogName })),
      orphanedOverrideCatalogs: orphanedOverrideCatalogs.map(o => ({ catalogId: o.catalogId, count: o._count.catalogId })),
      totalOrphanedOverrides: orphanedOverrideCatalogs.reduce((s, o) => s + o._count.catalogId, 0),
    };
  }

  const orphanedCatalogIds = orphanedRules.map(r => r.catalogId);
  const orphanedOverrideCatalogIds = orphanedOverrideCatalogs.map(o => o.catalogId);
  const allOrphanedIds = [...new Set([...orphanedCatalogIds, ...orphanedOverrideCatalogIds])];

  let deletedRules = 0;
  let deletedOverrides = 0;

  if (allOrphanedIds.length > 0) {
    const result = await prisma.$transaction([
      prisma.catalogRule.deleteMany({ where: { catalogId: { in: allOrphanedIds } } }),
      prisma.productOverride.deleteMany({ where: { catalogId: { in: allOrphanedIds } } }),
    ]);
    deletedRules = result[0].count;
    deletedOverrides = result[1].count;
  }

  return {
    dryRun: false,
    deletedRules,
    deletedOverrides,
    orphanedCatalogIds: allOrphanedIds,
  };
}
