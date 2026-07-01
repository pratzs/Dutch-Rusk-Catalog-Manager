import { useState, useMemo } from "react";
import { useLoaderData, useSubmit, useNavigate, useNavigation } from "react-router";

export async function loader({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { default: prisma } = await import("../db.server");
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const group = url.searchParams.get("group") || "";

  const where = { shop, ...(group ? { catalogGroup: group } : {}) };
  const [users, groupsRaw, statusCountsRaw] = await Promise.all([
    prisma.b2BUser.findMany({
      where,
      orderBy: [{ catalogGroup: "asc" }, { username: "asc" }],
      take: 500,
    }),
    prisma.b2BUser.groupBy({ by: ["catalogGroup"], where: { shop }, _count: { _all: true } }),
    prisma.b2BUser.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
  ]);

  const groups = groupsRaw
    .map((g) => ({ name: g.catalogGroup, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  const statusCounts = statusCountsRaw.reduce((acc, s) => {
    acc[s.status] = s._count._all;
    return acc;
  }, {});

  return { users, groups, statusCounts, selectedGroup: group };
}

export async function action({ request }) {
  const { authenticate } = await import("../shopify.server");
  const { default: prisma } = await import("../db.server");
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const ids = form.getAll("userId").map(String);
  if (ids.length === 0) return { error: "Select at least one customer." };

  if (intent === "disable") {
    await prisma.b2BUser.updateMany({
      where: { shop, id: { in: ids } },
      data: { status: "disabled" },
    });
    return { ok: `Disabled ${ids.length} account(s).` };
  }
  if (intent === "enable") {
    await prisma.b2BUser.updateMany({
      where: { shop, id: { in: ids } },
      data: { status: "active" },
    });
    return { ok: `Re-enabled ${ids.length} account(s).` };
  }
  if (intent === "send_invite" || intent === "send_reset") {
    const { sendBulkInvites } = await import("../lib/bulk-invite.server");
    const result = await sendBulkInvites({ shop, userIds: ids, purpose: intent === "send_reset" ? "reset" : "invite" });
    return { ok: `Sent ${result.sent}/${ids.length}. Failed: ${result.failed}.`, failures: result.failures };
  }
  return { error: "Unknown action." };
}

export default function CustomersIndex() {
  const { users, groups, statusCounts, selectedGroup } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const [selected, setSelected] = useState(new Set());
  const allIds = useMemo(() => users.map((u) => u.id), [users]);
  const total = groups.reduce((s, g) => s + g.count, 0);

  const toggleAll = () => {
    if (selected.size === users.length) setSelected(new Set());
    else setSelected(new Set(allIds));
  };
  const toggleOne = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const doBulk = (intent) => {
    if (selected.size === 0) return;
    const fd = new FormData();
    fd.set("intent", intent);
    for (const id of selected) fd.append("userId", id);
    submit(fd, { method: "post" });
    setSelected(new Set());
  };

  const tabs = [
    { key: "", label: "All", count: total },
    ...groups.map((g) => ({ key: g.name, label: g.name, count: g.count })),
  ];

  return (
    <s-page heading="B2B Customers"
      action-label="Import from CSV" action-url="/app/customers/import">

      <s-section>
        <s-stack direction="inline" gap="base">
          <s-badge>Invited: {statusCounts.invited || 0}</s-badge>
          <s-badge tone="success">Active: {statusCounts.active || 0}</s-badge>
          <s-badge tone="critical">Disabled: {statusCounts.disabled || 0}</s-badge>
          <s-badge tone="info">Total: {total}</s-badge>
        </s-stack>
      </s-section>

      <s-section heading="Customer groups">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {tabs.map((t) => {
            const isActive = t.key === selectedGroup;
            return (
              <button
                key={t.key || "__all"}
                onClick={() => navigate(t.key ? `/app/customers?group=${encodeURIComponent(t.key)}` : "/app/customers")}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: "1px solid " + (isActive ? "#111827" : "#d1d5db"),
                  background: isActive ? "#111827" : "white",
                  color: isActive ? "white" : "#111827",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t.label} <span style={{ opacity: 0.7 }}>({t.count})</span>
              </button>
            );
          })}
        </div>
      </s-section>

      {users.length === 0 ? (
        <s-section>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-text>No customers imported yet for this group.</s-text>{" "}
            <s-link href="/app/customers/import">Start the import</s-link>
          </s-box>
        </s-section>
      ) : (
        <s-section heading={selectedGroup ? `${selectedGroup} (${users.length})` : `All customers (${users.length})`}>
          <s-stack direction="inline" gap="tight">
            <s-button disabled={busy || selected.size === 0} onClick={() => doBulk("send_invite")}>
              Send invite ({selected.size})
            </s-button>
            <s-button disabled={busy || selected.size === 0} variant="secondary" onClick={() => doBulk("send_reset")}>
              Send password reset
            </s-button>
            <s-button disabled={busy || selected.size === 0} variant="secondary" onClick={() => doBulk("disable")}>
              Disable
            </s-button>
            <s-button disabled={busy || selected.size === 0} variant="secondary" onClick={() => doBulk("enable")}>
              Re-enable
            </s-button>
          </s-stack>

          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
            <thead>
              <tr style={{ background: "#f6f6f7", textAlign: "left", fontSize: 12 }}>
                <th style={cellHead}><input type="checkbox" checked={selected.size === users.length && users.length > 0} onChange={toggleAll} /></th>
                <th style={cellHead}>Username</th>
                <th style={cellHead}>Store</th>
                <th style={cellHead}>Email</th>
                <th style={cellHead}>Group</th>
                <th style={cellHead}>Status</th>
                <th style={cellHead}>Last login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid #e5e7eb", fontSize: 13 }}>
                  <td style={cell}><input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleOne(u.id)} /></td>
                  <td style={cell}><strong>{u.username}</strong></td>
                  <td style={cell}>{u.storeDisplayName}</td>
                  <td style={cell}>{u.email}</td>
                  <td style={cell}>{u.catalogGroup}</td>
                  <td style={cell}>
                    <span style={statusBadge(u.status)}>{u.status}</span>
                  </td>
                  <td style={cell}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length >= 500 ? (
            <s-text tone="subdued">Showing first 500 rows. Filter by group above to narrow.</s-text>
          ) : null}
        </s-section>
      )}
    </s-page>
  );
}

const cellHead = { padding: "8px 10px", fontWeight: 600, borderBottom: "1px solid #e5e7eb" };
const cell = { padding: "8px 10px" };
function statusBadge(status) {
  const base = { padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600 };
  if (status === "active") return { ...base, background: "#dcfce7", color: "#166534" };
  if (status === "disabled") return { ...base, background: "#fee2e2", color: "#991b1b" };
  return { ...base, background: "#fef3c7", color: "#92400e" };
}
