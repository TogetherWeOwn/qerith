# Drive upload completion responses

`POST /api/uploads/{intent}/complete` takes `{ "parentId": null, "name": "file" }`
(`null` selects the owner’s root). Responses are private and not cacheable.

| Reply | Client handling |
| --- | --- |
| `201` or `200` with `{ "id": "…" }` | The entry is published. An authorized repeat of the same intent, parent and name returns `200` with the same ID without contacting storage, as long as the entry and access still exist. No retry is needed after a success reply. |
| `409` with `{ "code": "name-taken" }` | An accessible destination has an occupied sibling name. Do not retry while occupied and do not offer replacement. The same intent and destination may be submitted once the name is free. If no completion was dispatched, this can perform its first completion; if a verified receipt already exists, the server reuses it and may do another `HEAD` but does not send another multipart completion. The reply does not tell the client which case applies. |
| Empty `409`, `404`, or any other error, including a missing response | Leave the item interrupted. Do not treat this as a name conflict or automatically resend parts, complete, or start a replacement upload. The reply does not establish whether storage accepted a request. A dispatched completion without a verified receipt cannot be redispatched by this route. |

Unknown and foreign intents and inaccessible folders have the same empty `404`.
A session denied at request admission gets an empty `401`; if access is lost
before the conflict lookup, no conflict or publication receipt is returned.
