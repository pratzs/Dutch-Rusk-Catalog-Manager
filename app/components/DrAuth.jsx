// Shared layout for the Dutch Rusk sign-in pages (/oidc/*). One look for
// every screen: Worthy + Dutch Rusk logo, one white card on the warm
// off-white page, navy buttons, and the same help line at the bottom.
// Tokens follow the Dutch Rusk master email template.

import { useNavigation } from "react-router";

export const DR_PHONE = "03 547 7809"; // non-breaking spaces: never split across lines
export const DR_EMAIL = "admin@dutchrusk.co.nz";
const LOGO = "https://b2b.dutchrusk.co.nz/cdn/shop/files/Dutch_Worthy_Merged_Logo_e1737aed-3224-440e-9608-ee25e0c3d7e1.webp?v=1757032227&width=600";

export function storefrontUrl() {
  return (typeof process !== "undefined" && process.env.STOREFRONT_URL) || "https://b2b.dutchrusk.co.nz";
}

const css = `
*{box-sizing:border-box}
html,body{margin:0}
.dra-page{min-height:100vh;background:#FAF8F5;color:#333333;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;padding:32px 16px}
.dra-logo{display:block;width:220px;max-width:70%;height:auto;margin:8px auto 24px}
.dra-card{width:100%;max-width:440px;background:#FEFEFE;border:1px solid #E8E8EC;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.03);padding:32px}
.dra-h1{margin:0 0 8px;font-size:26px;font-weight:800;color:#181344;line-height:1.2}
.dra-intro{margin:0 0 24px;font-size:16px;line-height:1.5;color:#555555}
.dra-form{display:flex;flex-direction:column;gap:0;margin:0}
.dra-label{display:block;font-size:15px;font-weight:700;color:#181344;margin:0 0 8px}
.dra-input{display:block;width:100%;font-family:inherit;height:50px;padding:0 14px;font-size:17px;color:#1F1D2E;background:#fff;border:1px solid #C9C7D6;border-radius:8px;outline:none}
.dra-input:focus{border-color:#181344;box-shadow:0 0 0 3px rgba(24,19,68,.15)}
.dra-input--code{letter-spacing:.4em;font-size:24px;text-align:center;font-weight:700}
.dra-field{margin:0 0 18px}
.dra-hint{margin:8px 0 0;font-size:14px;color:#666670;line-height:1.4}
.dra-btn{display:flex;font-family:inherit;align-items:center;justify-content:center;width:100%;min-height:50px;padding:12px 16px;font-size:17px;font-weight:700;border-radius:8px;border:2px solid #181344;cursor:pointer;text-decoration:none;text-align:center;line-height:1.2}
.dra-btn--primary{background:#181344;color:#FEFEFE}
.dra-btn--primary:hover{background:#231c5e}
.dra-btn--secondary{background:#FEFEFE;color:#181344;margin-top:12px}
.dra-btn--secondary:hover{background:#F2F1F8}
.dra-btn[disabled]{opacity:.65;cursor:progress}
.dra-links{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;margin:20px 0 0;font-size:15px}
.dra-links--center{justify-content:center}
.dra-link{color:#181344;font-weight:600;text-decoration:underline;text-underline-offset:3px;background:none;border:0;padding:0;font:inherit;cursor:pointer}
.dra-note{border-radius:8px;padding:12px 14px;font-size:15px;line-height:1.45;margin:0 0 20px}
.dra-note--error{background:#FDECEC;color:#8A1C1C;border:1px solid #F5C2C2}
.dra-note--info{background:#EEF0FB;color:#181344;border:1px solid #D6D9F2}
.dra-note--ok{background:#EAF6EE;color:#1D5A33;border:1px solid #C6E6D1}
.dra-store{margin:0 0 20px;padding:12px 14px;background:#F5F5F7;border-radius:8px;font-size:15px;color:#333}
.dra-store strong{color:#181344}
.dra-stores{display:grid;gap:10px;margin:0 0 4px}
.dra-storebtn{display:grid;grid-template-columns:1fr auto;grid-template-areas:"name go" "email go";align-items:center;gap:2px 12px;width:100%;padding:14px 16px;text-align:left;background:#FEFEFE;border:1px solid #D6D9F2;border-radius:10px;cursor:pointer;font-family:inherit;box-shadow:0 4px 10px rgba(0,0,0,.04)}
.dra-storebtn:hover{border-color:#181344;background:#F7F7FC}
.dra-storebtn__name{grid-area:name;font-size:17px;font-weight:800;color:#181344}
.dra-storebtn__email{grid-area:email;font-size:14px;color:#666670;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dra-storebtn__go{grid-area:go;font-size:15px;font-weight:700;color:#181344;white-space:nowrap}
.dra-or{display:flex;align-items:center;gap:12px;margin:20px 0;color:#666670;font-size:14px}
.dra-or::before,.dra-or::after{content:"";flex:1;height:1px;background:#E8E8EC}
.dra-help{width:100%;max-width:440px;margin:20px 0 0;text-align:center;font-size:14px;line-height:1.6;color:#666670}
.dra-help a{color:#181344;font-weight:600}
@media (max-width:480px){.dra-page{padding:20px 12px}.dra-card{padding:24px 20px}.dra-h1{font-size:23px}}
`;

export function DrAuthPage({ title, intro, children }) {
  return (
    <div className="dra-page">
      <style>{css}</style>
      <img className="dra-logo" src={LOGO} alt="Worthy and Dutch Rusk" width="220" height="60" />
      <main className="dra-card">
        <h1 className="dra-h1">{title}</h1>
        {intro ? <p className="dra-intro">{intro}</p> : null}
        {children}
      </main>
      <p className="dra-help">
        Need a hand? Call <a href={`tel:${DR_PHONE.replace(/\s/g, "")}`}>{DR_PHONE}</a> or email{" "}
        <a href={`mailto:${DR_EMAIL}`}>{DR_EMAIL}</a>
      </p>
    </div>
  );
}

export function Note({ kind = "info", children }) {
  if (!children) return null;
  return (
    <div className={`dra-note dra-note--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

// Primary submit that says what is happening while the request runs, so a
// slow email send never looks like a dead button.
export function SubmitButton({ children, busyText, name, value, variant = "primary" }) {
  const nav = useNavigation();
  const busy = nav.state !== "idle" && (!value || nav.formData?.get(name) === value);
  return (
    <button type="submit" name={name} value={value} className={`dra-btn dra-btn--${variant}`} disabled={busy}>
      {busy ? busyText || "One moment..." : children}
    </button>
  );
}
