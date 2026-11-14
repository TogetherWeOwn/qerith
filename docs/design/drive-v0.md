# Drive v0: screen spec

**Status:** UX Designer spec, 2026-11-14. Covers the Drive v0 scope, sections 3 and 7. Built from `TogetherWeOwn/two-design-kit` (Ember Hours tokens). The kit additions it needs are components **K1–K20**, template **T10**, voice **§8** and the Drive icons. They are in two-design-kit PR #12 (`docs/components.md` §K). Component ids below (A1, J1, K2…) refer to the kit's `docs/components.md`.

**How to use this:** build each screen from the kit components named here, render every state in its "Must render" list, and attach screenshots at 1280 × 800 and 390 × 844 plus the kit's design QA checklist (kit `AGENTS.md` §4). Design QA (UX Designer) checks the build against this spec. Where this spec and the kit disagree, the kit wins. Flag the conflict and I'll fix one of them.

**Out of scope here** (scope §5): pricing, plans, quotas, public links, previews beyond the optional image preview, trash, versions, search beyond the nice-to-have, notifications, and the owner browsing other people's files.

---

## 0. Shell (every signed-in screen)

Pattern **P6** with no rail (kit T10). Dark Ember Hours ground; one ember action per view.

```
1280 ─────────────────────────────────────────────────────────────────────────
[mark] Drive   My Drive · Shared with me · Users and invites*      (◯ Mora ▾)   J1 (60 px, the only sticky bar)
My Drive / Taxes 2025 / Receipts                                                K1
Receipts                         Opening Taxes…   [Upload] [New folder]         H1 (font-size.h3) + K4 row
214 items · 18.2 GB                                                             mono count line
┌ Name ▲ ─────────────────────────────── Size ── Modified ──── Kind ─────── ⋯ ┐ K2
│ ▭ Scans                                  —     14 Nov        Folder       ⋯ │
│ ▯ résumé 日本.pdf          Shared        1.2 MB  09:12        PDF          ⋯ │
│ …                                                                            │
│                 [Show 200 more]   200 of 5,000 shown                         │
└──────────────────────────────────────────────────────────────────────────────┘
                                                   ┌ Uploading 3 of 20 · 1.8 of 9.6 GB ┐ K14 (floating)
                                                   │ ████████░░░░░░░░                  │
footer: source line                                └────────────────────────────────────┘
* owner only

390 ──────────────────────────
[mark]            (◯) [≡]        J1 compact; Menu sheet holds the 3 sections + Sign out
← Up to Taxes 2025               K1 compact
Receipts                         H1
214 items · 18.2 GB
[        Upload        ]         K4 row: full width primary
[New folder]   [Sort: Name A–Z ▾]
▭ Scans                      ⋯   K2 two-line rows (size.row.dense)
  Folder · 14 Nov
▯ résumé 日本.pdf            ⋯
  1.2 MB · 09:12
═ Uploading 3 of 20 ████░░ ═     K14 bottom bar (tap → sheet)
```

- **J1 Drive form:** mark + "Drive" · nav "My Drive", "Shared with me", "Users and invites" (owner only; members never see the link and the route is not-found for them) · avatar + name opens a K5 menu: "Sign out". No project switcher, no spend meter.
- **Status region:** one `role="status"` per page (kit accessibility §6). It announces the result of the person's own actions and the K14 upload milestones. Nothing else is live.
- **Session expired:** any request that returns 401 sends the person to Sign in, then brings them back to the same URL. Uploads in progress are kept in the tray as "interrupted" (K15).
- **Header:** only J1 sticks (kit tool surfaces rule 4). The page header, with Upload in it (P6 rule 1), scrolls with the page; drop (K6) still uploads at any scroll position.
- **Signed-out pages** (sign-in, invite, recovery) use K17 on a bare page: mark only, no nav, no footer links except the source line.
- **Page titles:** `{folder} · Drive`, `Shared with me · Drive`, `Users and invites · Drive`, `Sign in · Drive`.

---

## 1. Sign in (M1, A1, A9)

**Route:** `/sign-in`. When signed out, every signed-in page redirects here, keeping `?next=`. Three public routes never redirect: `/sign-in` itself, `/invite/{token}` and `/recover/{token}` (section 2), because those are how a person without a working passkey gets one.

**Job:** prove it's you with a passkey. **Primary:** "Sign in with a passkey".

```
            [mark]
  ┌─────────────────────────────┐
  │ Sign in to Drive            │  K17
  │ Drive is invite-only. If you│
  │ lost your passkey, ask the  │
  │ owner for a sign-in link.   │
  │ [🔑 Sign in with a passkey ] │
  │ 🔒 No passwords. Your passkey│
  │ stays on your device or     │
  │ password manager.           │
  └─────────────────────────────┘
```

**Must render (K17):** sign in · waiting for the device · cancelled or timed out · no passkey on this device · browser can't do passkeys · account revoked (shown after a passkey that belongs to a revoked person) · too many tries (A9) · success → `next` or My Drive.

No "Create account", no "Forgot password", no email field anywhere (A2).

**If the Engineering Lead picks a different invite-gated method than passkeys (scope D4):** keep the K17 card and its states; swap only the primary and the device lines. Tell me on the build card and I'll update K17.

## 2. Invite redemption and recovery (M2, M3, A3, A5)

**Routes:** `/invite/{token}` and `/recover/{token}`. Both are public: they open signed out and are never redirected to Sign in (section 1).

**Job:** set up sign-in from a link the owner sent. **Primary:** "Set up a passkey".

- **Invite valid:** H1 "Mora invited you to Drive" · the owner's note, if any, as a quote · field "Your name" (prefilled from the invite, 1–64 characters, required) · primary · device explanation. After success: My Drive, empty state "Your drive is empty."
- **Recovery valid:** H1 "Set up a new passkey" · "The owner sent you this link because you lost your sign-in. Your files are all still here." · primary. No name field. After success: My Drive with the person's files.
- **One dead-link state** for used, expired, cancelled and never-existed: H1 "This link doesn't work any more" · "Invite and sign-in links work once and expire after 7 days. Ask the owner for a new one." Never say which.
- **Already signed in** and opening an invite: K17 shows "You're signed in as Mora. This invite is for someone else, so it wasn't used." · ghost "Go to My Drive". The token is not consumed.

**Must render:** both valid states · waiting · cancelled · browser can't do passkeys · dead link · already signed in · too many tries.

## 3. My Drive and folder view (M6, M7, A7, F1, F2)

**Routes:** `/` (My Drive root) and `/f/{folderId}`. The URL holds `sort`, `dir` and `page`.

**Job:** find a file or folder and act on it. **Primary:** "Upload" (K4).

**Layout:** section 0. Page header: K1 breadcrumb · H1 = folder name ("My Drive" at root) · mono count line "214 items · 18.2 GB" (folder size counts files directly and in subfolders; if the server can't compute it cheaply, show only "214 items").

**List (K2):** columns Name · Size · Modified · Kind · ⋯. Folders first. Default sort Name A–Z. Server-side sort and paging of 200. "Show 200 more · 200 of 5,000 shown". A folder with 5,000 items must show its first rows in ≤ 3 s (F2). That budget is the reason for paging, so don't render all 5,000 at once.

**Row actions (K5), own items:** Download · Share · Rename · Move · Details · Delete.

**New folder:** K8 "New folder in Receipts" → primary "Make folder". After success the new folder's row is highlighted (`bg.raised`) and focused. The person stays in the current folder.

**Must render:**
- new account, empty root: C3 "Your drive is empty." · "Upload a file or make a folder to start." · ghost "Upload files"
- empty folder: C3 "This folder is empty." · "Drop files here or use Upload."
- 1 item, 5,000 items (paged), mixed folders and files, Unicode and emoji names (U7), a name long enough to truncate in the middle
- each sort, both directions, at 1280 (column headers) and at 390 (Sort select)
- loading: server-rendered first paint; folder-to-folder navigation keeps old rows with `aria-busy` and "Opening {folder}…" after 1 s. The breadcrumb, H1 and count line keep the previous folder until the new rows arrive, so every visible row belongs to the folder named above it. If the navigation fails, the load-failed state replaces the old rows.
- load failed: A14 danger "This folder didn't load. Check your connection, then try again." · ghost "Try again"
- not found or not yours (A7): K11 "This folder isn't here", same page for both
- drag over (K6), owner's own folder
- an item you share with someone: neutral tag "Shared"
- details open (K3 details line)

## 4. Upload (M4, U1–U7)

**Entry:** "Upload" (file picker, `multiple`), "Upload files" in empty states, or drop anywhere on a folder you own (K6). Dropping a folder recreates its subfolders.

**Tray (K14) and items (K15):** up to 3 files in flight, the rest "Waiting". Per-file progress text and bar, updated at most once a second. Batch summary in the tray header.

**Resume (U3):** the item finds an earlier unfinished upload by name, size and modified time in the same folder, checks the uploaded parts against the picked file's bytes (K15 rules; a mismatch starts from zero), shows "Resuming · 2.1 of 5.4 GB already uploaded", and its bar starts there. After a closed tab, the reopened tab lists the unfinished upload as "interrupted" with "Pick file". The person re-selects the same file and the upload carries on. If the server can't list unfinished uploads to the browser, the "interrupted" row is dropped and resume happens silently when the same file is picked again, still showing the "Resuming" line.

**Cancel (U5):** "Cancel" on the item removes it at once. The server cleans up the parts. No confirmation for one file; "Cancel all" asks in place: "Cancel 17 uploads? *Cancel uploads* · Keep going".

**Name clash (U6, K16):** "There's already a file called "report.pdf" in Taxes." · "Keep both" · "Replace" · "Skip". Replace confirms in place, naming the existing file's size and date, and replaces only that version (K16). "Do this for the other 4 clashes" appears when there are more. Nothing is silently overwritten.

**Failure isolation (U4):** one item failing shows its reason and "Try again". The others carry on.

**Leaving:** closing or reloading the tab while uploads are active triggers the browser's leave prompt. Navigating between folders inside Drive doesn't stop uploads.

**Must render:** every K15 state (waiting, checking, uploading, resuming, paused offline, interrupted ×2, name clash, done, failed with each reason, cancelled), the tray collapsed and expanded at 1280, the bottom bar and sheet at 390, 20 files at once with one failed (U4), a 0-byte file (U1), and a 5 GiB file mid-way (U2).

**Uploading into a folder shared with you** isn't offered (no Upload, no drop target), per scope M10.

## 5. Download (M5, D1–D5)

A file name is a link that downloads; K5 "Download" does the same. Both are plain `<a href download>` to the server's download URL, so the browser handles progress, resume and Range (K12). Filenames download exactly as listed (U7). A failure before any bytes comes back as a redirect (K12): signed out → Sign in with `next` = the folder; anything else → the folder with the failed notice.

**Must render:** "Preparing download…" (only if the URL is fetched first) · download failed notice "{name} didn't download. Try again." · a file that was deleted or unshared since the page loaded: the same notice, then the row is removed on the next list refresh.

**Optional image preview (nice-to-have, cut first):** if built, K5 adds "Preview" for JPEG, PNG, GIF and WebP only. It opens a K7 dialog wide enough for the image (`layout.container` max), with the image on `bg.well`, the name as the H2, "Download" as the one primary and the image's `alt` = its file name. Nothing else previews.

## 6. Rename, move and delete (M8, M9, F3–F5)

- **Rename (K8):** title "Rename "Taxes 2025.pdf"" · the name up to the extension is preselected · "Rename". Validation copy is in K8. Instant; no progress beyond "Renaming…".
- **Move (K9):** browse your own folders from My Drive; the folder being browsed is the target, and each subfolder is a plain button that opens it (no listbox). The item itself can't be opened (reason shown), so its descendants are out of reach; in the item's current folder the primary is quiet with "Already here". Primary names the target: "Move to Taxes". Clash error: "There's already a file called "x" in Taxes. Rename one of them first." Done: the row leaves the list, and an ok notice "Moved to Taxes · *Open Taxes*" appears above it.
- **Delete (K10):** title "Delete "Receipts"?" · body states what is deleted (counts and size for a folder), that it's permanent with no bin, and who loses access if it was shared · a K20 check box for non-empty folders · "Delete permanently" (I1 destructive, ghost with danger text) · "Cancel" focused first. Done: rows gone, focus moves to the next row, status "Deleted Receipts". Move and delete both send focus to the next row (K2 "item just removed"), not back to the removed row's menu.
- **While saving,** none of these dialogs can be dismissed (K7): the result is always shown.

**Must render:** each dialog's default, saving, error (each K8 message, move clash, move target gone, delete failed "Receipts wasn't deleted. Try again.") and done states, at both widths (bottom sheets at 390).

## 7. Share dialog (M10, S1–S5)

**Entry:** K5 "Share" on your own file or folder.

**Dialog (K13):** title "Share "Taxes 2025"" · the read-only rule line (folders add "They also see anything you add to it later.") · "Add people" combobox of active people only (no email entry; S5) · chips for picked people · primary "Share" / "Share with 2 people" · "People with access" list: "You · owner" first, then each person with "Can view" and "Remove" (confirm in place) · footer: "Share" then ghost "Done". With nobody picked, Share stays in the footer as a quiet `aria-disabled` pill with "Pick someone to share with", and Done closes.

**Must render (K13 table):** not shared · picking · sharing · shared · removing · removed · nobody else on the drive (owner sees "Invite someone", member sees "Ask the owner to invite them.") · an item that inherits access from a shared folder ("Through Taxes", no Remove) · error on share and on remove.

**Cut line:** if folder sharing is cut (scope cut line), K5 "Share" appears only on files and the folder line is dropped. Nothing else changes.

## 8. Shared with me (M7, M10, S1–S4)

**Route:** `/shared` and `/shared/f/{folderId}` for browsing inside a shared folder.

**Job:** find what others shared with you and download it. **Primary:** none (there is nothing to create here). The view has no ember action, and that's fine: Download lives in each row.

**Header:** H1 "Shared with me" · lede "Shared with you to view and download." · count line "12 items from 3 people".

**List:** K2 with columns Name (with "Shared by Mora" second line) · Size · Shared (date shared, in place of Modified) · Kind · ⋯ (Download · Details only). Default sort: newest shared first. Inside a shared folder the breadcrumb starts "Shared with me / Taxes 2025 (Mora)" and the columns return to Modified. No Upload, New folder, drop target, Rename, Move, Delete or Share (S3).

**Must render:** empty: C3 "Nothing is shared with you yet." · "When someone shares a file or folder, it shows up here." (no action) · list · inside a shared folder, including an empty one (K2 shared-empty) · share removed while open: next request gives K11 "This folder isn't here"; on the list, the item drops out at the next refresh.

## 9. Users and invites (owner only; M2, M3, A3–A6)

**Route:** `/people`. Members get K11 (not-found), not "forbidden" (A6).

**Job:** let people in, and take access away or give it back. **Primary:** "Invite someone" (icon user-plus) in the page header.

```
1280
Users and invites                                         [Invite someone]
4 people · 1 invite waiting
PEOPLE ─────────────────────────────────────────────────────────────────────
Name             Status        Last signed in     Storage used   Actions
◯ Mora (you)     OWNER         Today 09:12        41.0 GB        —
◯ Sam            ACTIVE        Yesterday 18:40    12.3 GB        [Make a sign-in link] [Revoke access]
◯ Juno           ACCESS OFF    3 Nov              2.1 GB         [Restore access]
WAITING INVITES ────────────────────────────────────────────────────────────
For              Made          Expires            Actions
Pell · "my bro"  Today 08:50   in 7 days          [Make a new link] [Cancel invite]
```

At 390: two lists of cards (K19), the primary full width under the H1.

**Invite someone (K7):** title "Invite someone" · field "Name (optional)" · field "Note for them (optional, they'll see it)" up to 140 characters · primary "Make invite link". Then the same dialog shows the K18 copy field: "Send it to Pell yourself. It works once and expires on 21 Nov. You won't see this link again." · "Copy link" · ghost "Done". The invite then shows under Waiting invites.

**Revoke (K19):** confirm dialog, "Revoke access" (I1 destructive). After: status tag `warn` "Access off", status message "Sam's access is off. They're signed out within a minute." **Restore:** immediate, "Sam's access is back." **Sign-in link (recovery):** K7 with K18 and the recovery explanation. Revoked people can't be given a sign-in link until restored (the button is absent).

**Must render:** only you (C3 "It's just you so far." · "Invite someone, then copy the link and send it to them yourself."), no waiting invites (the section shows "No invites waiting."), an expired invite (neutral "Expired"; actions "Make a new link", "Remove"), a revoked person, each dialog's saving and error states ("That invite wasn't made. Try again."), clipboard refused.

**Optional audit list (nice-to-have):** if built, a third section "Recent changes": a J9 history list, newest first: "You invited Pell · Today 08:50", "You revoked Juno's access · 3 Nov", "Sam shared Taxes 2025 with Mora · 2 Nov". Names only, no file contents beyond the shared item's name.

---

## 10. Responsive rules

- Desktop first, one switch at 820 px (`breakpoint.compact-max`). At ≤ 820: J1 compact with the Menu sheet, two-line K2 rows, the Sort select, dialogs become bottom sheets, K5 menus become sheets, the tray becomes the bottom bar, owner tables become cards.
- No sideways page scroll at 320 px. File names truncate in the middle; nothing else truncates.
- Touch: every control ≥ 36 px; K2 rows at 390 are ≥ 56 px; the ⋯ button is 44 px at 390.
- Drag and drop is a desktop extra. Upload is always the picker.

## 11. Accessibility checks specific to Drive

On top of the kit's checks (accessibility.md §11):
- K2 is a real table at 1280 with a caption that names the folder, the sort and the time zone; `aria-sort` on the sorted column.
- K5 follows the APG menu-button pattern (Tab leaves the menu and moves on; it doesn't return to the button); K9 uses plain buttons in a list, never a listbox with nested controls; K13 the APG combobox pattern; K7 uses native `<dialog>` with `showModal()`, focus in, trapped, and back to the opener.
- Upload progress is never announced. Starts, failures, clashes and batch completion are, through the one status region.
- Keyboard-only run: upload (picker), make a folder, rename, move, share, remove a share, delete, invite, copy link, revoke and restore, all without a pointer.
- Screen reader run (NVDA + Firefox or VoiceOver + Safari) on My Drive, the upload tray, the share dialog and Users and invites.
- A right-to-left file name and an emoji file name render in place without reordering the row.

## 12. What design QA checks on each UI build card

Each UI build PR names the screen sections above it implements and attaches:
1. Screenshots at 1280 × 800 and 390 × 844 for every "Must render" state of those sections.
2. The kit `AGENTS.md` §4 checklist filled in, with the component ids used (K1, K2…).
3. Axe at both widths with 0 violations, plus the keyboard and screen-reader notes from §11 for the components it adds.
4. Copy matching this spec and kit voice §8 word for word, or a note on each change and why.

Design QA rejects raw colours, spacing, radii or durations, hover-only actions, a second ember action in one view, states shown by colour alone, and any copy that tells a person whether a hidden item or link exists.

## 13. Open points for the Engineering Lead (they don't block building)

1. **Auth method (D4):** this spec assumes passkeys. Another invite-gated method needs only a K17 swap, so tell me on the build card if you change it.
2. **Unfinished-upload listing:** section 4 works both ways: with server listing (an "interrupted" row after reopening) and without it (silent resume on re-pick).
3. **Folder size in the count line:** show only the item count if a recursive size is expensive.
4. **"Storage used" per person (M3):** needed on Users and invites. A daily or on-change figure is fine; label it "Storage used" with no "as of" unless it can be more than a day old.
