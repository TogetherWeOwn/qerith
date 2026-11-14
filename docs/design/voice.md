# Drive voice and copy

Drive talks like a careful colleague: plain, exact, and honest about what can and can't be undone. Every word on a Drive screen follows this page; the screen copy itself is in [drive-v0.md](drive-v0.md) and [components.md](components.md).

## 1. Principles

1. **Say what happens to the bytes.** "Rename" and "Move" are instant; say nothing about time. "Delete" is permanent: say "for good" and "There's no bin" every time.
2. **Exact sizes, plain units.** "5.4 GB", with the full byte count in details ("5,368,709,120 bytes"). Never "large file" in place of a size.
3. **Name the person and the place.** "Shared with Sam", "Moved to Taxes", "Mora invited you". Never the passive voice for something a person did.
4. **Never reveal what isn't yours.** A missing item and an item you can't see get the same words ("This folder isn't here"). A used, expired and unknown link get the same words.
5. **Say what happens next.** Every button and every state says what Drive will do ("It works once and expires on 21 Nov").
6. **Plain English, short sentences.** Under 20 words a sentence, one idea per sentence. UK spelling, 24-hour clock.
7. **Calm.** No exclamation marks, no hype, no urgency tricks.

## 2. Mechanics

| Topic | Rule | Do | Don't |
|---|---|---|---|
| Case | Sentence case for everything, including headings, buttons and tags | "Make invite link" | "Make Invite Link" |
| Buttons | Verb first, 1–4 words, says the outcome; name the thing when a row has several | "Move to Taxes", "Revoke Sam's access" | "Submit", "OK", "Click here" |
| Times | Viewer-local, 24-hour; the zone named once per list | "09:12", "Yesterday 18:40" | "9:12am", "a few moments ago" |
| Dates | "14 Nov" this year, "14 Nov 2025" before; "21 Nov" in sentences | "expires on 21 Nov" | "11/21/2026" |
| Numbers | Digits always; counts with a noun | "214 items · 18.2 GB" | "two hundred items", "214/5000" |
| Sizes | Decimal units, rules in components.md "Sizes and numbers" | "1.2 MB", "0 bytes" | "1.2MB", "1.17 MiB" |
| Names | People's names as they gave them; file and folder names exactly as stored, in straight quotes in sentences | "Rename "Taxes 2025.pdf"" | Emails, user ids, a "cleaned" file name |
| Errors | What happened, then what to do, no blame | "That didn't share. Try again." | "Error 500", "Invalid input" |
| Empty states | Honest sentence + one next step | "This folder is empty." · "Drop files here or use Upload." | "No data", "Oops!" |
| Contractions | Yes | "didn't", "There's no bin" | "did not" |
| Punctuation | Full stops in sentences, none in buttons, tags or single-line labels; middle dot `·` between facts | "1.2 of 5.4 GB · 22 %" | "1.2 of 5.4 GB - 22%." |
| Emoji | None in UI copy (file names keep theirs) | — | "🎉 Uploaded" |

## 3. Word list

| Use | Not |
|---|---|
| My Drive · Shared with me | Home, root, inbox |
| file · folder | document, item (in UI copy; "items" is fine in counts) |
| upload · download | import, export, sync |
| share · people with access · can view | permissions, ACL, collaborator, viewer role |
| remove (someone's access) | unshare, revoke (for a share) |
| invite · invite link · sign-in link | registration, magic link, token |
| revoke access · restore access (for a person, owner only) | ban, suspend, disable account |
| passkey | WebAuthn, credential, security key (unless it is one) |
| delete permanently · for good | purge, destroy, erase |
| keep both · replace · skip | overwrite, merge (for files) |
| Sign in · Sign out | Log in, Log out |
| the owner | admin, administrator |

## 4. Length budgets

| Element | Budget |
|---|---|
| Page H1 | ≤ 48 characters (a folder name is the person's own and is never cut; it wraps) |
| Lede | ≤ 2 sentences, ≤ 52 ch per line |
| Button | ≤ 4 words (≤ 24 characters) |
| Tag | ≤ 3 words |
| Row secondary line | ≤ 3 facts |
| Notice | 1 sentence + 1 action |

## 5. Privacy in copy

- Never print an email, a user id or a token in UI copy. People are shown by the name they gave.
- A link is shown only in the dialog that made it (K18), never again in a list.
- Never say which part of a link failed, or whether a hidden item exists (principle 4).
