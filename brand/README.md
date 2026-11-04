# Brand assets — The Discount Window

Produced by the brand session on Nov 3, 2026 and packed as `DISCOUNTWINDOW_BRAND_PACK.zip` (moved here
Nov 4, hash verified). That session stopped at 98% usage with raster-only pieces; the corrections below
were finished on Nov 4 with deterministic pixel work — recolouring and matting, no AI generation.

The app's palette, from `src/html.ts`: paper `#f4efe4`, ink `#191712`, oxblood `#78211f`, olive
`#40532a`, gold `#9a6f16`.

## Originals, as delivered

| File | Content | Verified state |
|---|---|---|
| `01_logo_primary.jpg` | mark, serif wordmark, tagline | cream ground `#fcf7ef`, mark near-black `#272b2e`, JPEG — no alpha |
| `02_app_icon.jpg` | rounded tile, cream glyph | tile **navy `#0e223b`** — off-palette against the app's ink `#191712` |
| `03_palette_type.png` | colour and type sheet | ground matches app paper exactly; accurate |
| `04_banner.jpg` | 1280×720 banner | **FUNDED and REFUSED stamped on one invoice** — a contradiction |

The banner defect was confirmed twice over: pixel sampling and an external image-recognition read that
transcribed both stamps on the same document.

## Added Nov 4 — deterministic corrections

| File | What it is |
|---|---|
| `01_logo_primary_ink.png` | logo recoloured to ink `#191712` |
| `01_logo_transparent.png` | alpha-matted logo; letter counters cleared (a flood fill would have kept them cream) |
| `01_logo_dark.jpg` | dark-mode preview: paper glyph on ink ground |
| `02_app_icon_ink.png` | tile recoloured navy → ink; verified pixel `(16,33,61)` → `(25,23,18)` = `#191712` |
| `02_app_icon_ink_transparent.png` | tile flood-matted from the edges; the cream glyph stays opaque |
| `favicon.ico`, `favicon-32.png`, `favicon-192.png`, `favicon-512.png` | cut from the recoloured tile; the app serves them at `/favicon.ico` and `/favicon-*.png` through an open route |
| `04_banner_v2.jpg` | rebuilt banner: full wordmark, one invoice, one REFUSED stamp, reason underneath |
| `05_thumbnail.jpg` | the same frame, as the YouTube thumbnail |

The rebuilt banner's card states A-1043's real refusal from the seed: `INVOICE A-1043`, `USD 48,000`,
Northwind Components Ltd · Aba, NG, `CONSIGNEE MISMATCH`, "evidence pinned to the refusal" — the same
numbers the app's Start-here strip opens on. An external image-recognition read of the rebuild came
back PASS: every line transcribed word for word, nothing cut off, no overlaps.

Two defects were caught and fixed along the way: the first rebuild sliced the wordmark at "The Discount
Wi" (a fixed-percentage scan cut through the text), and the evidence line carried A-1054's hash next to
A-1043's invoice number — replaced with a truthful sentence.

## Still open

- **SVG:** the brand session never exported vectors. A faithful SVG needs the original source or a
  hand-traced rebuild; neither exists here, so none was faked.
- The rebuild has a faint seam where the pasted lockup crop meets the painted background (the external
  check called it "very faint"; legibility unaffected).

Keep the JPEGs as delivered; do not upscale them.
