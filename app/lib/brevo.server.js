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

// Uses the same design system as the canonical Dutch Rusk / Worthy branded
// email template: warm off-white page (#FAF8F5), white rounded content card,
// navy brand colour (#181344), system-ui font stack. Kept lean compared to
// the full onboarding template (no hero banner or feature grid) since this
// is a transactional order alert, not a campaign.
export async function sendSalesRepOrderNotification({
  repEmail, repName, orderName, orderUrl, customerName, companyName, lineItems, subtotal, currency,
}) {
  const templateId = process.env.BREVO_TEMPLATE_SALES_REP_ORDER;
  const to = { email: repEmail, name: repName || repEmail };
  const params = {
    rep_name: repName || "there",
    order_name: orderName,
    order_url: orderUrl,
    customer_name: customerName,
    company_name: companyName,
    line_items: lineItems, // [{ title, sku, quantity, price, imageUrl }]
    subtotal,
    currency,
  };
  if (templateId) return sendTemplate({ templateId, to, params, tags: ["dr_sales_rep_order"] });

  const fmt = (n) => `${currency ?? ""} ${Number(n ?? 0).toFixed(2)}`.trim();
  const greetName = repName || "there";
  const PLACEHOLDER_IMG = "https://cdn.shopify.com/s/files/1/0668/0861/1129/files/Dutch_Rusk.jpg?v=1785119365";

  const text = `Hi ${greetName},

Good news, ${companyName} just placed an order.

Order: ${orderName}
Placed by: ${customerName}

${lineItems.map((li) => `  ${li.quantity} x ${li.title}${li.sku ? ` (${li.sku})` : ""}, ${fmt(li.price)} each`).join("\n")}

Subtotal: ${fmt(subtotal)}

View the full order here: ${orderUrl}

Cheers,
Dutch Rusk`;

  const rowsHtml = lineItems
    .map(
      (li) => `
                <tr>
                  <td style="padding:12px 0; border-bottom:1px solid #E8E8EC;" width="56">
                    <img src="${li.imageUrl || PLACEHOLDER_IMG}" alt="" width="48" height="48" style="width:48px; height:48px; border-radius:8px; object-fit:cover; display:block; border:1px solid #E8E8EC;" />
                  </td>
                  <td style="padding:12px 12px; border-bottom:1px solid #E8E8EC; font-size:14px; color:#333333; line-height:1.4;">
                    <strong style="color:#181344;">${li.title}</strong>${li.sku ? `<br><span style="color:#666670; font-size:12px;">${li.sku}</span>` : ""}
                  </td>
                  <td style="padding:12px 0; border-bottom:1px solid #E8E8EC; font-size:14px; color:#333333; text-align:center; white-space:nowrap;">
                    x${li.quantity}
                  </td>
                  <td style="padding:12px 0; border-bottom:1px solid #E8E8EC; font-size:14px; color:#181344; font-weight:bold; text-align:right; white-space:nowrap;">
                    ${fmt(li.price)}
                  </td>
                </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en-NZ">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>New order ${orderName}</title>
<style>
  @media only screen and (max-width: 600px) {
    .main-container { width: 100% !important; max-width: 100% !important; }
    .mobile-pad { padding-left: 20px !important; padding-right: 20px !important; }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#FAF8F5; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#333333; -webkit-font-smoothing:antialiased;">
  <div style="display:none; font-size:1px; color:#FAF8F5; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">
    ${companyName} just placed order ${orderName}, subtotal ${fmt(subtotal)}.
  </div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#FAF8F5; padding:30px 0;">
    <tr>
      <td align="center">
        <!--[if mso | IE]>
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" align="center" style="width:600px;">
          <tr><td>
        <![endif]-->
        <table class="main-container" role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:600px; margin:0 auto;">

          <tr>
            <td style="padding:15px 40px 25px 40px; text-align:center;">
              <img src="https://cdn.shopify.com/s/files/1/0668/0861/1129/files/Worthy_Logo_Full_Colour_1.png?v=1785119365" alt="Worthy" height="36" style="height:36px; width:auto; display:inline-block; vertical-align:middle; border:0; margin-right:12px;" />
              <img src="https://cdn.shopify.com/s/files/1/0668/0861/1129/files/Dutch_Rusk.jpg?v=1785119365" alt="Dutch Rusk" height="36" style="height:36px; width:auto; display:inline-block; vertical-align:middle; border:0; margin-left:12px;" />
            </td>
          </tr>

          <tr>
            <td style="padding:0 10px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#FEFEFE; border-radius:12px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.03);">

                <tr>
                  <td class="mobile-pad" style="padding:36px 40px 8px 40px;">
                    <h1 style="margin:0 0 16px 0; color:#181344; font-size:24px; font-weight:800; line-height:1.3;">
                      Hi ${greetName},
                    </h1>
                    <p style="margin:0 0 6px 0; font-size:16px; line-height:1.6; color:#333333;">
                      Good news, <strong style="color:#181344;">${companyName}</strong> just placed an order.
                    </p>
                    <p style="margin:0; font-size:14px; color:#666670;">
                      Order <strong style="color:#181344;">${orderName}</strong>, placed by ${customerName}
                    </p>
                  </td>
                </tr>

                <tr>
                  <td class="mobile-pad" style="padding:20px 40px 0 40px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      ${rowsHtml}
                    </table>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:4px;">
                      <tr>
                        <td style="padding:16px 0; text-align:right; font-size:15px; color:#181344;">
                          <strong>Subtotal: ${fmt(subtotal)}</strong>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td class="mobile-pad" align="center" style="padding:16px 40px 40px 40px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td align="center" style="background-color:#181344; border-radius:6px;">
                          <a href="${orderUrl}" target="_blank" style="display:inline-block; padding:14px 32px; color:#FEFEFE; text-decoration:none; font-weight:bold; font-size:15px;">
                            View the order in Shopify &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td class="mobile-pad" style="padding:0 40px 36px 40px; border-top:1px solid #E8E8EC; padding-top:24px;">
                    <p style="margin:0; font-size:14px; color:#333333; line-height:1.6;">
                      Cheers,<br>
                      <strong style="color:#181344;">Dutch Rusk</strong>
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <tr>
            <td class="mobile-pad" style="padding:24px 20px; text-align:center;">
              <div style="color:#181344; font-size:13px; font-weight:bold; margin-bottom:4px;">Dutch Rusk</div>
              <div style="color:#666670; font-size:12px; line-height:1.5;">14 Echodale Place, Stoke, Nelson 7011, New Zealand</div>
            </td>
          </tr>

        </table>
        <!--[if mso | IE]>
          </td></tr>
        </table>
        <![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendRawFallback({ to, subject: `New order ${orderName}, ${companyName}`, textBody: text, htmlBody: html, tags: ["dr_sales_rep_order"] });
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
