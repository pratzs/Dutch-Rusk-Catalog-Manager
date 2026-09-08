import React from 'react';
import { useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  // Nothing to load. The variant-hiding feature has been removed: pack-size
  // restrictions are now Shopify's own variant-level publishing, so there are
  // no rules, overrides or "blocked sizes" figures left for this page to
  // report. What remains on it is the price and strikethrough sync tooling,
  // which is all driven client-side from the buttons below.
  await authenticate.admin(request);
  return {};
};


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
  const navigate = useNavigate();
  const [syncState, setSyncState] = React.useState({ running: false, total: 0, done: false, error: null });
  const [backfillState, setBackfillState] = React.useState({ running: false, updated: 0, skipped: 0, done: false, error: null });
  const [catalogSyncState, setCatalogSyncState] = React.useState({ running: false, done: false, error: null, result: null });


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
            Catalog pricing, checkout strikethrough prices and BOGO bundles for the B2B store.
            Pack size visibility is handled by Shopify catalogs directly.
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <s-button variant="primary" onClick={() => navigate("/app/catalog-manager")}>
              Open Catalog Manager
            </s-button>
          </div>
        </div>
      </s-section>



      <s-section slot="aside" heading="How Pack Sizes Work Now">
        <s-stack direction="block" gap="tight">
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>Shopify controls this directly</div>
            <s-text tone="subdued">Pack sizes a customer may not order are excluded from their catalog in Shopify itself, under Catalogs. Shopify enforces it, so the excluded size never appears and cannot be added to a cart.</s-text>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>Where to change it</div>
            <s-text tone="subdued">Open the catalog in Shopify, find the product, and use Exclude from catalog on the individual variant. This app no longer holds visibility rules.</s-text>
          </s-box>
          <s-box padding="base" borderRadius="base" background="subdued">
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>New products need excluding</div>
            <s-text tone="subdued">A product published to a catalog arrives with every pack size visible, so exclude the ones that customer should not see when you add it.</s-text>
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
