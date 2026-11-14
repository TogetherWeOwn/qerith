# Drive accessibility and design QA

Target: **WCAG 2.2 level AA** on every Drive screen, at 390 and 1280, in the latest Chromium, Firefox and Safari, with keyboard, screen reader (NVDA + Firefox, VoiceOver + Safari), 200% zoom, reduced motion and forced colours. These are rules, not goals: a PR that breaks one is not done.

These rules are restated from the Ember Hours accessibility rules at `TogetherWeOwn/two-design-kit` tag v0.3.1 and are Drive's own from here. Drive-specific checks are in [drive-v0.md](drive-v0.md) §11.

## 1. Contrast (SC 1.4.3, 1.4.11)

- Text: **4.5:1** minimum on its actual ground, including 12 px mono labels and large headings. Non-text that carries meaning (control edges, focus ring, icons that are the only label, progress fill): **3:1**.
- Every allowed pair is in [tokens.md](tokens.md) §1.7. Using a pair that isn't there means measuring it and adding it first; if it fails, pick another pair.
- **Forbidden:** text over images; text on `bg.well`.
- Hairlines are decorative. A control's boundary uses `line.control` (≥ 3.46:1).
- Disabled controls are exempt from contrast in WCAG, but Drive's still use `text.tertiary` (≥ 5.5:1) so the reason stays readable.

## 2. Colour is never the only signal (SC 1.4.1)

Every state is a word plus, where possible, a shape: "Uploaded" tag + check icon, "Access off" tag, a failed upload's reason in words, the sort direction in the caption as well as the arrow. Test: screenshot in greyscale; every state must still be readable.

## 3. Focus (SC 2.4.7, 2.4.11, 2.4.13 as a target)

- Every focusable element shows `2px solid color.focus.ring` with a 3 px offset on `:focus-visible`. Never `outline: none` without this replacement. On ember, the ring is `focus.ring-on-accent`.
- **Not obscured (2.4.11):** the J1 header height is in `scroll-padding-top`; the K14 bottom bar height is in `scroll-padding-bottom` at ≤ 820 px. Focused items never sit under a sticky or fixed bar.
- **Order:** DOM order is the 390 reading order. Never reorder with CSS `order` or reversed grid rows.
- Dialogs, sheets and the menu sheet trap focus while open; Escape closes them (except while saving, K7) and returns focus as the component says.

## 4. Target size (SC 2.5.8)

The WCAG 2.2 AA floor is 24 × 24 px. **Drive's minimum is 36 px tall** for any control and 44–56 px for primary actions. Inline text links are exempt but get 8 px vertical padding when they stand alone. At 390 the K5 button is 44 px and K2 rows are at least 56 px.

## 5. Motion (SC 2.2.2, 2.3.3 as a target)

- All animation and transition CSS sits inside `@media (prefers-reduced-motion: no-preference)`. The token stylesheet also zeroes durations under `reduce` ([tokens.md](tokens.md) §6).
- Nothing auto-moves for more than 5 s. No carousels, tickers, count-ups, pulsing dots, shimmers or skeletons.
- **One exception, the loading indicator:** the 16 px stroke spinner in a busy control ([components.md](components.md), common states, `loading`). It appears only once the person's own action has taken over 1 s, rotates until that action ends, and is the only thing that rotates. Under `reduce` it shows but does not rotate.
- Progress updates by swapping text and bar width at most once a second, never by animating.

## 6. Status region (SC 4.1.3)

1. **One polite status region per page** (`<div role="status" aria-live="polite" class="sr">`). Nothing else on the page is `aria-live`.
2. **Announce results and milestones, not ticks.** Announce: the result of the person's own action ("Renamed to Taxes 2026", "Link copied"), an upload batch starting, each upload failure or clash, the batch ending, a sort change. Never announce: progress percentages, sizes counting up, times ageing.
3. **The person's own action is announced at once,** and drops any queued announcement it supersedes. Other announcements are merged when several arrive within 10 s.
4. **Errors from the person's own action** may use `role="alert"`; nothing else does.

## 7. Structure and names (SC 1.3.1, 2.4.6, 4.1.2)

- Landmarks: `header`, `nav[aria-label]`, `main#main`, `section[aria-labelledby]` for the upload tray, `footer`. One `h1` per page; headings in order.
- Every component's role and name is in [components.md](components.md). Quick rules: buttons act, links go; icon-only controls have `aria-label`; avatar images have `alt=""` with the name beside them.
- Tables are real tables with `caption` and `th scope`.
- Lists styled without markers (`list-style: none`) keep `role="list"` on the `ul`/`ol`, because Safari drops unmarked lists from the accessibility tree outside `nav`.
- Forms: visible labels; errors linked with `aria-describedby` and `aria-invalid`; errors say how to fix.
- Language: `<html lang="en">`. File names keep their own direction (`unicode-bidi: plaintext`).

## 8. Zoom, reflow and text spacing (SC 1.4.4, 1.4.10, 1.4.12)

- At 320 CSS px wide no page scrolls sideways. The only things that may scroll sideways are the K2 and K19 tables, inside their own focusable region named for the table (above 820 px; at 820 px and below they are lists).
- Every container grows with its text: no fixed heights on anything holding text; rows use `min-height`.
- With WCAG text-spacing overrides (line height 1.5, letter spacing 0.12 em, word spacing 0.16 em), nothing clips or overlaps. Headings wrap and never truncate.

## 9. Forced colours (Windows High Contrast)

- Tags, icons and the focus ring use outlines, text and `currentColor`, so they survive. Keep `forced-color-adjust: auto` (the default) everywhere.
- Buttons keep a visible border in forced colours (`border: 1px solid transparent` on pills so the system draws it).
- The drop target's dashed outline and the progress bars stay visible (`CanvasText` / `Highlight`).

## 10. Content and cognitive load

- One primary action per view. Explain each gate in one line where it bites ("Tick the box to confirm"). Times always carry a zone in the list caption.
- No time limits on any action. Invite and sign-in links expire after 7 days, and the copy says so where the link is made.

## 11. Checks a UI PR must run and report

| Check | How | Pass |
|---|---|---|
| Automated | axe-core with the WCAG 2.0–2.2 A and AA tags on each changed route at 390 and 1280, signed out and signed in | 0 violations |
| Contrast | every colour pair used is in [tokens.md](tokens.md) §1.7 | no new pair, or a new pair measured and added |
| Keyboard | Tab through the page at both widths: every control reachable, visible ring, nothing hidden under the header or the tray bar, dialogs and sheets trap and release | written in the PR |
| Screen reader | One pass with NVDA or VoiceOver on the changed component: names, roles, the announcements in §6 | written in the PR |
| Reduced motion | Emulate `reduce`; nothing moves | screenshot or note |
| Greyscale | Screenshot in greyscale; states still readable | screenshot |
| Reflow | 320 px wide; no sideways page scroll | screenshot |
| Forced colours | Emulate `forced-colors: active`; tags, icons, focus and buttons visible | screenshot |

## 12. Design QA checklist

The author fills this in the body of every Drive UI PR; design QA (the UX Designer) checks it against the evidence. A "no" blocks the merge until fixed or answered with a change to these docs.

**Evidence attached**
- [ ] Screenshots at 1280 × 800 and 390 × 844, full page, plus one per required state ("Must render" in [drive-v0.md](drive-v0.md)); each opened by the author.
- [ ] Commands run and their results (axe, and the project's tests).

**Tokens**
- [ ] No raw colour, spacing, radius, font or duration values (search the diff for `#`, `px`, `ms` outside the token stylesheet). Every value is a `--drive-*` property from [tokens.md](tokens.md); no `--two-*` property.
- [ ] Grounds step up by one level; ember used for one action per view.
- [ ] Any new colour pair is in tokens.md §1.7 and passes.

**Components and states**
- [ ] Every component used is from [components.md](components.md) and named by id in the PR.
- [ ] Every state in each component's table that can occur on this screen is rendered.
- [ ] State is readable in greyscale (word + shape, never colour alone).

**Layout**
- [ ] Matches the drive-v0.md §0 shell at both widths.
- [ ] No sideways page scroll at 320 px.
- [ ] Only J1 sticks; at ≤ 820 px the K14 bar is the only bottom bar.

**Copy**
- [ ] Matches drive-v0.md and [voice.md](voice.md) word for word, or a note on each change and why.
- [ ] Sentence case; verbs first on buttons; the word list followed.
- [ ] Times viewer-local, with the zone in the list caption.
- [ ] Nothing tells a person whether a hidden item or link exists.

**Accessibility**
- [ ] axe: 0 violations on each changed route, both widths.
- [ ] Keyboard pass: visible focus ring everywhere, nothing hidden under the header or tray bar, dialogs and sheets trap and release focus.
- [ ] One polite status region; announces results and milestones only (§6).
- [ ] Reduced motion: nothing moves. Forced colours: tags, icons, focus and buttons visible.
