# Drive read-grant HTTP contract

## Grant management

The generated Worker and the SvelteKit auth hook admit these endpoints only at
Drive's configured staging origin with `DRIVE_STAGING_READ_GRANTS=1`. The flag
is unset in normal publishes (off). Invite and sign-in fixture flags do not
enable the deployable endpoints, including in preview. The isolated test
fixture can still exercise the handlers without staging.

| Method | Exact path | Success |
| --- | --- | --- |
| `GET` | `/api/entries/{entryId}/read-grants` | `200` with `{"recipients":[{"recipientId":"…"}],"nextCursor":null}` |
| `PUT` | `/api/entries/{entryId}/read-grants/{recipientId}` | `204` when a grant is inserted |
| `DELETE` | `/api/entries/{entryId}/read-grants/{recipientId}` | `204` when an explicit grant is removed |

The list returns up to 100 explicit active-member recipients in binary ID order.
Send a non-null `nextCursor` as the sole query parameter `?cursor={nextCursor}`
for the next page, even if that grant has since been removed. An empty list is
successful. IDs and cursors are opaque, at most 512 UTF-8 bytes; encode each as
`encodeURIComponent(value).replaceAll("'", "%27")`. `.` and `..` are not
addressable as path IDs because URL parsers normalize those segments, even when
percent-encoded. No trailing slash, request body, or mutation query is accepted.

All requests use the real Drive session cookie. Mutations require the exact
configured `Origin`; a supplied `Sec-Fetch-Site` must be `same-origin` for every
operation. `ReadGrants` checks the live session and ownership of the entry in the
statement that reads or changes the grant. Owning the entry, not having the
Drive-wide owner role, is what permits management. A folder grant gives read
access to descendants but does not create descendant grant rows or permit a
recipient to write or re-share. Removing a grant does not affect independent
grants that still permit access. This management flag alone does not admit file
delivery to grantees or add sharing UI.

Responses are `private, no-store`. Errors have empty bodies: `401` for missing
or stale sessions observed at lookup, `403` for a wrong origin or site, `404`
for an unadmitted method/path, a missing or inaccessible entry, or an unchanged
grant (including an ineligible recipient or a duplicate insert), `400` for
invalid query or body, and `503` for an unavailable service. The fixture-only
entry point returns `405` for a wrong method on a matched path. There are no
invitation details, display names, or public links in the response.

## Shared-file delivery

At the staging origin, the existing default-off `DRIVE_STAGING_INVITE_ACCEPTANCE=1`
gate allows a live session to use `GET /api/download/{fileId}` for a published
file they own or can read via a direct or inherited grant. With that flag off,
staging download remains owner-only. Delivery rechecks access and the bound
published generation before storage dispatch and before returning the response.
Full and single-range downloads use the stored ETag for the storage request.
Delivery does not grant folder navigation, public or signed links, or write access.


## Shared with me

`GET` and `HEAD /shared` are a server-rendered member destination at the
staging origin, only when both `DRIVE_STAGING_INVITE_ACCEPTANCE=1` and
`DRIVE_STAGING_SHARED_LISTING=1`. The new flag is unset in deployed configuration;
it does not admit the fixture JSON endpoint or enable grant management.

Each page returns at most 100 explicit live grant roots in binary entry ID
order. A single opaque `cursor` seeks after the prior page, even if that grant
has been removed. It never identifies the viewer. The response is private and
non-cacheable; the page query rechecks the live session and grants on primary D1.

Design reference: [`docs/design` at `91a6ce10453e78b17c8c57838de4fe1b94961f6b`](https://github.com/TogetherWeOwn/qerith/tree/91a6ce10453e78b17c8c57838de4fe1b94961f6b/docs/design), Drive v0 §8 and K2/K5. This slice shows only name and kind;
it omits sender, size, date, and total counts. File names link to the existing
authorized download; folders are labels. Details, shared-folder navigation and
owner grant controls are outside this slice.
