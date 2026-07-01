const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

function requireBrevoKey() {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error("BREVO_API_KEY env var required to send B2B auth emails");
  return key;
}

function senderConfig() {
  return {
    email: process.env.BREVO_SENDER_EMAIL || "no-reply@dutchrusk.co.nz",
    name: process.env.BREVO_SENDER_NAME || "Dutch Rusk B2B",
  };
}

async function sendTemplate({ templateId, to, params, tags }) {
  const apiKey = requireBrevoKey();
  const body = {
    sender: senderConfig(),
    to: [{ email: to.email, name: to.name || to.email }],
    templateId: Number(templateId),
    params: params || {},
    tags: tags || [],
  };

  const resp = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Brevo send failed (${resp.status}): ${text.slice(0, 500)}`);
  }
  return await resp.json().catch(() => ({}));
}

async function sendRawFallback({ to, subject, textBody, htmlBody, tags }) {
  const apiKey = requireBrevoKey();
  const body = {
    sender: senderConfig(),
    to: [{ email: to.email, name: to.name || to.email }],
    subject,
    textContent: textBody,
    htmlContent: htmlBody,
    tags: tags || [],
  };
  const resp = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Brevo raw send failed (${resp.status}): ${text.slice(0, 500)}`);
  }
  return await resp.json().catch(() => ({}));
}

export async function sendB2BInvite({ email, firstName, storeDisplayName, username, actionUrl, expiresInDays }) {
  const templateId = process.env.BREVO_TEMPLATE_INVITE;
  const to = { email, name: firstName || email };
  const params = {
    first_name: firstName || "there",
    store_display_name: storeDisplayName,
    username,
    action_url: actionUrl,
    expires_in_days: expiresInDays ?? 7,
  };
  if (templateId) return sendTemplate({ templateId, to, params, tags: ["dr_b2b_invite"] });

  const subject = `Set up your Dutch Rusk B2B account — ${storeDisplayName}`;
  const text = `Hi ${params.first_name},

Your Dutch Rusk B2B wholesale account is ready for ${storeDisplayName}.

  Username: ${username}
  Store:    ${storeDisplayName}

Please save your username — you'll need it every time you log in.

Set your password:
${actionUrl}

This link expires in ${params.expires_in_days} days.

If you manage multiple Dutch Rusk stores, you will receive a separate email
for each — each with its own username. Your email address stays the same
across all of them.

Dutch Rusk Team`;
  return sendRawFallback({ to, subject, textBody: text, htmlBody: null, tags: ["dr_b2b_invite"] });
}

export async function sendB2BReset({ email, firstName, storeDisplayName, username, actionUrl, expiresInHours }) {
  const templateId = process.env.BREVO_TEMPLATE_RESET;
  const to = { email, name: firstName || email };
  const params = {
    first_name: firstName || "there",
    store_display_name: storeDisplayName,
    username,
    action_url: actionUrl,
    expires_in_hours: expiresInHours ?? 24,
  };
  if (templateId) return sendTemplate({ templateId, to, params, tags: ["dr_b2b_reset"] });

  const subject = `Reset your password — ${storeDisplayName} (${username})`;
  const text = `Hi ${params.first_name},

Someone requested a password reset for:
  Store:    Dutch Rusk ${storeDisplayName}
  Username: ${username}

If this was you, click here to set a new password:
${actionUrl}

This link expires in ${params.expires_in_hours} hours.

If you did not request this, you can ignore this email. The password for
this account will not change. If you manage other Dutch Rusk stores under
the same email address, those accounts are NOT affected by this request.

Dutch Rusk Team`;
  return sendRawFallback({ to, subject, textBody: text, htmlBody: null, tags: ["dr_b2b_reset"] });
}

export async function sendLoginOtp({ email, firstName, storeDisplayName, username, code, expiresInMin }) {
  const templateId = process.env.BREVO_TEMPLATE_OTP;
  const to = { email, name: firstName || email };
  const params = {
    first_name: firstName || "there",
    store_display_name: storeDisplayName,
    username,
    code,
    expires_in_min: expiresInMin ?? 10,
  };
  if (templateId) return sendTemplate({ templateId, to, params, tags: ["dr_login_otp"] });

  const subject = `Your Dutch Rusk login code — ${code}`;
  const text = `Hi ${params.first_name},

Your login code for ${storeDisplayName} (${username}) is:

    ${code}

This code expires in ${params.expires_in_min} minutes.

If you didn't request this, you can ignore this email.

Dutch Rusk Team`;
  return sendRawFallback({ to, subject, textBody: text, htmlBody: null, tags: ["dr_login_otp"] });
}
