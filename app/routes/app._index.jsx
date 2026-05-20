import { useLoaderData, useNavigate, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const [totalRules, totalOverrides, activeRules, recentRules] = await Promise.all([
    prisma.catalogRule.count(),
    prisma.productOverride.count(),
    prisma.catalogRule.count({ where: { hiddenVariantTypes: { isEmpty: false } } }),
    prisma.catalogRule.findMany({ orderBy: { updatedAt: "desc" }, take: 5 }),
  ]);

  return { totalRules, totalOverrides, activeRules, recentRules };
};

export default function Index() {
  const { totalRules, totalOverrides, activeRules, recentRules } = useLoaderData();
  const navigate = useNavigate();
  const syncFetcher = useFetcher();
  const isSyncing = syncFetcher.state !== 'idle';
  const syncResult = syncFetcher.data;

  return (
    <s-page heading="Dutch Rusk — Catalog Manager">

      {/* Hero Banner */}
      <s-section>
        <div style={{
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
          borderRadius: '12px',
          padding: '32px',
          color: '#fff',
        }}>
          <div style={{ fontSize: '22px', fontWeight: '700', marginBottom: '8px' }}>
            👋 Welcome to the Dutch Rusk Catalog Manager
          </div>
          <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: '15px', marginBottom: '24px', lineHeight: '1.6' }}>
            Control exactly what pack sizes and products each B2B customer can see and order —
            without touching Shopify settings manually.
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <s-button variant="primary" onClick={() => navigate("/app/catalog-manager")}>
              Open Catalog Manager →
            </s-button>
            <s-button onClick={() => navigate("/app/audit")}>
              View Audit Report
            </s-button>
          </div>
        </div>
      </s-section>

      {/* Stats Row */}
      <s-section heading="At a Glance">
        <s-stack direction="inline" gap="base">
          <div
            onClick={() => navigate("/app/catalog-manager")}
            style={{ flex: 1, textAlign: 'center', padding: '20px', border: '1px solid #e1e3e5', borderRadius: '8px', cursor: 'pointer', background: '#f6f6f7' }}>
            <div style={{ fontSize: '2.4rem', fontWeight: '800', color: '#008060', lineHeight: 1 }}>{totalRules}</div>
            <div style={{ fontWeight: '600', marginTop: '8px' }}>Customer Accounts</div>
            <div style={{ color: '#6d7175', fontSize: '13px', marginTop: '2px' }}>configured with rules</div>
          </div>

          <div
            onClick={() => navigate("/app/audit")}
            style={{ flex: 1, textAlign: 'center', padding: '20px', border: '1px solid #e1e3e5', borderRadius: '8px', cursor: 'pointer', background: '#f6f6f7' }}>
            <div style={{ fontSize: '2.4rem', fontWeight: '800', color: '#d72c0d', lineHeight: 1 }}>{totalOverrides}</div>
            <div style={{ fontWeight: '600', marginTop: '8px' }}>Product Exceptions</div>
            <div style={{ color: '#6d7175', fontSize: '13px', marginTop: '2px' }}>with custom per-product rules</div>
          </div>

          <div style={{ flex: 1, textAlign: 'center', padding: '20px', border: '1px solid #e1e3e5', borderRadius: '8px', background: '#f6f6f7' }}>
            <div style={{ fontSize: '2.4rem', fontWeight: '800', color: '#1a1a2e', lineHeight: 1 }}>{activeRules}</div>
            <div style={{ fontWeight: '600', marginTop: '8px' }}>Pack Type Blocks</div>
            <div style={{ color: '#6d7175', fontSize: '13px', marginTop: '2px' }}>accounts with blanket restrictions</div>
          </div>
        </s-stack>
      </s-section>

      {/* Getting Started — shown only when nothing is configured */}
      {totalRules === 0 && (
        <s-section>
          <div style={{ textAlign: 'center', padding: '40px 20px', border: '1px solid #e1e3e5', borderRadius: '8px', background: '#f6f6f7' }}>
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>🚀</div>
            <div style={{ fontSize: '18px', fontWeight: '700', marginBottom: '8px' }}>Ready to get started?</div>
            <div style={{ color: '#6d7175', marginBottom: '20px' }}>
              No rules are configured yet. Open the Catalog Manager to set up your first customer account.
            </div>
            <s-button variant="primary" onClick={() => navigate("/app/catalog-manager")}>
              Open Catalog Manager
            </s-button>
          </div>
        </s-section>
      )}

      {/* Recent Activity */}
      {recentRules.length > 0 && (
        <s-section heading="Recently Updated">
          <s-stack direction="block" gap="tight">
            {recentRules.map((rule) => {
              const hasTypes = rule.hiddenVariantTypes.length > 0;
              const hasSkus = rule.hiddenVariantIds?.length > 0;
              return (
                <s-box key={rule.id} padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <s-stack direction="inline" gap="base" align="center">
                    <s-stack direction="block" gap="extraTight" style={{ flex: 1 }}>
                      <s-text fontWeight="bold">{rule.catalogName}</s-text>
                      <s-text tone="subdued">
                        {hasTypes ? `Blocking: ${rule.hiddenVariantTypes.join(", ")}` : "No pack types blocked"}
                        {hasSkus && ` · ${rule.hiddenVariantIds.length} SKU exception(s)`}
                        {!hasTypes && !hasSkus && " — No restrictions set"}
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="tight">
                      <s-button variant="secondary" size="slim"
                        onClick={() => navigate(`/app/catalog-rules?catalogId=${encodeURIComponent(rule.catalogId)}&catalogName=${encodeURIComponent(rule.catalogName)}`)}>
                        Edit Rules
                      </s-button>
                      <s-button variant="secondary" size="slim"
                        onClick={() => navigate(`/app/catalog-overrides?catalogId=${encodeURIComponent(rule.catalogId)}&catalogName=${encodeURIComponent(rule.catalogName)}`)}>
                        Product Overrides
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        </s-section>
      )}

      {/* Sidebar */}
      <s-section slot="aside" heading="How It Works">
        <s-stack direction="block" gap="tight">
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>1️⃣ Pick a Customer Account</div>
            <s-text tone="subdued">Go to Catalog Manager and select the B2B customer to configure.</s-text>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>2️⃣ Block Entire Pack Types</div>
            <s-text tone="subdued">Use "Manage Rules" to hide all Shippers, Bags, etc. for that customer in one click.</s-text>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>3️⃣ Fine-Tune Per Product</div>
            <s-text tone="subdued">Use "Product Overrides" to adjust individual products that differ from the blanket rule.</s-text>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>4️⃣ Changes Go Live Instantly</div>
            <s-text tone="subdued">Once saved, the customer sees the updated view immediately on their next page load.</s-text>
          </s-box>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Need Help?">
        <s-text tone="subdued">Contact your Digital Lead for support with this tool.</s-text>
      </s-section>

      {/* Checkout Strikethrough Sync */}
      <s-section heading="Checkout Strikethrough Prices">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <s-text>
            B2B catalog customers see discounted prices at checkout, but Shopify doesn't
            automatically show the original retail price as a strikethrough. Click the button
            below to sync the retail price onto every variant's compare-at price — this is a
            one-time setup (or run it again after bulk price updates).
          </s-text>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button
              type="button"
              onClick={() => syncFetcher.submit({}, { method: 'post', action: '/api/sync-compare-prices' })}
              disabled={isSyncing}
              style={{
                background: isSyncing ? '#95c9b4' : '#008060',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: isSyncing ? 'not-allowed' : 'pointer',
              }}
            >
              {isSyncing ? 'Syncing…' : '🏷️ Sync Compare-At Prices'}
            </button>
            {syncResult?.success && (
              <span style={{ color: '#008060', fontWeight: '600' }}>
                ✅ Done — {syncResult.updatedCount} variant(s) updated
              </span>
            )}
            {syncResult?.error && (
              <span style={{ color: '#d72c0d', fontWeight: '600' }}>
                ❌ {syncResult.error}
              </span>
            )}
          </div>
          <s-text tone="subdued">
            This sets compare_at_price = price for any variant missing a compare-at value.
            Regular customers won't see a strikethrough (price = compare-at, so Shopify hides it),
            but B2B catalog customers will see ~~retail price~~ their discounted price at checkout.
          </s-text>
        </div>
      </s-section>

    </s-page>
  );
}
