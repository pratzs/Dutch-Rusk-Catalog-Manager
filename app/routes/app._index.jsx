import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const [totalRules, totalOverrides] = await Promise.all([
    prisma.catalogRule.count(),
    prisma.productOverride.count(),
  ]);

  const recentRules = await prisma.catalogRule.findMany({
    orderBy: { updatedAt: "desc" },
    take: 5,
    // We don't need to specify select if we want all fields, 
    // but Prisma will now include hiddenVariantIds by default
  });

  return { totalRules, totalOverrides, recentRules };
};

export default function Index() {
  const { totalRules, totalOverrides, recentRules } = useLoaderData();
  const navigate = useNavigate();

  return (
    <s-page heading="Dutch Rusk Catalog Manager">
      <s-section heading="Welcome">
        <s-paragraph>
          Manage which product variants are visible to each B2B customer catalog.
          Set bulk rules by variant type, or override specific products individually.
        </s-paragraph>
        <s-stack direction="inline" gap="base" style={{ marginTop: "12px" }}>
          <s-button
            variant="primary"
            onClick={() => navigate("/app/catalog-manager")}
          >
            Open Catalog Manager
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Overview">
        <s-stack direction="inline" gap="base">
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
            style={{ flex: 1, textAlign: "center" }}
          >
            <s-text fontWeight="bold" style={{ fontSize: "2rem" }}>
              {totalRules}
            </s-text>
            <s-text>Catalogs with rules</s-text>
          </s-box>
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
            style={{ flex: 1, textAlign: "center" }}
          >
            <s-text fontWeight="bold" style={{ fontSize: "2rem" }}>
              {totalOverrides}
            </s-text>
            <s-text>Product overrides</s-text>
          </s-box>
        </s-stack>
      </s-section>

      {recentRules.length > 0 && (
        <s-section heading="Recently Updated Catalogs">
          <s-stack direction="block" gap="tight">
            {recentRules.map((rule) => (
              <s-box
                key={rule.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="inline" gap="base" align="center">
                  <s-stack direction="block" gap="extraTight" style={{ flex: 1 }}>
                    <s-text fontWeight="bold">{rule.catalogName}</s-text>
                    <s-text tone="subdued">
                    Hiding: {rule.hiddenVariantTypes.length > 0 ? rule.hiddenVariantTypes.join(", ") : "nothing"}
                    {rule.hiddenVariantIds?.length > 0 && (
                      <> | <s-text fontWeight="bold">{rule.hiddenVariantIds.length} Restricted SKUs</s-text></>
                    )}
                  </s-text>
                  </s-stack>
                  <s-button
                    variant="secondary"
                    size="slim"
                    onClick={() =>
                      navigate(
                        `/app/catalog-rules?catalogId=${encodeURIComponent(rule.catalogId)}&catalogName=${encodeURIComponent(rule.catalogName)}`
                      )
                    }
                  >
                    Edit Rules
                  </s-button>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Quick Guide">
        <s-unordered-list>
          <s-list-item>
            <s-text fontWeight="bold">Bulk Rules</s-text> — Hide entire variant
            types (e.g. all Shippers) from a catalog
          </s-list-item>
          <s-list-item>
            <s-text fontWeight="bold">Product Overrides</s-text> — Make
            exceptions for specific products
          </s-list-item>
          <s-list-item>
            Rules apply to the storefront when a B2B customer logs in
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Need help?">
        <s-paragraph>
          Contact your Digital Lead for support with this app.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}