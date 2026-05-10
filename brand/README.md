# Snapsus brand assets

Drop these into anywhere you need the Snapsus mark — email signatures,
press kits, dashboard headers, swag, etc.

Source files are SVG (vector — scales infinitely). PNG renders are at the
size needed for most app/social use cases. Need a different size?
`rsvg-convert -w <px> file.svg -o out.png`.

## Files

| File                              | Use                                           |
|-----------------------------------|-----------------------------------------------|
| `logo-mark-on-dark.svg`           | Square mark, white-on-black — app icons, favicon, social avatars |
| `logo-mark-on-light.svg`          | Square mark, black-on-paper — light-themed UI |
| `logo-mark-black.svg`             | Just the viewfinder, black on transparent — for any light bg |
| `logo-mark-white.svg`             | Viewfinder, white on transparent — for dark bg |
| `logo-horizontal-dark.svg`        | Full lockup (mark + "Snapsus") — for light bg |
| `logo-horizontal-light.svg`       | Full lockup, white — for dark bg              |

PNG variants follow the same names with `@1024` or `@1440` suffix.

## Color tokens

| Token          | Hex       | Use                              |
|----------------|-----------|----------------------------------|
| `ink`          | `#0a0a0a` | Primary mark / wordmark          |
| `paper`        | `#fafaf7` | Background fill, app icon paper  |
| `white`        | `#ffffff` | Mark on dark, mark fill          |
| `accent`       | `#5b3bff` | Hover, link, highlights          |
| `accent-soft`  | `#eee9ff` | Tinted backgrounds               |

## Type

Display headings: **Instrument Serif** (Google Fonts), italic for accents.
Body / wordmark: **Inter** 600, letter-spacing −0.01em.

## Don'ts

- Don't recolor the mark to anything besides black, white, or `ink`/`paper`.
- Don't add effects (gradient fills, shadows, outlines around the mark).
- Don't compress the wordmark — keep the gap between the mark and "Snapsus".
- Don't rotate or skew the mark. The four brackets are oriented intentionally.
- Minimum mark size: 16px. Below that the brackets visually merge.

## File live at

After deploy: <https://snapsus.com/brand/logo-mark-on-dark.svg> (etc.).
