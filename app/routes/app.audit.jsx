import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const [overrides, catalogs] = await Promise.all([
      prisma.productOverride.findMany(),
      prisma.catalogRule.findMany(),
    ]);

    const catalogMap = catalogs.reduce((acc, cat) => {
      acc[cat.catalogId] = cat.catalogName;
      return acc;
    }, {});

    const reportData = {};

    overrides.forEach((o) => {
      if (o.productId === "GLOBAL_MIGRATION" || !o.productId) return;

      let fullGid = o.productId;
      if (!o.productId.toString().startsWith("gid://")) {
        fullGid = `gid://shopify/Product/${o.productId}`;
      }

      if (!reportData[fullGid]) {
        reportData[fullGid] = {
          productId: fullGid,
          catalogs: [],
          hiddenVariantIds: [],
          variantNames: "Loading...",
          title: "Product ID: " + fullGid.split("/").pop(),
        };
      }

      const catName = catalogMap[o.catalogId] || `Catalog ${o.catalogId}`;
      if (!reportData[fullGid].catalogs.includes(catName)) {
        reportData[fullGid].catalogs.push(catName);
      }

      if (o.hiddenVariantIds) {
        reportData[fullGid].hiddenVariantIds = [
          ...new Set([...reportData[fullGid].hiddenVariantIds, ...o.hiddenVariantIds]),
        ];
      }
    });

    const productGids = Object.keys(reportData).slice(0, 250);

    if (productGids.length > 0) {
      const response = await admin.graphql(
        `query getProductDetails($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              variants(first: 250) {
                nodes { id title }
              }
            }
          }
        }`,
        { variables: { ids: productGids } }
      );

      const resJson = await response.json();
      if (!resJson.errors && resJson.data?.nodes) {
        resJson.data.nodes.forEach((node) => {
          if (node && node.id && reportData[node.id]) {
            reportData[node.id].title = node.title;
            const names = reportData[node.id].hiddenVariantIds.map((hiddenId) => {
              const match = node.variants.nodes.find((v) => v.id === hiddenId);
              return match ? match.title : null;
            }).filter(Boolean);
            reportData[node.id].variantNames = names.length > 0 ? names.join(", ") : "None";
          }
        });
      }
    }

    const formattedReport = Object.values(reportData).sort((a, b) =>
      a.title.localeCompare(b.title)
    );

    return { report: formattedReport, error: null };
  } catch (error) {
    console.error("Audit Loader Error:", error);
    return { report: [], error: error.message };
  }
}

export default function AuditReport() {
  const { report, error } = useLoaderData();
  const navigate = useNavigate();

  const downloadCSV = () => {
    const headers = ["Product Title", "Product ID", "Hidden Variants", "Restricted Customer Accounts"];
    const rows = report.map((item) => [
      `"${item.title.replace(/"/g, '""')}"`,
      item.productId.split("/").pop(),
      `"${item.variantNames.replace(/"/g, '""')}"`,
      `"${item.catalogs.join(", ")}"`,
    ]);

    const csvContent = [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute(
      "download",
      `Dutch_Rusk_Visibility_Audit_${new Date().toISOString().split("T")[0]}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <s-page heading="Visibility Audit Report" back-action-url="/app/catalog-manager">

      <s-section heading="What is this report?">
        <s-text>
          This shows every product that has <b>custom visibility rules</b> applied —
          including which pack sizes are hidden and which customer accounts are affected.
        </s-text>
        <s-text tone="subdued">
          Note: Products hidden by blanket pack-type rules (e.g. "hide all Shippers") are not
          listed here unless they also have a product-level override.
        </s-text>
      </s-section>

      <s-section heading={`${report.length} Product${report.length !== 1 ? 's' : ''} with Custom Rules`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
          <s-text tone="subdued">Sorted A–Z by product name</s-text>
          <s-button variant="primary" onClick={downloadCSV} disabled={report.length === 0 || undefined}>
            Download CSV
          </s-button>
        </div>

        {error && (
          <div style={{ padding: '12px', background: '#fff4f4', border: '1px solid #ffd2d2', borderRadius: '6px', color: '#d72c0d' }}>
            <b>Error loading report:</b> {error}
          </div>
        )}

        {report.length === 0 && !error ? (
          <div style={{ textAlign: 'center', padding: '40px', color: '#6d7175' }}>
            <div style={{ fontWeight: '600', fontSize: '16px' }}>No custom product rules found</div>
            <div style={{ marginTop: '6px', fontSize: '14px' }}>
              All visibility is controlled by blanket pack-type rules. Head to the Catalog Manager to configure product-level overrides.
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #c9cccf', background: '#f6f6f7' }}>
                  <th style={{ padding: '12px 14px', fontWeight: '600' }}>Product</th>
                  <th style={{ padding: '12px 14px', fontWeight: '600' }}>Hidden Pack Sizes</th>
                  <th style={{ padding: '12px 14px', fontWeight: '600' }}>Affected Customer Accounts</th>
                </tr>
              </thead>
              <tbody>
                {report.map((item, index) => (
                  <tr
                    key={item.productId}
                    style={{
                      borderBottom: '1px solid #e1e3e5',
                      background: index % 2 === 0 ? '#fff' : '#fafbfb',
                    }}
                  >
                    <td style={{ padding: '12px 14px', fontWeight: '500', maxWidth: '280px' }}>
                      {item.title}
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      {item.variantNames && item.variantNames !== "None" ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                          {item.variantNames.split(", ").map((v) => (
                            <span key={v} style={{
                              background: '#ffeaeb', color: '#d72c0d',
                              padding: '2px 8px', borderRadius: '12px',
                              fontSize: '12px', fontWeight: '600',
                            }}>
                              {v}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: '#6d7175', fontStyle: 'italic' }}>None saved</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {item.catalogs.map((cat) => (
                          <span key={cat} style={{
                            background: '#e4e5e7', padding: '2px 8px',
                            borderRadius: '12px', fontSize: '12px', fontWeight: '500',
                          }}>
                            {cat}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

    </s-page>
  );
}
