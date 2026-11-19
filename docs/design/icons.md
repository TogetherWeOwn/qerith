# Drive icons

Drive draws its own inline-SVG stroke icons. The drawing rules and the general icons below match the Ember Hours set at `TogetherWeOwn/two-design-kit` tag v0.3.1, so Drive keeps that look; Drive owns its own copies.

## Rules

- 24 px grid (`size.icon.grid`), drawn at `size.icon.md` (20 px) or `size.icon.sm` (16 px, in menus and badges).
- 1.75 stroke, round caps and joins, no fill, `stroke="currentColor"`, so an icon takes its text colour and stays visible in forced colours.
- `aria-hidden="true"` on every icon. An icon next to text is decorative; an icon-only button has an `aria-label` that says the action ("Actions for report.pdf", "Close").
- No icon font and no third-party set.
- Shape tells icons apart, never colour.

## The set

| Name | Drawing | Used in |
|---|---|---|
| upload | arrow up from a bar under it, no tray, so it never reads as share | K4 Upload, empty states |
| download | arrow down onto a bar | K5 Download, K12 |
| folder | folder outline | K3, K9 |
| folder-shared | folder with a small person | K3 (an item shared with you) |
| file | page with a folded corner | K3 (unknown kind) |
| image | page + mountain | K3 |
| video | page + play triangle | K3 |
| audio | page + note | K3 |
| document | page + three lines | K3 |
| archive | page + zip teeth | K3 |
| more | three dots, horizontal | K5 menu button, K1 "…" |
| close | × | K7 close, K14 close |
| trash | bin | K5 Delete, K10 |
| move | folder with an arrow | K5 Move |
| copy | two offset rounded squares | K18 Copy link |
| key | key (passkey) | K17 primary |
| user-plus | person with a plus | "Invite someone" |
| info | i in a circle | K5 Details, info notices |
| share | share mark | K5 Share |
| edit | pencil | K5 Rename |
| check | tick | "Copied", "Uploaded", done states |
| lock | padlock | K17 lock line |
| up / down | chevron up / down | sort direction in K2 headers, K14 collapse and expand |
| menu | three lines | J1 Menu at ≤ 820 px |

The kind glyphs (file, image, video, audio, document, archive) are one page outline with a different mark inside, so they differ by shape. Kind comes from the file extension and stored type; anything unknown is "file".

## Product mark

The product mark is the Drive glyph followed by the word "Drive". It is the only thing in the K17 header and the start of the J1 header.

- **Glyph:** [assets/drive-mark.svg](assets/drive-mark.svg). A solid folder with a slot cut through it, on the 24 px grid. Unlike the icons it is filled, not stroked, so it never reads as the outline `folder` icon. Inline it (don't load it with `<img>`), keep `fill="currentColor"` and `aria-hidden="true"`, and draw it at 24 px (`size.icon.grid`).
- **Colour:** `color.text.primary`, never ember: the one ember surface belongs to the primary action. In forced colours it takes `CanvasText` through `currentColor`.
- **Word:** "Drive" in `font.ui`, `font-size.ui` (15 px), weight 600, `text.primary`, 8 px (`space.2`) after the glyph, glyph and word centred on one line.
- **Name for assistive tech:** the word is the name. In J1 the lockup is a link to My Drive named "Drive, My Drive" (`aria-label`). In K17 it is plain text inside `<header>`, not a link, because a signed-out person has nowhere to go.
- **Favicon:** the same glyph, `#F6F1EA` on `#15100F` with a 4 px corner radius at 32 px. Not required for the first sign-in build.
