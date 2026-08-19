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
  if (!row || row.usedAt || row.expiresAt < new Date() || row.purpose !== "reset") {
    return { valid: false, user: null };
  }
  const user = await prisma.b2BUser.findUnique({ where: { id: row.userId } });
  if (!user) return { valid: false, user: null };
  return { valid: true, user: { username: user.username, storeDisplayName: user.storeDisplayName } };
};

export const action = async ({ params, request }) => {
  const { default: prisma } = await import("../db.server");
  const { hashPassword, consumeToken } = await import("../lib/b2b-auth.server");
  const row = await findTokenRow(params.token);
  if (!row || row.usedAt || row.expiresAt < new Date() || row.purpose !== "reset") {
    return { error: "This reset link is invalid or has expired." };
  }
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  const pw2 = String(form.get("password2") || "");
  if (pw.length < 8) return { error: "Password must be at least 8 characters." };
  if (pw !== pw2) return { error: "Passwords don't match." };

  const consumed = await consumeToken(params.token, "reset");
  if (!consumed) return { error: "This reset link is invalid or has expired." };

  const hash = await hashPassword(pw);
  await prisma.b2BUser.update({
    where: { id: row.userId },
    data: { passwordHash: hash, status: "active" },
  });
  return redirect("/oidc/reset-done");
};

export default function ResetPage() {
  const { valid, user } = useLoaderData();
  const actionData = useActionData();
  if (!valid) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Reset link is invalid</h1>
          <p>The link you used has expired or was already used. Request a new one from the sign-in page.</p>
          <a href="/oidc/forgot" style={styles.btn}>Request a new reset link</a>
        </div>
      </div>
    );
  }
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Set a new password</h1>
        <p style={styles.help}>
          Store: <strong>{user.storeDisplayName}</strong><br />
          Username: <strong>{user.username}</strong>
        </p>
        {actionData?.error ? <div style={styles.error}>{actionData.error}</div> : null}
        <Form method="post" style={styles.form}>
          <label style={styles.label} htmlFor="reset-password">New password (min 8 characters)</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- intentional UX, see oidc.setup.$token.jsx */}
          <input id="reset-password" name="password" type="password" required minLength={8} style={styles.input} autoFocus />
          <label style={styles.label} htmlFor="reset-password2">Confirm password</label>
          <input id="reset-password2" name="password2" type="password" required minLength={8} style={styles.input} />
          <button type="submit" style={styles.btn}>Save new password</button>
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
  btn: { display: "inline-block", marginTop: 16, background: "#111827", color: "white", padding: "10px 18px", border: 0, borderRadius: 6, fontSize: 15, textDecoration: "none", cursor: "pointer", textAlign: "center" },
  error: { background: "#fef2f2", color: "#991b1b", padding: "10px 12px", borderRadius: 6, fontSize: 14 },
};
