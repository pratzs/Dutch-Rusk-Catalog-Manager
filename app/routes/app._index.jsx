import React from 'react';
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const SYSTEM_CHANNEL_KEYWORDS = [
  "channel catalog", "point of sale", "hydrogen", "graphiql",
  "online store", "buy button", "facebook", "instagram", "google", "pinterest",
];

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Fetch real catalogs from Shopify to filter out orphaned DB rows
  let activeCatalogIds = new Set();
  try {
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
  } catch (_) {
    // best-effort catalog fetch, ignore failure and fall back to no active-catalog filtering
  }

  const [allRules, , recentRulesRaw, overrideCounts, overrideProductGroups] = await Promise.all([
    prisma.catalogRule.findMany(),
    prisma.productOverride.count(),
    prisma.catalogRule.findMany({ orderBy: { updatedAt: "desc" }, take: 10 }),
    prisma.productOverride.groupBy({ by: ["catalogId"], _count: { catalogId: true } }),
    prisma.productOverride.groupBy({ by: ["catalogId"] }).then(r => new Set(r.map(x => x.catalogId))),
  ]);

  // Filter to only active Shopify catalogs
  const activeRules = allRules.filter(r => activeCatalogIds.has(r.catalogId));

  const overrideCountMap = {};
  overrideCounts.forEach((o) => { overrideCountMap[o.catalogId] = o._count.catalogId; });

  // Count overrides only for active catalogs
  const activeOverrideCounts = overrideCounts.filter(o => activeCatalogIds.has(o.catalogId));
  const totalOverrideRows = activeOverrideCounts.reduce((sum, o) => sum + o._count.catalogId, 0);
  const groupsWithOverrides = activeOverrideCounts.length;

  // Distinct products with overrides (across active catalogs only)
  const activeOverrideProductIds = await prisma.productOverride.findMany({
    where: { catalogId: { in: [...activeCatalogIds] } },
    select: { productId: true },
    distinct: ["productId"],
  });
  const distinctOverrideProducts = activeOverrideProductIds.length;

  const totalGroups = activeCatalogIds.size;
  const groupsWithBlanket = activeRules.filter(r => r.hiddenVariantTypes.length > 0).length;
  const configuredGroups = activeRules.filter(r =>
    r.hiddenVariantTypes.length > 0 || overrideProductGroups.has(r.catalogId)
  ).length;
  // Also count active catalogs that have overrides but no CatalogRule row
  const catalogIdsWithRules = new Set(activeRules.map(r => r.catalogId));
  const overrideOnlyCatalogs = [...activeCatalogIds].filter(id =>
    !catalogIdsWithRules.has(id) && overrideProductGroups.has(id)
  ).length;
  const finalConfigured = configuredGroups + overrideOnlyCatalogs;
  const unconfiguredGroups = totalGroups - finalConfigured;

  const packTypeBreakdown = {};
  activeRules.forEach(r => {
    r.hiddenVariantTypes.forEach(t => {
      packTypeBreakdown[t] = (packTypeBreakdown[t] || 0) + 1;
    });
  });

  // Recent rules — only show active catalogs
  const recentRules = recentRulesRaw.filter(r => activeCatalogIds.has(r.catalogId)).slice(0, 5);

  return {
    totalGroups, configuredGroups: finalConfigured, unconfiguredGroups,
    groupsWithBlanket, groupsWithOverrides,
    totalOverrideRows, distinctOverrideProducts,
    packTypeBreakdown,
    recentRules, overrideCountMap,
  };
};

const statCardStyle = {
  flex: 1,
  textAlign: 'center',
  padding: '22px 18px',
  border: '1px solid #e1e3e5',
  borderRadius: '10px',
  cursor: 'pointer',
  background: '#fff',
  font: 'inherit',
  color: 'inherit',
  boxShadow: '0 1px 2px rgba(16, 24, 40, 0.04)',
};
const statNumberStyle = { fontSize: '2.2rem', fontWeight: '800', lineHeight: 1 };
const statLabelStyle = { fontWeight: '600', marginTop: '10px', color: '#202223' };
const statSubStyle = { color: '#6d7175', fontSize: '13px', marginTop: '2px' };

function actionButtonStyle(kind, busy) {
  const palette = {
    primary: { idle: '#181344', busy: '#8683a8' },
    accent: { idle: '#2156c3', busy: '#8eb8e5' },
    success: { idle: '#008060', busy: '#95c9b4' },
    danger: { idle: '#d72c0d', busy: '#e8a89c' },
  }[kind];
  return {
    background: busy ? palette.busy : palette.idle,
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: busy ? 'not-allowed' : 'pointer',
  };
}

const toolSectionStyle = { display: 'flex', flexDirection: 'column', gap: '12px' };
const noteBoxStyle = { border: '1px solid #e1e3e5', background: '#f6f6f7', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', lineHeight: '1.6', color: '#4a4a4a' };

export default function Index() {
  const {
    configuredGroups, unconfiguredGroups,
    groupsWithBlanket, groupsWithOverrides,
    totalOverrideRows, distinctOverrideProducts,
    packTypeBreakdown,
    recentRules, overrideCountMap,
  } = useLoaderData();
  const navigate = useNavigate();
  const [syncState, setSyncState] = React.useState({ running: false, total: 0, done: false, error: null });
  const [backfillState, setBackfillState] = React.useState({ running: false, updated: 0, skipped: 0, done: false, error: null });
  const [catalogSyncState, setCatalogSyncState] = React.useState({ running: false, done: false, error: null, result: null });
  const [cleanupState, setCleanupState] = React.useState({ running: false, done: false, error: null, result: null });

  async function runCleanup(dryRun = true) {
    setCleanupState({ running: true, done: false, error: null, result: null });
    try {
      const url = dryRun ? '/api/cleanup-orphans?dryRun=true' : '/api/cleanup-orphans';
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        setCleanupState({ running: false, done: false, error: data.error || 'Request failed', result: null });
        return;
      }
      setCleanupState({ running: false, done: true, error: null, result: data });
    } catch (err) {
      setCleanupState({ running: false, done: false, error: err.message, result: null });
    }
  }

  async function runSync() {
    setSyncState({ running: true, total: 0, done: false, error: null });
    let cursor = null;
    let total = 0;
    try {
      for (;;) {
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

  async function runCatalogSync(forceAll = false) {
    setCatalogSyncState({ running: true, done: false, error: null, result: null });
    try {
      const res = await fetch('/api/catalog-price-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceAll }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setCatalogSyncState({ running: false, done: false, error: data.error || 'Request failed', result: null });
        return;
      }
      setCatalogSyncState({ running: false, done: true, error: null, result: data });
    } catch (err) {
      setCatalogSyncState({ running: false, done: false, error: err.message, result: null });
    }
  }

  async function runBackfill() {
    setBackfillState({ running: true, updated: 0, skipped: 0, done: false, error: null });
    let cursor = null;
    let updated = 0;
    let skipped = 0;
    try {
      for (;;) {
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
          background: 'linear-gradient(135deg, #181344 0%, #2a2360 100%)',
          borderRadius: '12px',
          padding: '32px',
          color: '#fff',
        }}>
          <div style={{ fontSize: '22px', fontWeight: '700', marginBottom: '8px' }}>
            Welcome to the Dutch Rusk Catalog Manager
          </div>
          <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: '15px', marginBottom: '24px', lineHeight: '1.6', maxWidth: '640px' }}>
            Control exactly what pack sizes and products each B2B customer can see and order —
            without touching Shopify settings manually.
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <s-button variant="primary" onClick={() => navigate("/app/catalog-manager")}>
              Open Catalog Manager
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
          <button type="button" onClick={() => navigate("/app/catalog-manager")} style={statCardStyle}>
            <div style={{ ...statNumberStyle, color: '#181344' }}>{configuredGroups}</div>
            <div style={statLabelStyle}>Customer Groups</div>
            <div style={statSubStyle}>with visibility rules active</div>
            {unconfiguredGroups > 0 && (
              <div style={{ color: '#946200', fontSize: '12px', marginTop: '8px', fontWeight: '600' }}>
                {unconfiguredGroups} not yet configured
              </div>
            )}
          </button>

          <button type="button" onClick={() => navigate("/app/audit")} style={statCardStyle}>
            <div style={{ ...statNumberStyle, color: '#2156c3' }}>{distinctOverrideProducts}</div>
            <div style={statLabelStyle}>Products with Exceptions</div>
            <div style={statSubStyle}>{totalOverrideRows} rules across {groupsWithOverrides} group{groupsWithOverrides !== 1 ? 's' : ''}</div>
          </button>

          <div style={{ ...statCardStyle, cursor: 'default' }}>
            <div style={{ ...statNumberStyle, color: '#66270f' }}>{groupsWithBlanket}</div>
            <div style={statLabelStyle}>Groups Hiding Sizes</div>
            <div style={statSubStyle}>blocking pack types for all products</div>
          </div>
        </s-stack>
      </s-section>

      {/* Pack Type Breakdown */}
      {Object.keys(packTypeBreakdown).length > 0 && (
        <s-section heading="Blocked Sizes Breakdown">
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {Object.entries(packTypeBreakdown)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <div key={type} style={{
                  padding: '12px 18px',
                  border: '1px solid #e1e3e5',
                  borderRadius: '8px',
                  background: '#f6f6f7',
                  textAlign: 'center',
                  minWidth: '100px',
                }}>
                  <div style={{ fontSize: '1.4rem', fontWeight: '700', color: '#181344' }}>{count}</div>
                  <div style={{ fontSize: '13px', fontWeight: '600', color: '#202223', marginTop: '2px' }}>{type}</div>
                  <div style={{ fontSize: '11px', color: '#6d7175', marginTop: '2px' }}>group{count !== 1 ? 's' : ''} blocking</div>
                </div>
              ))}
          </div>
        </s-section>
      )}

      {/* Getting Started — shown only when nothing is configured */}
      {configuredGroups === 0 && (
        <s-section>
          <div style={{ textAlign: 'center', padding: '40px 20px', border: '1px solid #e1e3e5', borderRadius: '8px', background: '#f6f6f7' }}>
            <div style={{ fontSize: '18px', fontWeight: '700', marginBottom: '8px' }}>Ready to get started?</div>
            <div style={{ color: '#6d7175', marginBottom: '20px' }}>
              No rules are configured yet. Open the Catalog Manager to set up your first customer group.
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
              const overrideCount = overrideCountMap[rule.catalogId] || 0;
              return (
                <s-box key={rule.id} padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <s-stack direction="inline" gap="base" align="center">
                    <s-stack direction="block" gap="extraTight" style={{ flex: 1 }}>
                      <s-text fontWeight="bold">{rule.catalogName}</s-text>
                      <s-text tone="subdued">
                        {hasTypes ? `Blocking: ${rule.hiddenVariantTypes.join(", ")}` : "No pack types blocked"}
                        {overrideCount > 0 && ` · ${overrideCount} product exception${overrideCount !== 1 ? 's' : ''}`}
                        {!hasTypes && overrideCount === 0 && " — No restrictions set"}
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
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>Step 1 — Pick a Customer Account</div>
            <s-text tone="subdued">Go to Catalog Manager and select the B2B customer to configure.</s-text>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>Step 2 — Block Entire Pack Types</div>
            <s-text tone="subdued">Use &ldquo;Manage Rules&rdquo; to hide all Shippers, Bags, etc. for that customer in one click.</s-text>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>Step 3 — Fine-Tune Per Product</div>
            <s-text tone="subdued">Use &ldquo;Product Overrides&rdquo; to adjust individual products that differ from the blanket rule.</s-text>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>Step 4 — Changes Go Live Instantly</div>
            <s-text tone="subdued">Once saved, the customer sees the updated view immediately on their next page load.</s-text>
          </s-box>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Need Help?">
        <s-text tone="subdued">Contact your Digital Lead for support with this tool.</s-text>
      </s-section>

      {/* Maintenance & Sync Tools */}
      <s-section heading="Maintenance &amp; Sync Tools">
        <s-text tone="subdued">
          Behind-the-scenes tools for keeping prices, discounts, and stored data in sync. These run
          automatically in the background — use the buttons below only for one-time setup or troubleshooting.
        </s-text>
      </s-section>

      {/* Checkout Strikethrough Sync */}
      <s-section heading="Checkout Strikethrough Prices">
        <div style={toolSectionStyle}>
          <s-text>
            B2B catalog customers see discounted prices at checkout, but Shopify doesn&apos;t
            automatically show the original retail price as a strikethrough. Click the button
            below to sync the retail price onto every variant&apos;s compare-at price — this is a
            one-time setup (or run it again after bulk price updates).
          </s-text>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <button type="button" onClick={runSync} disabled={syncState.running} style={actionButtonStyle('success', syncState.running)}>
              {syncState.running ? `Syncing… (${syncState.total} updated so far)` : 'Sync Compare-At Prices'}
            </button>
            {syncState.done && (
              <span style={{ color: '#008060', fontWeight: '600' }}>Done — {syncState.total} variant(s) updated</span>
            )}
            {syncState.error && (
              <span style={{ color: '#d72c0d', fontWeight: '600' }}>{syncState.error}</span>
            )}
          </div>
          <s-text tone="subdued">
            This sets compare_at_price = price for any variant missing a compare-at value.
            Regular customers won&apos;t see a strikethrough (price = compare-at, so Shopify hides it),
            but B2B catalog customers will see their discounted price at checkout against the retail price.
          </s-text>
        </div>
      </s-section>

      {/* Catalog Function Price Sync */}
      <s-section heading="Catalog Function Sync (Discount Records on Orders)">
        <div style={toolSectionStyle}>
          <s-text>
            Syncs your B2B catalog price lists into Shopify metafields so the
            &ldquo;B2B Catalog Discount&rdquo; Shopify Function can apply real per-line
            discounts at checkout — giving every order proper discount records
            visible in Shopify Admin and readable by Ostendo/Odoo.
            The sync runs automatically every 10 minutes and also triggers
            whenever Ostendo updates a product price.
          </s-text>
          <div style={{ ...noteBoxStyle, background: '#fff8e6', border: '1px solid #fdb714' }}>
            <strong>Before running:</strong> In Shopify Admin → Markets → Catalogs,
            set the blanket % to <strong>0%</strong> on each B2B catalog
            (and remove fixed price overrides). The Function handles all discounting.
            Run &ldquo;Force Full Sync&rdquo; first to populate all metafields, then
            create an <strong>Automatic Discount</strong> in Shopify Admin using
            the &ldquo;B2B Catalog Discount&rdquo; function.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => runCatalogSync(false)} disabled={catalogSyncState.running} style={actionButtonStyle('accent', catalogSyncState.running)}>
              {catalogSyncState.running ? 'Syncing…' : 'Sync Changed Catalogs'}
            </button>
            <button type="button" onClick={() => runCatalogSync(true)} disabled={catalogSyncState.running} style={actionButtonStyle('primary', catalogSyncState.running)}>
              Force Full Sync
            </button>
            {catalogSyncState.done && catalogSyncState.result && (
              <span style={{ color: '#008060', fontWeight: '600', fontSize: '13px' }}>
                {catalogSyncState.result.message} —{' '}
                {catalogSyncState.result.updatedCompanies} company metafield(s),{' '}
                {catalogSyncState.result.updatedVariants} variant metafield(s) written
              </span>
            )}
            {catalogSyncState.error && (
              <span style={{ color: '#d72c0d', fontWeight: '600' }}>{catalogSyncState.error}</span>
            )}
          </div>
          <s-text tone="subdued">
            &ldquo;Sync Changed Catalogs&rdquo; is fast — it skips price lists that haven&apos;t
            changed since the last run. &ldquo;Force Full Sync&rdquo; re-processes everything
            and is useful after first setup or if metafields get out of sync.
          </s-text>
        </div>
      </s-section>

      {/* Database Cleanup */}
      <s-section heading="Database Cleanup">
        <div style={toolSectionStyle}>
          <s-text>
            Remove stale database rows from catalogs that no longer exist in Shopify.
            These orphaned rows inflate your dashboard stats and waste storage.
            Run a <b>dry run</b> first to preview what would be removed.
          </s-text>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => runCleanup(true)} disabled={cleanupState.running} style={actionButtonStyle('accent', cleanupState.running)}>
              {cleanupState.running ? 'Scanning…' : 'Preview Orphaned Rows'}
            </button>
            {cleanupState.result?.dryRun === true && (cleanupState.result.orphanedRuleCount > 0 || cleanupState.result.totalOrphanedOverrides > 0) && (
              <button type="button" onClick={() => runCleanup(false)} disabled={cleanupState.running} style={actionButtonStyle('danger', false)}>
                Delete Orphaned Rows
              </button>
            )}
          </div>
          {cleanupState.result?.dryRun === true && (
            <div style={{ ...noteBoxStyle, background: '#f0f7ff', border: '1px solid #b4d4ff' }}>
              <b>Dry run result:</b> Found <b>{cleanupState.result.orphanedRuleCount}</b> orphaned catalog rule(s)
              and <b>{cleanupState.result.totalOrphanedOverrides}</b> orphaned product override(s).
              {cleanupState.result.orphanedRules.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  Stale catalogs: {cleanupState.result.orphanedRules.map(r => r.catalogName || r.catalogId).join(', ')}
                </div>
              )}
              {cleanupState.result.orphanedRuleCount === 0 && cleanupState.result.totalOrphanedOverrides === 0 && (
                <div style={{ marginTop: '4px', color: '#008060' }}>No orphaned rows found — database is clean.</div>
              )}
            </div>
          )}
          {cleanupState.result?.dryRun === false && (
            <div style={{ ...noteBoxStyle, background: '#f1f8f5', border: '1px solid #95c9b4', color: '#008060' }}>
              Deleted <b>{cleanupState.result.deletedRules}</b> catalog rule(s)
              and <b>{cleanupState.result.deletedOverrides}</b> product override(s).
            </div>
          )}
          {cleanupState.error && (
            <span style={{ color: '#d72c0d', fontWeight: '600' }}>{cleanupState.error}</span>
          )}
        </div>
      </s-section>

      {/* B2B Order Discount Records */}
      <s-section heading="B2B Discount Records on Orders">
        <div style={toolSectionStyle}>
          <s-text>
            Shopify&apos;s B2B catalog pricing silently lowers prices — no discount records appear on
            orders, so ERPs (Ostendo, Odoo, etc.) can&apos;t see what discount was applied.
            From now on, every new B2B order is automatically enriched with discount details
            under &ldquo;Additional Details&rdquo; on the order page. Use the button below to backfill
            the last 365 days of existing orders.
          </s-text>
          <div style={{ ...noteBoxStyle, background: '#f0f7ff', border: '1px solid #b4d4ff', color: '#1a4a8a' }}>
            <strong>How it works:</strong> For each order line, the app compares the
            B2B price paid against the retail compare-at price to calculate the exact
            saving per item. This is written to the order as &ldquo;Additional Details&rdquo; —
            visible on the Shopify Admin order page and readable by any ERP via the
            Shopify Orders API (<code>note_attributes</code> field).
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <button type="button" onClick={runBackfill} disabled={backfillState.running} style={actionButtonStyle('primary', backfillState.running)}>
              {backfillState.running
                ? `Backfilling… (${backfillState.updated} updated, ${backfillState.skipped} no-discount)`
                : 'Backfill Discount Records (last 365 days)'}
            </button>
            {backfillState.done && (
              <span style={{ color: '#008060', fontWeight: '600' }}>
                Done — {backfillState.updated} order(s) updated, {backfillState.skipped} had no B2B discount
              </span>
            )}
            {backfillState.error && (
              <span style={{ color: '#d72c0d', fontWeight: '600' }}>{backfillState.error}</span>
            )}
          </div>
          <s-text tone="subdued">
            New orders are handled automatically — this button is only needed once
            for historical orders, or after re-running the compare-at sync.
            Run &ldquo;Sync Compare-At Prices&rdquo; first if you haven&apos;t already.
          </s-text>
        </div>
      </s-section>

    </s-page>
  );
}
