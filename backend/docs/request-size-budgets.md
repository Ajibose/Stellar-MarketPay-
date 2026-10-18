# Request Size Budgets

_issue #1785 — audit of the global `express.json({ limit: "20kb" })` against
real payload sizes._

`backend/src/server.js` parses JSON bodies with a **default 20 KB budget** and
raises the limit **per route, only where real payloads plausibly exceed it**.
Budgets live in a single registry,
[`backend/src/middleware/requestSizeLimit.js`](../src/middleware/requestSizeLimit.js)
(`REQUEST_SIZE_BUDGETS`), and are mounted in `server.js` **before** the default
parser — body-parser only parses in the first middleware that consumes the
request stream, so a budget registered after the default parser would never
apply.

## Budgets

| Mount path         | Budget | Why                                                                                                                                            |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| _(default)_        | `20kb` | Typical API request objects are a few KB; unchanged from the previous global limit.                                                             |
| `/api/scope`       | `2mb`  | Scope sessions accept up to `MAX_CONTENT_LENGTH` = 500,000 characters; migration `V67` caps stored content at 512 KiB (`octet_length <= 524288`). |
| `/api/messages`    | `50kb` | Message content is capped at 10,000 characters (`messageRoutes.js`); multibyte text (e.g. emoji) can triple that on the wire, plus attachment metadata from `V27` (`attachment_cid/name/size/mime`). Matches the router's previously-declared (but shadowed) `50kb` intent. |
| `/api/profiles`    | `64kb` | Profile upserts carry `portfolio_items` (schema: `maxItems: 10`; bounded fields ≈ 1.4 KB per item but `url` has no `maxLength`) alongside the rest of the profile object — a full payload can exceed 20 KB. |

### Audited flows that do **not** need a raised budget

- **Dispute evidence uploads** (`POST /api/disputes/:jobId/evidence`) are
  `multipart/form-data` handled by multer with its own 5 MB file cap
  (`ipfsService.MAX_FILE_SIZE`) — they never pass through `express.json`.
  The evidence metadata and on-chain CID flows (`sorobanEvidence.js`) are
  single-CID / single-XDR payloads of a few KB, comfortably inside 20 KB.
- **Message attachment files** are uploaded through the multipart attachment
  endpoint (server-side egress to IPFS is capped separately at 1 MB in
  `ipfsService.js`); only the small metadata travels as JSON.

## Oversized-body error format

Every oversized body — default or raised budget — is rejected with a
structured JSON error instead of a bare 413:

```json
{
  "error": "Request body too large. Maximum size is 20kb.",
  "code": "FILE_TOO_LARGE",
  "details": { "limit": "20kb" }
}
```

`code` is always present on 413 responses. Route-level content checks keep
their own codes (e.g. `/api/scope` returns `PAYLOAD_TOO_LARGE` when
`content` exceeds `MAX_CONTENT_LENGTH`).

## Adding a budget

1. Measure the largest legitimate payload for the route.
2. Add the mount path + budget to `REQUEST_SIZE_BUDGETS` in
   `backend/src/middleware/requestSizeLimit.js` with a one-line justification.
3. Document the evidence in the table above.
4. Add/extend a test in `backend/__tests__/requestSizeBudgets.test.js`.

Do **not** raise limits for multipart/file flows — those belong to multer.
