import { Form, useActionData } from "react-router";
import { DrAuthPage, Note, SubmitButton } from "../components/DrAuth";

function shopFromEnv() {
  return process.env.SHOP_DOMAIN || "dutchrusk.myshopify.com";
}

// Sign-in pages are never cached: a stored copy could show an old page or an old sign-in.
export const headers = () => ({ "Cache-Control": "no-store" });
export const meta = () => [{ title: "Forgotten your password? | Dutch Rusk" }, { name: "robots", content: "noindex" }];

export const action = async ({ request }) => {
  const { findUsersByEmail, findUserByUsername, createResetToken } = await import("../lib/b2b-auth.server");
  const { sendB2BReset } = await import("../lib/brevo.server");
  const shop = shopFromEnv();
  const form = await request.formData();
  const identifier = String(form.get("identifier") || "").trim().toLowerCase();
  if (!identifier) return { error: "Please enter your store's email address." };

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
  if (actionData?.sent) {
    return (
      <DrAuthPage title="Check your email" intro="If there's a Dutch Rusk account for that email, we've sent a link to choose a new password. The link works for 24 hours. If you can't see it, check your junk or spam folder.">
        <a className="dra-btn dra-btn--secondary" href="/oidc/login">Back to sign in</a>
      </DrAuthPage>
    );
  }
  return (
    <DrAuthPage title="Forgotten your password?" intro="Enter the email address for your store and we'll email you a link to choose a new one.">
      <Note kind="error">{actionData?.error}</Note>
      <Form method="post" className="dra-form">
        <div className="dra-field">
          <label className="dra-label" htmlFor="identifier">Store email address</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the only field on this screen */}
          <input id="identifier" name="identifier" type="email" className="dra-input" autoComplete="email" required autoFocus />
        </div>
        <SubmitButton busyText="Sending...">Email me a reset link</SubmitButton>
      </Form>
      <div className="dra-links dra-links--center">
        <a className="dra-link" href="/oidc/login">Back to sign in</a>
      </div>
    </DrAuthPage>
  );
}

// Branded error page instead of React Router's raw one.
export { DrAuthErrorBoundary as ErrorBoundary } from "../components/DrAuth";
