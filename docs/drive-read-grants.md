# Drive read-grant HTTP contract

Only the generated disposable Worker fixture mounts these endpoints. Neither
staging admission layer is changed. There is no deployment flag for this slice.

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
grants that still permit access.

Responses are `private, no-store`. Errors have empty bodies: `401` for missing
or stale sessions observed at lookup, `403` for a wrong site, `404` for a
missing or inaccessible entry or an unchanged grant (including an ineligible
recipient or a duplicate insert), `400` for invalid query or body, `405` for a
wrong method on a matched path, and `503` for an unavailable service. There are
no invitation details, display names, or public links in the response.
