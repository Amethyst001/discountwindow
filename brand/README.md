# Brand assets — The Discount Window

Produced by the brand session on Nov 3, 2026, packed into `DISCOUNTWINDOW_BRAND_PACK.zip` in Downloads,
and moved here on Nov 4 (zip hash verified before and after the move).

| File | Content | Notes |
|---|---|---|
| `01_logo_primary.jpg` | mark, serif wordmark, tagline "Every refusal has a reason." | cream ground, JPEG — no alpha |
| `02_app_icon.jpg` | rounded tile, cream glyph | **navy ≈ `#14243f`**, not the app's ink `#191712` |
| `03_palette_type.png` | colour and type sheet | rendered from code, accurate |
| `04_banner.jpg` | 1280×720 Devpost / social banner | **FUNDED and REFUSED stamps on one invoice** |

The app's own palette, from `src/html.ts`: paper `#f4efe4`, ink `#191712`, oxblood `#78211f`,
olive `#40532a`, gold `#9a6f16`.

## Open items

- Recolour the app icon to ink `#191712` and export PNG with transparency.
- Rebuild the banner so one invoice carries one verdict; the current pair contradicts the product's
  own thesis and is the first thing a judge will notice.
- Export SVG versions of the mark and wordmark.
- Dark-mode logo; YouTube thumbnail (1280×720, under 2 MB).
- Wire the icon in as the app favicon (`src/html.ts` currently declares none) and use the thumbnail in
  `DEVPOST.md`, which references no images yet.

Keep the JPEGs as delivered until the alpha and SVG exports exist; do not upscale them.
