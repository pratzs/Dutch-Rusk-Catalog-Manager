import { Form, useActionData, useLoaderData, redirect } from "react-router";
import { DrAuthPage, Note, SubmitButton, storefrontUrl } from "../components/DrAuth";

async function findTokenRow(rawToken) {
  const { sha256Hex } = await import("../lib/crypto.server");
  const { default: prisma } = await import("../db.server");
  const tokenHash = sha256Hex(rawToken);
  return await prisma.b2BPasswordResetToken.findUnique({ where: { tokenHash } });
}

// Sign-in pages are never cached: a stored copy could show an old page or an old sign-in.
export const headers = () => ({ "Cache-Control": "no-store" });
export const meta = () => [{ title: "Choose a new password | Dutch Rusk" }, { name: "robots", content: "noindex" }];

export const loader = async ({ params }) => {
  const { default: prisma } = await import("../db.server");
  const row = await findTokenRow(params.token);
  if (!row || row.usedAt || row.expiresAt < new Date() || row.purpose !== "reset") {
    return { valid: false, user: null, storefront: storefrontUrl() };
  }
  const user = await prisma.b2BUser.findUnique({ where: { id: row.userId } });
  if (!user) return { valid: false, user: null, storefront: storefrontUrl() };
  return { valid: true, user: { username: user.username, storeDisplayName: user.storeDisplayName } };
};

export const action = async ({ params, request }) => {
  const { default: prisma } = await import("../db.server");
  const { hashPassword, consumeToken } = await import("../lib/b2b-auth.server");
  const row = await findTokenRow(params.token);
  if (!row || row.usedAt || row.expiresAt < new Date() || row.purpose !== "reset") {
    return { error: "This link has expired. Please ask for a new one." };
  }
  const form = await request.formData();
  const pw = String(form.get("password") || "");
  const pw2 = String(form.get("password2") || "");
  if (pw.length < 8) return { error: "Your password needs at least 8 characters." };
  if (pw !== pw2) return { error: "The two passwords don't match. Please type them again." };

  const consumed = await consumeToken(params.token, "reset");
  if (!consumed) return { error: "This link has expired. Please ask for a new one." };

  const hash = await hashPassword(pw);
  await prisma.b2BUser.update({
    where: { id: row.userId },
    data: { passwordHash: hash, status: "active" },
  });
  return redirect("/oidc/reset-done");
};

export default function ResetPage() {
  const { valid, user, storefront } = useLoaderData();
  const actionData = useActionData();
  if (!valid) {
    return (
      <DrAuthPage title="This link has expired" intro="The link has already been used or is more than 24 hours old. You can ask for a new one.">
        <a className="dra-btn dra-btn--primary" href="/oidc/forgot">Send me a new link</a>
      </DrAuthPage>
    );
  }
  return (
    <DrAuthPage title="Choose a new password" intro="You'll use this with your store's email address to sign in.">
      <p className="dra-store">Store: <strong>{user.storeDisplayName}</strong></p>
      <Note kind="error">{actionData?.error}</Note>
      <Form method="post" className="dra-form">
        <div className="dra-field">
          <label className="dra-label" htmlFor="password">New password</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- first field on this screen */}
          <input id="password" name="password" type="password" className="dra-input" minLength={8} autoComplete="new-password" required autoFocus />
          <p className="dra-hint">At least 8 characters.</p>
        </div>
        <div className="dra-field">
          <label className="dra-label" htmlFor="password2">Type it again</label>
          <input id="password2" name="password2" type="password" className="dra-input" minLength={8} autoComplete="new-password" required />
        </div>
        <SubmitButton busyText="Saving...">Save password</SubmitButton>
      </Form>
    </DrAuthPage>
  );
}
