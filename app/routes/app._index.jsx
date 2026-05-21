import React from 'react';
import { useLoaderData, useNavigate } from "react-router";
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
  const [syncState, setSyncState] = React.useState({ running: false, total: 0, done: false, error: null });
  const [backfillState, setBackfillState] = React.useState({ running: false, updated: 0, skipped: 0, done: false, error: null });

  async function runSync() {
    setSyncState({ running: true, total: 0, done: false, error: null });
    let cursor = null;
    let total = 0;
    try {
      while (true) {
        const res = await fetch('/api/sync-compare-prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setSyncState({ running: false, total, done: false, error: data.error || 'Request failed' });
          return;
        }
        total += data.updatedCount ?? 0;
        setSyncState({ running: !data.done, total, done: data.done, error: null });
        if (data.done) break;
        cursor = data.nextCursor;
      }
    } catch (err) {
      setSyncState({ running: false, total, done: false, error: err.message });
    }
  }

  async function runBackfill() {
    setBackfillState({ running: true, updated: 0, skipped: 0, done: false, error: null });
    let cursor = null;
    let updated = 0;
    let skipped = 0;
    try {
      while (true) {
        const res = await fetch('/api/backfill-order-discounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursor, daysBack: 365 }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setBackfillState({ running: false, updated, skipped, done: false, error: data.error || 'Request failed' });
          return;
        }
        updated += data.updatedCount ?? 0;
        skipped += data.skippedCount ?? 0;
        setBackfillState({ running: !data.done, updated, skipped, done: data.done, error: null });
        if (data.done) break;
        cursor = data.nextCursor;
      }
    } catch (err) {
      setBackfillState({ running: false, updated, skipped, done: false, error: err.message });
    }
  }

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
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={runSync}
              disabled={syncState.running}
              style={{
                background: syncState.running ? '#95c9b4' : '#008060',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: syncState.running ? 'not-allowed' : 'pointer',
              }}
            >
              {syncState.running ? `Syncing… (${syncState.total} updated so far)` : '🏷️ Sync Compare-At Prices'}
            </button>
            {syncState.done && (
              <span style={{ color: '#008060', fontWeight: '600' }}>
                ✅ Done — {syncState.total} variant(s) updated
              </span>
            )}
            {syncState.error && (
              <span style={{ color: '#d72c0d', fontWeight: '600' }}>
                ❌ {syncState.error}
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

      {/* B2B Order Discount Records */}
      <s-section heading="B2B Discount Records on Orders">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <s-text>
            Shopify's B2B catalog pricing silently lowers prices — no discount records appear on
            orders, so ERPs (Ostendo, Odoo, etc.) can't see what discount was applied.
            From now on, every new B2B order is automatically enriched with discount details
            under "Additional Details" on the order page. Use the button below to backfill
            the last 365 days of existing orders.
          </s-text>
          <div style={{
            background: '#f0f7ff',
            border: '1px solid #b4d4ff',
            borderRadius: '8px',
            padding: '12px 16px',
            fontSize: '13px',
            color: '#1a4a8a',
            lineHeight: '1.6',
          }}>
            <strong>How it works:</strong> For each order line, the app compares the
            B2B price paid against the retail compare-at price to calculate the exact
            saving per item. This is written to the order as "Additional Details" —
            visible on the Shopify Admin order page and readable by any ERP via the
            Shopify Orders API (<code>note_attributes</code> field).
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={runBackfill}
              disabled={backfillState.running}
              style={{
                background: backfillState.running ? '#8eb8e5' : '#1a4a8a',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: backfillState.running ? 'not-allowed' : 'pointer',
              }}
            >
              {backfillState.running
                ? `Backfilling… (${backfillState.updated} updated, ${backfillState.skipped} no-discount)`
                : '📋 Backfill Discount Records (last 365 days)'}
            </button>
            {backfillState.done && (
              <span style={{ color: '#008060', fontWeight: '600' }}>
                ✅ Done — {backfillState.updated} order(s) updated, {backfillState.skipped} had no B2B discount
              </span>
            )}
            {backfillState.error && (
              <span style={{ color: '#d72c0d', fontWeight: '600' }}>
                ❌ {backfillState.error}
              </span>
            )}
          </div>
          <s-text tone="subdued">
            New orders are handled automatically — this button is only needed once
            for historical orders, or after re-running the compare-at sync.
            Run "Sync Compare-At Prices" first if you haven't already.
          </s-text>
        </div>
      </s-section>

    </s-page>
  );
}
