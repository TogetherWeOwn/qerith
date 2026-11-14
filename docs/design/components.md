# Drive components

Every component Drive uses: its job, anatomy, sizing, states, content rules and accessible name and role. Values are Drive tokens ([tokens.md](tokens.md)). Where this page writes a size in px, it means the token in tokens.md with that value; every such size has one, and a size with no token is a bug in this page. Icons are in [icons.md](icons.md), words in [voice.md](voice.md), accessibility rules in [accessibility.md](accessibility.md). The screens that use them are in [drive-v0.md](drive-v0.md).

**Where these came from.** The base components (A, B, C, I, J) are restated from the Ember Hours components at `TogetherWeOwn/two-design-kit` tag v0.3.1, cut down to what Drive uses and with the same values, so Drive keeps that look. The K components were drafted for Drive. The ids are kept so build PRs and the screen spec can name them (K2, A14…); they are Drive's ids now and don't track the kit.

**How to read a state table.** *Looks* is what changes on screen. *Does* is behaviour. A state not listed is not allowed to exist: if you need one, ask the UX Designer to add it here first.

**States every interactive component has**, unless its table says otherwise:

| State | Rule |
|---|---|
| default | as specified |
| hover | colour step only (`motion.duration.base`, `motion.ease`); never movement, never shadow; pointer devices only |
| focus-visible | `2px solid color.focus.ring`, `outline-offset: 3px`, radius follows the control; never removed, never only a colour change |
| active | `motion.duration.fast` darken/lighten of the hover step; no scale |
| disabled | `aria-disabled="true"` (not the `disabled` attribute, so it stays focusable and can explain itself), `bg.raised` ground, `text.tertiary` label, plus a visible reason ("Tick the box to confirm") |
| loading | label changes to the present participle ("Renaming…"), `aria-busy="true"` on the control, no spinner unless it takes over 1 s; then a 16 px stroke spinner that does not rotate under reduced motion |

**Every Drive component** follows these: tokens only, one ember action per view, state as word + shape (never colour alone), 36 px minimum controls, the 12 px text floor, and the Drive voice.

---

## A. Primitives

### A1. Button (pill)

**Job:** one action. The house button is a pill.

**Anatomy:** container (`radius.pill`) · optional leading icon (`size.icon.md`) · label · optional trailing count in mono.

**Variants:**

| Variant | Ground / text | Use | Limit |
|---|---|---|---|
| `primary` | `accent.default` / `text.on-accent`; hover `accent.hover` | The one primary action in the view | One per view (a row's action counts separately) |
| `ghost` | transparent, inset `line.hairline-strong` / `text.primary`; hover `bg.raised` | Secondary actions, row actions | — |
| `quiet` | `bg.raised` / `text.primary` | Actions that are not available yet, shown with `aria-disabled` and a reason | — |

**Sizes:** `sm` 36 px (padding 0 14, 14 px label), `md` 44 px (0 20, 15 px), `lg` 56 px (0 28, 16 px). Label `font-weight.semibold` at `font-width.button` (105%). Full width inside cards, sheets and at 390 for the page's primary.

**States:** all common states. `primary` disabled is not allowed (use `quiet` with a reason instead).

**Content:** a verb first, sentence case, 1–4 words: "Upload", "Make folder", "Move to Taxes". Never "Click here", "Submit", "OK". Name the thing when a row has several buttons ("Revoke Sam's access").

**A11y:** `<button>` for actions, `<a>` for navigation, never a `div`. Accessible name = visible label; icon-only buttons need `aria-label`. Minimum target 36 px tall.

**Don't:** two primary pills in one view; an ember ghost button; a pill that only says "More".

### A2. Text link and link button

- **In running text:** text colour, underline 1 px at 3 px offset. Hover: `text.primary`.
- **In breadcrumbs and facts lists:** `text.link` (ember), no underline until hover. Distinguishable by position.
- **Link button** ("Cancel all", "Skip"): 14 px `font-weight.medium`, `text.secondary`, underlined, 8 px padding so the target is at least 36 px.
- **A11y:** link text says where it goes ("Go to My Drive", "Open Taxes").

### A3. Icon button

`ghost` pill, square (`size.control.sm` or `md`), icon `size.icon.md`. Always `aria-label` ("Actions for report.pdf", "Close", "Menu"). A menu button also has `aria-expanded` and `aria-controls`.

### A4. Tag

**Job:** a short state or category label on a row, card or person.

**Anatomy:** mono label (`font.data`, `font-size.label`, uppercase, `tracking.label`), `space.inset.tag-y` × `space.inset.tag-x` padding, `radius.s`, inset 1 px outline.

| Variant | Text | Outline | Use in Drive |
|---|---|---|---|
| neutral | `text.secondary` | `line.hairline-strong` | "Shared", "Owner", "Can view", "Expired" |
| `ok` | `state.ok` | `state.ok` at 45% | "Active", "Uploaded" |
| `warn` | `state.warn` | `state.warn` at 45% | "Access off" |

**Content:** 1–3 words. Sentence case in source; CSS uppercases.

**A11y:** a tag is text inside its row; no role. Tags are never interactive.

### A8. Avatar

Circle. A fallback disc in `color.avatar.<hash % 12>` (a stable hash of the person's id, never the name) with `color.avatar-text` initials, 12 px semibold. Sizes per `size.avatar.*`. Drive has no profile images in v0. Next to a name the disc is `aria-hidden="true"`. **Loading:** `bg.overlay` disc, no shimmer.

### A11. Text field

44 px, `radius.m`, `bg.canvas` inside, inset 1 px `line.control`, 15 px text, 14 px horizontal padding.

| State | Looks |
|---|---|
| default | as above; placeholder in `text.tertiary` and never the only label |
| hover | outline `text.tertiary` |
| focus-visible | focus ring outside the control outline |
| filled | text `text.primary` |
| read-only | as filled; selectable; used by K18 (mono) |
| error | outline `state.danger`, a message below in `state.danger` 14 px starting with what to do ("Type a name."), `aria-invalid="true"`, `aria-describedby` → message |
| disabled | `bg.raised`, text `text.tertiary`, reason in helper text |

**A11y:** a visible `<label>`.

### A14. Notice

Inline message for a section, not a toast. `radius.m`, 16 px padding, the matching `state.*-bg` ground, a 16 px icon, a 15 px `text.primary` sentence and an optional action. Kinds: info (`bg.surface` + hairline), ok, warn, danger. **Danger notices** use `role="alert"` only when they are the result of the person's own action; otherwise they are plain content. No toasts, no auto-dismiss.

### A15. Progress bar

`size.progress` (`size.progress-row` in K15 rows), `radius.pill`, track `bg.overlay`, fill `accent.default` (your uploads) or the state colour the K15 table names. Always paired with the numbers in text ("1.2 of 5.4 GB"). A native `<progress>` labelled by the file name.

### A16. Skip link

First focusable element. A `primary sm` pill, off-screen until focused, then at top-left 12 px. "Skip to content", targets `<main id="main">`.

---

## B. Shell

### B2. Menu sheet

Opens from the J1 Menu button at ≤ 820 px. Full-width sheet under the header, `bg.sheet` with `elevation.blur`, nav links as `size.sheet-row` rows, then "Sign out". Opens with a `motion.duration.slow` fade and 8 px slide under `no-preference` only. `aria-expanded` on the button; focus moves to the first link; Tab is trapped inside; Escape and the Menu button close it and return focus to the button. The page behind is `inert`.

---

## C. Content

### C3. Empty state

**Job:** say honestly that there is nothing here, and give one next step.

**Anatomy:** `radius.m` box, inset `line.hairline-strong`, 20 px padding; 16 px semibold sentence ("This folder is empty."), 14 px secondary explanation, at most one ghost `sm` action. At 390 the action goes under the text. Drive's empty states and their copy are in K2, K13 and [drive-v0.md](drive-v0.md).

**Never:** an illustration, an apology, "Oops", or an empty box with no explanation.

### C6. Facts list

Key–value list in a `bg.surface` box, 8 × 22 px padding. `<dl>`; keys are mono labels (`text.tertiary`), values 15 px `text.primary`, right-aligned; rows divided by hairlines. Link values are `text.link`.

---

## I. Tables and destructive actions

### I1. Dense table and destructive actions

Density: `size.row.admin` (40 px) rows, 14 px text, hairlines between rows, `bg.surface` header row with mono labels. Named row actions ("Revoke Sam's access", never bare "Revoke"). State as text tags, never colour alone. **Destructive actions** are `ghost` with `state.danger` text (and the trash icon where it fits); there is no danger-filled pill. A single destructive row action confirms in place ("Remove Sam's access? *Remove* · Cancel"); one with wider effects uses a K7 dialog. `<table>` semantics with `scope`.

---

## J. Tool parts

### J1. Drive header

The Drive top bar. 60 px (`size.header.compact`) at every width, sticky, `bg.sticky` with `elevation.blur`, bottom hairline. The only sticky element on Drive.

**Anatomy (1280):** product mark (glyph + "Drive", [icons.md](icons.md)) · section nav: "My Drive", "Shared with me", "Users and invites" (owner only), as 36 px pills, 15 px medium, `text.secondary`; the current section `bg.raised` + `text.primary` · end cluster: avatar + name, an A3-style button that opens a K5 menu with "Sign out". No project switcher, no spend status.

**At ≤ 820 px:** mark · avatar · Menu icon button (B2 sheet holds the sections and "Sign out").

**States:** current section (`aria-current="page"`); owner (three sections) or member (two).

**A11y:** `<header>` landmark; `<nav aria-label="Drive">`; the mark links to My Drive and is named "Drive, My Drive" with `alt=""` on the image. The header height is in `scroll-padding-top`.

### J9. History list

`<ol>` of events, newest first. Each line: one sentence naming the actor by name ("You invited Pell") · mono time. Hairlines between lines. Used only by the optional audit list on Users and invites.

### J13. Table

I1 at tool density, for any list of records: `size.row.admin` rows, `<table>` with a caption (visually hidden unless the screen says otherwise), mono uppercase headers on `bg.surface`, tabular numbers right-aligned, named row actions, state as tags. Wide tables scroll inside a focusable region named for the table. Highlighted row: `bg.raised`.

---

## K. Drive (file surfaces)

Components for the file screens. They follow every rule above.

**Sizes and numbers in every K component.**
- **Bytes** are decimal; KB and larger show one decimal place below 100 units (a trailing ".0" included) and none from 100 up: "0 bytes", "1 byte", "980 bytes", "1.2 KB", "4.7 MB", "18.2 GB", "41.0 GB", "214 GB" (1 KB = 1,000 bytes). Wherever a size is shown, its `<data value="5368709120">` carries the exact byte count, and the details line (K3) prints it in full ("5,368,709,120 bytes").
- **Times** are viewer-local: "09:12" today, "Yesterday 18:40", "14 Nov" this year, "14 Nov 2025" before. The list caption names the zone once ("Times in Europe/London"); each time is a `<time datetime>` with the full instant.
- **File names are user data.** Render them as text, never HTML; keep every character, including Unicode and emoji, with `unicode-bidi: plaintext` so a right-to-left name can't reorder the row. A long name is truncated in the middle with an ellipsis so the extension stays visible ("Quarterly-report-final…v3.pdf"); the full name is the row's accessible name and is shown in the details line.


### K1. Breadcrumb

**Job:** say where you are in the folder tree and go up in one step.

**Anatomy:** `<nav aria-label="Folder path">` with an `<ol>`: root ("My Drive", or "Shared with me" then the share's top folder) · separator "/" in `text.tertiary` (`aria-hidden`) · each ancestor as an A2 rail link (`text.link`) · the current folder as `text.primary` semibold text with `aria-current="page"`. 15 px, one line, in the page header above the H1 (the H1 repeats the current folder name).

**Long paths:** above 4 levels, the middle collapses to an icon button "…" (`aria-label="Show 3 more folders"`) that opens a K5 menu of the hidden ancestors, keeping root, the parent and the current folder visible. At 390 only "← {parent}" shows (a link named "Up to {parent}"), plus the "…" menu when deeper than 2.

**States:** root (only "My Drive", no separator) · loading (rendered by the server with the page; never a skeleton) · not found (the page is the K11 not-found state; no breadcrumb).

### K2. File list

**Job:** show a folder's items and let the person sort, open and act on them, at any size up to 5,000 items and beyond.

**Anatomy:** a J13 table (`<table>` with a visually hidden caption "Contents of {folder}, sorted by name, A to Z. Times in Europe/London."). Columns at 1280: **Name** (fills; K3 name cell) · **Size** (`size.column.size`, right, tabular; "—" for folders) · **Modified** (`size.column.modified`) · **Kind** (`size.column.kind`, words: "Folder", "PDF", "MP4 video", "JPEG image", "File") · **Actions** (`size.column.actions`, the K5 menu button). Folders first, then files, in every sort. Rows `size.row.admin`, hairlines between, hover `bg.surface`, the row whose menu is open `bg.raised`.

**At ≤ 820 px:** the table becomes a `role="list"` of two-line rows, `size.row.dense` minimum: line 1 the name cell; line 2 mono `text.tertiary` "5.4 GB · 14 Nov" (folders: "Folder · 14 Nov"); the K5 button on the right. Sorting moves to the "Sort" select in the K4 action row.

**Sort:** each sortable column header is a `<button>` inside the `<th>`, with `aria-sort` on the `<th>` and an up or down icon beside the label for the active one. Default: Name, A to Z. Clicking the active header reverses it. Name sorts by locale with numbers in order ("file 2" before "file 10"). Sort is a URL query (`?sort=size&dir=desc`) and is done on the server over the whole folder, never only over the rows on screen. The status region announces "Sorted by size, largest first".

**Large folders:** the server sends the first 200 rows in the chosen sort; a footer row holds a ghost `sm` button "Show 200 more" and the mono count "200 of 5,000 shown". The button appends the next page and keeps focus on itself (it moves down with the list); a no-JS fallback is a link to `?page=2` that renders 400 rows. No virtual scrolling: every shown row stays in the DOM so find-in-page, screen readers and keyboard order work. The page header always states the full count ("5,000 items").

**Opening:** a folder name is a link to the folder's URL. A file name is a link that downloads it (K12); the K5 menu holds the rest. Double-click is never required.

| State | Looks |
|---|---|
| default | as above |
| empty folder | the table is replaced by C3: "This folder is empty." · "Drop files here or use Upload." · ghost `sm` "Upload files" (My Drive root, new account: "Your drive is empty." · "Upload a file or make a folder to start." with the same action) |
| shared folder, empty | C3: "Nothing is in this folder yet." · "{Name} shares it with you, so new files show up here." · no action |
| loading (first render) | server-rendered; no skeleton. Client navigation between folders keeps the old rows, sets `aria-busy="true"` on the table and shows "Opening {folder}…" in the toolbar status text after 1 s |
| loading more | the "Show 200 more" button reads "Showing more…" (`aria-busy`) |
| load failed | A14 danger notice in place of the rows: "This folder didn't load. Check your connection, then try again." · ghost "Try again"; the breadcrumb and toolbar stay |
| item just added | the new row appears in its sorted place with `bg.raised` for the rest of the visit; no animation, no scroll jump |
| item just removed | the row is gone; focus moves to the next row's name, or the previous one if it was last |
| drag over (K6) | the list area gets the K6 drop target |

**A11y:** real table semantics at 1280; the row's name link is its first focusable element and the K5 button its last, so Tab moves name → menu → next name. The size, time and kind cells are plain text. The selected sort is in the caption, not only in the arrow.

### K3. Name cell and kind glyph

**Anatomy:** kind glyph (`size.icon.md`, `text.secondary`, `aria-hidden`) · 8 px · name (15 px `text.primary`, medium for folders) · optional neutral A4 tag ("Shared" on an item the viewer shares with someone; on Shared with me, the owner's name in a 13 px `text.tertiary` second line: "Shared by Mora").

**Kind glyphs** (outline, 24 px grid, 1.75 stroke; shape tells them apart, never colour): folder · folder-shared (folder with a small person) · file (page with a folded corner) · image (page + mountain) · video (page + play triangle) · audio (page + note) · document (page + three lines) · archive (page + zip teeth). Kind comes from the file extension and stored type; anything unknown is "file". See [icons.md](icons.md) for the drawing list.

**Details line:** opened from K5 "Details" as an inline `bg.surface` row under the item (not a modal): a C6 facts list with Name (full), Size ("5.4 GB · 5,368,709,120 bytes"), Kind, Modified (full time with zone), Uploaded, and on your own shared items "Shared with: Mora, Sam". Close with "Hide details" or Escape.

### K4. Drive toolbar

The action row of the Drive page header (the page's one primary sits in the page header, [drive-v0.md](drive-v0.md) §0). It is not sticky: on Drive only J1 sticks, so it scrolls away with the header. Upload is never lost with it: dropping files anywhere on the folder (K6) works at any scroll position, and every empty state carries "Upload files". Placement: at 1280, on the H1 row, end-aligned; at ≤ 820 px, under the count line. Left: the page's one primary action, `primary sm` "Upload" (icon upload) with a second, ghost `sm` "New folder". Right: on ≤ 820 px only, a "Sort" select ("Name, A to Z" · "Name, Z to A" · "Newest first" · "Oldest first" · "Largest first" · "Smallest first"). On Shared with me and inside a folder shared with you, Upload and New folder are absent (not disabled): the page lede says "Shared with you to view and download." **New folder** opens K8 in "New folder" mode. The row holds a status text slot (mono, `text.tertiary`) for slow states ("Opening Taxes 2025…").

### K5. Row action menu

**Job:** every action on one item, from one button.

**Anatomy:** A3 icon button (more, three dots), `aria-label="Actions for {name}"`, `aria-haspopup="menu"`, `aria-expanded`. Opens a `role="menu"` popover (`bg.overlay`, hairline-strong, `radius.m`, `space.1` padding, min-width `size.menu.min`) anchored to the button, flipped to stay on screen. Items are 40 px `role="menuitem"` rows with a 16 px icon and a verb: **own item:** Download (files) · Share · Rename · Move · Details · separator · Delete (text `state.danger`). **Shared with you:** Download (files) · Details. Items that don't apply are absent, never disabled.

**Behaviour:** arrow keys move between items, Home and End jump, typing a letter jumps, Enter or Space activates. Escape closes the menu and returns focus to the button. Tab and Shift+Tab close it and move focus on as if from the button (Tab to the next row's name, Shift+Tab to this row's name), so the menu adds no extra stop. Choosing an item opens its dialog (K8, K9, K10, K13) and focus returns to this button when that closes, unless the action removed the row (move, delete): then focus follows K2 "item just removed". The same menu opens on right-click on a row (pointer only; the button is always there). At ≤ 820 px the menu opens as a K7 sheet from the bottom with the item name as its title.

**A11y:** the APG menu-button pattern. The menu is the only place these actions exist on a row; there are no hover-only icons.

### K6. Drop target

**Job:** take files dropped anywhere on a folder you own.

Dragging files over the window marks the folder's list area: a 2 px dashed `line.control` inset at `radius.l` round it, the ground stays the same, and a centred `bg.overlay` panel says "Drop to upload to {folder}". Dropping starts the uploads in K15. Dropping on a folder row targets that folder (its row shows the same dashed outline and the panel reads "Drop to upload to {subfolder}"). Not offered on folders shared with you: there the cursor shows "not allowed" and nothing is drawn. Dropping a folder from the desktop uploads its files and recreates its subfolders. The Upload button and its file picker always do the same job; dragging is never required (WCAG 2.5.7). No animation.

### K7. Dialog

**Job:** a short focused task over a page: rename, new folder, move, delete, share, invite. Drive's only modal. Use it only for a task that needs its own fields; confirm a single row action in place (I1) when it fits.

**Anatomy:** native `<dialog>` opened with `showModal()`. `bg.surface`, hairline-strong, `radius.l`, `space.inset.card` padding, width `min(100vw - 2 × layout.gutter.compact, layout.measure.reading × 1ch)` (about 560 px), max height 100 dvh minus 2 × `space.8`, content scrolls inside. Backdrop `scrim.sheet` with `elevation.blur`. **Header:** H2 at `font-size.title`, semibold, one line that names the item ("Rename "Taxes 2025""), close icon button (`aria-label="Close"`). **Body.** **Footer:** right-aligned, the primary action then ghost "Cancel"; at 390 full-width and stacked with the primary on top.

**At ≤ 820 px:** a bottom sheet: full width, `radius.l` on the top corners only, `env(safe-area-inset-bottom)` padding, max height 90 dvh.

**Behaviour:** focus moves to the first field, or to the primary action when there is no field (Delete: to "Cancel", so Enter never deletes by accident). Tab stays inside. Escape, the close button, Cancel and a click on the backdrop close it without changes. While it is saving, none of them do: the request may already have been committed, so the dialog stays until it can show the result. The page behind is `inert`. Focus returns to the control that opened it, or, when the action removed that control's row, to the place K2 "item just removed" names. Under `no-preference` the sheet uses the B2 fade and slide; under `reduce` nothing moves.

| State | Looks |
|---|---|
| default | as above |
| saving | the primary reads the present participle ("Renaming…", `aria-busy`); fields read-only; Cancel and the close button are `aria-disabled`; Escape and the backdrop do nothing |
| error | A14 danger notice at the top of the body, `role="alert"` (the person's own action), saying what to do; the fields keep their values; focus moves to the notice's first link or the field at fault |
| done | the dialog closes and the page's status region announces the result ("Renamed to Taxes 2026") |

**A11y:** `aria-labelledby` the H2; `aria-describedby` the first body sentence when it explains a consequence (Delete, Share). One primary per dialog; it is the only ember action while the dialog is open ("yours" marks, [tokens.md](tokens.md) §1.4, may still show behind it).

### K8. Name dialog (rename and new folder)

K7 with one A11 field. **Rename:** title "Rename "{name}"", field label "Name", value preselected up to the extension ("Taxes 2025" selected in "Taxes 2025.pdf") so typing keeps the extension; primary "Rename". **New folder:** title "New folder in {parent}", field "Folder name", empty; primary "Make folder".

**Validation**, on submit and then live once shown (A11 error state):
- empty: "Type a name."
- only spaces or dots, or "/" in it: "Names can't contain "/" or be only dots or spaces."
- over 255 bytes (UTF-8): "That name is too long. Shorten it and try again." The limit is in bytes, and emoji and many non-Latin characters take up to 4 each, so the copy names no number and the field shows no character counter.
- clash: "There's already a {file|folder} called "{name}" here. Pick another name."
- unchanged (rename): the dialog just closes.

Rename and move are instant whatever the size (metadata only), so there is no progress state beyond K7 "saving".

### K9. Move dialog and folder picker

K7, title "Move "{name}"". The picker has no selection: the person browses to the destination, and the folder being browsed is the target. Body: the K1 path of the folder being browsed ("My Drive / Taxes", as an H3 with `tabindex="-1"`, not `aria-live`: moving focus to it is what announces the new folder, so the page keeps its one status region, [accessibility.md](accessibility.md) §6) · a ghost `sm` "Up to {parent}" button when not at root · a native list (`<ul>`) of its subfolders, each a 40 px native `<button>` (folder glyph `aria-hidden` · name · "›" `aria-hidden`) whose accessible name is the folder name and which opens that folder in the picker. No `listbox`, no controls nested in options. Only your own folders appear. The folder being moved shows in the list as `aria-disabled="true"` with the reason in a 13 px second line, tied by `aria-describedby` ("Can't move a folder into itself"), so nobody can browse into it or its descendants. A folder with no subfolders says "No folders in Taxes." in the list's place. Footer: primary names the browsed folder ("Move to Taxes") · ghost "Cancel" · ghost `sm` "New folder" on the left (K8 inside the picker, which then opens the new folder). When the browsed folder is the item's current folder, the primary is a quiet `aria-disabled` pill with the reason "Already here".

**Keyboard:** Tab moves through Up, the folder buttons and the footer. Enter or Space on a folder opens it and moves focus to the path heading, so the screen reader reads the new path ("My Drive / Taxes, heading level 3"). Up does the same for the parent. Nothing in the picker is `aria-live`. Moving is always the footer primary, so opening and choosing never share a key.

Errors (K7 error): clash "There's already a file called "{name}" in Taxes. Rename one of them first." · gone "That folder was deleted. Pick another one." **Done:** the row leaves the list; status "Moved to Taxes" with a link "Open Taxes" in an A14 ok notice at the top of the list for the rest of the visit.

### K10. Delete confirm

K7, title "Delete "{name}"?" (several items from one drop or menu are not in v0). Body, by kind:
- file: "This deletes the file for good. There's no bin, so it can't be restored."
- folder: "This deletes the folder and everything in it for good: 3 folders and 214 files, 18.2 GB. There's no bin, so it can't be restored."
- shared item, adds: "Mora and Sam lose access to it."

A folder with anything in it adds a K20 check box "I understand this deletes 217 items" that must be ticked first; until then "Delete permanently" is a quiet pill with `aria-disabled` and the reason "Tick the box to confirm". Footer: "Delete permanently" as the I1 destructive button (`ghost` with `state.danger` text and icon trash; there is no danger-filled pill, and no ember action in this dialog) · ghost "Cancel", focused first.

**Done:** the dialog closes, the row is gone (K2 "item just removed"), status "Deleted {name}". No undo is offered, because none exists.

### K11. Not-found and no-access page

One page for a folder or file that is missing, deleted, or not yours, so it never reveals which. H1 "This folder isn't here" (or "This file isn't here") · lede "It may have been deleted or moved, or it isn't shared with you." · ghost "Go to My Drive". Never "access denied" or "forbidden".

### K12. Download

A file name link and the K5 "Download" item are both a plain `<a href>` to the download URL, **without** the `download` attribute. A successful response carries `Content-Disposition: attachment; filename="{ascii}"; filename*=UTF-8''{encoded}` (RFC 6266): `{encoded}` is the exact name as UTF-8, percent-encoded per RFC 8187 (every byte outside its attr-char set, so spaces, `;`, `"` and non-ASCII are all escaped), which keeps Unicode names exact (U7); `{ascii}` is an ASCII-only fallback with `"` and `\` dropped, for clients that ignore `filename*`. the browser hands it to its own download manager, which handles progress and resume, and the page stays where it is. Without `download` the click is an ordinary navigation, so a redirect response (below) does navigate the page; with `download` the browser would save the redirect target (the Sign in page) as a file instead. Never add `download`. No in-page progress. If the URL needs to be fetched first (signed link), the menu item reads "Preparing download…" (`aria-busy`) for up to 5 s, then the page navigates to the signed URL (`location.assign`, same attachment rule), and the browser takes over. **Error:** the page can't read the status of a plain download link, so the download URL answers a failure before any bytes with a redirect: signed out → Sign in with `next` = the folder URL; anything else (gone, unshared, expired link, server error) → the folder URL with a one-shot flag that shows an A14 danger notice above the list "{name} didn't download. Try again." with ghost "Try again". An expired signed link is refetched silently once before showing it. A failure after bytes have started is the browser's own download error, with its own retry. Video and audio open in the browser's own player only through the optional image/media preview (not in v0's must-haves).

### K13. Share dialog

**Job:** give invited people read-only access to a file or folder, see who has it, and take it away.

K7, title "Share "{name}"". Body in this order:
1. A 14 px `text.secondary` line: "People you add can view and download. They can't change, delete or re-share it." Folder: "…They also see anything you add to it later."
2. **Add people:** a combobox (an A11 field that opens a `bg.overlay` listbox popover under it, `radius.m`, hairline-strong), label "Add people", placeholder "Find someone by name". Options are only active people on this drive, excluding you and people who already have access (they're listed below): 36 px avatar (A8 fallback disc) · name · mono `text.tertiary` "Invited 3 Nov". Picked people become removable chips inside the field ("Sam ×", the × is a button "Remove Sam"). No free text: typing an email or a name that isn't in the list shows "Nobody called "zz" is on this drive. The owner can invite them." Primary "Share" (names the count when > 1: "Share with 2 people"), only when at least one person is picked; else quiet with `aria-disabled` and "Pick someone to share with".
3. **People with access:** an H3 "People with access" and a list: you first ("You · owner"), then each person: avatar · name · neutral tag "Can view" · ghost danger `sm` "Remove" (`aria-label="Remove Sam's access"`), which confirms in place (I1): "Remove Sam's access? *Remove* · Cancel". For an item inside a shared folder, people who have it through the folder show "Through Taxes" in a 13 px second line and no Remove (it's removed on the folder).
4. **Footer:** the K7 footer, always the same two buttons: the item 2 "Share" primary, then ghost "Done" in Cancel's place (removals take effect at once, so there's nothing to cancel). With nobody picked, Share is the quiet `aria-disabled` pill with its reason line, and Done closes the dialog.

| State | Looks |
|---|---|
| not shared | the access list shows only "You · owner" and the line "Only you can see this." |
| sharing | "Sharing…" on the primary |
| shared | chips clear; the new people appear in the list with `bg.raised` for the rest of the visit; status "Shared with Sam" |
| removing | the row's Remove reads "Removing…" |
| removed | the row is gone; status "Sam can no longer see {name}" |
| nobody else on the drive | the Add people field is replaced by C3 "There's nobody else on this drive yet." · owner: ghost `sm` "Invite someone" (to Users and invites) · member: "Ask the owner to invite them." |
| person revoked since | they drop out of the list; never shown as a choice |
| error | K7 error: "That didn't share. Try again." / "Sam's access wasn't removed. Try again." |

**A11y:** APG combobox with listbox; each chip is a list item; picked count announced ("Sam added, 2 people picked"). The access list is a `role="list"`.

### K14. Upload tray

**Job:** show every upload in this tab, keep them going, and let the person cancel, retry, resume and settle name clashes.

**Anatomy (1280):** a panel fixed to the bottom-right inside the viewport, width `layout.rail.max`, `elevation.sheet`, hairline-strong, `radius.l` (top corners when docked to the bottom edge), above the page but never over the J1 header. **Header row:** H2 at 15 px semibold with the summary ("Uploading 3 of 20 · 1.8 of 9.6 GB", "20 uploads done", "2 uploads need you") · icon button "Collapse uploads" / "Expand uploads" (`aria-expanded`) · icon button "Close uploads" (only when nothing is active). **Summary bar:** A15 bar for the batch, `accent.default` fill (it is yours). **List:** K15 items, newest batch first, scrolling inside the panel (max height 50 vh). **Footer:** link button "Cancel all" while any are active.

**At ≤ 820 px:** a collapsed bar fixed to the bottom (`bg.sheet`, `line.hairline-strong` top edge, `space.3` padding plus `env(safe-area-inset-bottom)`: the summary line and the batch bar); tapping it opens the full list as a K7 bottom sheet. The page adds bottom padding equal to the bar. It's the one bottom bar on Drive screens.

**Behaviour:** the tray appears when the first upload starts and stays until closed. It survives navigation between folders (client routing). Closing the tab with uploads active triggers the browser's "Leave site?" prompt. Collapsed, it keeps the header row and the batch bar. Up to 3 files transfer at once; the rest are "Waiting". Each finished file appears in its folder's list as soon as it is done.

**A11y:** `<section aria-labelledby>` (not a dialog; it doesn't take focus). Announce via the page status region only: the first start of a batch ("Uploading 20 files to Taxes"), each failure or clash at once ("{name} didn't upload"; "{name} already exists in Taxes. Choose what to do in Uploads."), and the batch end ("20 uploads done", "18 uploads done, 2 failed"). Progress percentages are never announced. Each item's progress is a native `<progress>` labelled by its name.

### K15. Upload item

**Anatomy:** a row in the tray: kind glyph · name (middle truncation) · mono `text.tertiary` line: progress and destination ("1.2 of 5.4 GB · 22 % · to Taxes") · A15 progress bar (`size.progress-row`) · one or two icon or `sm` ghost actions on the right. The progress text and bar update at most once a second, by text swap.

| State | Line | Bar | Actions |
|---|---|---|---|
| waiting | "Waiting · 5.4 GB · to Taxes" | empty track | Cancel (`aria-label="Cancel upload of {name}"`) |
| checking | "Checking for an earlier upload…" | empty | Cancel |
| uploading | "1.2 of 5.4 GB · 22 % · about 4 min left" | ember fill | Cancel |
| resuming | "Resuming · 2.1 of 5.4 GB already uploaded" (shown once when an earlier upload of the same file in the same folder is picked up) | fill starts at the resumed point | Cancel |
| paused, offline | "Paused · you're offline. It carries on when you're back." | fill frozen, `text.tertiary` | Cancel |
| interrupted (part failed after retries, or the tab was closed and reopened) | "Stopped at 2.1 of 5.4 GB. Pick the same file again to carry on." for a reopened tab; "Stopped at 2.1 of 5.4 GB. The connection dropped." while the tab still has the file | frozen, `state.warn` fill | "Resume" ghost `sm` (tab still has the file) or "Pick file" (reopened tab: opens the picker; the item resumes when the same file is chosen) · Cancel |
| name clash | "There's already a file called "{name}" in Taxes." | none | K16 choice inline |
| done | "5.4 GB · in Taxes" with a check icon and `ok` tag "Uploaded" | full, `state.ok` | "Show" link (opens the folder, focuses the row) |
| failed | "Didn't upload: {reason}. Try again." Reasons in words: "the connection dropped", "you're out of space" (if the provider refuses), "the file changed while uploading", "you no longer have access to this folder" | `state.danger` fill at the failed point | "Try again" ghost `sm` · "Remove" |
| cancelled | the row disappears; status "Cancelled {name}". Parts already sent are cleaned up by the server | — | — |

**Rules:** one file failing never stops the others. "Try again" and "Resume" reuse the parts already uploaded. A 0-byte file goes straight to done. Resume across a closed tab needs the same file in the same folder: the item matches on name, size and modified time and says so ("Pick "{name}" again to carry on"). Name, size and time only find the candidate: before any part is reused, the uploaded parts are checked against the picked file's bytes (during "checking"; the checksum method is the engineers' choice). If they don't match, nothing is reused and the item starts from zero with the line "This isn't the same file, so it starts from the beginning." shown once.

### K16. Name-clash choice

Shown inline in a K15 item (and as a single K7 when one file is dropped and the tray is collapsed). Sentence: "There's already a file called "report.pdf" in Taxes." Two ghost `sm` buttons of equal weight: **"Keep both"** (uploads as "report (1).pdf"; the next free number) and **"Replace"**, plus link button "Skip". Replace asks once more in place: "Replace the existing report.pdf (2.1 MB, 3 Nov)? It's deleted for good. *Replace* · Cancel". When several files clash in one batch, a check box "Do this for the other 4 clashes" appears under the buttons. Nothing uploads over an existing file without an explicit Replace. Replace is bound to the file it named (its identity and version, not its name): if that file changed or was removed before the upload finishes, nothing is replaced and the item shows the clash again with the current size and date (or uploads normally if the name is now free). Folder clashes on a dropped folder merge into the existing folder and only clash file by file.

### K17. Passkey card

**Job:** sign in, or set up sign-in from an invite, with a passkey and no password.

**Anatomy:** a card (`bg.surface`, hairline-strong, `radius.l`, `space.inset.card-lg`) centred in a narrow page (max `layout.rail.max`) under a header with only the product mark ([icons.md](icons.md), "Product mark"; plain text here, not a link). H1 at `font-size.h3` · one sentence · primary `md` full width · a 14 px `text.secondary` explanation · a lock line ("No passwords. Your passkey stays on your device or password manager.").

| State | H1 | Primary | Body |
|---|---|---|---|
| sign in | "Sign in to Drive" | "Sign in with a passkey" (icon key) | "Drive is invite-only. If you lost your passkey, ask the owner for a sign-in link." |
| invite valid | "Mora invited you to Drive" (name from the invite; "You're invited to Drive" with none) · optional note from the owner as a quote | "Set up a passkey" | field "Your name" (prefilled from the invite, editable, 1–64 characters) above the button · "Your device asks to save a passkey for this site. That's how you sign in from now on." |
| recovery link valid | "Set up a new passkey" | "Set up a passkey" | "The owner sent you this link because you lost your sign-in. Your files are all still here." |
| waiting for the device | unchanged | "Waiting for your device…" (`aria-busy`) | "Follow your browser's prompt." · link button "Cancel" |
| cancelled or timed out | unchanged | the button returns | A14 info: "Nothing was saved. Try again when you're ready." |
| no passkey on this device (sign in) | unchanged | unchanged | A14 info: "This device doesn't have a passkey for Drive. Use the device you set it up on, or ask the owner for a sign-in link." |
| browser can't do passkeys | unchanged | the same label, quiet and `aria-disabled` (sign in: "Sign in with a passkey"; invite and recovery: "Set up a passkey") | warn notice: "This browser can't use passkeys. Try an up-to-date Chrome, Edge, Firefox or Safari." |
| link used, expired or cancelled | "This link doesn't work any more" | — (no button) | "Invite and sign-in links work once and expire after 7 days. Ask the owner for a new one." |
| account revoked | "Your access is turned off" | — | "The owner turned off your access to Drive. Your files are kept. Ask them if you think this is a mistake." |
| too many tries | unchanged | quiet, `aria-disabled`, "Try again in 1 min" | "Too many tries. Wait a minute, then try again." |
| signed in, success | — | sign in: redirects to `next` (a same-origin Drive path only) or My Drive; invite and recovery: My Drive (first time: the empty My Drive state) | — |

**A11y:** the device prompt is the browser's; the card announces the result via `role="alert"` only for the person's own failed action. Never show which part of a link failed (used vs expired vs never existed): one state covers all three.

### K18. Copy field

**Job:** hand over an invite or sign-in link once.

**Anatomy:** a read-only A11 field in mono holding the full URL (selectable, `aria-label="Invite link for Sam"`) · ghost `sm` "Copy link" beside it (under it at 390). After copying: the button reads "Copied" with a check for 2 s (text swap), and the status region says "Link copied". If the clipboard is refused, the field text is selected and a line says "Press Ctrl+C or ⌘C to copy." Below, a 14 px `text.secondary` line: "Send it to Sam yourself. It works once and expires on 21 Nov. You won't see this link again." The link is shown only in the dialog that made it (K7 "Invite someone" or "Make a sign-in link"); lists never show it again.

### K19. People table (owner)

J13 for the owner's Users and invites screen. **People columns:** Name (avatar + name; "(you)" after yours) · Status (A4 tag: `ok` "Active", neutral "Owner", `warn` "Access off") · Last signed in (time, or "Never") · Storage used (size) · Actions (named ghost `sm` buttons: "Revoke Sam's access", "Restore Sam's access", "Make a sign-in link for Sam"). The owner row has no actions. **Pending invites columns:** Name or note · Made (time) · Expires ("in 6 days", "21 Nov") · Actions: "Cancel invite for Sam", "Make a new link" (cancels this one and opens K18 with a fresh link). Expired invites show neutral "Expired" and only "Make a new link" and "Remove".

**Revoke** confirms in a K7: title "Revoke Sam's access?" · "Sam is signed out everywhere within a minute and can't sign in. Their files are kept, and you can restore access later." · I1 destructive button "Revoke access" · ghost "Cancel", focused first. **Restore** acts at once, with status "Sam's access is back". **Sign-in link** opens K7 "Sign-in link for Sam" with K18 and "Use this if Sam lost their passkey or device. It works once and expires in 7 days."

At ≤ 820 px each table becomes a `role="list"` of cards: name + status tag on line 1, mono facts on line 2, actions as full-width ghost buttons under a K5 "Actions for Sam" menu.

### K20. Check box

Native `<input type="checkbox">`, 20 px, `accent-color: accent.default`, `line.control` edge, label to the right in 15 px `text.primary`, the whole row (label included) a 36 px target. Focus ring per the common states. Used for confirmations (K10) and batch choices (K16). Never pre-ticked for a destructive choice.
