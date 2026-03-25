import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const [overrides, catalogs] = await Promise.all([
      prisma.productOverride.findMany(),
      prisma.catalogRule.findMany()
    ]);

    const catalogMap = catalogs.reduce((acc, cat) => {
      acc[cat.catalogId] = cat.catalogName;
      return acc;
    }, {});

    // --- DEBUG DATA ---
    const rawDbCount = overrides.length;
    const sampleIds = overrides.slice(0, 5).map(o => o.productId);
    // ------------------

    const reportData = {};
    
    overrides.forEach((o) => {
      if (o.productId === 'GLOBAL_MIGRATION' || !o.productId) return;

      let fullGid = o.productId;
      if (!o.productId.toString().startsWith("gid://")) {
        fullGid = `gid://shopify/Product/${o.productId}`;
      }

      if (!reportData[fullGid]) {
        reportData[fullGid] = {
          productId: fullGid,
          catalogs: [],
          hiddenVariantIds: [], // Keep track of GIDs for mapping
          variantNames: "Loading...",
          title: "Product ID: " + fullGid.split("/").pop()
        };
      }
      
      const catName = catalogMap[o.catalogId] || `Catalog ${o.catalogId}`;
      if (!reportData[fullGid].catalogs.includes(catName)) {
        reportData[fullGid].catalogs.push(catName);
      }
      
      // Store variant IDs to match against GraphQL results
      if (o.hiddenVariantIds) {
        reportData[fullGid].hiddenVariantIds = [
          ...new Set([...reportData[fullGid].hiddenVariantIds, ...o.hiddenVariantIds])
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
              variants(first: 50) {
                nodes {
                  id
                  title
                }
              }
            }
          }
        }`,
        { variables: { ids: productGids } }
      );
      
      const resJson = await response.json();
      if (!resJson.errors && resJson.data?.nodes) {
        resJson.data.nodes.forEach(node => {
          if (node && node.id && reportData[node.id]) {
            reportData[node.id].title = node.title;
            
            // Map the hidden GIDs to their actual titles (e.g., "Bag", "Shipper")
            const names = reportData[node.id].hiddenVariantIds.map(hiddenId => {
              const match = node.variants.nodes.find(v => v.id === hiddenId);
              return match ? match.title : "Unknown Variant";
            });
            
            reportData[node.id].variantNames = names.length > 0 ? names.join(", ") : "None";
          }
        });
      }
    }

    const formattedReport = Object.values(reportData).sort((a, b) => a.title.localeCompare(b.title));

    return { 
      report: formattedReport, 
      error: null,
      debug: { rawDbCount, sampleIds } 
    };
  } catch (error) {
    console.error("Audit Loader Fatal Error:", error);
    return { report: [], error: error.message };
  }
}

export default function AuditReport() {
  const { report, error, debug } = useLoaderData();
  const navigate = useNavigate();

  const downloadCSV = () => {
    const headers = ["Product Title", "Product ID", "Hidden Variant Names", "Hidden In Catalogs"];
    const rows = report.map(item => [
      `"${item.title.replace(/"/g, '""')}"`,
      item.productId.split("/").pop(),
      `"${item.variantNames.replace(/"/g, '""')}"`,
      `"${item.catalogs.join(", ")}"`
    ]);

    const csvContent = [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `Worthy_Visibility_Audit_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <s-page heading="Global Audit Report" back-action-url="/app/catalog-manager">
      <s-layout>
        <s-layout-section>
          <s-box padding="base" background="highlight" style={{ marginBottom: "20px", border: "1px solid #e1e3e5" }}>
            <s-block-stack gap="tight">
              <s-text fontWeight="bold">Database Status:</s-text>
              <s-text>Total Raw records in DB: {debug?.rawDbCount || 0}</s-text>
            </s-block-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base" background="surface">
            <s-block-stack gap="base">
              
              <s-stack direction="inline" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <div>
                  <s-text variant="headingMd" as="h2">Visibility Overview ({report.length} Products)</s-text>
                  <s-text color="subdued">Detailed view of hidden variants per catalog.</s-text>
                </div>
                <s-button variant="primary" tone="success" onClick={downloadCSV} disabled={report.length === 0}>
                  Download CSV
                </s-button>
              </s-stack>

              {error && <s-banner tone="critical">{error}</s-banner>}

              {report.length === 0 ? (
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-text>No active overrides found in the database.</s-text>
                </s-box>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid #ccc" }}>
                        <th style={{ padding: "12px 8px" }}>Product Title</th>
                        <th style={{ padding: "12px 8px" }}>Hidden Variants</th>
                        <th style={{ padding: "12px 8px" }}>Restricted Catalogs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.map((item, index) => (
                        <tr key={item.productId} style={{ borderBottom: "1px solid #eee", backgroundColor: index % 2 === 0 ? "#fff" : "#f9fafb" }}>
                          <td style={{ padding: "12px 8px", fontWeight: "500", maxWidth: "300px" }}>{item.title}</td>
                          <td style={{ padding: "12px 8px" }}>
                            <s-text color="critical" fontWeight="bold">
                              {item.variantNames}
                            </s-text>
                          </td>
                          <td style={{ padding: "12px 8px" }}>
                            <s-stack direction="inline" gap="tight" style={{ flexWrap: "wrap" }}>
                              {item.catalogs.map(cat => (
                                <span key={cat} style={{ background: "#e4e5e7", padding: "4px 8px", borderRadius: "4px", fontSize: "12px" }}>
                                  {cat}
                                </span>
                              ))}
                            </s-stack>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </s-block-stack>
          </s-box>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}