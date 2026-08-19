import { Form, useActionData, useLoaderData, redirect } from "react-router";

function shopFromOidcRequest(_reqPayload) {
  // clientId in Shopify's OIDC flow is store-specific (registered per shop).
  // For phase 1 we run against one shop; SHOP_DOMAIN env pin the *.myshopify.com host.
  return process.env.SHOP_DOMAIN || "dutchrusk.myshopify.com";
}

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    null
  );
}

export const loader = async ({ request }) => {
  const { readOidcRequestPayload } = await import("../lib/oidc-request.server");
  const oidcReq = readOidcRequestPayload(request);
  if (!oidcReq) {
    return new Response("OIDC session missing or expired. Please start the login flow again from your Dutch Rusk storefront.", {
      status: 400,
      headers: { "content-type": "text/plain" },
    });
  }
  const url = new URL(request.url);
  const otpEmail = url.searchParams.get("otp_email") || "";
  const otpUserId = url.searchParams.get("otp_uid") || "";
  const preselect = url.searchParams.get("email") || oidcReq.loginHint || "";
  const error = url.searchParams.get("error") || null;
  return {
    prefillEmail: preselect,
    otpMode: Boolean(otpEmail && otpUserId),
    otpEmail,
    otpUserId,
    error,
  };
};

async function issueAuthCode({ user, oidcReq }) {
  const { randomToken } = await import("../lib/crypto.server");
  const { default: prisma } = await import("../db.server");
  const code = randomToken(32);
  await prisma.oidcAuthCode.create({
    data: {
      code,
      b2bUserId: user.id,
      customerGid: user.customerGid,
      companyLocationGid: user.companyLocationGid,
      clientId: oidcReq.clientId,
      redirectUri: oidcReq.redirectUri,
      nonce: oidcReq.nonce || null,
      scope: oidcReq.scope,
      codeChallenge: oidcReq.codeChallenge || null,
      codeChallengeMethod: oidcReq.codeChallengeMethod || null,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
  const cb = new URL(oidcReq.redirectUri);
  cb.searchParams.set("code", code);
  if (oidcReq.state) cb.searchParams.set("state", oidcReq.state);
  return cb.toString();
}

export const action = async ({ request }) => {
  const [{ default: prisma }, { readOidcRequestPayload, writeOidcSessionCookie }, authLib, brevo] = await Promise.all([
    import("../db.server"),
    import("../lib/oidc-request.server"),
    import("../lib/b2b-auth.server"),
    import("../lib/brevo.server"),
  ]);
  const {
    findUserByUsername,
    findUsersByEmail,
    verifyPassword,
    recordAudit,
    isRateLimited,
    issueOtp,
    verifyOtp,
  } = authLib;
  const { sendLoginOtp } = brevo;

  const oidcReq = readOidcRequestPayload(request);
  if (!oidcReq) {
    return new Response("OIDC session expired.", { status: 400 });
  }
  const shop = shopFromOidcRequest(oidcReq);
  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent") || null;
  const form = await request.formData();
  const mode = String(form.get("mode") || "password");

  if (mode === "password") {
    const username = String(form.get("username") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");
    if (!username || !password) {
      return { error: "Enter your username and password." };
    }
    if (await isRateLimited(shop, username)) {
      await recordAudit({ shop, username, result: "rate_limited", ip, userAgent });
      return { error: "Too many failed attempts. Please wait 15 minutes before trying again." };
    }
    const user = await findUserByUsername(shop, username);
    if (!user) {
      await recordAudit({ shop, username, result: "unknown_user", ip, userAgent });
      return { error: "Invalid username or password." };
    }
    if (user.status === "disabled") {
      await recordAudit({ shop, username, result: "disabled", ip, userAgent });
      return { error: "This account has been disabled. Contact Dutch Rusk support." };
    }
    if (!user.passwordHash) {
      await recordAudit({ shop, username, result: "bad_password", ip, userAgent });
      return { error: "Password not set yet. Check your email for the invite, or use \"Forgot password\"." };
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      await recordAudit({ shop, username, result: "bad_password", ip, userAgent });
      return { error: "Invalid username or password." };
    }
    await prisma.b2BUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAudit({ shop, username, email: user.email, result: "ok", ip, userAgent });
    const callback = await issueAuthCode({ user, oidcReq });
    const sessionCookie = writeOidcSessionCookie({
      userId: user.id,
      companyLocationGid: user.companyLocationGid,
    });
    return redirect(callback, {
      headers: { "set-cookie": sessionCookie },
    });
  }

  if (mode === "otp_request") {
    const email = String(form.get("email") || "").trim().toLowerCase();
    if (!email) return { error: "Enter your email address." };
    const users = await findUsersByEmail(shop, email);
    if (users.length === 0) {
      await recordAudit({ shop, email, result: "unknown_user", ip, userAgent });
      return { info: "If that email exists on file, a login code has been sent." };
    }
    if (users.length > 1) {
      return { multi: users.map((u) => ({ id: u.id, storeDisplayName: u.storeDisplayName, username: u.username })) };
    }
    const user = users[0];
    const code = await issueOtp(user.id);
    await sendLoginOtp({
      email: user.email,
      firstName: (user.storeDisplayName || "").split(" ")[0],
      storeDisplayName: user.storeDisplayName,
      username: user.username,
      code,
    });
    await recordAudit({ shop, username: user.username, email: user.email, result: "otp_sent", ip, userAgent });
    const url = new URL(request.url);
    url.searchParams.set("otp_email", email);
    url.searchParams.set("otp_uid", user.id);
    return redirect(`/oidc/login?otp_email=${encodeURIComponent(email)}&otp_uid=${user.id}`);
  }

  if (mode === "otp_pick") {
    const uid = String(form.get("uid") || "");
    const user = await prisma.b2BUser.findUnique({ where: { id: uid } });
    if (!user) return { error: "Invalid selection." };
    const code = await issueOtp(user.id);
    await sendLoginOtp({
      email: user.email,
      firstName: (user.storeDisplayName || "").split(" ")[0],
      storeDisplayName: user.storeDisplayName,
      username: user.username,
      code,
    });
    await recordAudit({ shop, username: user.username, email: user.email, result: "otp_sent", ip, userAgent });
    return redirect(`/oidc/login?otp_email=${encodeURIComponent(user.email)}&otp_uid=${user.id}`);
  }

  if (mode === "otp_verify") {
    const uid = String(form.get("uid") || "");
    const code = String(form.get("code") || "").trim();
    const user = await prisma.b2BUser.findUnique({ where: { id: uid } });
    if (!user) return { error: "Session expired. Request a new code." };
    if (user.status === "disabled") {
      await recordAudit({ shop, username: user.username, email: user.email, result: "disabled", ip, userAgent });
      return { error: "This account has been disabled." };
    }
    const ok = await verifyOtp(user.id, code);
    if (!ok) {
      await recordAudit({ shop, username: user.username, email: user.email, result: "otp_bad", ip, userAgent });
      return { error: "Invalid or expired code.", otpMode: true, otpUserId: uid, otpEmail: user.email };
    }
    await prisma.b2BUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAudit({ shop, username: user.username, email: user.email, result: "otp_verified", ip, userAgent });
    const callback = await issueAuthCode({ user, oidcReq });
    const sessionCookie = writeOidcSessionCookie({
      userId: user.id,
      companyLocationGid: user.companyLocationGid,
    });
    return redirect(callback, { headers: { "set-cookie": sessionCookie } });
  }

  return { error: "Unknown login mode." };
};

export default function OidcLoginPage() {
  const { prefillEmail, otpMode, otpEmail, otpUserId, error: qsError } = useLoaderData();
  const actionData = useActionData();
  const err = actionData?.error || qsError;
  const info = actionData?.info;
  const multi = actionData?.multi;

  const showOtpVerify = otpMode || actionData?.otpMode;
  const otpUidForVerify = actionData?.otpUserId || otpUserId;
  const otpEmailForVerify = actionData?.otpEmail || otpEmail;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Dutch Rusk B2B — Sign in</h1>

        {err ? <div style={styles.error}>{err}</div> : null}
        {info ? <div style={styles.info}>{info}</div> : null}

        {multi ? (
          <Form method="post" style={styles.form}>
            <input type="hidden" name="mode" value="otp_pick" />
            <p style={styles.help}>This email is used for multiple stores. Which one do you want to sign in to?</p>
            {multi.map((m) => (
              <label key={m.id} style={styles.radioRow}>
                <input type="radio" name="uid" value={m.id} required />
                <span><strong>{m.storeDisplayName}</strong> — {m.username}</span>
              </label>
            ))}
            <button type="submit" style={styles.btn}>Send login code</button>
          </Form>
        ) : showOtpVerify ? (
          <Form method="post" style={styles.form}>
            <input type="hidden" name="mode" value="otp_verify" />
            <input type="hidden" name="uid" value={otpUidForVerify} />
            <p style={styles.help}>We sent a 6-digit code to <strong>{otpEmailForVerify}</strong>.</p>
            <label style={styles.label} htmlFor="otp-code">Enter code</label>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- intentional UX, see oidc.setup.$token.jsx */}
            <input id="otp-code" name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} style={styles.input} autoFocus />
            <button type="submit" style={styles.btn}>Verify code</button>
            <a href="/oidc/login" style={styles.linkSmall}>Back</a>
          </Form>
        ) : (
          <>
            <details open style={styles.details}>
              <summary style={styles.summary}>Username + Password</summary>
              <Form method="post" style={styles.form}>
                <input type="hidden" name="mode" value="password" />
                <label style={styles.label} htmlFor="password-username">Username</label>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus -- intentional UX, see oidc.setup.$token.jsx */}
                <input id="password-username" name="username" required autoComplete="username" style={styles.input} autoFocus />
                <label style={styles.label} htmlFor="password-password">Password</label>
                <input id="password-password" name="password" type="password" required autoComplete="current-password" style={styles.input} />
                <button type="submit" style={styles.btn}>Sign in</button>
                <a href="/oidc/forgot" style={styles.linkSmall}>Forgot password?</a>
              </Form>
            </details>

            <details style={styles.details}>
              <summary style={styles.summary}>Sign in with email code instead</summary>
              <Form method="post" style={styles.form}>
                <input type="hidden" name="mode" value="otp_request" />
                <label style={styles.label} htmlFor="otp-email">Email address</label>
                <input id="otp-email" name="email" type="email" required defaultValue={prefillEmail} autoComplete="email" style={styles.input} />
                <button type="submit" style={styles.btn}>Send login code</button>
              </Form>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#f6f6f7", display: "grid", placeItems: "center", padding: "24px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
  card: { width: "100%", maxWidth: 420, background: "white", borderRadius: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.08)", padding: 32 },
  h1: { fontSize: 20, marginBottom: 16, margin: 0, marginTop: 0, paddingBottom: 16 },
  form: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 13, fontWeight: 600, marginTop: 8 },
  input: { padding: "10px 12px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 15 },
  btn: { marginTop: 16, background: "#111827", color: "white", padding: "10px 14px", border: 0, borderRadius: 6, fontSize: 15, cursor: "pointer" },
  linkSmall: { fontSize: 13, marginTop: 12, color: "#2563eb", textAlign: "center", textDecoration: "none" },
  details: { marginTop: 12, borderTop: "1px solid #e5e7eb", paddingTop: 12 },
  summary: { fontWeight: 600, cursor: "pointer", padding: "6px 0" },
  error: { background: "#fef2f2", color: "#991b1b", padding: "10px 12px", borderRadius: 6, fontSize: 14, marginBottom: 12 },
  info: { background: "#eff6ff", color: "#1e40af", padding: "10px 12px", borderRadius: 6, fontSize: 14, marginBottom: 12 },
  help: { fontSize: 14, color: "#374151", margin: "0 0 4px" },
  radioRow: { display: "flex", gap: 8, alignItems: "center", padding: "6px 0", fontSize: 14 },
};
