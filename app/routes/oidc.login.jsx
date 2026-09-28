import { Form, useActionData, useLoaderData, redirect } from "react-router";
import { DrAuthPage, Note, SubmitButton, DR_PHONE, storefrontUrl } from "../components/DrAuth";

// Dutch Rusk sign-in (our own identity provider). Every store signs in with
// its store email: either a 6-digit code emailed to it, or a password.
// Screens: email -> (code | password) -> back to Shopify.

function shopDomain() {
  // One shop per deployment; SHOP_DOMAIN pins the *.myshopify.com host.
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

const OTP_SENDS_PER_15_MIN = 5;
const CODE_FAILS_PER_15_MIN = 8;

// Sign-in pages are never cached: a stored copy could show an old page or an old sign-in.
export const headers = () => ({ "Cache-Control": "no-store" });
export const meta = () => [{ title: "Sign in | Dutch Rusk" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }) => {
  const { readOidcRequestPayload } = await import("../lib/oidc-request.server");
  const url = new URL(request.url);
  const r = url.searchParams.get("r") || "";
  const oidcReq = readOidcRequestPayload(request, r);
  if (!oidcReq) return { expired: true, storefront: storefrontUrl() };
  const { rememberedStores } = await import("../lib/oidc-device.server");
  const remembered = (await rememberedStores(request, shopDomain())).map((u) => ({ id: u.id, store: u.storeDisplayName, email: u.email }));
  // A switch link names the store (login_hint). If this device cannot switch
  // silently, say which store they are signing in to.
  let hintStore = null;
  if (oidcReq.loginHint) {
    const { default: prisma } = await import("../db.server");
    const u = await prisma.b2BUser.findFirst({ where: { shop: shopDomain(), email: String(oidcReq.loginHint).trim().toLowerCase() } });
    hintStore = u ? u.storeDisplayName : null;
  }
  return {
    expired: false,
    hintStore,
    remembered,
    r,
    step: url.searchParams.get("step") || "email",
    email: url.searchParams.get("email") || oidcReq.loginHint || "",
    uid: url.searchParams.get("uid") || "",
    sent: url.searchParams.get("sent") === "1",
    purpose: ["setup", "reset"].includes(url.searchParams.get("purpose")) ? url.searchParams.get("purpose") : "login",
  };
};

async function issueAuthCode(args) {
  const { issueAuthCode: issue } = await import("../lib/oidc-code.server");
  return issue(args);
}

// After a successful sign-in: the short pending cookie as before, plus this
// device's list of verified stores (for silent switching later).
// "Remember this store on this device" (ticked by default) decides whether
// this device may switch back to the store later without a code. Unticked
// on a shared computer, the store is also taken off this device's list.
async function signedInHeaders(request, user, writeOidcSessionCookie, remember = true) {
  const { deviceCookieWith, deviceCookieWithout } = await import("../lib/oidc-device.server");
  const h = new Headers();
  h.append("set-cookie", writeOidcSessionCookie({ userId: user.id, companyLocationGid: user.companyLocationGid }));
  h.append("set-cookie", remember ? deviceCookieWith(request, user.id) : deviceCookieWithout(request, user.id));
  return h;
}

function RememberBox() {
  return (
    <label className="dra-remember">
      <input type="checkbox" name="remember" value="1" defaultChecked />
      <span>Remember this store on this device<small>Switch back without a code next time. Untick on a shared computer.</small></span>
    </label>
  );
}


// After the emailed code proves who they are, a short signed grant lets
// them choose a password on the next screen (setting one up, or resetting).
const GRANT = "dr_pw_grant";
async function grantCookie(user) {
  const { signCookiePayload } = await import("../lib/crypto.server");
  const val = signCookiePayload({ uid: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 600 });
  return `${GRANT}=${val}; Path=/oidc; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}
async function readGrant(request) {
  const [{ verifyCookiePayload }, { readCookieValue }] = await Promise.all([import("../lib/crypto.server"), import("../lib/oidc-request.server")]);
  const v = readCookieValue(request, GRANT);
  return v ? verifyCookiePayload(v) : null;
}
const clearGrant = `${GRANT}=; Path=/oidc; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export const action = async ({ request }) => {
  const [{ default: prisma }, { readOidcRequestPayload, writeOidcSessionCookie }, auth, brevo] = await Promise.all([
    import("../db.server"),
    import("../lib/oidc-request.server"),
    import("../lib/b2b-auth.server"),
    import("../lib/brevo.server"),
  ]);
  const form = await request.formData();
  const r = String(form.get("r") || "");
  const oidcReq = readOidcRequestPayload(request, r);
  if (!oidcReq) return redirect("/oidc/login");
  // Every screen change keeps this sign-in's id.
  const q = (params) => "/oidc/login?" + new URLSearchParams({ ...params, r }).toString();
  const shop = shopDomain();
  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent") || null;
  const mode = String(form.get("mode") || "");
  const email = String(form.get("email") || "").trim().toLowerCase();
  const remember = form.get("remember") === "1";
  const since = new Date(Date.now() - 15 * 60 * 1000);

  const sendCode = async (user, purpose = "login") => {
    const recent = await prisma.b2BLoginAudit.count({ where: { shop, email: user.email, result: "otp_sent", createdAt: { gte: since } } });
    if (recent >= OTP_SENDS_PER_15_MIN) {
      await auth.recordAudit({ shop, username: user.username, email: user.email, result: "rate_limited", ip, userAgent });
      return { error: "We've sent several codes already. Please use the latest one in your email, or wait 15 minutes and try again.", step: "code", email: user.email, uid: user.id, purpose };
    }
    const code = await auth.issueOtp(user.id);
    await brevo.sendLoginOtp({ email: user.email, firstName: "", storeDisplayName: user.storeDisplayName, username: user.username, code, expiresInMin: 10, purpose });
    await auth.recordAudit({ shop, username: user.username, email: user.email, result: "otp_sent", ip, userAgent });
    return redirect(q({ step: "code", email: user.email, uid: user.id, sent: "1", purpose }));
  };

  if (mode === "start" || mode === "resend") {
    const method = String(form.get("method") || "code");
    if (!email || !email.includes("@")) return { error: "Please enter your store's email address.", step: "email", email };
    const all = await auth.findUsersByEmail(shop, email);
    const users = all.filter((u) => u.status !== "disabled");
    if (users.length === 0 && all.length > 0) {
      await auth.recordAudit({ shop, email, result: "disabled", ip, userAgent });
      return { error: `Sign-in for ${email} is paused at the moment. Please call Dutch Rusk on ${DR_PHONE} and we'll sort it out.`, step: "email", email };
    }
    if (users.length === 0) {
      await auth.recordAudit({ shop, email, result: "unknown_user", ip, userAgent });
      return { error: `We can't find a Dutch Rusk account for ${email}. Check it's the email address for your store, or call us on ${DR_PHONE}.`, step: "email", email };
    }
    if (method === "password" && mode === "start") {
      // No password yet: set one up now (code first, then choose it).
      if (!users[0].passwordHash) return sendCode(users[0], "setup");
      return redirect(q({ step: "password", email }));
    }
    const again = String(form.get("purpose") || "login");
    return sendCode(users[0], mode === "resend" && ["setup", "reset"].includes(again) ? again : "login");
  }

  if (mode === "choose") {
    // One tap on a store this device has already verified: no code, no password.
    const { readDeviceUserIds } = await import("../lib/oidc-device.server");
    const uid = String(form.get("uid") || "");
    const user = readDeviceUserIds(request).includes(uid) ? await prisma.b2BUser.findUnique({ where: { id: uid } }) : null;
    if (!user || user.shop !== shop || user.status === "disabled") {
      return { error: "Please sign in to that store again with your email.", step: "email", email: "" };
    }
    await prisma.b2BUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await auth.recordAudit({ shop, username: user.username, email: user.email, result: "remembered", ip, userAgent });
    const callback = await issueAuthCode({ user, oidcReq });
    return redirect(callback, { headers: await signedInHeaders(request, user, writeOidcSessionCookie, true) });
  }

  if (mode === "forget_device") {
    const { clearDeviceCookie } = await import("../lib/oidc-device.server");
    return redirect(q({ step: "email" }), { headers: { "set-cookie": clearDeviceCookie() } });
  }

  if (mode === "forgot") {
    const users = (await auth.findUsersByEmail(shop, email)).filter((u) => u.status !== "disabled");
    if (users.length === 0) return { error: "Please enter your email again.", step: "email", email };
    return sendCode(users[0], users[0].passwordHash ? "reset" : "setup");
  }

  if (mode === "set_password") {
    const grant = await readGrant(request);
    const user = grant?.uid ? await prisma.b2BUser.findUnique({ where: { id: grant.uid } }) : null;
    if (!user || user.shop !== shop || user.email !== email || grant.email !== email || user.status === "disabled") {
      return { error: "That took a little too long. Please start again.", step: "email", email };
    }
    const pw = String(form.get("password") || "");
    const pw2 = String(form.get("password2") || "");
    const purpose = String(form.get("purpose") || "setup");
    if (pw.length < 8) return { error: "Your password needs at least 8 characters.", step: "newpw", email, purpose };
    if (pw !== pw2) return { error: "The two passwords don't match. Please type them again.", step: "newpw", email, purpose };
    await prisma.b2BUser.update({ where: { id: user.id }, data: { passwordHash: await auth.hashPassword(pw), status: "active", lastLoginAt: new Date() } });
    // A new password ends every other signed-in session for this store.
    await prisma.oidcRefreshToken.updateMany({ where: { b2bUserId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await auth.recordAudit({ shop, username: user.username, email, result: purpose === "reset" ? "password_reset" : "password_set", ip, userAgent });
    const callback = await issueAuthCode({ user, oidcReq });
    const headers = await signedInHeaders(request, user, writeOidcSessionCookie, remember);
    headers.append("set-cookie", clearGrant);
    return redirect(callback, { headers });
  }

  if (mode === "password") {
    const password = String(form.get("password") || "");
    if (!email || !password) return { error: "Please enter your email address and password.", step: "password", email };
    const users = await auth.findUsersByEmail(shop, email);
    const user = users[0];
    if (user && (await auth.isRateLimited(shop, user.username))) {
      await auth.recordAudit({ shop, username: user.username, email, result: "rate_limited", ip, userAgent });
      return { error: "Too many attempts. Please wait 15 minutes, or email yourself a sign-in code instead.", step: "password", email };
    }
    if (!user || user.status === "disabled") {
      await auth.recordAudit({ shop, email, result: "unknown_user", ip, userAgent });
      return { error: "That email and password don't match. Try again, or email yourself a sign-in code.", step: "password", email };
    }
    if (!user.passwordHash) return sendCode(user, "setup");
    if (!(await auth.verifyPassword(password, user.passwordHash))) {
      await auth.recordAudit({ shop, username: user.username, email, result: "bad_password", ip, userAgent });
      return { error: "That email and password don't match. Try again, or email yourself a sign-in code.", step: "password", email };
    }
    await prisma.b2BUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await auth.recordAudit({ shop, username: user.username, email, result: "ok", ip, userAgent });
    const callback = await issueAuthCode({ user, oidcReq });
    return redirect(callback, { headers: await signedInHeaders(request, user, writeOidcSessionCookie, remember) });
  }

  if (mode === "otp_verify") {
    const uid = String(form.get("uid") || "");
    const code = String(form.get("code") || "").replace(/\D/g, "");
    const user = uid ? await prisma.b2BUser.findUnique({ where: { id: uid } }) : null;
    // The code screen names one store; it must be the email shown on it.
    if (!user || user.shop !== shop || user.email !== email || user.status === "disabled") {
      return { error: "That sign-in has expired. Please enter your email again.", step: "email", email };
    }
    const fails = await prisma.b2BLoginAudit.count({ where: { shop, email, result: "otp_bad", createdAt: { gte: since } } });
    if (fails >= CODE_FAILS_PER_15_MIN) {
      return { error: "Too many wrong codes. Please wait 15 minutes, then send a new code.", step: "code", email, uid };
    }
    if (code.length !== 6 || !(await auth.verifyOtp(user.id, code))) {
      await auth.recordAudit({ shop, username: user.username, email, result: "otp_bad", ip, userAgent });
      return { error: "That code isn't right, or it has expired. Check the latest email from us, or send a new code.", step: "code", email, uid, purpose: String(form.get("purpose") || "login") };
    }
    const purpose = String(form.get("purpose") || "login");
    if (purpose === "setup" || purpose === "reset") {
      await auth.recordAudit({ shop, username: user.username, email, result: "otp_verified", ip, userAgent });
      return redirect(q({ step: "newpw", email, purpose }), { headers: { "set-cookie": await grantCookie(user) } });
    }
    await prisma.b2BUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await auth.recordAudit({ shop, username: user.username, email, result: "otp_verified", ip, userAgent });
    const callback = await issueAuthCode({ user, oidcReq });
    return redirect(callback, { headers: await signedInHeaders(request, user, writeOidcSessionCookie, remember) });
  }

  return { error: "Something went wrong. Please enter your email again.", step: "email", email };
};

// Keep only the digits of whatever is typed or pasted ("386 146", "386-146",
// or the whole line from the email), up to 6. A pasted code with a space or a
// hidden character used to be cut short by a length limit and rejected.
function keepDigits(e) {
  const el = e.currentTarget;
  const digits = el.value.replace(/\D/g, "").slice(0, 6);
  if (el.value !== digits) el.value = digits;
}

export default function DrSignIn() {
  const data = useLoaderData();
  const act = useActionData();

  if (data.expired) {
    return (
      <DrAuthPage title="Let's try that again" intro="This sign-in page was open for a while, so it has timed out. One tap starts it again.">
        <a className="dra-btn dra-btn--primary" href={`${data.storefront}/customer_authentication/login?return_to=%2F`}>Sign in again</a>
      </DrAuthPage>
    );
  }

  const step = act?.step || data.step;
  const email = act?.email ?? data.email;
  const uid = act?.uid || data.uid;
  const purpose = act?.purpose || data.purpose || "login";
  const heading = { login: "Check your email", setup: "Set up your password", reset: "Reset your password" }[purpose];

  if (step === "newpw") {
    return (
      <DrAuthPage title={purpose === "reset" ? "Choose a new password" : "Choose your password"} intro={<>For <strong>{email}</strong>. You&apos;ll use this with your store&apos;s email address to sign in.</>}>
        <Note kind="error">{act?.error}</Note>
        <Form method="post" className="dra-form">
          <input type="hidden" name="r" value={data.r} />
          <input type="hidden" name="mode" value="set_password" />
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="purpose" value={purpose} />
          <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
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
          <RememberBox />
          <SubmitButton name="mode" value="set_password" busyText="Saving and signing you in...">Save password and sign in</SubmitButton>
        </Form>
      </DrAuthPage>
    );
  }

  if (step === "code" && uid) {
    return (
      <DrAuthPage title={heading} intro={<>{purpose === "login" ? null : <>First, let&apos;s check it&apos;s you. </>}We&apos;ve sent a 6-digit code to <strong>{email}</strong>. It can take a minute to arrive. If you can&apos;t see it, check your junk or spam folder.</>}>
        <Note kind="error">{act?.error}</Note>
        <Form method="post" className="dra-form">
          <input type="hidden" name="r" value={data.r} />
          <input type="hidden" name="mode" value="otp_verify" />
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="uid" value={uid} />
          <input type="hidden" name="purpose" value={purpose} />
          <div className="dra-field">
            <label className="dra-label" htmlFor="code">6-digit code</label>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the only field on this screen */}
            <input id="code" name="code" className="dra-input dra-input--code" inputMode="numeric" autoComplete="one-time-code" required autoFocus onInput={keepDigits} />
            <p className="dra-hint">The code works for 10 minutes.</p>
          </div>
          <RememberBox />
          <SubmitButton name="mode" value="otp_verify" busyText={purpose === "login" ? "Signing you in..." : "Checking..."}>{purpose === "login" ? "Sign in" : "Next: choose a password"}</SubmitButton>
        </Form>
        <div className="dra-links">
          <Form method="post" style={{ margin: 0 }}>
            <input type="hidden" name="r" value={data.r} />
            <input type="hidden" name="mode" value="resend" />
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="purpose" value={purpose} />
            <button type="submit" className="dra-link">Send a new code</button>
          </Form>
          <a className="dra-link" href={`/oidc/login?step=email&r=${data.r}`}>Use a different email</a>
        </div>
      </DrAuthPage>
    );
  }

  if (step === "password") {
    return (
      <DrAuthPage title="Enter your password" intro={<>Signing in as <strong>{email}</strong>.</>}>
        <Note kind="error">{act?.error}</Note>
        <Form method="post" className="dra-form">
          <input type="hidden" name="r" value={data.r} />
          <input type="hidden" name="mode" value="password" />
          <input type="hidden" name="email" value={email} />
          <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
          <div className="dra-field">
            <label className="dra-label" htmlFor="password">Password</label>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the only field on this screen */}
            <input id="password" name="password" type="password" className="dra-input" autoComplete="current-password" required autoFocus />
          </div>
          <RememberBox />
          <SubmitButton name="mode" value="password" busyText="Signing you in...">Sign in</SubmitButton>
        </Form>
        <div className="dra-links">
          <Form method="post" style={{ margin: 0 }}>
            <input type="hidden" name="r" value={data.r} />
            <input type="hidden" name="mode" value="forgot" />
            <input type="hidden" name="email" value={email} />
            <button type="submit" className="dra-link">Forgotten your password?</button>
          </Form>
          <Form method="post" style={{ margin: 0 }}>
            <input type="hidden" name="r" value={data.r} />
            <input type="hidden" name="mode" value="resend" />
            <input type="hidden" name="email" value={email} />
            <button type="submit" className="dra-link">Email me a code instead</button>
          </Form>
        </div>
      </DrAuthPage>
    );
  }

  const remembered = data.remembered || [];
  return (
    <DrAuthPage title={data.hintStore && !act?.error ? `Sign in to ${data.hintStore}` : "Sign in to Dutch Rusk"} intro={data.hintStore && !act?.error ? "This device needs a quick check for this store first. We'll email a 6-digit code, then it switches without one next time." : remembered.length ? "Choose a store you've used on this device, or sign in with another email." : "Wholesale ordering for Dutch Rusk customers. Use the email address for your store."}>
      <Note kind="error">{act?.error}</Note>
      {remembered.length ? (
        <>
          <div className="dra-stores">
            {remembered.map((s) => (
              <Form method="post" key={s.id} className="dra-form">
                <input type="hidden" name="r" value={data.r} />
                <input type="hidden" name="mode" value="choose" />
                <input type="hidden" name="uid" value={s.id} />
                <button type="submit" className="dra-storebtn">
                  <span className="dra-storebtn__name">{s.store}</span>
                  <span className="dra-storebtn__email">{s.email}</span>
                  <span className="dra-storebtn__go" aria-hidden="true">Continue &rarr;</span>
                </button>
              </Form>
            ))}
          </div>
          <p className="dra-or"><span>or sign in with another email</span></p>
        </>
      ) : null}
      <Form method="post" className="dra-form">
        <input type="hidden" name="r" value={data.r} />
        <input type="hidden" name="mode" value="start" />
        <div className="dra-field">
          <label className="dra-label" htmlFor="email">Store email address</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the only field on this screen */}
          <input id="email" name="email" type="email" className="dra-input" defaultValue={email} autoComplete="email" inputMode="email" required autoFocus />
        </div>
        <SubmitButton name="method" value="code" busyText="Sending your code...">Email me a sign-in code</SubmitButton>
        <SubmitButton name="method" value="password" variant="secondary" busyText="One moment...">Sign in with a password</SubmitButton>
      </Form>
      {remembered.length ? (
        <div className="dra-links dra-links--center">
          <Form method="post" style={{ margin: 0 }}>
            <input type="hidden" name="r" value={data.r} />
            <input type="hidden" name="mode" value="forget_device" />
            <button type="submit" className="dra-link">Forget these stores on this device</button>
          </Form>
        </div>
      ) : null}
    </DrAuthPage>
  );
}
