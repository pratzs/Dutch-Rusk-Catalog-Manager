import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function HelpPage() {
  const cardStyle = {
    background: '#fff',
    border: '1px solid #e1e3e5',
    borderRadius: '12px',
    padding: '24px',
    marginBottom: '20px',
  };

  const stepStyle = {
    display: 'flex',
    gap: '16px',
    alignItems: 'flex-start',
    marginBottom: '16px',
  };

  const stepNumStyle = {
    minWidth: '32px',
    height: '32px',
    borderRadius: '50%',
    background: '#008060',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: '700',
    fontSize: '14px',
    flexShrink: 0,
  };

  const badgeStyle = (color) => ({
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: '600',
    background: color === 'red' ? '#ffd2d2' : color === 'green' ? '#d3f5e6' : color === 'yellow' ? '#fff3cd' : '#f1f1f1',
    color: color === 'red' ? '#d72c0d' : color === 'green' ? '#008060' : color === 'yellow' ? '#8a6116' : '#444',
    marginRight: '6px',
  });

  const warningBoxStyle = {
    background: '#fff3cd',
    border: '1px solid #f0c040',
    borderRadius: '8px',
    padding: '12px 16px',
    fontSize: '13px',
    color: '#5c4813',
    marginTop: '12px',
  };

  const tipBoxStyle = {
    background: '#d3f5e6',
    border: '1px solid #95d8b8',
    borderRadius: '8px',
    padding: '12px 16px',
    fontSize: '13px',
    color: '#1a5c40',
    marginTop: '12px',
  };

  const sectionHeading = {
    fontSize: '18px',
    fontWeight: '700',
    marginBottom: '6px',
    color: '#1a1a2e',
  };

  const sectionSubheading = {
    fontSize: '13px',
    color: '#6d7175',
    marginBottom: '20px',
  };

  const divider = {
    border: 'none',
    borderTop: '1px solid #e1e3e5',
    margin: '20px 0',
  };

  return (
    <s-page heading="Help & Quick Guide">

      {/* Intro banner */}
      <s-section>
        <div style={{
          background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
          borderRadius: '12px',
          padding: '28px 32px',
          color: '#fff',
          marginBottom: '8px',
        }}>
          <div style={{ fontSize: '20px', fontWeight: '700', marginBottom: '8px' }}>
            📖 Admin Quick Reference Guide
          </div>
          <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: '14px', lineHeight: '1.7' }}>
            Everything you need to know to manage the Dutch Rusk B2B catalog — in one place.
            This guide covers the three most common tasks you&apos;ll perform.
          </div>
        </div>
      </s-section>

      {/* How the app works — mental model */}
      <s-section>
        <div style={cardStyle}>
          <div style={sectionHeading}>🧠 How the App Works — The Big Picture</div>
          <div style={sectionSubheading}>Read this first so the rest makes sense.</div>

          <p style={{ fontSize: '14px', lineHeight: '1.8', color: '#3a3a3a', marginBottom: '16px' }}>
            Each B2B customer in Shopify has their own <strong>Catalog</strong> — a list of products they can see and order.
            This app lets you control <em>which pack sizes</em> each customer can see, without changing anything in Shopify directly.
          </p>

          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <div style={{ flex: '1', minWidth: '200px', background: '#f6f6f7', borderRadius: '8px', padding: '16px' }}>
              <div style={{ fontWeight: '700', marginBottom: '6px', fontSize: '14px' }}>🚫 Pack Type Rules</div>
              <div style={{ fontSize: '13px', color: '#444', lineHeight: '1.6' }}>
                Hide an <em>entire category</em> of pack sizes for a customer.
                Example: block all &ldquo;Shipper&rdquo; sizes so they never see bulk cases.
              </div>
            </div>
            <div style={{ flex: '1', minWidth: '200px', background: '#f6f6f7', borderRadius: '8px', padding: '16px' }}>
              <div style={{ fontWeight: '700', marginBottom: '6px', fontSize: '14px' }}>🎯 Product Overrides</div>
              <div style={{ fontSize: '13px', color: '#444', lineHeight: '1.6' }}>
                Fine-tune <em>individual products</em>. Show or hide specific variants
                for a customer — even if a blanket rule is in place.
              </div>
            </div>
            <div style={{ flex: '1', minWidth: '200px', background: '#f6f6f7', borderRadius: '8px', padding: '16px' }}>
              <div style={{ fontWeight: '700', marginBottom: '6px', fontSize: '14px' }}>📋 Copy Rules</div>
              <div style={{ fontSize: '13px', color: '#444', lineHeight: '1.6' }}>
                Copy a fully configured customer&apos;s rules to another customer.
                Great for setting up new accounts quickly.
              </div>
            </div>
          </div>

          <div style={tipBoxStyle}>
            💡 <strong>Rule of thumb:</strong> Use Pack Type Rules for broad restrictions, then use Product Overrides only for exceptions to those rules.
          </div>
        </div>
      </s-section>

      {/* Task 1 */}
      <s-section>
        <div style={cardStyle}>
          <div style={sectionHeading}>Task 1 — Block a Pack Type for a Customer</div>
          <div style={sectionSubheading}>Use this when a customer should never see an entire category of pack sizes (e.g. no Shippers, no Bags).</div>

          <div style={stepStyle}>
            <div style={stepNumStyle}>1</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Go to <strong>Catalog Manager</strong> in the top navigation.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>2</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Find the customer account in the list. Click <strong>Manage Rules</strong> next to their name.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>3</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              You&apos;ll see a list of pack types: Shipper, Bag, Block, Packet, Each, Outer.
              <strong> Tick the checkbox</strong> next to any type you want to <strong>hide</strong> for this customer.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>4</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Click <strong>Save Rules</strong>. The change is live instantly.
            </div>
          </div>

          <hr style={divider} />

          <div style={{ fontSize: '13px', color: '#444' }}>
            <strong>What you&apos;ll see on the Catalog Manager list after saving:</strong><br />
            <span style={badgeStyle('red')}>🚫 Shipper</span>
            <span style={badgeStyle('red')}>🚫 Bag</span>
            <span style={{ fontSize: '13px', color: '#6d7175' }}>— red badges for each blocked type.</span>
          </div>

          <div style={warningBoxStyle}>
            ⚠️ <strong>Important:</strong> Ticking a pack type hides ALL products of that type for this customer — with no exceptions unless you add a Product Override (see Task 2).
          </div>
        </div>
      </s-section>

      {/* Task 2 */}
      <s-section>
        <div style={cardStyle}>
          <div style={sectionHeading}>Task 2 — Show or Hide a Specific Product</div>
          <div style={sectionSubheading}>Use this when you need to make an exception — showing or hiding one product regardless of the blanket rules.</div>

          <div style={stepStyle}>
            <div style={stepNumStyle}>1</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Go to <strong>Catalog Manager</strong> and find the customer account.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>2</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Click <strong>Product Overrides</strong> next to their name (not &ldquo;Manage Rules&rdquo;).
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>3</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Use the <strong>Search</strong> box to find the product by name.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>4</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Each pack size variant shows as a checkbox.{' '}
              <span style={badgeStyle('green')}>✓ Ticked = Visible</span>
              <span style={badgeStyle('red')}>Unticked = Hidden</span><br />
              Tick or untick the variants you want to change.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>5</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Click <strong>Save All Changes</strong> in the sticky bar at the top of the page.
              You&apos;ll see <span style={badgeStyle('yellow')}>Custom rule saved</span> appear on the product.
            </div>
          </div>

          <hr style={divider} />

          <div style={{ fontSize: '13px', color: '#444', lineHeight: '1.7' }}>
            <strong>Bulk tip:</strong> Use <strong>Hide All</strong> or <strong>Show All</strong> buttons
            to change everything at once, then untick/tick only the exceptions. Much faster than doing them one by one.
          </div>

          <div style={warningBoxStyle}>
            ⚠️ <strong>Don&apos;t forget to save!</strong> If you navigate away without clicking Save, your changes will be lost.
            The page will warn you if you try to leave with unsaved changes.
          </div>
        </div>
      </s-section>

      {/* Task 3 */}
      <s-section>
        <div style={cardStyle}>
          <div style={sectionHeading}>Task 3 — Copy Rules from One Customer to Another</div>
          <div style={sectionSubheading}>Use this when setting up a new customer account that should have the same restrictions as an existing one.</div>

          <div style={stepStyle}>
            <div style={stepNumStyle}>1</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Click <strong>Copy Rules</strong> in the top navigation.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>2</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Under <em>&ldquo;Copy rules FROM this account&rdquo;</em>, select the customer whose rules are already set up correctly.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>3</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Under <em>&ldquo;Apply rules TO this account&rdquo;</em>, select the new customer you want to configure.
            </div>
          </div>
          <div style={stepStyle}>
            <div style={stepNumStyle}>4</div>
            <div style={{ fontSize: '14px', lineHeight: '1.7' }}>
              Review the preview box, then click <strong>Copy Rules</strong>. Done — all pack type rules and product exceptions are copied instantly.
            </div>
          </div>

          <div style={warningBoxStyle}>
            ⚠️ <strong>This replaces all existing rules on the destination account.</strong> If the new customer already has rules configured, they will be overwritten. Only use this on a fresh or empty account — or when you intentionally want to reset them to match another customer.
          </div>

          <div style={tipBoxStyle}>
            💡 After copying, you can use Product Overrides to make any small adjustments specific to that customer.
          </div>
        </div>
      </s-section>

      {/* Status badge legend */}
      <s-section>
        <div style={cardStyle}>
          <div style={sectionHeading}>🏷️ Badge Reference — What Do the Colours Mean?</div>
          <div style={sectionSubheading}>A quick legend for the coloured labels you&apos;ll see throughout the app.</div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e1e3e5' }}>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6d7175', fontWeight: '600' }}>Badge</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6d7175', fontWeight: '600' }}>Where you see it</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: '#6d7175', fontWeight: '600' }}>What it means</th>
              </tr>
            </thead>
            <tbody>
              {[
                { badge: badgeStyle('red'), label: '🚫 Shipper', location: 'Catalog Manager list', meaning: 'This pack type is blocked for this customer' },
                { badge: badgeStyle('red'), label: 'All hidden', location: 'Product Overrides', meaning: 'Every variant of this product is hidden' },
                { badge: badgeStyle('red'), label: 'Partial restriction', location: 'Product Overrides', meaning: 'Some (not all) variants are hidden' },
                { badge: badgeStyle('yellow'), label: 'Custom rule saved', location: 'Product Overrides', meaning: 'A product-level override is saved for this product' },
                { badge: badgeStyle('yellow'), label: '✏️ 3 product exception(s)', location: 'Catalog Manager list', meaning: 'This customer has 3 individual product overrides' },
                { badge: null, label: 'Not configured', location: 'Catalog Manager list', meaning: 'No rules have been set up for this customer yet' },
                { badge: { display: 'inline-block', padding: '2px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: '600', background: '#ff8c00', color: '#fff', marginRight: '6px' }, label: 'Unsaved changes', location: 'Product Overrides', meaning: 'You have changes that haven\'t been saved yet' },
              ].map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f1f1' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={row.badge || badgeStyle('gray')}>{row.label}</span>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6d7175' }}>{row.location}</td>
                  <td style={{ padding: '10px 12px', color: '#3a3a3a' }}>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>

      {/* FAQ */}
      <s-section>
        <div style={cardStyle}>
          <div style={sectionHeading}>❓ Common Questions</div>
          <div style={{ fontSize: '14px', lineHeight: '1.8', color: '#3a3a3a' }}>

            <div style={{ marginBottom: '20px' }}>
              <strong>Q: I hid a product using a Pack Type Rule, but it still shows in the Audit Report as &ldquo;no custom rules&rdquo;. Is that a bug?</strong><br />
              <span style={{ color: '#444' }}>No — the Audit Report only shows <em>Product Override</em> exceptions, not blanket pack type blocks. If a product is hidden by a pack type rule, it won&apos;t appear in the report. That&apos;s expected behaviour.</span>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <strong>Q: I saved changes but the customer says they can still see the product. What&apos;s wrong?</strong><br />
              <span style={{ color: '#444' }}>Check the Catalog Manager — make sure you saved against the <em>correct</em> customer account. Also check that the product is actually in that customer&apos;s Shopify catalog (assigned in Shopify B2B settings), not just visible in this app.</span>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <strong>Q: Can I undo a save?</strong><br />
              <span style={{ color: '#444' }}>Not automatically. You&apos;ll need to manually revert the changes. If you&apos;re unsure, use the Audit Report first to check what&apos;s currently configured before making changes.</span>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <strong>Q: A new customer account isn&apos;t appearing in the list. What do I do?</strong><br />
              <span style={{ color: '#444' }}>New B2B catalogs created in Shopify Admin will appear automatically. If it&apos;s not showing, check that it was created as a B2B catalog in Shopify — not just a regular price list.</span>
            </div>

            <div style={{ marginBottom: '0' }}>
              <strong>Q: Who do I contact if something goes wrong?</strong><br />
              <span style={{ color: '#444' }}>Contact your <strong>Digital Lead</strong> for support with this tool.</span>
            </div>

          </div>
        </div>
      </s-section>

    </s-page>
  );
}
