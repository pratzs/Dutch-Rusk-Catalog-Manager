# Product images

## Standard

Every live Dutch Rusk product image is a **PNG, exactly 500x500, on a white background**, with the product centred and not cropped. This has been the standard since July 2026.

## State on 20 Nov 2026

All 1,780 live products were checked, and 1,754 meet the standard:
- 1,286 off-spec images were reformatted and swapped.
- 28 products that had no image were given one.

26 still have no image, because no reliable photo exists online and a supplier photo or our own photo is needed. The list, with reasons, is in OneDrive: `03.Dutch Rusk E-Commerce Project/Product Images/Still need photos 2026-11-20.csv`. The originals of every swapped image are kept in `Product Images/Backup - Originals 2026-11-20` with a manifest, so any product can be put back.

## Weekly check

`app/lib/image-check.server.js` runs inside the web service. Every Monday from 08:00 NZ it lists live products that:
- have no image,
- have an image that failed to process, or
- have an image that is not a 500x500 PNG.

It emails that list, with new products (created in the last 8 days) first and the rest sorted by stock. Each line links to the product in admin. If every product is fine, nothing is sent.

- Recipients: `IMAGE_ALERT_TO` (comma list), otherwise `PRICING_ALERT_EMAIL`.
- `IMAGE_CHECK=off` stops it.
- Only one email is sent each week: it is claimed in `ReportSendLog` with the key `image-check-<Monday date>`.
- Log prefix: `[image-check]`.

## How images were swapped (20 Nov 2026)

The office IP is blocked from the app's Admin API token, so the work was split between the office PC and Render:
1. On the PC, the originals were downloaded and formatted with Pillow. Near-white margins were trimmed, the product was fitted into 460px and centred on a white 500x500 canvas, and the result was saved as PNG.
2. A Render one-off job ran `stagedUploadsCreate` (POST targets).
3. The PC uploaded the files to those targets. Google storage is not IP-restricted.
4. A second Render job ran `productUpdate(product, media)` to add the new image, then `productDeleteMedia` to remove the old one.
