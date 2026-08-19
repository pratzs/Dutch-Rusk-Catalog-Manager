import { Form, useActionData } from "react-router";

function shopFromEnv() {
  return process.env.SHOP_DOMAIN || "dutchrusk.myshopify.com";
}

export const action = async ({ request }) => {
  const { findUsersByEmail, findUserByUsername, createResetToken } = await import("../lib/b2b-auth.server");
  const { sendB2BReset } = await import("../lib/brevo.server");
  const shop = shopFromEnv();
  const form = await request.formData();
  const identifier = String(form.get("identifier") || "").trim().toLowerCase();
  if (!identifier) return { error: "Enter your username or email." };

  const isEmail = identifier.includes("@");
  let users = [];
  if (isEmail) {
    users = await findUsersByEmail(shop, identifier);
  } else {
    const u = await findUserByUsername(shop, identifier);
    if (u) users = [u];
  }

  // Always show the same message regardless of whether we found anyone,
  // to avoid disclosing which usernames/emails exist.
  for (const user of users) {
    const raw = await createResetToken(user.id, 24);
    const url = process.env.SHOPIFY_APP_URL || "";
    const actionUrl = `${url.replace(/\/$/, "")}/oidc/reset/${raw}`;
    try {
      await sendB2BReset({
        email: user.email,
        firstName: (user.storeDisplayName || "").split(" ")[0],
        storeDisplayName: user.storeDisplayName,
        username: user.username,
        actionUrl,
        expiresInHours: 24,
      });
    } catch (err) {
      console.error("[oidc.forgot] Brevo send failed:", err.message);
    }
  }
  return { sent: true };
};

export default function ForgotPage() {
  const actionData = useActionData();
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Forgot your Dutch Rusk password?</h1>
        {actionData?.sent ? (
          <div style={styles.info}>
            If an account matches, a reset link has been sent. It expires in 24 hours.<br /><br />
            If you have multiple Dutch Rusk stores under the same email address, you&apos;ll receive a separate reset link for each — each email clearly names which store&apos;s password it resets.
          </div>
        ) : (
          <Form method="post" style={styles.form}>
            {actionData?.error ? <div style={styles.error}>{actionData.error}</div> : null}
            <label style={styles.label} htmlFor="identifier">Username or email</label>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- intentional UX, see oidc.setup.$token.jsx */}
            <input id="identifier" name="identifier" required autoFocus style={styles.input} />
            <button type="submit" style={styles.btn}>Send reset link</button>
            <a href="/oidc/login" style={styles.linkSmall}>Back to sign in</a>
          </Form>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#f6f6f7", display: "grid", placeItems: "center", padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  card: { width: "100%", maxWidth: 420, background: "white", borderRadius: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 32 },
  h1: { fontSize: 20, margin: "0 0 16px 0" },
  form: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 13, fontWeight: 600, marginTop: 8 },
  input: { padding: "10px 12px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 15 },
  btn: { marginTop: 16, background: "#111827", color: "white", padding: "10px 14px", border: 0, borderRadius: 6, fontSize: 15, cursor: "pointer" },
  linkSmall: { fontSize: 13, marginTop: 12, color: "#2563eb", textAlign: "center", textDecoration: "none" },
  info: { background: "#eff6ff", color: "#1e40af", padding: "10px 12px", borderRadius: 6, fontSize: 14 },
  error: { background: "#fef2f2", color: "#991b1b", padding: "10px 12px", borderRadius: 6, fontSize: 14 },
};
