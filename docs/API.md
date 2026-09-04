# LEXX 2.0 — API Reference

Every endpoint below was read out of `backend/routes/` and its matching controller. Request shapes come from the zod schemas; response shapes from the `res.json(...)` calls. Where the implementation differs from the design spec, the implementation is what is written here — the differences are listed under [Known inconsistencies](#known-inconsistencies).

Base URL: `PUBLIC_BASE_URL` (default `http://localhost:5000`). All JSON bodies are capped at 256 kB (`express.json`); multipart uploads are capped separately by `MAX_UPLOAD_BYTES` (default 256 MB) and, for FSL reports, by a hard 32 MB.

CORS: origins from `WEB_ORIGIN` (comma-separated), `credentials: true`, methods `GET, POST, PATCH, OPTIONS`.

---

## Contents

- [Authentication](#authentication)
- [The error envelope](#the-error-envelope)
- [Authorization model in one paragraph](#authorization-model-in-one-paragraph)
- [Modules](#modules) — [Auth](#auth) · [Cases](#cases) · [Evidence](#evidence) · [Custody](#custody) · [FSL](#fsl) · [Disclosure](#disclosure) · [Certificates](#certificates) · [Ledger](#ledger) · [Anchors](#anchors) · [Audit](#audit) · [Search](#search) · [Health](#health)
- [Denial reason codes](#denial-reason-codes)
- [The public surface](#the-public-surface)
- [Known inconsistencies](#known-inconsistencies)

---

## Authentication

```
Authorization: Bearer <jwt>
```

The header is parsed strictly (`backend/middleware/authenticate.js:25`): exactly two whitespace-separated parts, scheme matching `/^Bearer$/i`, and the credential must match `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$`. Anything else is a 401 before the signature is even checked.

| Property | Value | Source |
|---|---|---|
| Algorithm | HS256, **pinned on verification** | `services/tokens.js:54` |
| Issuer / audience | `lexx` / `lexx-api` | `services/tokens.js:21` |
| Access token lifetime | `JWT_ACCESS_TTL_SEC`, default **900 s (15 min)**, clamped 60–3600 | `config/env.js:71` |
| Refresh token | 48 random bytes, base64url; SHA-256 hashed at rest; single-use; rotated | `services/tokens.js:65` |
| Refresh lifetime | `REFRESH_TTL_SEC`, default 12 h | `config/env.js:72` |

**Refresh rotation.** `POST /api/auth/refresh` consumes the presented token, mints a successor in the same `familyId`, and re-verifies the directory. Presenting an already-consumed or revoked token revokes **every** live token in that family with reason `TOKEN_REUSE_DETECTED` and returns `REFRESH_REUSED` (401).

**Token claims are not the authorization input.** The JWT carries `sub`, `authorityId`, `authority`, `role`, `scope`, `pubKeyFingerprint`, `mfaAt`. None of it is used to decide access. `resolveContext` (`middleware/authenticate.js:59`) re-reads the `User` document on every request and builds `req.user` from the **stored** `role`, `authority`, `scope` and `status`; the access resolver reads only that. See ADR-005 in `docs/AGENT_DECISIONS.md`. Two consequences that are visible in the API:

- A user suspended after their token was minted gets `403 USER_NOT_ACTIVE` on their **next request**, not their next login.
- If `role` or `authority` in the token no longer matches the database (transfer, roster rotation, re-designation), the request is refused with `401 SESSION_STALE` and the client must sign in again.

**Logout** (`POST /api/auth/logout`) revokes all refresh tokens for the user. It does **not** invalidate the outstanding access token, which remains usable until it expires — up to 15 minutes.

---

## The error envelope

Every error response, from every route, has this shape (`backend/middleware/errorHandler.js`):

```json
{ "error": { "code": "STRING_CODE", "message": "safe human text", "details": { } } }
```

`details` is present only when the error carries it. Stack traces, driver messages, file paths and configuration values are never included. An unhandled error returns `500 INTERNAL_ERROR` with `details.incidentId` (a UUID); outside production only, an extra `error.debug` field carries the raw message.

### Common codes

| Code | Status | When |
|---|---|---|
| `NOT_AUTHENTICATED` | 401 | No/malformed `Authorization` header |
| `TOKEN_EXPIRED` / `TOKEN_INVALID` | 401 | JWT verification failed |
| `SESSION_USER_MISSING` | 401 | Token `sub` no longer resolves to a user |
| `SESSION_STALE` | 401 | Token role/authority differs from the database |
| `USER_NOT_ACTIVE` | 403 | Account is `SUSPENDED` or `DEACTIVATED` (`details.status`) |
| *(a `DENY_REASON` value)* | 403 | Refused by the access resolver — see the [table below](#denial-reason-codes) |
| `RESOURCE_NOT_FOUND` | 404 | Resource missing **or** the caller is not entitled to know it exists |
| `ROUTE_NOT_FOUND` | 404 | No route matched |
| `VALIDATION_FAILED` | 400 | zod rejected the body/query (`details.fields` = failing paths) |
| `INVALID_IDENTIFIER` | 400 | Malformed ObjectId (Mongoose `CastError`); the offending value is not echoed |
| `MALFORMED_JSON` | 400 | Body is not valid JSON |
| `DUPLICATE` | 409 | Mongo duplicate key (`details.fields`) |
| `CONCURRENT_UPDATE` | 409 | An optimistic guard lost a race; retry |
| `LEDGER_IMMUTABLE` / `AUDIT_IMMUTABLE` | 409 | Attempt to modify an append-only record |
| `PAYLOAD_TOO_LARGE` | 413 | Body or upload over the limit |
| `LIMIT_UNEXPECTED_FILE`, `LIMIT_FILE_COUNT`, `LIMIT_FIELD_COUNT`, `LIMIT_FIELD_KEY`, `LIMIT_FIELD_VALUE`, `LIMIT_PART_COUNT` | 400 | Multer rejections; `details.field` names the offending field |
| `RATE_LIMITED` | 429 | Auth rate limiter tripped |
| `DIRECTORY_UNAVAILABLE` | 503 | An authority directory is unreachable (`details.directory`). The system fails **closed** |
| `INTERNAL_ERROR` | 500 | Unhandled (`details.incidentId`) |

Note that a resolver denial uses the `DENY_REASON` value **as** the error `code` (`utils/errors.js:64`), so `code` and the audited `reason` are the same string.

---

## Authorization model in one paragraph

Every protected route passes through one of three guards from `backend/middleware/authorize.js`, all of which call the single policy point in `backend/services/accessResolver.js`:

| Guard | What it asks | What it attaches |
|---|---|---|
| `authorize({action, resourceType, idFrom})` | May this user take this ACTION on the resource with this id? The resolver **loads the resource itself** from the database (`idFrom` defaults to `params.id`). | `req.resource`, `req.caseDoc`, `req.scopeFilter` |
| `authorizeCollection(resourceType)` | Collection route, no id. Always allows an active session and returns a Mongo scope filter the controller must intersect. | `req.scopeFilter` |
| `authorizeCreate(resourceType, contextFn)` | May this role create this kind of resource, **and** is the caller entitled to WRITE the case it hangs off? | `req.createContext` |

Both allow and deny decisions are written to `audit_events` before the response is produced. Default is deny (`NO_MATCHING_POLICY`).

**ACTION** values: `READ`, `WRITE`, `DOWNLOAD`, `VERIFY`, `ORDER`, `APPROVE`, `ACKNOWLEDGE`, `LOGIN`.
**RESOURCE_TYPE** values: `CASE`, `EVIDENCE`, `CUSTODY_ITEM`, `REFERRAL`, `DISCLOSURE_PACK`, `CERTIFICATE`, `CASE_ACCESS_GRANT`, `LEDGER`, `AUDIT`, `SEARCH`.

The role × scope matrix is in [`docs/SECURITY.md`](./SECURITY.md#authorization). Per-endpoint, "who may call it" below states the guard, then what that resolves to in practice.

---

# Modules

## Auth

`backend/routes/auth.js` → `backend/controllers/auth.js`. **None of these routes require a session** except `rotate-key`, `me` and `logout`.

Rate limiting is per IP over a 15-minute window, and is skipped entirely when `NODE_ENV=test`, and for loopback addresses when `NODE_ENV !== production`. In production there is no exemption.

| Limiter | Env var | Default | Applied to |
|---|---|---|---|
| lookup | `RATE_LIMIT_LOOKUP` | 60 | `verify-identity` |
| otp | `RATE_LIMIT_OTP` | 10 | `request-otp`, `rotate-key` |
| login | `RATE_LIMIT_LOGIN` | 20 | `activate`, `login`, `refresh` |

### `POST /api/auth/verify-identity`

**Auth:** none. **Rate limit:** lookup.

Body: `{ authorityId }` — string, trimmed, 3–64 chars, `^[A-Za-z0-9/_.-]+$`.

Resolves the identifier against all three authority directories in parallel and requires exactly one match.

**200**
```json
{
  "authorityId": "UP-GZB-4471",
  "name": "…", "authority": "POLICE", "role": "IO",
  "scope": { "stationCode": null, "districtCode": null, "stateCode": null, "courtId": null, "labId": null },
  "maskedPhone": "•••••3210",
  "accountExists": true,
  "nextStep": "LOGIN"
}
```
`nextStep` is `"LOGIN"` when a Lexx account exists, `"ACTIVATE"` otherwise.

**Errors:** `VALIDATION_FAILED` 400 · `IDENTITY_NOT_VERIFIED` 403 (`details.reason` — e.g. `IDENTITY_NOT_IN_DIRECTORY`, `OFFICER_SUSPENDED`, `POSTING_EXPIRED`, `NOT_ON_CURRENT_ROSTER`, `CERTIFICATE_OF_PRACTICE_EXPIRED`) · `AMBIGUOUS_IDENTITY` 400 · `DIRECTORY_UNAVAILABLE` 503 · `RATE_LIMITED` 429.

### `POST /api/auth/request-otp`

**Auth:** none. **Rate limit:** otp.

Body: `{ authorityId, purpose? }` — `purpose` ∈ `ACTIVATION | LOGIN`, defaults to `LOGIN`.

The OTP is sent to the phone **on record in the directory**, never to a number in the request. Any previous unconsumed challenge for the same `(authorityId, purpose)` is deleted first, so only the newest code works.

**200** `{ "sent": true, "maskedPhone": "…", "expiresInSec": 300, "demoOtp": "482913" }`
`demoOtp` appears only when `DEMO_ECHO_OTP=true`, which is refused at startup when `NODE_ENV=production` (ADR-004).

**Errors:** `VALIDATION_FAILED` 400 · `IDENTITY_NOT_VERIFIED` 403 · `ACCOUNT_EXISTS` 400 (ACTIVATION requested for an existing account) · `ACCOUNT_NOT_ACTIVATED` 400 (LOGIN requested for an account that does not exist) · `DIRECTORY_UNAVAILABLE` 503 · `RATE_LIMITED` 429.

### `POST /api/auth/activate`

**Auth:** none. **Rate limit:** login.

Body:

| Field | Type | Constraint |
|---|---|---|
| `authorityId` | string | 3–64, `^[A-Za-z0-9/_.-]+$` |
| `otp` | string | `^\d{4,8}$` |
| `password` | string | 12–200 chars |
| `publicKeyJwk` | object | `{ kty: "EC", crv: "P-256", x: string(1–128), y: string(1–128) }` |

`authority`, `role`, `name` and `scope` are taken from the directory response and **cannot** be supplied. Password is bcrypt-hashed at `BCRYPT_ROUNDS` (default 12).

**201** `{ accessToken, refreshToken, expiresIn, user }` where `user` is the session context: `{ userId, authorityId, authority, role, name, scope{stationCode,districtCode,stateCode,courtId,labId}, status, publicKeyFingerprint, directoryLastVerifiedAt }`.

**Errors:** `VALIDATION_FAILED` 400 · `IDENTITY_NOT_VERIFIED` 403 · `ACCOUNT_EXISTS` 400 · `OTP_INVALID` 401 · `OTP_EXPIRED` 401 · `OTP_ATTEMPTS_EXCEEDED` 429 · `DIRECTORY_UNAVAILABLE` 503 · `RATE_LIMITED` 429.

### `POST /api/auth/login`

**Auth:** none. **Rate limit:** login.

Body: `{ authorityId, password (1–200), otp (^\d{4,8}$) }`.

Order: local user lookup → bcrypt compare (which runs against a dummy hash even for an unknown user, so timing does not distinguish the two cases) → lock check → status check → OTP consume → **live directory re-verification** → adopt the directory's current `authority`, `role`, `name`, `scope` → issue tokens.

**200** — same body as `activate`.

**Errors:** `BAD_CREDENTIALS` 401 (unknown user *and* wrong password, uniformly) · `ACCOUNT_LOCKED` 429 · `USER_NOT_ACTIVE` 403 · `OTP_INVALID` / `OTP_EXPIRED` 401 · `OTP_ATTEMPTS_EXCEEDED` 429 · `DIRECTORY_REVERIFICATION_FAILED` 403 (`details.reason`) · `DIRECTORY_UNAVAILABLE` 503 · `RATE_LIMITED` 429.

### `POST /api/auth/refresh`

**Auth:** none (the refresh token is the credential). **Rate limit:** login.

Body: `{ refreshToken }` — string, 10–500 chars.

Rotates the token **and** re-verifies the directory. A directory refusal revokes every refresh token the user holds.

**200** — same body as `activate`, with the successor refresh token.

**Errors:** `VALIDATION_FAILED` 400 · `REFRESH_INVALID` 401 · `REFRESH_REUSED` 401 (family revoked) · `REFRESH_EXPIRED` 401 · `USER_NOT_ACTIVE` 403 · `DIRECTORY_REVERIFICATION_FAILED` 403 · `DIRECTORY_UNAVAILABLE` 503.

### `POST /api/auth/rotate-key`

**Auth:** session required. **Rate limit:** otp.

Body: `{ otp (^\d{4,8}$), publicKeyJwk }`. The OTP must have been issued with purpose **`LOGIN`**.

Costs a live session *and* a fresh OTP, re-verifies the directory, replaces `User.publicKeyJwk`, and revokes all refresh tokens (`SIGNING_KEY_ROTATED`). It does **not** invalidate past signatures — every `Evidence` row pins the key that made its signature.

**200** `{ "rotated": true, "publicKeyFingerprint": "<sha256 hex>", "previousFingerprint": "<sha256 hex>", "note": "Existing evidence remains verifiable against the key that signed it." }`

**Errors:** `VALIDATION_FAILED` 400 · `DIRECTORY_REVERIFICATION_FAILED` 403 · `OTP_*` as above · `SESSION_USER_MISSING` 401 · `RATE_LIMITED` 429.

### `GET /api/auth/me`

**Auth:** session required. **200** `{ user }` — the session context, read from the database this request.

### `POST /api/auth/logout`

**Auth:** session required. **200** `{ "ok": true }`. Revokes refresh tokens only; see the note under [Authentication](#authentication).

### `ALL /api/auth/register`

**410** `{ "error": { "code": "SELF_REGISTRATION_DISABLED", "message": "Accounts are provisioned by your authority directory" } }`. Present deliberately, on every method.

---

## Cases

`backend/routes/cases.js` → `backend/controllers/cases.js`. All routes require a session.

### `POST /api/cases/from-fir`

**Guard:** `authorizeCreate(CASE, cases.firContext)`.
**In practice:** POLICE, role `IO` or `SHO`, and the FIR's station (resolved from the police directory, not the body) must equal the caller's `scope.stationCode`. Anyone else: `NO_MATCHING_POLICY`; a police role that is neither IO nor SHO: `READ_ONLY_ROLE`; wrong station: `OUT_OF_JURISDICTION`.

Body: `{ firNumber }` — 3–32 chars, `^[A-Za-z0-9/-]+$`.

Every jurisdictional fact on the created case (station, district, state, BNS sections, max punishment, sensitivity class, victim protection, investigating officer) comes from the directory FIR record. A `CaseAccessGrant` with basis `POSTING_ORDER` is created for the IO, and a `CASE_CREATED` ledger entry is appended.

**201** `{ "case": { "_id": "…", "firNumber": "…", "stage": "UNDER_INVESTIGATION", … } }` — the full Mongo document.

**Errors:** `VALIDATION_FAILED` 400 · `FIR_NOT_FOUND` 404 · `CASE_ALREADY_EXISTS` 409 (`details.caseId`) · `DIRECTORY_UNAVAILABLE` 503.

### `GET /api/cases`

**Guard:** `authorizeCollection(CASE)` — any active session; the scope filter does the work.

Query: `limit` (number, capped at 200, default 50).

Scope filter by role: IO → `{ioUserId, stationCode}`; SHO → `{stationCode}`; DISTRICT_SP → `{districtCode}`; MALKHANA_CUSTODIAN → *nothing*; COURT roles → `{courtId}` (nothing if no `courtId` in scope); FSL → cases with a live `OPEN`/`ACCEPTED` referral to their lab; LEGAL → cases with a live `CaseAccessGrant` for them. A null filter renders as an empty list, never as an unfiltered query.

**200** `{ "cases": [ …full documents… ], "total": <count> }` (`total` is `countDocuments` of the filter, so it can exceed `cases.length`).

### `GET /api/cases/:id`

**Guard:** `authorize({ action: READ, resourceType: CASE })`.
**In practice:** IO must be the assigned IO at the right station; SHO same station; SP same district; JUDGE/REGISTRAR/EVIDENCE_CUSTODIAN require `case.courtId === scope.courtId` (so a pre-chargesheet case is refused, ADR-015); FSL requires a live referral in the case; LEGAL requires a live grant.

**200** `{ "case": { … } }` — the document the resolver loaded.

**Errors:** `RESOURCE_NOT_FOUND` 404 · any denial reason 403.

### `GET /api/cases/:id/timeline`

**Guard:** `authorize({ READ, CASE })`. Ledger entries for this case, oldest first, capped at 500.

**200**
```json
{ "caseId": "…",
  "events": [ { "seq": 1, "eventType": "CASE_CREATED", "actorRole": "IO",
                "occurredAt": "…", "payload": {…},
                "entryHash": "…", "prevHash": "…", "anchorBatchId": null } ] }
```

### `POST /api/cases/:id/compute-jurisdiction`

**Guard:** `authorize({ WRITE, CASE })`.
**In practice:** IO on the case at a writable stage, or the station SHO. Court and FSL roles hold no WRITE on a case; advocates are read-only.

Body: ignored. Inputs are read from the case document (ADR-014: `victimIsMinor` is derived, never supplied).

**200**
```json
{ "jurisdiction": { "courtType": "SESSIONS", "requiredDesignation": null,
                    "requiresCommittal": true, "reasons": ["…"], "districtCode": "…" },
  "court": { "code": "…", "name": "…", "designations": ["POCSO"] },
  "courtLookupError": null,
  "note": null }
```
`court` is `null` when no court in the district holds the required designation; `note` then carries the escalation text. `courtLookupError` is non-null (e.g. `COURT_LOOKUP_FAILED`) if the court directory threw — a directory outage is never reported as "no court required".

### `POST /api/cases/:id/file-chargesheet`

**Guard:** `authorize({ WRITE, CASE })`. Body: none.

Requires the case to be at `UNDER_INVESTIGATION` or `FURTHER_INVESTIGATION`, and requires a court listing for the FIR in the court directory. Sets `stage=CHARGESHEET_FILED`, `cnrNumber`, `courtId`, `courtName`, `chargesheetFiledOn`, guarded optimistically on the current stage.

**200** `{ "case": { … } }`

**Errors:** `INVALID_STAGE` 409 · `NO_COURT_LISTING` 404 · `CONCURRENT_UPDATE` 409 · `DIRECTORY_UNAVAILABLE` 503.

### `POST /api/cases/:id/record-order`

**Guard:** `authorize({ action: ORDER, resourceType: CASE })`.
**In practice: judges only.** `ORDER` is in `COURT_ONLY_ACTIONS`, so police and FSL are denied `READ_ONLY_ROLE`; the registrar branch denies `ORDER` explicitly; advocates are read-only. A judge additionally needs `case.courtId === scope.courtId`.

Body: `{ orderType (2–64), text (1–5000), effectiveOn? (coercible date) }`. `effectiveOn` is stored inside the ledger payload as `clientEffectiveOn` and is **never** chain input (ADR-007).

**201** `{ "recorded": true, "ledgerSeq": 42, "entryHash": "<sha256 hex>" }`

---

## Evidence

`backend/routes/evidence.js` (+ `evidenceFslRouter` from `routes/fsl.js`) → `backend/controllers/evidence.js`.

### `POST /api/evidence/upload` *(multipart)*

**Middleware order:** multer (parses the body so `caseId` exists) → `authorizeCreate(EVIDENCE, uploadCaseContext)` → controller.
**In practice:** POLICE `IO` or `SHO` (capability), **and** a WRITE to the specific case loaded from `body.caseId` — so station scope, IO assignment and case stage all apply. An IO uploading into another officer's case is refused `NOT_ASSIGNED_IO`; a case past investigation is refused `CASE_STAGE_CLOSED_TO_WRITES`.

File field: `file` (exactly one). Limits: `fileSize = MAX_UPLOAD_BYTES`, `files: 1`, `fields: 24`, `fieldSize: 64 kB`. The temp file is deleted on every path, including denial.

| Field | Type | Constraint |
|---|---|---|
| `caseId` | string | `^[0-9a-fA-F]{24}$` |
| `title` | string | 1–300 |
| `description` | string | ≤5000, optional, default `""` |
| `sha256Client` | string | `^[0-9a-f]{64}$` (case-insensitive) |
| `signature` | string | `^[0-9a-f]{128}$` — ECDSA P-256, **IEEE P1363** (`r‖s`), 64 bytes hex |
| `sourceType` | enum | `MOBILE, COMPUTER, DVR, CD_DVD, FLASH_DRIVE, SERVER, CLOUD, OTHER` |
| `make`, `model` | string | ≤120, optional |
| `colour` | string | ≤60, optional |
| `serialNumber`, `imeiOrUid` | string | ≤120, optional |
| `macAddress` | string | ≤64, optional |
| `capturedAt` | date | optional |
| `metadata` | string | ≤8000, optional JSON; malformed JSON is ignored, never fatal |

Pipeline: MIME allowlist + magic-byte sniff → recompute SHA-256 from the received bytes → verify the signature over `sha256Client` against the caller's registered key → generate DEK, AES-256-GCM encrypt into the vault, wrap the DEK under the per-case KEK → triage → create the `Evidence` record → append `EVIDENCE_UPLOADED` to the ledger → build the officer's receipt.

Accepted MIME types (`services/fileType.js`): `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/tiff`, `video/mp4`, `video/quicktime`, `video/x-msvideo`, `audio/mpeg`, `audio/wav`, `application/pdf`, `text/plain`, `application/zip`. `text/plain` is accepted only when nothing else sniffs.

**201**
```json
{ "evidence": { "_id": "…", "exhibitCode": "EX-01232026-001", "caseId": "…",
                "sha256Client": "…", "sha256Server": "…", "signature": "…",
                "signerPubKeyFingerprint": "…", "signerPublicKeyJwk": {…},
                "hashMatchedOnIngest": true, "signatureValidOnIngest": true,
                "storageKey": "…", "sizeBytes": 1234, "mimeType": "image/jpeg",
                "sourceDevice": {…}, "triage": {…}, "ledgerSeq": 7 },
  "receipt": { "exhibitCode": "…", "evidenceId": "…", "caseId": "…", "firNumber": "…",
               "sha256": "…", "hashAlgorithm": "SHA-256",
               "signerAuthorityId": "…", "signerPubKeyFingerprint": "…",
               "ledgerSeq": 7, "entryHash": "…", "prevHash": "…",
               "signedAt": "…", "issuer": "LEXX",
               "anchorNetwork": "monad-testnet", "receiptHash": "…" } }
```
The `encryption` subdocument is stripped from the response — wrapped keys and IVs never leave the server.

**Errors:** `FILE_REQUIRED` 400 · `VALIDATION_FAILED` 400 · `CASE_NOT_FOUND` 404 · `CASE_MISMATCH` 400 · `MIME_TYPE_NOT_ALLOWED` / `MIME_TYPE_MISMATCH` 400 (`details.declared`, `details.detected`) · `HASH_MISMATCH` 400 (`details.sha256Client`, `details.sha256Server`; also writes an `INTEGRITY_EXCEPTION` ledger entry and a DENY audit row) · `NO_REGISTERED_KEY` 400 · `SIGNATURE_INVALID` 400 (also writes an `INTEGRITY_EXCEPTION`) · `PAYLOAD_TOO_LARGE` 413 · `LIMIT_*` 400 · `STORAGE_WRITE_FAILED` 500.

### `GET /api/evidence`

**Guard:** `authorizeCollection(EVIDENCE)` — any active session, filtered by the caller's **case** scope.

Query: `caseId` (`^[0-9a-fA-F]{24}$`, optional — intersected, never substituted), `limit` (≤200, default 100).

**200** `{ "evidence": [ …documents without `encryption`… ], "total": <items.length> }`

> This endpoint filters by *case*, not by disclosure set. See [Known inconsistencies](#known-inconsistencies) item 3.

### `GET /api/evidence/queue/triage`

**Guard:** `authorizeCollection(EVIDENCE)`. Same case-level scope filter.

**200**
```json
{ "queue": [ { "exhibitCode": "…", "title": "…", "caseId": "…",
               "triage": { "priority": "HIGH", "disclaimer": "…" },
               "forensic": {…}, "mimeType": "…", "createdAt": "…" } ],
  "uiLabel": "Review Priority",
  "disclaimer": "Automated triage only. Not expert opinion under BSA s.39 / IT Act s.79A." }
```
Sorted `HIGH` → `MEDIUM` → `LOW`. `disclaimer` is `null` when the queue is empty.

### `GET /api/evidence/:id`

**Guard:** `authorize({ READ, EVIDENCE })`.
**In practice:** police roles by case scope; FSL requires a live `OPEN`/`ACCEPTED` referral **for this exhibit** to their lab; LEGAL requires (a) a live grant on the case, (b) a `SERVED` disclosure pack whose `servedTo` includes them, and (c) this exhibit in `pack.exhibitIds` — otherwise `EXHIBIT_NOT_IN_DISCLOSURE_SET`.

**200** `{ "evidence": { "_id": "…", … } }` with `encryption` deleted.

### `POST /api/evidence/:id/verify`

**Guard:** `authorize({ action: VERIFY, resourceType: EVIDENCE })`. `VERIFY` counts as a read action, so every role with read access to the exhibit may verify it. Body: none.

Four independent lights, each recomputed from first principles rather than read from a stored flag.

**200**
```json
{ "exhibitCode": "EX-…",
  "fileIntegrity": "FILE_INTACT | FILE_MODIFIED | FILE_MISSING",
  "signatureValid": true,
  "chainIntegrity": "CHAIN_INTACT | CHAIN_BROKEN",
  "anchorIntegrity": "ANCHOR_MATCH | ANCHOR_MISMATCH | NOT_ANCHORED | ANCHOR_UNAVAILABLE",
  "brokenAtSeq": null, "chainBreakReason": null, "entriesChecked": 128,
  "expectedSha256": "…", "recomputedSha256": "…",
  "publishedRoot": "0x…", "computedRoot": "0x…",
  "anchorTxHash": "0x…", "anchorNetwork": "monad-testnet",
  "anchorExplorerUrl": "https://testnet.monadexplorer.com/tx/0x…",
  "verifiedAt": "…",
  "interpretation": "The stored file matches its recorded hash, …" }
```
`recomputedSha256` is `null` when the GCM tag failed (the ciphertext was altered, so no plaintext can be recovered) or the object is missing. `chainIntegrity` reflects the **whole** ledger, not just this exhibit. Writes a `VERIFY` audit row with `reason = fileIntegrity`.

### `POST /api/evidence/:id/stream-token`

**Guard:** `authorize({ action: DOWNLOAD, resourceType: EVIDENCE })`. Body: none.

**200** `{ "token": "<43-char base64url>", "expiresInSec": 60 }` (`STREAM_TOKEN_TTL_SEC`, default 60, range 10–600). Only `sha256(token)` is stored, bound to `userId`, `resourceId`, purpose `EVIDENCE` and `caseId` (ADR-010).

### `GET /api/evidence/:id/stream?token=`

**Guard:** `authorize({ DOWNLOAD, EVIDENCE })` — the token is necessary but not sufficient; the resolver still runs.

Query: `token` (required).

The token is consumed atomically (`findOneAndUpdate` on `consumedAt: null` and unexpired), so a replay finds nothing. It is then checked to be bound to this user and this resource.

**200** decrypted bytes, with `Content-Type: <evidence.mimeType>`, `Content-Disposition: attachment; filename="<exhibitCode>"`, `X-Content-Type-Options: nosniff`. Writes a `DOWNLOAD` audit row before streaming.

**Errors:** `STREAM_TOKEN_REQUIRED` 403 · `STREAM_TOKEN_INVALID` 403 (unknown, consumed or expired) · `STREAM_TOKEN_WRONG_USER` 403 · `STREAM_TOKEN_WRONG_RESOURCE` 403 · `OBJECT_NOT_FOUND` 404.

> The GCM tag is only checked at the *end* of the stream. A consumer that aborts early has not verified integrity; `POST /verify` is the endpoint that does.

### `POST /api/evidence/:id/refer-fsl`

Mounted from `routes/fsl.js` under `/api/evidence`.

**Guards:** `authorize({ WRITE, EVIDENCE })` **then** `authorizeCreate(REFERRAL, fsl.referralContext)`.
**In practice: SHO only.** The `REFERRAL` create capability is `POLICE && role === SHO`; the WRITE guard additionally requires the exhibit's case to be in the SHO's station.

Body: `{ labCode (3–64, ^[A-Za-z0-9-]+$), discipline, questionsPosed? (≤2000) }` where `discipline` ∈ `MOBILE_FORENSICS | MEDIA_FORENSICS | COMPUTER_FORENSICS`.

`labId`, `labName` and `section79ARef` are read from the FSL directory, never from the request.

**201** `{ "referral": { "id": "…", … }, "ledgerSeq": 12, "entryHash": "…" }` — see [`referralView`](#fsl) for the field list.

**Errors:** `VALIDATION_FAILED` 400 · `LAB_NOT_FOUND` 404 · `DISCIPLINE_NOT_OFFERED` 400 (`details.labCode`, `details.disciplines`) · `DUPLICATE_LIVE_REFERRAL` 409 (`details.referralId`, `details.status`) · `DIRECTORY_UNAVAILABLE` 503.

---

## Custody

`backend/routes/custody.js` → `backend/controllers/custody.js`. All routes require a session.

The `item` object returned by every endpoint here (`itemView`) is:

```json
{ "id": "…", "itemCode": "IT-01232026-001", "caseId": "…", "evidenceId": null,
  "description": "…", "identifiers": { "imei": null, "serialNumber": null },
  "sealNumber": "…", "sealIntact": true, "stationCode": "…", "districtCode": "…",
  "currentHolderUserId": "…", "currentLocation": "FIELD", "currentLocationDetail": null,
  "status": "SEIZED", "frozen": false, "frozenReason": null, "frozenAt": null,
  "pendingTransfer": null, "qrPayload": "LEXX:v1:IT-…:<hmac>", "createdAt": "…" }
```

The stored transfer token hash is never included in `pendingTransfer`.

**Lawful transitions** (`CUSTODY_TRANSITIONS`): `SEIZED → IN_STORE`; `IN_STORE → AT_FSL | IN_COURT | RETURNED | DESTROYED`; `AT_FSL → IN_STORE`; `IN_COURT → IN_STORE | RETURNED`; `RETURNED` and `DESTROYED` are terminal. Everything routes through the malkhana.

### `POST /api/custody/items`

**Guard:** `authorizeCreate(CUSTODY_ITEM, custody.createItemContext)`.
**In practice:** POLICE `IO` or `SHO` (capability) **and** a WRITE to the case named by `body.caseId`.

| Field | Type | Constraint |
|---|---|---|
| `caseId` | string | `^[0-9a-fA-F]{24}$` |
| `evidenceId` | string \| null | optional ObjectId |
| `description` | string | 1–1000 |
| `sealNumber` | string | 1–120 |
| `identifiers.imei` | string \| null | ≤64, optional |
| `identifiers.serialNumber` | string \| null | ≤120, optional |
| `location` | enum | `MALKHANA | FSL | COURT | FIELD`, default `FIELD` |
| `locationDetail` | string \| null | ≤200 |

`stationCode` and `districtCode` are copied from the authorised case, never from the body.

**201**
```json
{ "item": { … }, 
  "qr": { "payload": "LEXX:v1:IT-…:<hmac>", "itemCode": "IT-…",
          "printable": { "itemCode": "…", "exhibit": "…", "sealNumber": "…",
                         "firNumber": "…", "stationCode": "…", "issuedAt": "…",
                         "notice": "This label identifies the item. It grants no authority to move it." } },
  "ledgerSeq": 15, "entryHash": "…" }
```

**Errors:** `VALIDATION_FAILED` 400 · `CASE_NOT_FOUND` 404 · `CASE_MISMATCH` 400 · `INVALID_ITEM_CODE` 400.

### `GET /api/custody/scan/:qrToken`

**Middleware:** `custody.resolveScannedItem` (verifies the HMAC, resolves `itemCode` → item id) → `authorize({ READ, CUSTODY_ITEM, idFrom: 'scannedItemId' })` → controller.

A valid tag proves Lexx printed the label. It is **identification only** — the resolver runs on the resolved id exactly as it would for a typed id (ADR-011).

Path param: the full payload `LEXX:v1:<itemCode>:<base64url HMAC>`, ≤512 chars; `itemCode` must match `^IT-[A-Za-z0-9-]{1,48}$`.

**200**
```json
{ "tag": { "authentic": true, "itemCode": "IT-…" },
  "item": { … },
  "allowedActions": ["VIEW_CHAIN", "INITIATE_TRANSFER"],
  "nextStates": ["IN_STORE"],
  "notice": "The label is authentic. Authenticity of the label is not authority over the item; …" }
```
`allowedActions` is a UI hint computed from state — every action listed is re-authorised when attempted.

**Errors:** `INVALID_OR_FORGED_TAG` 400 (`details.reason` ∈ `MALFORMED_PAYLOAD`, `NOT_A_LEXX_TAG`, `UNSUPPORTED_TAG_VERSION`, `INVALID_OR_FORGED_TAG`; also writes a DENY audit row) · `RESOURCE_NOT_FOUND` 404 · `CUSTODIAN_SCOPE` / other denials 403.

### `GET /api/custody/gaps`

**Guard:** `authorizeCollection(CUSTODY_ITEM)` — any active session; the scope filter (for `CUSTODY_ITEM`) decides the result.

Query: `caseId` (ObjectId, optional), `limit` (≤200, default 100).

Walks each item's ledger history and reports structured findings. Finding codes: `NO_LEDGER_HISTORY`, `MISSING_GENESIS_EVENT`, `TIMESTAMP_INVERSION`, `UNSEQUENCED_EVENT`, `SEQUENCE_DISCONTINUITY`, `INTEGRITY_EXCEPTION_RECORDED`, `UNRECORDED_STATE`, `STATE_DISCONTINUITY`, `ILLEGAL_STATE_TRANSITION`, `STATE_DIVERGENCE`.

**200**
```json
{ "items": [ { "itemId": "…", "itemCode": "…", "caseId": "…",
               "recordedStatus": "IN_STORE", "ledgerStatus": "IN_STORE",
               "frozen": false, "sealIntact": true,
               "intact": false, "findingCount": 1,
               "findings": [ { "code": "ILLEGAL_STATE_TRANSITION", "detail": "…",
                               "ledgerSeq": 41, "custodySeq": 3, "occurredAt": "…" } ] } ],
  "total": 1, "withFindings": 1, "broken": ["IT-…"] }
```

> The scope filter used here is keyed for cases, not custody items. See [Known inconsistencies](#known-inconsistencies) item 4.

### `POST /api/custody/items/:id/initiate-transfer`

**Guard:** `authorize({ WRITE, CUSTODY_ITEM })`. For a `MALKHANA_CUSTODIAN` the resolver only checks `item.stationCode === scope.stationCode`; for other police roles it is a case-scoped WRITE.

Body: `{ toUserId (ObjectId), reason (1–500), toStatus (CUSTODY_STATUS), toLocation (CUSTODY_LOCATION) }`.

Controller-level checks, in order: item not frozen → caller **is** the current holder → transition is lawful → recipient exists and is `ACTIVE` → the IO-custody rule → no unexpired pending transfer → atomic write guarded on `(status, frozen:false, currentHolderUserId)`.

**The IO custody rule:** a transfer to `IN_STORE` whose recipient is the case's `ioUserId` is refused. The investigating officer cannot be the store keeper for their own case's evidence.

**201**
```json
{ "transferToken": "<43-char base64url — shown once>",
  "expiresAt": "…", "expiresInSec": 300,
  "item": { … }, "ledgerSeq": 22 }
```
Only `sha256(token)` is stored; the token never appears in the ledger.

**Errors:** `CUSTODY_FROZEN` 403 · `NOT_CURRENT_HOLDER` 403 · `ILLEGAL_CUSTODY_TRANSITION` 409 (`details.from`, `.to`, `.permitted`, `.via`) · `RECIPIENT_NOT_AVAILABLE` 400 · `IO_CANNOT_HOLD_OWN_CASE_EVIDENCE` 403 · `TRANSFER_ALREADY_PENDING` 409 (`details.expiresAt`) · `CONCURRENT_UPDATE` 409.

### `POST /api/custody/items/:id/accept-transfer`

**Guard:** `authorize({ WRITE, CUSTODY_ITEM })`.

Body: `{ transferToken (16–256 chars), sealIntact (boolean) }`.

Token comparison is constant-time; "no transfer pending" and "wrong token" answer identically. The consume is atomic on `(status, frozen:false, pendingTransfer.tokenHash, pendingTransfer.toUserId, pendingTransfer.expiresAt > now)`.

`sealIntact: false` does **not** cancel the handover — the item really is in the receiver's hands. It records the move, sets `frozen: true` with reason `SEAL_BROKEN_ON_ACCEPTANCE`, and appends a second `INTEGRITY_EXCEPTION` ledger entry.

**200**
```json
{ "item": { … }, "frozen": false,
  "integrityException": null,
  "ledgerSeq": 23, "entryHash": "…" }
```
When the seal was broken, `integrityException` is `{ "reason": "SEAL_BROKEN", "ledgerSeq": …, "entryHash": "…", "message": "…" }`.

**Errors:** `TRANSFER_TOKEN_INVALID` 403 · `TRANSFER_TOKEN_EXPIRED` 403 · `TRANSFER_WRONG_RECIPIENT` 403 · `CUSTODY_FROZEN` 403 · `IO_CANNOT_HOLD_OWN_CASE_EVIDENCE` 403 (re-checked at acceptance) · `ILLEGAL_CUSTODY_TRANSITION` 409.

### `GET /api/custody/items/:id/chain`

**Guard:** `authorize({ READ, CUSTODY_ITEM })`.

**200** `{ "item": {…}, "events": [ { "seq", "custodySeq", "eventType", "actorRole", "occurredAt", "payload", "entryHash", "prevHash", "anchorBatchId" } ], "analysis": { …same shape as one entry of `/gaps`.items… } }`

---

## FSL

`backend/routes/fsl.js` → `backend/controllers/fsl.js`. (`POST /api/evidence/:id/refer-fsl` is documented under [Evidence](#post-apievidenceidrefer-fsl).)

`referralView`:
```json
{ "id": "…", "caseId": "…", "evidenceId": "…", "exhibitCode": "EX-…",
  "labId": "…", "labName": "…", "section79ARef": "…",
  "discipline": "MEDIA_FORENSICS", "questionsPosed": "…",
  "status": "OPEN | ACCEPTED | REPORTED | WITHDRAWN",
  "referredAt": "…", "acceptedAt": null, "reportedAt": null }
```

### `GET /api/fsl/referrals`

**Guard:** `authorizeCollection(REFERRAL)` — any active session. The controller reads `req.scopeFilter.__fslLab`; a session with no lab scope gets an empty list, so this is effectively FSL-only.

Query: `status` (a `REFERRAL_STATUS` value, optional), `limit` (≤200, default 100).

**200** `{ "labId": "…", "referrals": [ …referralView… ], "total": n }` — or `{ "labId": null, "referrals": [], "total": 0 }` for a non-FSL caller.

### `POST /api/fsl/referrals/:id/accept`

**Guard:** `authorize({ WRITE, REFERRAL })`, then the controller's `assertActingLab` requires `req.user.scope.labId === referral.labId`.

Why both: the resolver's POLICE branch would let the station SHO pass a WRITE on a referral in their own case; `assertActingLab` compares *scope*, not roles, and stops anyone with no lab scope. Body: none.

**200** `{ "referral": { …status: "ACCEPTED"… }, "ledgerSeq": 30 }`

Also sets `Evidence.forensic.status = UNDER_EXAMINATION` and records the examiner.

**Errors:** `NO_OPEN_REFERRAL_TO_YOUR_LAB` 403 · `REFERRAL_NOT_OPEN` 409 (`details.status`) · `CONCURRENT_UPDATE` 409.

### `POST /api/fsl/referrals/:id/report` *(multipart)*

**Guard:** `authorize({ WRITE, REFERRAL })` → multer → controller (`assertActingLab` again). Authorisation happens *before* the bytes are buffered.

File field: `report` (exactly one, ≤32 MB, held in memory). Body fields:

| Field | Type | Constraint |
|---|---|---|
| `opinion` | enum | `AUTHENTIC | MANIPULATED | INCONCLUSIVE` |
| `examinationSummary` | string | 1–5000 |
| `reportSha256` | string | `^[0-9a-f]{64}$` |
| `reportSignature` | string | `^[0-9a-f]{128}$` (P-256, IEEE P1363) |

The referral must be `ACCEPTED`. The file must sniff as `application/pdf`. The server recomputes the SHA-256 and requires the signature to verify against the examiner's registered key — an unverifiable signature is refused *and* recorded as an `INTEGRITY_EXCEPTION`. The report is then sealed (AES-256-GCM under a fresh DEK wrapped by the case KEK) into a self-describing container (`LEXXSEAL1` magic, ADR-018).

**201**
```json
{ "referral": { …status: "REPORTED"… },
  "forensic": { "opinion": "AUTHENTIC", "examinationSummary": "…",
                "labId": "…", "labName": "…", "section79ARef": "…",
                "reportSha256": "…", "reportedAt": "…" },
  "ledgerSeq": 44, "entryHash": "…",
  "basisNote": "This opinion is the source for Part B of the BSA s.63 certificate. …" }
```

**Errors:** `NO_OPEN_REFERRAL_TO_YOUR_LAB` 403 · `FILE_REQUIRED` 400 · `VALIDATION_FAILED` 400 · `REFERRAL_NOT_ACCEPTED` 409 (`details.status`) · `REPORT_MUST_BE_PDF` 400 (`details.detected`) · `REPORT_HASH_MISMATCH` 400 (`details.declared`, `.computed`) · `NO_REGISTERED_KEY` 400 · `SIGNATURE_INVALID` 400 · `CONCURRENT_UPDATE` 409 · `PAYLOAD_TOO_LARGE` 413.

`AUTHENTIC | MANIPULATED | INCONCLUSIVE` is the **only** authenticity vocabulary in the system and only an examiner can produce it. It is entirely separate from `evidence.triage`, which this module never reads or writes.

---

## Disclosure

`backend/routes/disclosure.js` → `backend/controllers/disclosure.js`. All routes require a session.

`packView`:
```json
{ "packId": "…", "caseId": "…", "cnrNumber": "…",
  "status": "DRAFT | APPROVED | SERVED",
  "exhibitIds": ["…"], "exhibitCount": 3,
  "excludedItems": [ { "itemId": "…", "reason": "…", "approved": false, "approvedAt": null } ],
  "redactionVariant": "DEFENCE_V1", "maskVictimIdentity": true,
  "dueOn": null, "servedOn": null, "approvedAt": null,
  "servedTo": [ { "userId": "…", "servedAt": "…", "watermarkToken": "…",
                  "watermarkLabel": "Name · ENROL/123 · 2026-…", "acknowledgedAt": null } ] }
```

### `POST /api/disclosure/:caseId/prepare`

**Guards:** `authorize({ WRITE, CASE, idFrom: 'params.caseId' })` **then** `authorizeCreate(DISCLOSURE_PACK, packCreateContext)`.
**In practice: the assigned IO only.** The `DISCLOSURE_PACK` capability is `POLICE && role === IO`; the WRITE guard adds station scope, IO assignment and a writable case stage. An SHO passes the WRITE but fails the capability with `READ_ONLY_ROLE`.

Body:

| Field | Type | Constraint |
|---|---|---|
| `excludedItems` | array | ≤200, default `[]`; each `{ itemId: ObjectId, reason: string 10–1000 }` |
| `redactionVariant` | string | 2–64, optional (default `DEFENCE_V1` on first prepare) |
| `maskVictimIdentity` | boolean | optional |

The exhibit set is **computed** server-side as every exhibit on the case minus the requested exclusions. The body cannot assert membership, only reasoned exclusions. `maskVictimIdentity` is `caseDoc.isVictimProtected || body.maskVictimIdentity` — masking can be turned on but never off.

**201** on first prepare, **200** on revision: `{ "pack": { …packView… } }`

**Errors:** `VALIDATION_FAILED` 400 · `DISCLOSURE_PACK_LOCKED` 409 (`details.packId`, `.status` — an already `APPROVED`/`SERVED` pack cannot be re-prepared) · `EXCLUDED_ITEM_NOT_IN_CASE` 400 (`details.itemIds`).

### `POST /api/disclosure/:caseId/sync-representation`

**Guards:** `authorize({ READ, CASE, idFrom: 'params.caseId' })` **then** `authorizeCreate(CASE_ACCESS_GRANT, …)`.
**In practice: a COURT `REGISTRAR` whose `scope.courtId` matches the case.** The `CASE_ACCESS_GRANT` capability is registrar-only, and `resolveCreate` then evaluates a WRITE on the case, which for a registrar means court scope. An investigating officer cannot decide who represents the accused (ADR-019).

Body: **not read at all.** Every fact comes from the court directory.

For each ACTIVE `LEGAL` user in Lexx, the court directory is queried for vakalatnamas and legal-aid assignments matching the case's CNR. `ACCEPTED` vakalatnamas create a grant (`VAKALATNAMA`); anything else revokes one. `ACTIVE` legal-aid assignments create a `LEGAL_AID_ORDER` grant; anything else revokes. `appearingFor` maps `ACCUSED → DEFENCE_COUNSEL`, `VICTIM → VICTIM_COUNSEL`; other values are skipped.

**200**
```json
{ "caseId": "…", "cnrNumber": "…", "advocatesChecked": 4,
  "granted": [ { "grantId": "…", "userId": "…", "role": "DEFENCE_COUNSEL",
                 "grantBasis": "VAKALATNAMA", "grantRef": "VAK/…", "authorityId": "…" } ],
  "revoked": [ { "grantId": "…", "userId": "…", "role": "…", "reason": "VAKALATNAMA_WITHDRAWN", "authorityId": "…" } ],
  "source": "COURT_DIRECTORY" }
```

**Errors:** `CASE_NOT_LISTED` 409 (no CNR yet) · `DIRECTORY_UNAVAILABLE` 503 (fails closed — never falls back to a cached answer).

Recorded in `audit_events` with reason `REPRESENTATION_SYNCED`; there is no `LEDGER_EVENT` for a grant change.

### `POST /api/disclosure/:packId/approve`

**Guard:** `authorize({ action: APPROVE, resourceType: DISCLOSURE_PACK, idFrom: 'params.packId' })`.
**In practice: `REGISTRAR` **or** `JUDGE`**, each needing `case.courtId === scope.courtId`. `APPROVE` is in `COURT_ONLY_ACTIONS`, so police and FSL are denied `READ_ONLY_ROLE`; advocates are read-only (ADR-019).

Body:

| Field | Type | Constraint |
|---|---|---|
| `approvedExclusions` | array of ObjectId | ≤200, default `[]` |
| `redactionVariant` | string | 2–64, optional |
| `maskVictimIdentity` | boolean | optional (still cannot unmask a protected victim) |

Sets `status = APPROVED` and stamps each approved exclusion with the registrar id and time.

**200** `{ "pack": {…}, "pendingExclusions": ["…"], "servable": false }`

**Errors:** `VALIDATION_FAILED` 400 · `PACK_ALREADY_SERVED` 409 · `UNKNOWN_EXCLUSION` 400 (`details.itemIds` — approving something never requested).

### `POST /api/disclosure/:packId/serve`

**Guard:** `authorize({ WRITE, DISCLOSURE_PACK, idFrom: 'params.packId' })`.
**In practice:** a `REGISTRAR` or `EVIDENCE_CUSTODIAN` in the case's court — *and also* the station `SHO`, and the assigned `IO` while the case is still open to writes, because `WRITE` is not court-only. See [Known inconsistencies](#known-inconsistencies) item 5.

Body: `{ recipientUserIds? }` — array of ObjectId, ≤50. Optional narrowing of the recipient list; every id must already hold a live advocate grant.

Requires the pack to be past `DRAFT` and **every** exclusion to have been ruled on. Recipients come from live `CaseAccessGrant` rows with an advocate role; the watermark identity is read from the `User` record.

**200**
```json
{ "pack": { …status: "SERVED"… },
  "servedNow": [ { "userId": "…", "authorityId": "…",
                   "watermarkToken": "<43-char base64url>",
                   "watermarkLabel": "Name · ENROL/123 · 2026-…Z" } ],
  "disclosureServedOn": "…" }
```
Also sets `Case.clocks.disclosureServedOn` (the BNSS s.230 clock) and writes the watermark tokens into the ledger payload.

**Errors:** `PACK_NOT_APPROVED` 409 · `UNAPPROVED_EXCLUSIONS` 409 (`details.itemIds`) · `RECIPIENT_NOT_ON_RECORD` 400 (`details.userIds`) · `ALREADY_SERVED` 409 · `NO_RECIPIENTS_ON_RECORD` 409 · `RECIPIENT_NOT_ACTIVE` 409.

### `GET /api/disclosure/my-pack/:caseId`

**Guard:** `authorize({ READ, CASE, idFrom: 'params.caseId' })` — for an advocate this means a live `CaseAccessGrant`, otherwise `NOT_ON_RECORD_FOR_THIS_CASE`.

The controller adds the second half of the guarantee: the pack must be `SERVED` **and** `servedTo.userId` must include the caller. A pack served on co-accused counsel is not served on them.

**200**
```json
{ "caseId": "…", "cnrNumber": "…", "firNumber": "…", "packId": "…",
  "status": "SERVED", "servedOn": "…", "dueOn": null, "acknowledgedAt": null,
  "redactionVariant": "DEFENCE_V1", "maskVictimIdentity": true,
  "watermark": { "token": "…", "label": "Name · ENROL/123 · …" },
  "exhibitCount": 3,
  "exhibits": [ { "evidenceId": "…", "exhibitCode": "…", "title": "…", "description": "…",
                  "kind": "DIGITAL", "mimeType": "…", "sizeBytes": 1234,
                  "sha256": "…", "hashAlgorithm": "SHA-256", "capturedAt": null,
                  "courtStatus": "NOT_PRODUCED",
                  "forensic": { "status": "REPORT_FILED", "opinion": "AUTHENTIC",
                                "labName": "…", "section79ARef": "…", "reportedAt": "…" },
                  "createdAt": "…" } ],
  "withheld": [ { "reason": "…" } ] }
```
`exhibitView` deliberately omits `triage` (machine review-prioritisation must not reach a party as if it were a finding) and `encryption`/`storageKey`. The FSL opinion **is** included. `withheld` names the ground for each exclusion but never which exhibit it was.

**Errors:** `NO_DISCLOSURE_PACK_SERVED` 403 (also audited as a DENY).

### `POST /api/disclosure/:packId/acknowledge`

**Guard:** `authorize({ action: ACKNOWLEDGE, resourceType: DISCLOSURE_PACK, idFrom: 'params.packId' })`.
**In practice: only a `LEGAL` user on a pack that is `SERVED` and whose `servedTo` includes them.** `ACKNOWLEDGE` is granted nowhere else — police, court and FSL branches never reach it, and it confers no general WRITE (ADR-019). The update is scoped by `servedTo.$` to the caller's own entry.

Body: none.

**200** `{ "packId": "…", "acknowledgedAt": "…", "alreadyAcknowledged": false, "clock": "BNSS_S230_STOPPED_FOR_RECIPIENT" }`
Repeat calls return `{ packId, acknowledgedAt, alreadyAcknowledged: true }` (no `clock` field) rather than erroring.

**Errors:** `NO_DISCLOSURE_PACK_SERVED` 403 · `CONCURRENT_UPDATE` 409.

---

## Certificates

`backend/routes/certificate.js` → `backend/controllers/certificate.js`. BSA s.63 certificates.

`certificateView`:
```json
{ "certificateId": "…", "evidenceId": "…", "caseId": "…",
  "templateVersion": "v1.0", "generatedAt": "…",
  "partA": { "deponentName", "deponentDesignation", "deponentAuthorityId", "sourceType",
             "make", "model", "colour", "serialNumber", "imeiOrUid",
             "hashValue", "hashAlgorithm", "mannerOfProduction", "conditionsStatement" },
  "partB": { "expertName", "labName", "section79ARef", "examinationSummary",
             "expertOpinion", "reportSha256", "reportedAt" },
  "partAComplete": true, "partBComplete": false,
  "pdfSha256": "…",
  "signatures": [ { "role": "PARTY", "signerName": "…", "pubKeyFingerprint": "…",
                    "signedPayloadHash": "…", "signedAt": "…" } ],
  "verificationToken": "<43-char base64url>",
  "verificationUrl": "http://localhost:5000/public/verify/<token>",
  "bodyHash": "<sha256 hex over certificateId|evidenceId|caseId|templateVersion|partA|partB>" }
```
`bodyHash` is what a signer signs. It is computed over an **explicit field list**, so adding an operational field later cannot invalidate signatures already collected. The raw signature bytes are never returned.

### `POST /api/certificates/generate`

**Middleware:** `validateGenerateBody` → `authorize({ READ, EVIDENCE, idFrom: 'body.evidenceId' })` → `authorizeCreate(CERTIFICATE, …)` → controller.
**In practice:** POLICE `IO` **or** COURT `REGISTRAR` (capability), plus READ on the exhibit. Uniquely, `CREATE_IMPLIES_ACTION[CERTIFICATE] = READ`, so the case-level check is READ rather than WRITE — a certificate attests to the record, it does not amend it, and it is normally prepared *after* the chargesheet closes the case to writes.

Body: `{ evidenceId }` — `^[0-9a-fA-F]{24}$`.

Part A is assembled from the evidence record, the caller's directory-derived identity, and the **ledger** (`mannerOfProduction` is rendered mechanically from the append-only timeline, not typed by the deponent). Part B comes only from `evidence.forensic` when `status === REPORT_FILED`; otherwise it is blank and `partBComplete` is false. A PDF is rendered, sealed and stored, and `CERTIFICATE_GENERATED` is appended to the ledger.

Required Part A fields: `deponentName`, `deponentDesignation`, `deponentAuthorityId`, `sourceType`, `hashValue`, `hashAlgorithm`, `mannerOfProduction`, `conditionsStatement`; plus `make`, `model`, `colour` when `sourceType` is a physical article (`MOBILE`, `COMPUTER`, `DVR`, `CD_DVD`, `FLASH_DRIVE`, `SERVER`); plus at least one of `serialNumber` / `imeiOrUid`.

**201** `{ "certificate": { …certificateView… }, "partBNote": "Part B is blank: no section 79A laboratory report has been filed for this exhibit." }` (`partBNote` is `null` when Part B is complete.)

**Errors:** `VALIDATION_FAILED` 400 · `SESSION_USER_MISSING` 404 · **`CERTIFICATE_PART_A_INCOMPLETE` 400** with `details.missing` (an array such as `["partA.make", "partA.serialNumber OR partA.imeiOrUid"]`), `details.exhibitCode` and `details.remedy`. Nothing is written, and the refusal is audited. Generating a second certificate for the same exhibit is permitted — signed documents are never edited, a new one is issued.

### `GET /api/certificates/:id`

**Guard:** `authorize({ READ, CERTIFICATE })`. For FSL, the resolver allows any examiner whose lab holds a referral (of any status) for the certificate's exhibit.

**200** `{ "certificate": { …certificateView… } }`

### `POST /api/certificates/:id/sign-part-a`

**Guard:** `authorize({ WRITE, CERTIFICATE })`, then the controller requires `partA.deponentAuthorityId === req.user.authorityId`.

Body: `{ signature }` — `^[0-9a-f]{128}$`, ECDSA P-256 IEEE P1363 over the server-computed `bodyHash`.

Appends a `PARTY` signature, re-renders and re-stores the PDF, and appends `CERTIFICATE_SIGNED` to the ledger.

**200** `{ "certificate": { …with the new signature… } }`

**Errors:** `VALIDATION_FAILED` 400 · `ALREADY_SIGNED` 409 · `NOT_THE_DEPONENT` 403 · `NO_REGISTERED_KEY` 400 · `SIGNATURE_INVALID` 400 (`details.signedPayloadHash` — the hash the server expected) · plus the resolver's `CASE_STAGE_CLOSED_TO_WRITES` for an IO on a filed case (see [Known inconsistencies](#known-inconsistencies) item 1).

### `POST /api/certificates/:id/sign-part-b`

**Guard:** `authorize({ WRITE, CERTIFICATE })`, then the controller requires `partBComplete` and `evidence.forensic.examinerUserId === req.user.userId`.

Body: `{ signature }` — as above. Appends an `EXPERT` signature.

**200** `{ "certificate": { … } }`

**Errors:** `ALREADY_SIGNED` 409 · `PART_B_NOT_FILED` 409 · `NOT_THE_REPORTING_EXAMINER` 403 · `NO_REGISTERED_KEY` 400 · `SIGNATURE_INVALID` 400.

### `GET /api/certificates/:id/pdf`

**Guard:** `authorize({ action: DOWNLOAD, resourceType: CERTIFICATE })` — audited as a download.

Renders fresh; if the bytes differ from the stored `pdfSha256` (a signature was added since the last render) the object is re-stored so the recorded hash always describes the document actually handed out.

**200** the PDF, with `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="s63-certificate-<exhibitCode>.pdf"`, `X-Content-Type-Options: nosniff`, and `X-Lexx-Pdf-Sha256: <hex>`.

### `GET /public/verify/:token` — PUBLIC

Mounted at `/public`, **outside** `/api`, on its own router with no `requireSession` and no resolver. The only credential is the 32-byte token in the path.

Path param: `^[A-Za-z0-9_-]{43}$`. A malformed token is answered **identically** to an unknown one, so the token space cannot be mapped from outside.

**200**
```json
{ "valid": true, "issuer": "LEXX",
  "certificate": {
    "certificateId": "…", "templateVersion": "v1.0",
    "statute": "Bharatiya Sakshya Adhiniyam, 2023 — section 63",
    "generatedAt": "…",
    "exhibitCode": "EX-…", "cnrNumber": "…", "firNumber": "…",
    "evidenceHash": "<sha256 hex>", "hashAlgorithm": "SHA-256",
    "pdfSha256": "…", "pdfIntegrity": "PDF_INTACT | PDF_MODIFIED | PDF_MISSING",
    "partAComplete": true, "partBComplete": false,
    "signatures": [ { "part": "A", "role": "PARTY", "present": true, "signedAt": "…" },
                    { "part": "B", "role": "EXPERT", "present": false, "signedAt": null } ] },
  "disclosure": "This verifier reports the validity of a certificate. It discloses no case narrative, no party or witness details, and no evidence content.",
  "verifiedAt": "…" }
```

**404** `{ "valid": false, "reason": "CERTIFICATE_NOT_FOUND" }` — note this is **not** the standard error envelope.

What it deliberately does not carry: any person's name, designation or authority id; the laboratory; the expert opinion or examination summary; the manner-of-production narrative; the conditions statement; device make/model/colour/serial/IMEI; the exhibit title or description; any part of the case narrative. Every field is listed explicitly in the controller for that reason.

---

## Ledger

`backend/routes/system.js` → `backend/controllers/ledger.js`. `/api/ledger/*` requires a session.

### `GET /api/ledger/case/:id`

**Guard:** `authorize({ READ, CASE })`. All ledger entries for the case, oldest first (no limit).

**200**
```json
{ "caseId": "…", "count": 18,
  "entries": [ { "seq": 1, "eventType": "CASE_CREATED", "actorRole": "IO",
                 "subjectType": "CASE", "payload": {…}, "payloadHash": "…",
                 "prevHash": "0000…", "entryHash": "…",
                 "occurredAt": "…", "anchorBatchId": "0x…" } ] }
```

`LEDGER_EVENT` values: `CASE_CREATED`, `CASE_STAGE_CHANGED`, `EVIDENCE_UPLOADED`, `CUSTODY_ITEM_CREATED`, `CUSTODY_TRANSFER_INITIATED`, `CUSTODY_TRANSFERRED`, `REFERRED_TO_FSL`, `FSL_EXAMINATION_STARTED`, `FSL_REPORT_FILED`, `REPRESENTATION_SYNCED`, `DISCLOSURE_PREPARED`, `DISCLOSURE_APPROVED`, `DISCLOSURE_SERVED`, `DISCLOSURE_ACKNOWLEDGED`, `CERTIFICATE_GENERATED`, `CERTIFICATE_SIGNED`, `EXHIBIT_MARKED`, `JUDICIAL_ORDER`, `INTEGRITY_EXCEPTION`.

### `GET /api/ledger/verify-chain`

**Guard:** `requireSession` only — **no `authorize()` call**. Any active session may call it (ADR-012 made it non-public).

Query: `from` (int ≥1, default 1), `to` (int ≥1, optional).

Walks the chain and recomputes every hash. The response carries no entry content.

**200**
```json
{ "intact": true, "entriesChecked": 128,
  "firstSeq": 1, "lastSeq": 128,
  "brokenAtSeq": null, "reason": null, "verifiedAt": "…" }
```
`reason` on a break is one of `SEQUENCE_GAP: expected seq N, found M`, `PREV_HASH_MISMATCH: …`, `PAYLOAD_HASH_MISMATCH: …`, `ENTRY_HASH_MISMATCH: …`.

### `GET /api/ledger/entry/:seq/anchor-proof`

**Guard:** `requireSession`; the controller then checks that the entry's case is inside the caller's materialised scope filter. An entry with `caseId: null` skips that check.

Path param: `seq` (int ≥1).

**200** `{ "seq": 42, "entryHash": "…", "ok": true, "reason": null, "batchId": "0x…", "publishedRoot": "0x…", "computedRoot": "0x…", "proof": ["0x…"], "onChainVerified": true, "network": "monad-testnet", "chainId": 10143, "txHash": "0x…", "explorerUrl": "https://testnet.monadexplorer.com/tx/0x…" }`

When the entry is not anchored the body is the short form `{ seq, entryHash, ok: false, reason: "NOT_ANCHORED" }`; other short-form reasons are `ENTRY_NOT_FOUND`, `BATCH_NOT_FOUND`, `ROOT_MISMATCH` (with both roots), `PROOF_INVALID`. `onChainVerified` is `null` when there is no chain connection or the batch is not `CONFIRMED`.

**404** `{ "error": { "code": "NOT_FOUND", "message": "No such entry" } }` · **403** `{ "error": { "code": "OUT_OF_SCOPE", "message": "Access denied" } }`.

---

## Anchors

### `GET /api/anchors/latest` — PUBLIC

`backend/routes/system.js:45`. No authentication, no session, no resolver. Returns the newest `CONFIRMED` or `DRY_RUN` batch.

**200 (anchored)**
```json
{ "anchored": true,
  "batchId": "0x…", "merkleRoot": "0x…",
  "fromSeq": 1, "toSeq": 128, "leafCount": 128,
  "network": "monad-testnet", "chainId": 10143,
  "contractAddress": "0x…", "txHash": "0x…", "blockNumber": 12345678,
  "status": "CONFIRMED", "anchoredAt": "…",
  "explorerUrl": "https://testnet.monadexplorer.com/tx/0x…" }
```
**200 (none yet)** `{ "anchored": false, "message": "No batch has been anchored yet" }`

`leafHashes` are deliberately **not** included — publishing them would disclose the shape and volume of the ledger. `ANCHOR_STATUS` values: `PENDING`, `SUBMITTED`, `CONFIRMED`, `FAILED`, `DRY_RUN`.

---

## Audit

`backend/routes/system.js` → `backend/controllers/audit.js`. Both routes require a session.

### `GET /api/audit`

**Guard:** `requireSession` only. The controller gates on role: `SHO`, `DISTRICT_SP`, `REGISTRAR`, `JUDGE`. Anyone else gets `AUDIT_NOT_PERMITTED` 403.

Query: `caseId` (ObjectId, optional — intersected with the visible set, never widening it), `decision` (`ALLOW | DENY`), `action` (string ≤24), `limit` (1–200, default 100).

Rows are restricted to cases inside the caller's materialised scope filter, so a row with `caseId: null` (authentication events, collection-level denials) never appears here.

**200**
```json
{ "events": [ { "at": "…", "actorName": "…", "authorityId": "…",
                "authority": "POLICE", "role": "IO", "action": "READ",
                "resourceType": "EVIDENCE", "resourceLabel": "EX-…",
                "caseId": "…", "decision": "DENY",
                "reason": "EXHIBIT_NOT_IN_DISCLOSURE_SET" } ],
  "total": 1 }
```
`ip` and `userAgent` are stored on the record but are not surfaced in this feed.

### `GET /api/audit/security`

**Guard:** `requireSession`; the controller requires (POLICE **and** (`SHO` or `DISTRICT_SP`)) **or** role `REGISTRAR`. Note a `JUDGE` may read `/api/audit` but not this feed.

Query: `limit` (capped 200, default 50).

Returns authentication-layer events (`action: 'LOGIN'`) only — failed identity checks, rejected activations, denied logins. These carry no `caseId`, so this feed is **not** scope-filtered; see [Known inconsistencies](#known-inconsistencies) item 6.

**200** `{ "events": [ { "at": "…", "authorityId": "…", "decision": "DENY", "reason": "IDENTITY_NOT_IN_DIRECTORY", "ip": "…" } ], "total": n }`

Auth audit `reason` values seen in practice: `IDENTITY_VERIFIED`, `IDENTITY_NOT_IN_DIRECTORY`, `IDENTITY_NOT_ACTIVE`, `ACCOUNT_ACTIVATED`, `LOGIN_SUCCESS`, `BAD_CREDENTIALS`, `ACCOUNT_LOCKED`, `USER_SUSPENDED` / `USER_DEACTIVATED`, `DIRECTORY_REVERIFICATION_FAILED`, `SIGNING_KEY_ROTATED`, plus directory-supplied reasons (`OFFICER_SUSPENDED`, `POSTING_EXPIRED`, `POSTING_NOT_YET_VALID`, `POSTING_NOT_CURRENT`, `NO_CURRENT_POSTING`, `UNSUPPORTED_POSTING_ROLE`, `NOT_ON_CURRENT_ROSTER`, `UNSUPPORTED_REGISTRY_ROLE`, `CERTIFICATE_OF_PRACTICE_EXPIRED`, `ADVOCATE_*`, `EXAMINER_*`, `JUDGE_*`, `REGISTRY_*`).

---

## Search

### `GET /api/search`

`backend/controllers/search.js`. **Guard:** `requireSession` only; the scope filter is applied inside the controller.

Query: `q` (2–200 chars, required), `caseId` (ObjectId, optional), `limit` (1–100, default 25).

The scope filter is applied **before** the text query, never after. A requested `caseId` narrows the visible set and can never widen it. Every query is audited, including ones that return nothing — search terms are themselves investigative signal.

**200**
```json
{ "query": "…",
  "cases": [ { "_id": "…", "firNumber": "…", "title": "…", "stage": "…",
               "stationCode": "…", "districtCode": "…", "createdAt": "…" } ],
  "evidence": [ { "_id": "…", "exhibitCode": "…", "title": "…", "caseId": "…",
                  "mimeType": "…", "triage": { "priority": "HIGH" },
                  "courtStatus": "…", "createdAt": "…" } ],
  "total": 2 }
```
Both queries use MongoDB `$text` and fall back to `[]` if the text index is unavailable, so a missing index degrades to empty results rather than an error.

**Errors:** `VALIDATION_FAILED` 400 (including a `q` shorter than 2 characters).

---

## Health

Both are unauthenticated, defined directly in `backend/app.js`.

### `GET /healthz`
**200** `{ "status": "ok", "service": "lexx-core", "db": "connected|disconnected", "anchorNetwork": "monad-testnet", "chainId": 10143 }` — deliberately cheap and dependency-free.

### `GET /readyz`
**200 / 503** `{ "status": "ready|degraded", "db": "connected|disconnected", "directories": { "police": { "ok": true, "latencyMs": 4 }, "court": {…}, "legal": {…} } }` — 503 unless the database and all three directories are reachable.

---

## Denial reason codes

Every value of `DENY_REASON` in `backend/models/enums.js:265`. These are returned as the HTTP `error.code` with status **403** (except `RESOURCE_NOT_FOUND`, which the middleware converts to a 404), and are recorded verbatim in the `reason` column of `audit_events`.

Each is safe to show a user on its own: it may reveal *why the caller is not entitled*, never anything about the resource.

| Code | Plain English |
|---|---|
| `NOT_AUTHENTICATED` | No session context reached the resolver. |
| `USER_NOT_ACTIVE` | The account is `SUSPENDED` or `DEACTIVATED` in the database as of this request. |
| `NOT_ASSIGNED_IO` | You are an investigating officer, but not the one assigned to this case. |
| `OUT_OF_JURISDICTION` | The case belongs to a different station (IO/SHO) or district (District SP) than your posting. |
| `CASE_STAGE_CLOSED_TO_WRITES` | The case has left investigation (`UNDER_INVESTIGATION` / `FURTHER_INVESTIGATION`), so investigative writes are no longer accepted. |
| `CUSTODIAN_SCOPE` | A malkhana custodian may touch only custody items at their own station, and nothing else at all. |
| `READ_ONLY_ROLE` | Your role may read this but may not perform this action. Also returned when a police or FSL user attempts a court-only action (`ORDER`, `APPROVE`), when a registrar attempts `ORDER`, and when a role lacks the capability to create this kind of resource. |
| `CASE_NOT_LISTED_IN_YOUR_COURT` | Judge: the case is not bound to your court — either it has no `courtId` yet (still under investigation, before no court) or it is listed elsewhere. |
| `OUT_OF_COURT_SCOPE` | Registry staff: the case is not listed in your court. |
| `NO_OPEN_REFERRAL_TO_YOUR_LAB` | Your laboratory holds no live referral for this exhibit or case — the only thing that gives an examiner visibility. Also returned when the session carries no lab scope at all, and by the FSL controller when the acting user's `scope.labId` does not match the referral. |
| `NOT_ON_RECORD_FOR_THIS_CASE` | No live `CaseAccessGrant` exists for you on this case (no accepted vakalatnama, legal-aid order or prosecution assignment). |
| `GRANT_REVOKED` | *Defined but not currently returned* — the resolver's grant lookup filters on `revokedAt: null`, so a revoked grant surfaces as `NOT_ON_RECORD_FOR_THIS_CASE`. |
| `GRANT_NOT_YET_VALID` | Your grant exists but its `validFrom` is in the future. |
| `GRANT_EXPIRED` | Your grant's `validTo` has passed. |
| `NO_DISCLOSURE_PACK_SERVED` | You are on record, but no disclosure pack has been served **on you** in this case (or the pack is not yet `SERVED`). |
| `EXHIBIT_NOT_IN_DISCLOSURE_SET` | You have been served a pack, but this exhibit is not in it. Also returned to counsel who reach for a physical custody item, which is a police and court matter. |
| `NOT_CURRENT_HOLDER` | Only the person actually holding a custody item can hand it on. |
| `CUSTODY_FROZEN` | Custody was frozen by an integrity exception (a seal reported broken). An SHO must act before it can move again. |
| `IO_CANNOT_HOLD_OWN_CASE_EVIDENCE` | The investigating officer on a case cannot be the store keeper for its own evidence. |
| `RESOURCE_NOT_FOUND` | The resource does not exist — **or** it does and you are not entitled to know that. Converted to a 404 so the two are indistinguishable from outside. Also returned by `resolveCreate` when no `caseId` context was supplied. |
| `NO_MATCHING_POLICY` | Deny-by-default. No branch of the policy matched this (authority, role, resource type) combination. |

---

## The public surface

Six endpoints require no `Authorization` header. Two are the intended public verification surface; four are the front door and health probes.

| Endpoint | Discloses | Deliberately does **not** disclose |
|---|---|---|
| `GET /api/anchors/latest` | Batch id, Merkle root, `fromSeq`/`toSeq`, leaf count, network, chain id, contract address, tx hash, block number, status, timestamp, explorer URL | The leaf hashes themselves, any entry content, any case identifier, any name. A root is a commitment; it reveals nothing about what it commits to. |
| `GET /public/verify/:token` | That a certificate exists in the register; whether its PDF still hashes to the published value; which of the two signatures are present and when; the evidence SHA-256 the certificate attests to; the exhibit code, CNR and FIR number | Any person's name, designation or authority id; the laboratory; the expert opinion or summary; the manner-of-production narrative; the conditions statement; device make/model/colour/serial/IMEI; the exhibit title or description; anything of the case narrative. **Validity, not contents.** |

The remaining unauthenticated routes:

| Endpoint | Note |
|---|---|
| `POST /api/auth/verify-identity` | Rate-limited (60/15 min per IP). Returns the directory's `name`, `authority`, `role`, `scope` and a masked phone for a valid identifier — see [Known inconsistencies](#known-inconsistencies) item 7. |
| `POST /api/auth/request-otp`, `/activate`, `/login`, `/refresh` | The front door. Rate-limited; see the [Auth](#auth) table. |
| `ALL /api/auth/register` | Always 410. |
| `GET /healthz`, `GET /readyz` | Liveness and readiness. `/healthz` discloses the anchor network and chain id and whether the database is connected; `/readyz` additionally discloses per-directory reachability and latency. |

Everything under `/api/cases`, `/api/evidence`, `/api/custody`, `/api/fsl`, `/api/disclosure`, `/api/certificates`, `/api/ledger`, `/api/audit` and `/api/search` requires a session. `GET /api/ledger/verify-chain` was moved behind authentication by ADR-012.

---

## Known inconsistencies

Recorded rather than smoothed over. Each was found by reading the source against the routes.

**1. Response identifier fields are inconsistent across modules.**

| Module | Endpoint(s) | Field | Value |
|---|---|---|---|
| Cases | `POST /from-fir`, `GET /:id`, `POST /file-chargesheet` | `case._id` | full Mongo document |
| Evidence | `POST /upload`, `GET /:id`, `GET /` | `evidence._id` | full Mongo document (minus `encryption`) |
| Evidence receipt | `POST /upload` | `receipt.evidenceId` | string |
| Custody | all | `item.id` | string (`itemView`) |
| FSL | all | `referral.id` | string (`referralView`) |
| Disclosure | `prepare`, `approve`, `serve` | `pack.packId` | string (`packView`) |
| Disclosure | `my-pack` | top-level `packId` | string |
| Certificates | all | `certificate.certificateId` | string |
| Disclosure exhibits | `my-pack` | `exhibits[].evidenceId` | string |
| Search | `GET /api/search` | `cases[]._id`, `evidence[]._id` | raw documents |
| Custody gap analysis | `/gaps`, `/chain` | `analysis.itemId` | string |

Cases and evidence return raw Mongo documents (`_id`, `ObjectId` semantics); custody, FSL, disclosure and certificates return hand-written view objects with a renamed, stringified id. A client cannot assume a single id field name across the API. Fixing this would be a breaking change to the frontend and is not attempted here.

**2. `GET /api/cases` returns `total` from `countDocuments`, but every other list endpoint returns `total = results.length`.** `/api/evidence`, `/api/fsl/referrals`, `/api/audit` and `/api/custody/gaps` all report the size of the returned page, not the size of the matching set. Only `/api/cases` reports a true total, so pagination cannot be driven uniformly.

**3. The evidence *list* endpoints are scoped by case, not by disclosure set or referral.** `GET /api/evidence`, `GET /api/evidence/queue/triage` and `GET /api/search` all filter on `materialiseScopeFilter(user, CASE)` and then query `Evidence` by those case ids. The single-resource path `GET /api/evidence/:id` is stricter: it requires an advocate to be in a served disclosure pack containing that exhibit, and an examiner to hold a live referral for it. The list paths do not re-apply either test, so an advocate on record — or an examiner with one referral in a case — sees every exhibit in that case in the list, including exhibits excluded from the disclosure pack, and `triageQueue` and `search` additionally expose `triage.priority`, which `exhibitView` deliberately withholds from `my-pack`.

**4. `GET /api/custody/gaps` uses a case-shaped scope filter against a `CustodyItem` query.** `scopeFilterFor(user, CUSTODY_ITEM)` returns `{ ioUserId, stationCode }` for an IO and `{ courtId }` for court roles. `CustodyItem` has `stationCode` and `districtCode` but no `ioUserId` and no `courtId` (`backend/models/CustodyItem.js:33-57`), so an IO and every court role always get an empty result. SHO, District SP and malkhana custodian work correctly.

**5. `POST /api/disclosure/:packId/serve` is not registrar-restricted.** The route comment says "Registrar serves it", but the only guard is `authorize({ WRITE, DISCLOSURE_PACK })`, and `WRITE` is not in `COURT_ONLY_ACTIONS`. The station SHO — and the assigned IO while the case is still open to writes — therefore pass the resolver and can mint watermarks and serve the pack. `prepare`, `approve`, `acknowledge` and `sync-representation` all carry a second capability or action-level guard; `serve` does not.

**6. `GET /api/audit/security` is not scope-filtered.** It is gated on role only (`SHO`/`DISTRICT_SP` in POLICE, or `REGISTRAR`) and then returns every `LOGIN` audit row in the deployment — `authorityId`, decision, reason and source IP — regardless of station, district or court. `GET /api/audit` is properly scoped; this feed is not, and the code says so explicitly ("these carry no caseId, so they are gated on role rather than case scope").

**7. `POST /api/auth/verify-identity` is an unauthenticated identity oracle.** Given a valid identifier it returns the person's real name, authority, Lexx role, full jurisdictional scope, a masked phone number and whether they hold a Lexx account. It is rate-limited (60 per 15 minutes per IP) and audited, but the rate limiter is skipped for loopback whenever `NODE_ENV !== production` — and behind a reverse proxy in a non-production deployment, every request arrives from loopback.

**8. `GET /api/ledger/verify-chain` discloses ledger volume to any authenticated session.** ADR-012 describes it as "scope-filtered", and the controller comment says "what is scoped is the DETAIL returned". In fact no scoping happens: any active session — including an advocate with a single grant — learns `intact`, `entriesChecked`, `firstSeq`, `lastSeq` and `brokenAtSeq` for the whole deployment. No entry content is returned, so the leak is metadata (total ledger size and growth), not case data.

**9. Several controller doc-comments describe an older authorization design.** `controllers/disclosure.js:321-324` states that approval is "REGISTRAR-scoped" because "no single ACTION covers both" registrar and judge; `:646-651` states that acknowledgement "is authorised with `ACTION.VERIFY`"; `:741-747` states that `sync-representation` "is authorised as a WRITE on the case… That admits the station's IO/SHO as well". All three were superseded by ADR-019 and the current routes use `APPROVE`, `ACKNOWLEDGE` and a registrar-only `CASE_ACCESS_GRANT` capability respectively. The routes are correct; the comments are stale.

**10. `DENY_REASON.GRANT_REVOKED` is defined but unreachable.** `liveGrantFor` (`services/accessResolver.js:117`) filters the query on `revokedAt: null`, so a revoked grant is simply not found and the caller sees `NOT_ON_RECORD_FOR_THIS_CASE`. The more specific code is never returned.

**11. `POST /api/certificates/:id/sign-part-a` requires `WRITE` where `generate` deliberately requires only `READ`.** `CREATE_IMPLIES_ACTION[CERTIFICATE] = ACTION.READ` exists precisely because a certificate is prepared at or after the chargesheet, when the case has closed to investigative writes. Signing was not given the same treatment: `routes/certificate.js:58` uses `ACTION.WRITE`, so an IO who can generate a certificate on a `CHARGESHEET_FILED` case is refused `CASE_STAGE_CLOSED_TO_WRITES` when they try to sign it.
