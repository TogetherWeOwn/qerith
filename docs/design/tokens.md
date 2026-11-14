# Drive tokens

Every colour, size, space, radius, font and duration Drive uses. Values were copied from the Ember Hours tokens at `TogetherWeOwn/two-design-kit` tag **v0.3.1** (`4eb4181762ac4dca636701f16366f285b8ac8490`), so Drive keeps that look. Drive owns them from here: this file is the source of truth for Drive, and a change to the kit does not change Drive.

**Naming.** In prose and in [components.md](components.md) a token is written by its dotted name (`color.bg.surface`, `size.control.sm`). In CSS it is a custom property with the `--drive-` prefix and dots turned into dashes: `color.bg.surface` → `--drive-color-bg-surface`, `font-size.h3` → `--drive-font-size-h3`. Drive CSS never uses `--two-*` properties and never loads the kit's stylesheet.

**Rule:** components and pages use these tokens only. A raw hex, pixel, millisecond or font value in Drive CSS is a bug unless this file names it. A missing value is added here first, by the UX Designer, with its contrast pair (§1.7) if it is a colour.

## 1. Colour

Dark only. Set `color-scheme: dark` on `:root`.

### 1.1 Grounds (elevation is luminance, never a shadow)

| Token | Value | Use |
|---|---|---|
| `color.bg.canvas` | `#15100F` | Page. Inside of text fields. |
| `color.bg.surface` | `#1C1614` | Cards, panels, dialogs, row hover, details line. |
| `color.bg.raised` | `#241C19` | Active nav pill, the row whose menu is open, a just-added row, quiet buttons. |
| `color.bg.overlay` | `#2E2420` | Menus, the drop panel, empty progress tracks, loading avatar discs. |
| `color.bg.sticky` | `rgba(21, 16, 15, 0.86)` | The J1 header, with `elevation.blur` and a bottom hairline. |
| `color.bg.sheet` | `rgba(28, 22, 20, 0.94)` | Bottom sheets, the upload tray, the menu sheet, with `elevation.blur` and a `line.hairline-strong` top edge. |
| `color.bg.well` | `#121212` | Behind the optional image preview only. Never behind text. |
| `color.scrim.sheet` | `rgba(28, 22, 20, 0.94)` | Dialog backdrop (K7). |
| `color.ground.4` | `#3E322C` | `+N` disc in an avatar stack. |

**Rule:** a component sits one step above what it sits on (a dialog on the page, a menu on a dialog). Never skip two steps; never go down.

### 1.2 Text

| Token | Value | Use |
|---|---|---|
| `color.text.primary` | `#F6F1EA` | Headings, names, values. |
| `color.text.secondary` | `#D2C7BD` | Body copy, ledes, explanations, kind glyphs. |
| `color.text.tertiary` | `#A89A8E` | Mono lines, times, counts, separators, disabled labels. |
| `color.text.accent` | `#FF9C36` | Rare ember text marks. |
| `color.text.link` | `#FF9C36` | Breadcrumb links and links in facts lists. |
| `color.text.on-accent` | `#1D0B00` | Text and icons on ember. |
| `color.avatar-text` | `#FFFFFF` | Initials on avatar fallback discs. |

### 1.3 Lines

| Token | Value | Use |
|---|---|---|
| `color.line.hairline` | `rgba(255, 236, 220, 0.08)` | Row separators, card edges. Decorative. |
| `color.line.hairline-strong` | `rgba(255, 236, 220, 0.14)` | Tag outlines, ghost buttons, dialogs, menus. Decorative. |
| `color.line.control` | `#85766B` | Any edge a person must see to operate a control: text fields, check boxes, the drop outline. 3.46:1 or better on every ground. |

A hairline is never the only way to find a control or read a state.

### 1.4 Accent and focus

| Token | Value | Use |
|---|---|---|
| `color.accent.default` | `#FF9C36` | The one primary action; the progress fills of your own uploads; the K20 tick. |
| `color.accent.hover` | `#FFAA47` | Hover on ember surfaces. |
| `color.focus.ring` | `#FF9C36` | 2 px outline, 3 px offset, every focusable element. |
| `color.focus.ring-on-accent` | `#1D0B00` | Focus ring on an ember surface. |

**Ember is rationed:** one ember surface per view (the primary action), plus small "yours" marks: the A15 progress fills of your own uploads (the K14 summary bar and K15 rows), the K20 tick, `text.link` and the focus ring. A "yours" mark is never a button or a panel. Apart from those marks, if two things on screen are ember-filled, one of them is wrong.

### 1.5 State (one meaning each)

| Token | Value | Ground token | Ground value | Means |
|---|---|---|---|---|
| `color.state.ok` | `#5FD39A` | `color.state.ok-bg` | `#16291F` | Done, uploaded, active, saved. |
| `color.state.warn` | `#F2C14E` | `color.state.warn-bg` | `#2E2410` | Access off, interrupted upload, needs attention. |
| `color.state.danger` | `#FF7A6B` | `color.state.danger-bg` | `#3A1A16` | Errors, failed uploads, destructive actions. |

State never relies on colour alone: every state colour comes with a word ("Uploaded", "Access off") and, where it has one, an icon.

### 1.6 Avatar fallback discs

`color.avatar.0`…`11`, chosen by a stable hash of the person's id (never by name), with `color.avatar-text` initials:

| 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `#AB4E00` | `#5701AE` | `#B9001C` | `#430093` | `#822800` | `#DC0037` | `#4D00A1` | `#7A2BD1` | `#9A3B00` | `#3A0086` | `#C2185B` | `#5E35B1` |

### 1.7 Contrast: every allowed pair

Ratios are WCAG 2.x relative luminance, measured at kit v0.3.1. Floors: text 4.5, non-text 3, avatar initials 5.1. A colour pair that isn't here isn't used; to add one, measure it and add it here first. Translucent tokens (hairlines, sticky, sheet, scrim) are decorative and not in the table.

| Foreground | On `bg.canvas` | On `bg.surface` | On `bg.raised` | On `bg.overlay` | Floor |
|---|---|---|---|---|---|
| `text.primary` | 16.79 | 15.92 | 14.89 | 13.45 | 4.5 |
| `text.secondary` | 11.36 | 10.77 | 10.07 | 9.10 | 4.5 |
| `text.tertiary` | 6.90 | 6.54 | 6.12 | 5.53 | 4.5 |
| `text.accent` / `text.link` | 9.04 | 8.57 | 8.02 | 7.24 | 4.5 |
| `state.ok` | 10.13 | 9.60 | 8.98 | 8.11 | 4.5 |
| `state.warn` | 11.24 | 10.66 | 9.97 | 9.01 | 4.5 |
| `state.danger` | 7.41 | 7.02 | 6.57 | 5.94 | 4.5 |
| `line.control` | 4.31 | 4.09 | 3.83 | 3.46 | 3 |
| `focus.ring` | 9.04 | 8.57 | 8.02 | 7.24 | 3 |
| `accent.default` (fills) | 9.04 | 8.57 | 8.02 | 7.24 | 3 |

| Foreground | Background | Ratio | Floor |
|---|---|---|---|
| `text.on-accent` | `accent.default` | 9.15 | 4.5 |
| `text.on-accent` | `accent.hover` | 10.08 | 4.5 |
| `focus.ring-on-accent` | `accent.default` | 9.15 | 3 |
| `state.ok` | `state.ok-bg` | 8.22 | 4.5 |
| `text.primary` | `state.ok-bg` | 13.63 | 4.5 |
| `state.warn` | `state.warn-bg` | 9.09 | 4.5 |
| `text.primary` | `state.warn-bg` | 13.58 | 4.5 |
| `text.secondary` | `state.warn-bg` | 9.19 | 4.5 |
| `state.danger` | `state.danger-bg` | 6.16 | 4.5 |
| `text.primary` | `state.danger-bg` | 13.95 | 4.5 |
| `text.secondary` | `state.danger-bg` | 9.44 | 4.5 |
| `focus.ring` | `bg.well` | 8.97 | 3 |

Avatar initials (`avatar-text` on `avatar.0`…`11`): 5.50 · 10.39 · 6.82 · 12.65 · 9.32 · 5.12 · 11.47 · 6.79 · 7.00 · 13.78 · 5.87 · 8.02 (floor 5.1).

## 2. Typography

| Token | Value | Job |
|---|---|---|
| `font.ui` | `Mona Sans, system-ui, sans-serif` | All UI text: body, buttons, nav, fields, headings. Self-hosted variable font (wdth 75–125, wght 200–900), latin subset, preloaded, `font-display: swap`. |
| `font.data` | `Fragment Mono, ui-monospace, monospace` | Sizes, times, counts, labels, links in copy fields. Latin subset, `font-display: optional`. |

Both are SIL OFL. Drive uses no serif accent.

| Token | Value |
|---|---|
| `font-weight.regular` / `medium` / `display` / `semibold` | 400 / 500 / 560 / 600 |
| `font-width.body` / `button` / `display` | 100% / 105% / 108% |
| `line-height.heading` / `title` / `body` / `label` | 1.1 / 1.3 / 1.55 / 1.4 |
| `tracking.h3` / `body` / `label` | −0.025em / −0.005em / 0.04em |

**Scale:**

| Token | Size | Weight / width / tracking / leading | Use in Drive |
|---|---|---|---|
| `font-size.h3` | `clamp(22px, 2vw, 26px)` | 560 / 108% / −0.025em / 1.1 | Page H1 on every Drive screen; K17 card H1 |
| `font-size.title` | 20px | 600 / 1.3 | Dialog H2 (K7) |
| `font-size.lede` | 18px (16px at ≤ 820 px) | 400 / 1.55 | Page lede |
| `font-size.body` | 16px | 400 / 1.55 | Body copy |
| `font-size.ui` | 15px | 500–600 / 1.3, buttons at 105% width | Buttons, nav, names, fields, rows |
| `font-size.small` | 14px | 400 / 1.4 | Explanations, notes, breadcrumbs at 390 |
| `font-size.meta` | 13px | 400 / 1.4 | Second lines in rows and pickers ("Shared by Mora", "Through Taxes", a disabled folder's reason). Drive only: the K components named 13 px before Drive had its own tokens. |
| `font-size.label` | 12px | Fragment Mono 400, uppercase, +0.04em | Tags and column headers. **The floor.** |

Where [components.md](components.md) gives a text size in px (15 px, 14 px, 13 px, 12 px), it means the token with that value.

**Rules:**
- **12 px floor.** No text is smaller.
- **Headings** wrap with `text-wrap: balance` and never truncate. File names in rows truncate in the middle (components.md, "Sizes and numbers").
- **Mono is data:** sizes, times, counts and labels. Uppercase only for labels of three words or fewer.
- **Numbers that update or compare are tabular** (`font-variant-numeric: tabular-nums`).
- **Sentence case** everywhere: headings, buttons, tags.

## 3. Space, radius, size

**Space:**

| Token | `space.1` | `2` | `3` | `4` | `5` | `6` | `7` | `8` | `9` | `10` | `11` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Value | 4px | 8px | 12px | 16px | 20px | 24px | 32px | 40px | 56px | 72px | 88px |

**Insets** (off the scale on purpose): `space.inset.tag-y` 5px · `tag-x` 7px · `tight` 10px · `room` 14px · `compact` 18px · `card` 22px · `card-lg` 28px. Every padding, gap and margin is one of these; a px value in components.md maps to the token with that value.

**Radius:** `radius.s` 6px (tags) · `radius.m` 10px (rows, fields, notices, menus) · `radius.l` 16px (cards, dialogs, the tray) · `radius.pill` 999px (buttons, avatars).

| Token | Value | Use |
|---|---|---|
| `size.control.sm` / `md` / `lg` | 36px / 44px / 56px | Pill heights. 36 is the minimum for any control. |
| `size.control.nav` | 40px | Nav pills in a wide header. |
| `size.target-min` | 24px | The WCAG 2.2 SC 2.5.8 floor (Drive's minimum is above it). |
| `size.icon.sm` / `md` / `grid` | 16px / 20px / 24px | Icons, drawn on the 24 px grid ([icons.md](icons.md)). |
| `size.avatar.xs` / `sm` / `md` / `lg` | 24px / 28px / 36px / 44px | Stacks / chips / header and pickers / people rows. |
| `size.row.dense` / `admin` | 56px / 40px | Two-line rows at ≤ 820 px / table rows at 1280. |
| `size.header.compact` | 60px | The J1 header at every width. |
| `size.focus.width` / `offset` | 2px / 3px | Focus ring. |
| `size.line` | 1px | Hairlines, inset outlines (A4, A11), the running-text link underline. |
| `size.progress` / `progress-row` | 8px / 6px | A15 bar height / the same bar in K15 rows. |
| `size.sheet-row` | 52px | Nav rows in the B2 menu sheet. |
| `size.menu.min` | 200px | Minimum width of the K5 menu popover. |
| `size.column.size` / `modified` / `kind` / `actions` | 104px / 152px / 120px / 52px | K2 table column widths at 1280 (Name fills the rest). |

The last five rows are Drive's own: the components used these sizes before Drive had its own tokens, and the values are unchanged.

## 4. Elevation

No drop shadows. Elevation is one ground step plus a hairline. Order: canvas → surface → raised → overlay; the sticky and sheet layers sit above all.

| Token | Value | Use |
|---|---|---|
| `elevation.sticky` | `rgba(21, 16, 15, 0.86)` (= `color.bg.sticky`) | The J1 header ground. |
| `elevation.sheet` | `rgba(28, 22, 20, 0.94)` (= `color.bg.sheet`) | Sheets, the upload tray. |
| `elevation.blur` | 14px | Backdrop blur on sticky and sheet layers and the dialog backdrop. |

## 5. Layout and breakpoint

| Token | Value |
|---|---|
| `layout.container` | 1240px max |
| `layout.gutter.wide` / `compact` | 40px / 20px (page margin) |
| `layout.rail.max` | 420px (upload tray width, K17 page width) |
| `layout.measure.lede` / `reading` | 52 / 62 (used as `ch`: ledes, dialog width) |
| `breakpoint.compact-max` | 820px: the one layout switch |
| `breakpoint.review-mobile` / `review-desktop` | 390 × 844 and 1280 × 800: the two screenshot sizes |

Mobile first in CSS, desktop first in design. **One layout switch** at 820 px. No page scrolls sideways at any width from 320 px up.

## 6. Motion

| Token | Value | Use |
|---|---|---|
| `motion.ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | The only easing. |
| `motion.duration.fast` | 120ms | Press feedback. |
| `motion.duration.base` | 160ms | Colour and background on hover and focus. |
| `motion.duration.slow` | 240ms | Sheet and menu sheet open and close (with an 8 px slide). |

**What moves:** colour transitions, sheets, and the loading spinner once an action has taken over 1 s ([accessibility.md](accessibility.md) §5). **What never moves:** progress and status change by swapping text; no pulse, count-up, shimmer or skeleton, and no spinner under 1 s.

**Reduced motion:** every transition is written inside `@media (prefers-reduced-motion: no-preference)`. The token stylesheet also sets every duration to `0ms` and the easing to `linear` under `reduce`, as a second guard.

## 7. The token stylesheet

Build CSS ships one `:root` block with every token above as a `--drive-*` custom property, plus the reduced-motion layer:

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --drive-motion-ease: linear;
    --drive-motion-duration-fast: 0ms;
    --drive-motion-duration-base: 0ms;
    --drive-motion-duration-slow: 0ms;
  }
}
```

`layout.measure.*` are unitless numbers; use them as `calc(var(--drive-layout-measure-reading) * 1ch)`.
