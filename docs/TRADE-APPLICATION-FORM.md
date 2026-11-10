# Online wholesale account application form

Live since Tue 10 Nov 2026 on both storefronts. It replaces "download two PDFs,
fill them in by hand and email them back".

| Site | Page | Applications go to |
| --- | --- | --- |
| Worthy Products | https://worthyproducts.nz/pages/wholesale-inquiries | accounts@worthyproducts.nz |
| Dutch Rusk | https://b2b.dutchrusk.co.nz/pages/wholesale-account | admin@dutchrusk.co.nz |

On Dutch Rusk the old `/pages/wholesale-inquiries` page sends visitors to the
page above (a redirect in `layout/theme.liquid`).

## What the customer does

Four steps: business details, contacts and references, terms (Worthy Products)
or guarantee (Dutch Rusk), then the direct debit authority. They sign on screen
with a finger or mouse. The two PDF downloads stay under the form for anyone who
prefers paper.

## What the team receives

One email with a summary table and two PDFs attached: the team's own
application form and direct debit authority, filled in and signed, so they look
the same as the paper forms. The customer gets a copy. Replying to the team
email goes to the customer.

Nothing is stored. Bank details exist only in the emailed PDF.

## Rules

- Registration number is mandatory. GST number is optional.
- The first two trade references are mandatory (name and contact number).
- Worthy Products: the guarantee is mandatory when the company type is Company,
  optional otherwise. Dutch Rusk: one signature covers the application and the
  personal guarantee, as on its paper form, so it is always required.
- The signed date is the day of submission (New Zealand time).
- Five applications per hour from one internet connection, to slow down spam.
- Address fields look up New Zealand addresses from Google.

## Where the code is

| Piece | Location |
| --- | --- |
| Endpoint `POST /api/trade-application` | `app/routes/api.trade-application.jsx` (this repo, runs on Render) |
| Validation, PDF filling, brand settings | `app/lib/trade-forms.server.js` |
| The blank PDFs that get filled | `app/assets/trade-forms/` (`wp-*.pdf`, `dr-*.pdf`) |
| Worthy Products form | theme `sections/trade-application.liquid`, template `page.trade-application.json` (store vjtrading) |
| Dutch Rusk form | theme repo `Worthy-Technology/WorthyProductsSouthWebsite`: `sections/dr-trade-application.liquid`, `sections/wholesale-account-help.liquid`, `templates/page.wholesale-account.json` |

The brand is decided by the website the request comes from (`origins` in
`BRANDS`), never by anything in the request.

Emails go through Brevo. Worthy Products sends from `no-reply@worthy.nz`
because `worthyproducts.nz` is not set up as a sending domain in Brevo. Dutch
Rusk sends from `no-reply@dutchrusk.co.nz`.

## How to change things

- **Team email address:** `teamEmail` in `BRANDS` in `app/lib/trade-forms.server.js`. Also the
  `team_email` setting in the page template, which is the address shown beside the PDF buttons.
- **A PDF form is reissued:** replace the file in `app/assets/trade-forms/` with the same name.
  If the layout moved, the positions in `fillWorthyCredit`, `fillDutchRuskCredit` or `fillDd`
  need re-measuring (they are points from the top-left of the page). Also update the download
  links in the page template.
- **Which fields are mandatory:** change it in two places, the server rules
  (`validateApplication` / `validateDutchRusk`) and the form's own `check()` in the theme section.
  The server is the one that counts; the form check is there so people see the message early.
- **Google address lookup:** key `google_maps_key` in the page template. The key lives in Google
  Cloud project `worthy-properties-509000` and only works from worthyproducts.nz and
  dutchrusk.co.nz addresses. Leave the setting blank to switch the lookup off.

## Testing without emailing the team

The live forms always email the real team inbox. To see the emails yourself,
run the same code locally with the team address overridden (see the git history
for `.scratch_tradeform_send_both.mjs`, used on 10 Nov), or submit the live form
with TEST in the company name and warn the team first.

## Not done yet (as at 10 Nov 2026)

- A real application approved end to end by each accounts team.
- A finger-drawn signature on a real phone.
- A spending alert on the Google Cloud project.
- Dutch Rusk's homepage and FAQ still link straight to the PDFs.
