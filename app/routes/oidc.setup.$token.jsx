import { Form, useActionData, useLoaderData, redirect } from "react-router";

async function findTokenRow(rawToken) {
  const { sha256Hex } = await import("../lib/crypto.server");
  const { default: prisma } = await import("../db.server");
  const tokenHash = sha256Hex(rawToken);
  return await prisma.b2BPasswordResetToken.findUnique({ where: { tokenHash } });
}

export const loader = async ({ params }) => {
  const { default: prisma } = await import("../db.server");
  const row = await findTokenRow(params.token);
  if (!row || row.usedAt || row.expiresAt < new Date() || row.purpose !== "invite") {
    return { valid: false, user: null };
  }
  const user = await prisma.b2BUser.findUnique({ where: { id: row.userId } });
  if (!user) return { valid: false, user: null };
  return {
    valid: true,
    user: { username: user.username, storeDisplayName: user.storeDisplayName, email: user.email },
  };
};

export const action = async ({ params, request }) => {
  const { default: prisma } = await import("../db.server");
  const { hashPassword, consumeToken } = await import("../lib/b2b-auth.server");
  const row = await findTokenRow(params.token);
  if (!row || row.usedAt || row.expiresAt < new Date() || row.purpose !== "invite") {
    return { error: "This invite link is invalid or has expired." };
  }
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  const pw2 = String(form.get("password2") || "");
  if (pw.length < 8) return { error: "Password must be at least 8 characters." };
  if (pw !== pw2) return { error: "Passwords don't match." };

  const consumed = await consumeToken(params.token, "invite");
  if (!consumed) return { error: "This invite link is invalid or has expired." };

  const hash = await hashPassword(pw);
  await prisma.b2BUser.update({
    where: { id: row.userId },
    data: { passwordHash: hash, status: "active" },
  });

  return redirect("/oidc/setup-done");
};

export default function SetupPage() {
  const { valid, user } = useLoaderData();
  const actionData = useActionData();
  if (!valid) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Invite link is invalid</h1>
          <p>The link you used has expired or was already used. Please contact the Dutch Rusk team to receive a new invite.</p>
        </div>
      </div>
    );
  }
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Set your Dutch Rusk password</h1>
        <p style={styles.help}>
          Store: <strong>{user.storeDisplayName}</strong><br />
          Username: <strong>{user.username}</strong>
        </p>
        {actionData?.error ? <div style={styles.error}>{actionData.error}</div> : null}
        <Form method="post" style={styles.form}>
          <label style={styles.label}>New password (min 8 characters)</label>
          <input name="password" type="password" required minLength={8} style={styles.input} autoFocus />
          <label style={styles.label}>Confirm password</label>
          <input name="password2" type="password" required minLength={8} style={styles.input} />
          <button type="submit" style={styles.btn}>Save password</button>
        </Form>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#f6f6f7", display: "grid", placeItems: "center", padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  card: { width: "100%", maxWidth: 420, background: "white", borderRadius: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 32 },
  h1: { fontSize: 20, margin: 0, paddingBottom: 8 },
  help: { fontSize: 14, color: "#374151" },
  form: { display: "flex", flexDirection: "column", gap: 8, marginTop: 12 },
  label: { fontSize: 13, fontWeight: 600, marginTop: 8 },
  input: { padding: "10px 12px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 15 },
  btn: { marginTop: 16, background: "#111827", color: "white", padding: "10px 14px", border: 0, borderRadius: 6, fontSize: 15, cursor: "pointer" },
  error: { background: "#fef2f2", color: "#991b1b", padding: "10px 12px", borderRadius: 6, fontSize: 14 },
};
