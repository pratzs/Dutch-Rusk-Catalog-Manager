// Branded HTML for the sign-in emails (code and password reset). Follows the
// Dutch Rusk master email template: Worthy + Dutch Rusk logos, one white card
// on #FAF8F5, navy #181344, phone and email help side by side.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const WORTHY = "https://cdn.shopify.com/s/files/1/0668/0861/1129/files/Worthy_Logo_Full_Colour_1.png?v=1785119365";
const DR = "https://cdn.shopify.com/s/files/1/0668/0861/1129/files/Dutch_Rusk.jpg?v=1785119365";
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function authEmailHtml({ preheader, heading, bodyHtml, footnote }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background-color:#FAF8F5;">
<div style="display:none;max-height:0;overflow:hidden;color:#FAF8F5;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF8F5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td align="center" style="padding:0 0 20px;">
<img src="${WORTHY}" alt="Worthy" height="40" style="height:40px;width:auto;vertical-align:middle;border:0;margin:0 10px;">
<img src="${DR}" alt="Dutch Rusk" height="40" style="height:40px;width:auto;vertical-align:middle;border:0;margin:0 10px;">
</td></tr>
<tr><td style="background-color:#FEFEFE;border:1px solid #E8E8EC;border-radius:12px;padding:32px 28px;font-family:${FONT};color:#333333;">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;font-weight:800;color:#181344;">${esc(heading)}</h1>
${bodyHtml}
<p style="margin:24px 0 0;font-size:14px;line-height:1.5;color:#666670;">${esc(footnote)}</p>
</td></tr>
<tr><td style="padding:16px 0 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="50%" style="padding:0 6px 0 0;"><div style="background:#FEFEFE;border:1px solid #E8E8EC;border-radius:10px;padding:14px;font-family:${FONT};font-size:14px;color:#333;"><strong style="color:#181344;">Call us</strong><br><a href="tel:035477809" style="color:#181344;">03 547 7809</a></div></td>
<td width="50%" style="padding:0 0 0 6px;"><div style="background:#FEFEFE;border:1px solid #E8E8EC;border-radius:10px;padding:14px;font-family:${FONT};font-size:14px;color:#333;"><strong style="color:#181344;">Email us</strong><br><a href="mailto:admin@dutchrusk.co.nz" style="color:#181344;">admin@dutchrusk.co.nz</a></div></td>
</tr></table>
</td></tr>
<tr><td align="center" style="padding:20px 0 0;font-family:${FONT};font-size:12px;color:#666670;">The Dutch Rusk Team</td></tr>
</table></td></tr></table></body></html>`;
}

export function codeEmail({ code, storeDisplayName, expiresInMin, purpose = "login" }) {
  const what = { login: "sign in to Dutch Rusk", setup: "set up your Dutch Rusk password", reset: "reset your Dutch Rusk password" }[purpose] || "sign in to Dutch Rusk";
  return {
    subject: purpose === "login" ? `Your Dutch Rusk sign-in code: ${code}` : `Your Dutch Rusk code: ${code}`,
    html: authEmailHtml({
      preheader: `Your sign-in code is ${code}. It works for ${expiresInMin} minutes.`,
      heading: purpose === "login" ? "Your sign-in code" : "Your code",
      bodyHtml: `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;">Here's your code to ${esc(what)} for <strong style="color:#181344;">${esc(storeDisplayName)}</strong>.</p>
<div style="margin:0 0 20px;padding:18px;background:#F5F5F7;border-radius:10px;text-align:center;font-size:34px;letter-spacing:10px;font-weight:800;color:#181344;font-family:${FONT};">${esc(code)}</div>
<p style="margin:0;font-size:16px;line-height:1.5;">Type it on the sign-in page. It works for ${esc(expiresInMin)} minutes.</p>`,
      footnote: "Didn't ask for this? You can ignore this email. Nobody can sign in without the code.",
    }),
    text: `Your Dutch Rusk sign-in code for ${storeDisplayName} is ${code}. It works for ${expiresInMin} minutes.\n\nDidn't ask for this? You can ignore this email.\n\nNeed a hand? Call 03 547 7809 or email admin@dutchrusk.co.nz.\n\nThe Dutch Rusk Team`,
  };
}

export function resetEmail({ actionUrl, storeDisplayName, expiresInHours }) {
  return {
    subject: "Choose a new Dutch Rusk password",
    html: authEmailHtml({
      preheader: `Choose a new password for ${storeDisplayName}. The link works for ${expiresInHours} hours.`,
      heading: "Choose a new password",
      bodyHtml: `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;">We got a request to change the password for <strong style="color:#181344;">${esc(storeDisplayName)}</strong>.</p>
<p style="margin:0 0 24px;text-align:center;"><a href="${esc(actionUrl)}" style="display:inline-block;background:#181344;color:#FEFEFE;text-decoration:none;font-weight:700;font-size:16px;padding:14px 26px;border-radius:6px;">Choose a new password &rarr;</a></p>
<p style="margin:0;font-size:16px;line-height:1.5;">The link works for ${esc(expiresInHours)} hours.</p>`,
      footnote: "Didn't ask for this? You can ignore this email. Your password won't change.",
    }),
    text: `Choose a new password for ${storeDisplayName}:\n${actionUrl}\n\nThe link works for ${expiresInHours} hours. Didn't ask for this? You can ignore this email.\n\nThe Dutch Rusk Team`,
  };
}
