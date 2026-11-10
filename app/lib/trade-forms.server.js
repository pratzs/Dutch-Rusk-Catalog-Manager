// Online trade account application: fills the team's own PDF forms.
//
// The storefront form posts the applicant's answers and drawn signatures.
// We print them onto the ORIGINAL Account Application and Direct Debit PDFs
// (app/assets/trade-forms/), so what the operations team receives looks the
// same as the paper form they already use. Positions below were measured from
// the PDFs (points, y measured from the TOP of the page as PDF viewers show
// it; toY() flips it for pdf-lib).
//
// Nothing is stored: the PDFs are built in memory, emailed, and dropped.

import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const INK = rgb(0.05, 0.1, 0.35);
const ASSET_DIR = path.join(process.cwd(), "app", "assets", "trade-forms");

// One entry per storefront. `origins` is the list of sites allowed to post.
export const BRANDS = {
  "worthy-products": {
    label: "Worthy Products",
    legalName: "Worthy Products Limited",
    teamEmail: "accounts@worthyproducts.nz",
    senderEmail: process.env.TRADE_FORM_SENDER_WP || "no-reply@worthy.nz",
    senderName: "Worthy Products",
    origins: ["https://worthyproducts.nz", "https://www.worthyproducts.nz", "https://vjtrading.myshopify.com"],
    creditPdf: "wp-credit.pdf",
    ddPdf: "wp-dd.pdf",
    phone: "+64 9 580 4110",
    accent: "#2156C3",
  },
  "dutch-rusk": {
    label: "Dutch Rusk",
    legalName: "Worthy Products South Ltd t/a Dutch Rusk",
    teamEmail: "admin@dutchrusk.co.nz",
    senderEmail: process.env.TRADE_FORM_SENDER_DR || "no-reply@dutchrusk.co.nz",
    senderName: "Dutch Rusk",
    origins: ["https://b2b.dutchrusk.co.nz", "https://dutchrusk.co.nz", "https://www.dutchrusk.co.nz", "https://dutchrusk.myshopify.com"],
    creditPdf: "dr-credit.pdf",
    ddPdf: "dr-dd.pdf",
    phone: "03 547 7809",
    accent: "#181344",
  },
};

export const DR_ENTITY_TYPES = ["Company", "Partnership", "Sole Trader"];

export const COMPANY_TYPES = ["Sole Trader", "Individual", "Partnership", "Company"];

// ---------- validation ----------

const str = (v, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(v) && v.length <= 120;
const digits = (v, max) => String(v ?? "").replace(/\D/g, "").slice(0, max);

function signature(v) {
  if (typeof v !== "string") return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (!m || m[1].length < 200 || m[1].length > 400_000) return null;
  return Buffer.from(m[1], "base64");
}

// The direct debit authority is the same on every brand's form.
function validateDirectDebit(input, d, e) {
  d.ddAccountName = str(input?.ddAccountName, 80);
  if (!d.ddAccountName) e.ddAccountName = "Account name is required";
  d.ddBankName = str(input?.ddBankName, 60);
  if (!d.ddBankName) e.ddBankName = "Name of your bank is required";
  d.ddBank = digits(input?.ddBank, 2);
  d.ddBranch = digits(input?.ddBranch, 4);
  d.ddAccount = digits(input?.ddAccount, 7);
  d.ddSuffix = digits(input?.ddSuffix, 3);
  if (d.ddBank.length !== 2) e.ddBank = "2 digits";
  if (d.ddBranch.length !== 4) e.ddBranch = "4 digits";
  if (d.ddAccount.length !== 7) e.ddAccount = "7 digits";
  if (d.ddSuffix.length < 2) e.ddSuffix = "2 or 3 digits";
  if (input?.ddAuthorise !== true) e.ddAuthorise = "Please confirm the direct debit authority";
  d.ddSignature = signature(input?.ddSignature);
  if (!d.ddSignature) e.ddSignature = "Please sign the direct debit authority";
  d.ddSignature2 = signature(input?.ddSignature2);
}

// Dutch Rusk's Customer Credit Application Form asks different questions
// from the Worthy Products one, so it has its own rules.
function validateDutchRusk(input) {
  const e = {};
  const d = {};
  const req = (key, label, max) => {
    d[key] = str(input?.[key], max);
    if (!d[key]) e[key] = `${label} is required`;
  };
  const opt = (key, max) => { d[key] = str(input?.[key], max); };

  req("tradingName", "Trading name", 100);
  d.entityType = DR_ENTITY_TYPES.includes(input?.entityType) ? input.entityType : "";
  if (!d.entityType) e.entityType = "Please choose a business entity";
  req("legalName", "Legal name", 100);
  opt("dateIncorporated", 20);
  opt("registrationNo", 30);
  opt("dateCommenced", 20);
  opt("startTradingDate", 20);
  req("deliveryAddress", "Delivery address", 200);
  opt("postalAddress", 200);
  req("contactPerson", "Contact person", 60);
  opt("phone", 30);
  req("mobile", "Mobile number", 30);
  req("email", "Email address", 120);
  if (d.email && !isEmail(d.email)) e.email = "Please enter a valid email address";
  req("estimatedPurchases", "Estimated monthly purchases", 30);

  d.references = [0, 1].map((i) => ({
    name: str(input?.references?.[i]?.name, 60),
    phone: str(input?.references?.[i]?.phone, 30),
    monthly: str(input?.references?.[i]?.monthly, 30),
  }));
  d.directors = [0, 1, 2].map((i) => ({ name: str(input?.directors?.[i]?.name, 70), address: str(input?.directors?.[i]?.address, 120) }));
  if (!d.directors[0].name) e.director1Name = "At least one director, partner or sole trader is required";
  if (d.directors[0].name && !d.directors[0].address) e.director1Address = "Address is required";

  // One signature covers the application and the personal guarantee, as on the paper form.
  req("signName", "Your full name", 100);
  req("signTitle", "Your title", 60);
  if (input?.acceptTerms !== true) e.acceptTerms = "Please accept the guarantee and conditions";
  d.acceptSignature = signature(input?.acceptSignature);
  if (!d.acceptSignature) e.acceptSignature = "Please sign";

  validateDirectDebit(input, d, e);
  d.companyName = d.legalName || d.tradingName; // used in email subjects and file names
  return { ok: Object.keys(e).length === 0, errors: e, data: d };
}

// Returns { ok, errors, data }. `errors` maps field name -> message for the form.
export function validateApplication(input, brandKey = "worthy-products") {
  if (brandKey === "dutch-rusk") return validateDutchRusk(input);
  const e = {};
  const d = {};
  const req = (key, label, max) => {
    d[key] = str(input?.[key], max);
    if (!d[key]) e[key] = `${label} is required`;
  };
  const opt = (key, max) => { d[key] = str(input?.[key], max); };

  req("companyName", "Company name", 120);
  opt("tradingName", 80);
  opt("companyRegNumber", 40);
  opt("gstNumber", 40);
  d.companyType = COMPANY_TYPES.includes(input?.companyType) ? input.companyType : "";
  if (!d.companyType) e.companyType = "Please choose a company type";
  req("businessAddress", "Business address", 200);
  req("deliveryAddress", "Delivery address", 200);
  req("email", "Email address", 120);
  if (d.email && !isEmail(d.email)) e.email = "Please enter a valid email address";
  req("estimatedPurchases", "Estimated monthly purchases", 30);

  req("contactName", "Business contact name", 100);
  opt("contactDesignation", 60);
  opt("contactEmail", 120);
  if (d.contactEmail && !isEmail(d.contactEmail)) e.contactEmail = "Please enter a valid email address";
  opt("contactLandline", 30);
  req("contactMobile", "Business contact mobile", 30);

  opt("accountsName", 100);
  opt("accountsDesignation", 60);
  opt("accountsEmail", 120);
  if (d.accountsEmail && !isEmail(d.accountsEmail)) e.accountsEmail = "Please enter a valid email address";
  opt("accountsLandline", 30);
  opt("accountsMobile", 30);

  d.directors = [0, 1, 2].map((i) => ({ name: str(input?.directors?.[i]?.name, 100), phone: str(input?.directors?.[i]?.phone, 40) }));
  if (!d.directors[0].name) e.director1Name = "At least one director, partner or proprietor is required";
  if (d.directors[0].name && !d.directors[0].phone) e.director1Phone = "Contact number is required";

  d.references = [0, 1, 2].map((i) => ({
    name: str(input?.references?.[i]?.name, 100),
    phone: str(input?.references?.[i]?.phone, 40),
    monthly: str(input?.references?.[i]?.monthly, 30),
  }));

  req("acceptName", "Your full name", 100);
  req("acceptDesignation", "Your designation", 50);
  if (input?.acceptTerms !== true) e.acceptTerms = "Please accept the Terms and Conditions of Trade";
  d.acceptSignature = signature(input?.acceptSignature);
  if (!d.acceptSignature) e.acceptSignature = "Please sign";

  // Guarantee: required for a Company, optional for the other types.
  opt("guarantorName", 100);
  opt("guarantorPosition", 60);
  d.guarantorSignature = signature(input?.guarantorSignature);
  const guaranteeStarted = d.guarantorName || d.guarantorPosition || d.guarantorSignature;
  if (d.companyType === "Company" || guaranteeStarted) {
    if (!d.guarantorName) e.guarantorName = "Guarantor name is required";
    if (!d.guarantorPosition) e.guarantorPosition = "Position in company is required";
    if (!d.guarantorSignature) e.guarantorSignature = "Guarantor signature is required";
  }
  d.hasGuarantee = Boolean(d.guarantorName && d.guarantorSignature);

  validateDirectDebit(input, d, e);

  return { ok: Object.keys(e).length === 0, errors: e, data: d };
}

// ---------- PDF drawing helpers ----------

function nzDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: get("day"), month: get("month"), year: get("year"), text: `${get("day")}/${get("month")}/${get("year")}` };
}

// WinAnsi (Helvetica) cannot draw every character; swap the common ones and drop the rest.
function printable(text) {
  return String(text ?? "")
    .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[Āā]/g, (c) => (c === "Ā" ? "A" : "a")).replace(/[Ēē]/g, (c) => (c === "Ē" ? "E" : "e"))
    .replace(/[Īī]/g, (c) => (c === "Ī" ? "I" : "i")).replace(/[Ōō]/g, (c) => (c === "Ō" ? "O" : "o"))
    .replace(/[Ūū]/g, (c) => (c === "Ū" ? "U" : "u"))
    .replace(/[^\x20-\x7E -ÿ]/g, "");
}

function makePen(page, font) {
  const H = page.getHeight();
  const toY = (top) => H - top;
  return {
    // Text on a blank line: x0..x1 is the line, base is the line's y (from top).
    line(text, x0, x1, base, size = 8.5) {
      let t = printable(text);
      if (!t) return;
      const room = x1 - x0 - 4;
      let s = size;
      while (s > 5.5 && font.widthOfTextAtSize(t, s) > room) s -= 0.25;
      while (t.length > 1 && font.widthOfTextAtSize(t, s) > room) t = t.slice(0, -1);
      page.drawText(t, { x: x0 + 2, y: toY(base) + 1.8, size: s, font, color: INK });
    },
    centred(text, x0, x1, base, size) {
      const t = printable(text);
      const w = font.widthOfTextAtSize(t, size);
      page.drawText(t, { x: x0 + (x1 - x0 - w) / 2, y: toY(base), size, font, color: INK });
    },
    tick(x0, top, x1, bottom) {
      const pad = 3;
      page.drawLine({ start: { x: x0 + pad, y: toY(top + pad) }, end: { x: x1 - pad, y: toY(bottom - pad) }, thickness: 1.3, color: INK });
      page.drawLine({ start: { x: x0 + pad, y: toY(bottom - pad) }, end: { x: x1 - pad, y: toY(top + pad) }, thickness: 1.3, color: INK });
    },
    // Signature image fitted inside a box, sitting on the box's bottom edge.
    image(img, x0, top, x1, bottom) {
      const scale = Math.min((x1 - x0) / img.width, (bottom - top) / img.height);
      const w = img.width * scale, h = img.height * scale;
      page.drawImage(img, { x: x0, y: toY(bottom), width: w, height: h });
    },
  };
}

async function loadTemplate(file) {
  return PDFDocument.load(await fs.readFile(path.join(ASSET_DIR, file)));
}

// ---------- Worthy Products: Account Application Form (2 pages) ----------

async function fillWorthyCredit(d, date) {
  const pdf = await loadTemplate(BRANDS["worthy-products"].creditPdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const [p1, p2] = pdf.getPages();
  const a = makePen(p1, font);

  a.line(d.companyName, 110, 337, 139.9);
  a.line(d.tradingName, 391, 550, 139.9);
  a.line(d.companyRegNumber, 152, 284, 159.4);
  a.line(d.gstNumber, 389, 550, 159.4);

  const boxes = {
    "Sole Trader": [181.5, 172.3, 196, 182.8],
    Individual: [243.5, 172.3, 258, 182.8],
    Partnership: [308.5, 172.8, 323, 183.3],
    Company: [370.5, 173.3, 385, 183.8],
  };
  if (boxes[d.companyType]) a.tick(...boxes[d.companyType]);

  a.line(d.businessAddress, 101, 527, 198.5);
  a.line(d.deliveryAddress, 100, 526, 218.1);
  a.line(d.email, 100, 494, 237.5);
  a.line(d.estimatedPurchases.replace(/^\$\s*/, ""), 201, 317, 266.7);

  a.line(d.contactName, 157, 543, 296.1);
  a.line(d.contactDesignation, 83, 290, 315.6);
  a.line(d.contactEmail, 328, 551, 315.6);
  a.line(d.contactLandline, 96, 291, 335.2);
  a.line(d.contactMobile, 329, 552, 335.2);

  a.line(d.accountsName, 174, 552, 354.8);
  a.line(d.accountsDesignation, 83, 290, 374.3);
  a.line(d.accountsEmail, 328, 551, 374.3);
  a.line(d.accountsLandline, 96, 291, 393.9);
  a.line(d.accountsMobile, 329, 552, 393.9);

  [442.8, 462.3, 482.2].forEach((base, i) => {
    a.line(d.directors[i].name, 48, 295, base);
    a.line(d.directors[i].phone, 300, 547, base);
  });
  [530.8, 550.4, 569.7].forEach((base, i) => {
    a.line(d.references[i].name, 48, 291, base);
    a.line(d.references[i].phone, 296, 432, base);
    a.line(d.references[i].monthly, 441, 548, base);
  });

  a.line(d.acceptName, 81, 319, 644.6);
  a.line(d.acceptDesignation, 433, 541, 644.6);
  const acceptSig = await pdf.embedPng(d.acceptSignature);
  a.image(acceptSig, 90, 646.5, 380, 666.5);
  a.line(date.text, 411, 547, 665.6);

  if (d.hasGuarantee) {
    a.line(d.companyName, 247, 442, 711.9);
    a.line(date.text, 64, 279, 780.3);
    a.image(await pdf.embedPng(d.guarantorSignature), 362, 763.5, 550, 781);
    a.line(d.guarantorName, 115, 281, 800.9);
    a.line(d.guarantorPosition, 350, 551, 800.9);
  }

  // Page 2: Terms and Conditions of Trade, signed and dated at the bottom.
  const b = makePen(p2, font);
  b.image(acceptSig, 322, 700, 466, 730);
  b.line(date.text, 490, 552, 729.6, 8);

  pdf.setTitle(`Account Application - ${printable(d.companyName)}`);
  return Buffer.from(await pdf.save());
}

// ---------- Direct Debit Authority (1 page, same layout on both brands) ----------
// `top` shifts the account boxes and `sig` the signature row: the Dutch Rusk
// form is the same bank form with the blocks sitting a little differently.

async function fillDd(brandKey, d, date, { top = 0, sig = 0 } = {}) {
  const pdf = await loadTemplate(BRANDS[brandKey].ddPdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.getPages()[0];
  const a = makePen(page, font);

  a.line(d.ddAccountName, 76, 371, 124.5 + top, 10.5);
  a.line(d.ddBankName, 76, 371, 158.5 + top, 10.5);

  // One digit per box. x positions are the box edges measured from the form.
  const edges = {
    bank: [73.2, 90.1, 106.9],
    branch: [123.5, 140.2, 156.6, 173.2, 189.9],
    account: [206.4, 223.0, 239.4, 256.0, 272.6, 289.1, 305.7, 322.2],
    suffix: [339.0, 355.9, 372.8],
  };
  const row = 190.5 + top;
  const boxed = (value, xs) => [...value].forEach((ch, i) => a.centred(ch, xs[i], xs[i + 1], row, 11));
  boxed(d.ddBank, edges.bank);
  boxed(d.ddBranch, edges.branch);
  boxed(d.ddAccount, edges.account);
  // The form has two suffix boxes. A three-digit suffix that starts with 0
  // (e.g. 000) prints as its last two digits; any other three digits are
  // printed across both boxes so nothing is lost.
  if (d.ddSuffix.length === 3 && d.ddSuffix[0] !== "0") a.centred(d.ddSuffix, edges.suffix[0], edges.suffix[2], row, 11);
  else boxed(d.ddSuffix.slice(-2), edges.suffix);

  a.image(await pdf.embedPng(d.ddSignature), 78, 368 + sig, 234, 419.5 + sig);
  if (d.ddSignature2) a.image(await pdf.embedPng(d.ddSignature2), 259, 368 + sig, 409, 419.5 + sig);

  a.centred(date.day, 434, 462, 417.5 + sig, 10);
  a.centred(date.month, 467, 497, 417.5 + sig, 10);
  a.centred(date.year, 500, 528, 417.5 + sig, 10);

  pdf.setTitle(`Direct Debit Authority - ${printable(d.ddAccountName)}`);
  return Buffer.from(await pdf.save());
}

// ---------- Dutch Rusk: Customer Credit Application Form (1 page) ----------

async function fillDutchRuskCredit(d, date) {
  const pdf = await loadTemplate(BRANDS["dutch-rusk"].creditPdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.getPages()[0];
  const a = makePen(page, font);

  // Splits a long address over the form's three short lines.
  const wrap = (text, x0, x1, bases, size = 9) => {
    const words = printable(text).split(" ").filter(Boolean);
    const room = x1 - x0 - 4;
    const lines = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && font.widthOfTextAtSize(next, size) > room && lines.length < bases.length - 1) { lines.push(cur); cur = w; }
      else cur = next;
    }
    if (cur) lines.push(cur);
    lines.forEach((l, i) => a.line(l, x0, x1, bases[i], size));
  };

  a.line(d.tradingName, 152, 461, 171, 10);
  // The form's only tick space is beside COMPANY; other entity types are written next to the heading.
  if (d.entityType === "Company") a.line("X", 70, 84, 193.4, 9);
  else a.line(d.entityType, 247, 400, 183, 9);
  a.line(d.legalName, 208, 453, 194, 9.5);
  a.line(d.dateIncorporated, 194, 285, 216, 9);
  a.line(d.registrationNo, 364, 459, 216, 9);
  a.line(d.dateCommenced, 215, 365, 238, 9);
  a.line(d.startTradingDate, 403, 510, 260, 9);

  wrap(d.deliveryAddress, 72, 276, [308, 332, 356]);
  wrap(d.postalAddress, 326, 510, [308, 332, 356]);

  a.line(d.contactPerson, 158, 279, 379, 9.5);
  a.line(d.phone, 180, 303, 409, 9.5);
  a.line(d.mobile, 397, 515, 409, 9.5);
  a.line(d.email, 150, 513, 436, 9.5);

  [500, 512].forEach((base, i) => {
    a.line(d.references[i].name, 72, 221, base, 8.5);
    a.line(d.references[i].phone, 276, 359, base, 8.5);
    a.line(d.references[i].monthly.replace(/^\$\s*/, ""), 405, 510, base, 8.5);
  });
  a.line(d.estimatedPurchases.replace(/^\$\s*/, ""), 405, 510, 524, 9);

  [586, 598, 610].forEach((base, i) => {
    a.line(d.directors[i].name, 72, 246, base, 8.5);
    a.line(d.directors[i].address, 288, 497, base, 8.5);
  });

  a.line(d.signName, 108, 281, 643, 8.5); // "I, ____ personally guarantee to you"
  a.image(await pdf.embedPng(d.acceptSignature), 264, 714, 397, 738);
  a.line(date.text, 431, 523, 737, 9.5);
  a.line(d.signName, 191, 465, 761, 9.5);
  a.line(d.signTitle, 324, 524, 786, 9.5);

  pdf.setTitle(`Customer Credit Application - ${printable(d.companyName)}`);
  return Buffer.from(await pdf.save());
}

// Returns the two filled PDFs for a validated application.
export async function buildApplicationPdfs(brandKey, data, now = new Date()) {
  const date = nzDate(now);
  let credit, dd, creditName;
  if (brandKey === "worthy-products") {
    [credit, dd] = await Promise.all([fillWorthyCredit(data, date), fillDd(brandKey, data, date)]);
    creditName = "Account_Application";
  } else if (brandKey === "dutch-rusk") {
    [credit, dd] = await Promise.all([fillDutchRuskCredit(data, date), fillDd(brandKey, data, date, { top: 16.1, sig: -3.7 })]);
    creditName = "Customer_Credit_Application";
  } else {
    throw new Error(`No PDF forms set up for ${brandKey}`);
  }
  const safe = printable(data.companyName).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "Applicant";
  return {
    date,
    files: [
      { name: `${creditName}_${safe}.pdf`, content: credit },
      { name: `Direct_Debit_Authority_${safe}.pdf`, content: dd },
    ],
  };
}

// Rows for the summary table in the emails. Bank details are left out on purpose.
export function summaryRows(brandKey, d) {
  const join = (...parts) => parts.filter(Boolean).join(", ");
  let rows;
  if (brandKey === "dutch-rusk") {
    rows = [
      ["Trading name", d.tradingName], ["Business entity", d.entityType], ["Legal name", d.legalName],
      ["Date of incorporation", d.dateIncorporated], ["Registration number", d.registrationNo],
      ["Date commenced business", d.dateCommenced], ["Date to start trading with Dutch Rusk", d.startTradingDate],
      ["Delivery address", d.deliveryAddress], ["Postal address", d.postalAddress],
      ["Contact person", join(d.contactPerson, d.phone, d.mobile)], ["Email", d.email],
      ["Estimated purchases per month", d.estimatedPurchases],
      ...d.references.filter((x) => x.name).map((x, i) => [`Trade reference ${i + 1}`, join(x.name, x.phone, x.monthly)]),
      ...d.directors.filter((x) => x.name).map((x, i) => [`Director / partner ${i + 1}`, join(x.name, x.address)]),
      ["Signed and guaranteed by", join(d.signName, d.signTitle)],
    ];
  } else {
    rows = [
      ["Company name", d.companyName], ["Trading name", d.tradingName], ["Company type", d.companyType],
      ["Company registration number", d.companyRegNumber], ["GST number", d.gstNumber],
      ["Business address", d.businessAddress], ["Delivery address", d.deliveryAddress], ["Email", d.email],
      ["Estimated purchases per month", d.estimatedPurchases],
      ["Business contact", join(d.contactName, d.contactDesignation, d.contactEmail, d.contactLandline, d.contactMobile)],
      ["Accounts contact", join(d.accountsName, d.accountsDesignation, d.accountsEmail, d.accountsLandline, d.accountsMobile)],
      ...d.directors.filter((x) => x.name).map((x, i) => [`Director / partner ${i + 1}`, join(x.name, x.phone)]),
      ...d.references.filter((x) => x.name).map((x, i) => [`Trade reference ${i + 1}`, join(x.name, x.phone, x.monthly)]),
      ["Terms accepted by", join(d.acceptName, d.acceptDesignation)],
      ["Guarantee", d.hasGuarantee ? join(d.guarantorName, d.guarantorPosition) : "Not provided"],
    ];
  }
  rows.push(["Direct debit authority", "Signed. Bank details are in the attached PDF only."]);
  return rows.filter(([, v]) => v);
}
