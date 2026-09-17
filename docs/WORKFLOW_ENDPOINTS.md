# LEXX — the case lifecycle, endpoint by endpoint

This is the reference for how a case moves through LEXX, which role performs each step, and the
exact API call behind it. It describes the routes in `backend/routes/*.js` as they stand; every
step is exercised by the backend test suite (see *How this is verified* at the end).

```
Police upload evidence ─→ Section 63 certificate issued + signed by the system (automatic)
                       ─→ permanent QR label for the physical article (print once, valid forever;
                          a scan opens the public lifecycle page — no sign-in)
                       ─→ AI analysis runs in the background (visible to the FSL only)
                       ─→ FSL reviews where required: verdict Authentic / Manipulated / Inconclusive
                          (anyone who may read it can verify the certificate in one click)
                       ─→ Chargesheet ─→ Court: cognizance → (committal) → trial → close
                          (optionally attaching a judgment / declaration / order signed with the judge's key)
                       ─→ Court accepts an advocate's vakalatnama
                       ─→ that advocate reads the case, every exhibit and its certificate (automatic)

Every step: ledger entry → Merkle root → Monad Testnet
          → described on the lifecycle with who did it and the proofs (§11)
          → a "something changed" signal to every open page allowed to read the case (§12)
```

All authenticated calls carry `Authorization: Bearer <access token>`. Every protected route runs
through the single policy point, `backend/services/accessResolver.js`, and every allow and deny is
written to the audit log.

---

## Roles

| Role | Who | What they do |
|---|---|---|
| `IO` | Investigating officer | Opens the case, uploads evidence, files the chargesheet |
| `SHO` | Station house officer | Sees every case at the station; may upload, file, and refer an exhibit to a named lab. **Never an approval step.** |
| `DISTRICT_SP` | District SP | Read-only across the district |
| `FSL_EXAMINER` | Forensic examiner | The only role that sees AI analysis; works cases ordered by AI priority; records the official verdict |
| `COURT` | **One role** for every court identity (judges and registry staff) | Sees every case listed before any court in its district; takes cognizance, commits, begins trial, closes; accepts or rejects vakalatnamas |
| `DEFENCE_COUNSEL` / `VICTIM_COUNSEL` / `LEGAL_AID_COUNSEL` | Advocates | File a vakalatnama; once on record, read the case, every exhibit and its certificate (read-only) |
| `PUBLIC_PROSECUTOR` | Prosecutor | Reads a case through a live grant; may not file a vakalatnama |
| *(public)* | Anyone | Verifies a certificate by its token or scans an exhibit's QR label (§5 · Public verification); reads the authority public key and anchor roots |

Legacy court roles (`JUDGE`, `EVIDENCE_CUSTODIAN`, `REGISTRAR`) are migrated to `COURT` at boot.

### What each role is shown

| | AI analysis, AI priority, AI ordering | Physical custody fields | Certificates | Forensic verdict |
|---|---|---|---|---|
| FSL examiner | yes | yes (articles at / referred to the lab) | yes | yes |
| Police (IO, SHO, SP) | **no** | yes | yes | yes |
| Court | **no** | yes | yes | yes |
| Counsel on record | **no** | **no** | yes | yes |

The rule lives in `backend/services/ai/visibility.js` (`seesAiAnalysis(user)` is true only for an
FSL session). For every other role the `aiAnalysis` key is absent from every response, case
summaries carry no analysis counts or `highestPriority`, `pendingActions` carries no AI-derived
entry, and exhibit lists are ordered newest first rather than by AI priority.

---

## 1 · Identity and sessions

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/verify-identity` | `{ authorityId }` → name, role and scope **from the authority directory** |
| POST | `/api/auth/request-otp` | `{ authorityId, purpose: ACTIVATION\|LOGIN }` → code sent to the phone on record |
| POST | `/api/auth/activate` | `{ authorityId, otp, password, publicKeyJwk }` → first sign-in, registers the device key |
| POST | `/api/auth/login` | `{ authorityId, password, otp }` → re-checks the directory live; adopts the current role |
| POST | `/api/auth/refresh` | `{ refreshToken }` → new access token + rotated refresh token; re-verifies against the directory |
| POST | `/api/auth/rotate-key` | session + `{ otp, publicKeyJwk }` → register a new device key |
| GET | `/api/auth/me` | The session's user |
| POST | `/api/auth/logout` | Revokes the refresh-token family |
| ANY | `/api/auth/register` | Always `410` — there is no self-registration |

**Sessions never expire on their own.** The access token lives 15 minutes (`JWT_ACCESS_TTL_SEC=900`)
and the client renews it silently with the refresh token. `REFRESH_TTL_SEC=0` (the default) means
the refresh token has no lifetime: a session ends only on sign-out, a failed directory
re-verification at refresh, or refresh-token reuse (which revokes the family). Any non-zero value
(≥ 300) restores a lifetime in seconds.

## 2 · Case

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/cases/from-fir` | IO, SHO | `{ firNumber }` — the case inherits station, sections, sensitivity from the FIR; `stationName` is copied from the police directory at creation (display only) |
| GET | `/api/cases` | all | Scope-filtered list; each row carries `summary` (below) |
| GET | `/api/cases/by-cnr/:cnr` | all in scope | Locate by CNR, then decided exactly as `/:id` (counsel not on record → `NOT_ON_RECORD_FOR_THIS_CASE`, audited) |
| GET | `/api/cases/:id` | all in scope | `{ case (with summary and closure), workflow }` — `workflow.lifecycle` described (§11) |
| GET | `/api/cases/:id/overview` | all in scope | The case **grouped**: `evidence[]` cards, `custody[]`, `pendingActions[]`, `recentActivity[]`; `workflow.lifecycle` described (§11) |
| GET | `/api/cases/:id/workflow` | all in scope, **including counsel on record** | `{ caseId, closure, workflow }` — stage, lifecycle strip with descriptions and proofs (§11), every act with `ok` / blocked `message`, next act per authority |
| GET | `/api/cases/:id/closure-document` | all in scope (court, police on the case, counsel on record) | The signed PDF attached at closing; audited download (§7) |
| GET | `/api/cases/:id/timeline` | all in scope | Ledger events for the case |
| POST | `/api/cases/:id/compute-jurisdiction` | IO, SHO | Court type, designation, committal, and the reasons |

Every case object the API returns — list rows, `/:id`, `/by-cnr`, `/overview`, `from-fir`,
`file-chargesheet` and the transition / close responses — carries `closure`: `null` while the case is
open (and for a case closed before closure records existed), otherwise the **closure view** described
in §7 · *Closing with a signed document*. The stored subdocument is never served.

In the client, **the CNR has a copy button wherever it is shown**: officer case views
(`CaseParts.jsx`), the court, lab and counsel screens, both exhibit dialogs, vakalatnama filings and
the public verify page (`CopyableValue` in `frontend/src/components/common/CopyButton.jsx`: check mark
plus a short "Copied" toast; a click or Enter never also opens the row it sits in). The closure's
SHA-256 and signer key and every hash / key / ledger / anchor proof on a lifecycle have the same button.

`summary` on every case row:

```jsonc
{
  "exhibits": 5, "forensicOpinions": 1, "awaitingForensics": 4, "counselOnRecord": 1,
  "workflow": { "stageLabel": "…", "requiresCommittal": true, "waitingOn": "…",
                "nextCourtAction": { "action": "TAKE_COGNIZANCE", "label": "…", "description": "…", "requiresNote": false },
                "nextPoliceAction": null },
  "lastActivityAt": "2026-…",
  "attention": { "police": 0, "court": 1 },          // + "fsl" for a laboratory viewer
  "custody": { "items": 2, "seized": 1, "inStore": 1, "atFsl": 0, "inCourt": 0, "finished": 0, "frozen": 0 },  // not for counsel
  "pendingFilings": 0,                                // court only
  "analysis": { "completed": 4, "pending": 1, "failed": 0, "unsupported": 0 },                               // FSL only
  "fslReviewRecommended": 1, "highestPriority": "HIGH"                                                      // FSL only
}
```

Each exhibit **card** (overview, FSL groups):

```jsonc
{
  "_id": "…", "exhibitCode": "EX-0123-001", "caseId": "…", "title": "…", "kind": "DIGITAL",
  "mimeType": "image/jpeg", "sizeBytes": 20480, "sourceType": "OTHER", "createdAt": "…", "sha256": "…",
  "forensic": { "status": "REPORT_FILED", "opinion": "MANIPULATED", "labName": "…", "examinerName": "…",
                "examinationSummary": "…", "reportedAt": "…", "basis": "DIRECT_REVIEW" },
  "certificate": { "certificateId": "…", "status": "ACTIVE", "state": "ISSUED", "issuedAt": "…",
                   "lastVerification": { "result": "VERIFIED", "at": "…", "byRole": "COURT" } },
  "label": { "token": "…43 chars…", "url": "<PUBLIC_WEB_URL>/verify?label=…" },   // permanent QR label, §3
  "physicalCustody": { … } ,   // not for counsel; null when no article is linked
  "aiAnalysis": { … }          // FSL only — see §4
}
```

## 3 · Evidence

### Upload

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/evidence/upload` | IO, SHO (case open to writes) | multipart, below |

What the officer fills in: **the file and a title**, optionally a description. Everything else the
browser supplies automatically or is optional.

| Field | Required | Source |
|---|---|---|
| `file` | yes | the officer |
| `caseId` | yes | the screen the officer is on |
| `title` | yes | the officer (1–300 chars) |
| `description` | no | the officer |
| `sha256Client` | yes | computed in the browser before upload |
| `signature` | yes | ECDSA P-256 over `sha256Client`, made by the device key registered at activation |
| `sourceType`, `make`, `model`, `colour`, `serialNumber`, `imeiOrUid`, `macAddress`, `capturedAt`, `metadata` | no | optional source-device particulars; blank = absent (`sourceType` defaults to `OTHER`; the certificate says "not recorded") |

The server checks the bytes' real type, recomputes SHA-256, and verifies the signature against the
officer's registered key. A hash mismatch (`400 HASH_MISMATCH`) or bad signature
(`400 SIGNATURE_INVALID`) is refused and written to the ledger as an `INTEGRITY_EXCEPTION`. On
success the file is encrypted (AES-256-GCM, per-case wrapped key), recorded, written to the ledger,
queued for AI analysis, and **its Section 63 certificate is issued and signed in the same request**.

`201` response:

```jsonc
{
  "evidence": { "_id": "…", "exhibitCode": "EX-0123-006", "title": "…", "sha256Server": "…",
                "ledgerSeq": 42, "labelToken": "…",
                "label": { "token": "…", "url": "<PUBLIC_WEB_URL>/verify?label=…" }, … },
                                               // `aiAnalysis` present only for an FSL session; never `encryption`
  "receipt": { "exhibitCode": "…", "evidenceId": "…", "caseId": "…", "firNumber": "…", "sha256": "…",
               "hashAlgorithm": "SHA-256", "signerAuthorityId": "…", "signerPubKeyFingerprint": "…",
               "ledgerSeq": 42, "entryHash": "…", "prevHash": "…", "signedAt": "…",
               "issuer": "LEXX", "anchorNetwork": "monad-testnet", "receiptHash": "…" },
  "certificate": { "certificateId": "…", "status": "ACTIVE", "state": "ISSUED", "issuedAt": "…",
                   "verificationToken": "…", "verificationUrl": "<PUBLIC_WEB_URL>/verify?token=…" }   // null only if issuing failed
}
```

Certificate issuing never fails an upload: if it throws, the exhibit is kept and the certificate is
issued on the next read of the exhibit or its certificates, or by the boot migration.

### The permanent QR label

Every exhibit carries `labelToken` — 32 random bytes (43 base64url characters), unique, set once at
upload and **immutable** (`backend/models/Evidence.js`; older exhibits get one from the boot
migration). `backend/services/evidenceLabel.js` turns it into

```jsonc
"label": { "token": "…", "url": "<PUBLIC_WEB_URL>/verify?label=<token>" }
```

which is returned on the upload response, `GET /api/evidence/:id`, every row of `GET /api/evidence`,
the case-overview and FSL evidence cards, and each exhibit in counsel's case file. Anyone who may
read the exhibit may print it. Unlike a certificate's `verificationToken`, the label **does not
change when a certificate is superseded**, so a sticker printed on day one keeps resolving for the
life of the exhibit. It opens `GET /public/evidence/:labelToken` (§5 · Public verification).

In the client, *Print QR label* prints only a 70 × 40 mm sticker (QR, exhibit code, case
particulars). It is offered right after upload, in the exhibit dialogs (police/court and lab), and
as an icon in each evidence-table row. The QR encodes `label.url`, so `PUBLIC_WEB_URL` must be an
address the scanning phone can reach (see *Configuration*).

### Reading and checking an exhibit

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/evidence?caseId=&limit=` | in scope | Scope-filtered list, newest first; each row carries `label` |
| GET | `/api/evidence/by-code/:code` | in scope | Locate by `EX-…` code, then decided as `/:id` |
| GET | `/api/evidence/:id` | in scope | Exhibit + `label` + `certificate` + `physicalCustody` (not counsel) + `aiAnalysis` (FSL only) |
| GET | `/api/evidence/:id/lifecycle` | in scope (READ on the exhibit) | `{ evidenceId, exhibitCode, lifecycle }` — every milestone with description, actor and proofs, authenticated variant (§11); `403` for anyone who may not read the exhibit |
| POST | `/api/evidence/:id/verify` | in scope | Four independent lights, below |
| POST | `/api/evidence/:id/stream-token` | in scope | Single-use, user-bound download token `{ token, expiresInSec }` |
| GET | `/api/evidence/:id/stream?token=` | in scope | Audited download of the decrypted bytes |

`POST /api/evidence/:id/verify` →

```jsonc
{
  "exhibitCode": "…",
  "fileIntegrity": "FILE_INTACT | FILE_MODIFIED | FILE_MISSING",
  "signatureValid": true,
  "chainIntegrity": "CHAIN_INTACT | CHAIN_BROKEN",
  "anchorIntegrity": "ANCHOR_MATCH | ANCHOR_LOCAL_ONLY | ANCHOR_MISMATCH | NOT_ANCHORED | ANCHOR_UNAVAILABLE",
  "expectedSha256": "…", "recomputedSha256": "…",
  "publishedRoot": "…", "computedRoot": "…", "anchorTxHash": "…", "anchorExplorerUrl": "…",
  "anchorSubmitted": true, "anchorBatchStatus": "CONFIRMED",
  "chainCheckedFrom": 120, "chainCheckedTo": 131, "entriesChecked": 12,
  "brokenAtSeq": null, "chainBreakReason": null,
  "verifiedAt": "…",
  "interpretation": "The stored file matches its recorded hash, the signature verifies, and the ledger chain is unbroken."
}
```

## 4 · AI analysis (FSL examiners only)

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/evidence/:id/ai-analysis/retry` | FSL | `202 { exhibitCode, aiAnalysis }`. Re-queues a **FAILED** analysis (or one stuck in `PROCESSING`); `409 AI_ANALYSIS_NOT_RETRYABLE` otherwise; `403 READ_ONLY_ROLE` for any non-FSL session |
| GET | `/api/evidence/queue/triage` | FSL | Completed analyses ordered by AI priority. Any other role receives `{ queue: [], disclaimer: null }` |

### How the analysis runs

```
upload → aiAnalysis PENDING → background queue → PROCESSING
       → decrypt stored bytes, re-check SHA-256 (a modified file is never sent)
       → ONE structured analysis request, schema-constrained (services/ai/geminiClient.js)
       → schema + coherence validation                       (services/ai/analysisSchema.js)
       → COMPLETED   — or FAILED / UNSUPPORTED with the reason; never an invented score
```

The upload never waits on, or fails because of, the analysis. PENDING analyses are resumed at boot.
**Each exhibit costs exactly one AI request** (plus bounded retries of that same request) — there
is no second, web-search-grounded call. Uploads and boot-time resumption share one queue that runs
`AI_ANALYSIS_CONCURRENCY` analyses at a time (default **1**, which keeps a free-tier key inside its
per-minute quota).

### Rate limits and retries (`services/ai/analysisService.js`)

Only retryable failures are retried (`AI_RATE_LIMITED`, `AI_UNAVAILABLE`, `AI_TIMEOUT`,
`AI_EMPTY_RESPONSE`, `AI_PARTIAL_RESPONSE`, `AI_INVALID_JSON`, `AI_RESPONSE_SCHEMA_INVALID`,
`AI_RESPONSE_INCOHERENT`), at most `GEMINI_MAX_RETRIES` times:

- **429 / `RESOURCE_EXHAUSTED`** — the wait the provider asked for is honoured: the `Retry-After`
  header (seconds or an HTTP date), else a `RetryInfo.retryDelay` (`"12s"`) in the error body, plus
  a small jitter (≤ 1 s) so concurrent waiters do not return in lockstep.
- **503** — its `Retry-After` header is honoured the same way.
- **No stated wait** — exponential backoff with equal jitter: step =
  `GEMINI_RETRY_BASE_MS × 2^attempt` (×4 for a rate limit), capped at 60 s; the wait is half the
  step plus a random half.
- **A stated wait over 120 s is not waited for.** The attempt stops and the exhibit is recorded
  `FAILED` with `error.retryable: true`, so the examiner can re-queue it later instead of the one
  analysis slot being held for minutes.

### What an FSL session receives (`aiAnalysisView`)

```jsonc
"aiAnalysis": {
  "status": "PENDING | PROCESSING | COMPLETED | FAILED | UNSUPPORTED",
  "requestedAt": "…", "startedAt": "…", "completedAt": "…", "attempts": 1,
  "deepfakeAssessment": "LIKELY_MANIPULATED | LIKELY_AUTHENTIC | INCONCLUSIVE",
  "deepfakeScore": 78,
  "analysisDescription": "…", "detectedIndicators": ["…"],
  "triagePriority": "CRITICAL | HIGH | MEDIUM | LOW", "priorityReason": "…",
  "fslReviewRecommended": true, "fslReviewReason": "…",
  "evidenceSummary": "…",
  "error": null,                 // { code: "AI_…", message, retryable, issues[], at } on failure
  "disclaimer": "Automated preliminary assessment generated by an AI model. …"
}
```

- **Provider-neutral.** Responses never contain `provider` or `model` (both are persisted for the
  record only), and stored text is passed through a neutraliser so older records do not name the
  provider either. Error codes are `AI_*`; codes stored by earlier versions as `GEMINI_*` are
  rewritten to `AI_*` on the way out.
- **Separate from the verdict.** The AI assessment is a preliminary queue-ordering aid. No AI
  output is written to the ledger or the chain, and the certificate does not depend on it.

Failure codes: `AI_NOT_CONFIGURED`, `AI_INVALID_API_KEY`, `AI_PERMISSION_DENIED`,
`AI_MODEL_NOT_FOUND`, `AI_INVALID_REQUEST`, `AI_PAYLOAD_TOO_LARGE`, `AI_RATE_LIMITED`,
`AI_UNAVAILABLE`, `AI_TIMEOUT`, `AI_RESPONSE_BLOCKED`, `AI_EMPTY_RESPONSE`, `AI_PARTIAL_RESPONSE`,
`AI_INVALID_JSON`, `AI_RESPONSE_SCHEMA_INVALID`, `AI_RESPONSE_INCOHERENT`, `AI_UNSUPPORTED_FORMAT`,
`AI_FILE_TOO_LARGE`, `AI_ANALYSIS_FAILED`,
plus the integrity codes `EVIDENCE_OBJECT_MISSING`, `EVIDENCE_UNREADABLE`,
`EVIDENCE_INTEGRITY_MISMATCH`.

## 5 · Section 63 certificate — automatic, one per exhibit

There is **no route to generate or sign a certificate**. Uploading evidence issues exactly one
certificate (template `v3.0`) and signs it with the system key, the **LEXX Certificate Authority**
(`backend/services/certificateIssuer.js`, `systemSigner.js`):

1. Part A is filled from the record: the uploading officer it is issued on behalf of, the optional
   device particulars (absent ones rendered as not recorded), the SHA-256, a manner-of-production
   account rendered mechanically from the ledger, and the conditions statement.
2. Part B is the ingest hash attestation — the browser and server SHA-256 values and whether they
   matched — attested by the LEXX Certificate Authority. **It carries no forensic opinion.**
3. The PDF is rendered and stored encrypted; the authority key signs the canonical hash of
   (certificate body, PDF SHA-256, key fingerprint) with ECDSA P-256 / SHA-256 (IEEE P1363).
4. `CERTIFICATE_GENERATED` is appended to the ledger with actor role `SYSTEM`. Only then is the
   certificate `ISSUED`.

One `ACTIVE` certificate per exhibit is enforced by the partial unique index
`one_active_certificate_per_evidence`; concurrent issuing converges on one certificate.

The key comes from `CERTIFICATE_SIGNING_KEY` (64 hex chars or a PKCS#8 PEM) or, when blank, is
derived deterministically from `MASTER_KEK` with HKDF-SHA256. Changing either changes the authority
key, and certificates signed under the old key then fail the signature check.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/certificates?evidenceId=` | anyone who may read the exhibit | `{ evidenceId, exhibitCode, active, certificates[], total }` — repairs a missing certificate on the way |
| GET | `/api/certificates/:id` | readers | `{ certificate }` (small view, below) |
| POST | `/api/certificates/:id/verify` | readers (police in scope, court, lab, counsel on record) | **One-click verification.** No body. `GET` on the same path is kept for older clients |
| GET | `/api/certificates/:id/pdf` | readers | The stored, signed PDF; audited download; header `X-Lexx-Pdf-Sha256`. `409 CERTIFICATE_DOCUMENT_UNAVAILABLE` if the stored document is missing or altered |
| GET | `/api/certificates/authority-key` | **public** | The authority's public key |
| GET | `/api/fsl/referrals/:id/certificates` | FSL, through a referral | Same shape as the list |
| GET | `/public/verify/:token[?copy=<sha256>]` | **public**, rate-limited | Same `result` and `checks`, plus the public evidence view (below) |
| GET | `/public/evidence/:labelToken` | **public**, rate-limited | What a scanned QR label opens — the same public evidence view (below) |
| GET | `/public/certificate-authority-key` | **public** | Same as `/api/certificates/authority-key` |

Certificate view:

```jsonc
{
  "certificateId": "…", "evidenceId": "…", "exhibitCode": "EX-0123-001",
  "status": "ACTIVE | SUPERSEDED", "issuedAt": "…", "templateVersion": "v3.0",
  "issuedOnBehalfOf": { "name": "…", "authorityId": "…", "role": "IO" },
  "signedBy": "LEXX Certificate Authority",
  "verificationToken": "…", "verificationUrl": "…", "pdfUrl": "/api/certificates/…/pdf",
  "lastVerification": { "result": "VERIFIED", "at": "…", "byRole": "COURT" }
}
```

`POST /api/certificates/:id/verify` →

```jsonc
{
  "certificateId": "…", "exhibitCode": "EX-0123-001",
  "result": "VERIFIED",            // or "FAILED" if any check fails
  "verifiedAt": "…",
  "checks": [
    { "key": "documentUnchanged",     "label": "Certificate document is unchanged",                      "ok": true, "detail": "SHA-256 … matches the recorded fingerprint." },
    { "key": "systemSignatureValid",  "label": "Certificate is signed by the LEXX Certificate Authority", "ok": true, "detail": "…" },
    { "key": "evidenceFileUnchanged", "label": "Evidence file is unchanged since it was uploaded",       "ok": true, "detail": "Re-computed SHA-256 … matches the certificate." },
    { "key": "activeCertificate",     "label": "This is the current certificate for this evidence",      "ok": true, "detail": "…" },
    { "key": "ledgerRecordIntact",    "label": "Ledger record of issue is intact",                       "ok": true, "detail": "Ledger entry 57 verifies and links to entry 56." }
  ]
}
```

Everything is recomputed server-side from what is stored; nobody uploads a file, hash or proof. The
result is written to the ledger as `CERTIFICATE_VERIFIED` (with the actor) and stored as
`lastVerification`. **Verification never consults the forensic verdict** — a `MANIPULATED` finding
does not change it. Check details never name a person.

### Public verification — certificate token and QR label

Two unauthenticated routes (`backend/routes/certificate.js`, mounted at `/public` in `app.js`) answer
with **one builder**, `backend/services/publicEvidenceView.js`, so a scanned label and a certificate
link show the same page (`/verify?label=…` or `/verify?token=…` on the web client):

| | `GET /public/evidence/:labelToken` | `GET /public/verify/:token` |
|---|---|---|
| Found by | the exhibit's permanent `labelToken` | a certificate's `verificationToken` |
| Certificate verified | the exhibit's **ACTIVE** certificate | **that** certificate — a superseded token still answers `FAILED` on `activeCertificate` |
| No certificate | `result: "NO_CERTIFICATE"`, `checks: []`, `certificate: null` — **never issues one** | n/a |
| Extra | — | `copy` when `?copy=<sha256>` is sent |
| Unknown / malformed token | `404 { valid: false, reason: "LABEL_NOT_FOUND", error: { code: "LABEL_NOT_FOUND", … } }` | `404 { valid: false, reason: "CERTIFICATE_NOT_FOUND" }` |

Both recompute every check from what is stored and **record nothing** — no ledger entry, no
`lastVerification` update (only the authenticated `POST /api/certificates/:id/verify` records).
Both send `Cache-Control: no-store` and share a per-IP limit of `RATE_LIMIT_LOOKUP` requests per
15 minutes (default 60; `429 RATE_LIMITED`), because each call re-hashes the stored evidence file.
The limit is skipped under tests and for loopback requests while `NODE_ENV` is not `production`
(`backend/middleware/rateLimit.js`); that exemption is hard-refused in production.

`GET /public/evidence/:labelToken` →

```jsonc
{
  "result": "VERIFIED",                       // VERIFIED | FAILED | NO_CERTIFICATE
  "checks": [ … the five checks above … ],
  "verifiedAt": "2026-09-13T10:02:11.000Z",
  "evidence": {
    "exhibitCode": "EX-0124-001",
    "title": "CCTV still, gate 2",            // null when the case is sensitive …
    "titleWithheld": false,                   // … and then true
    "fileType": "image/jpeg", "sizeBytes": 20480,
    "sha256": "…", "hashAlgorithm": "SHA-256",
    "registeredAt": "…", "capturedAt": null,
    "source": { "sourceType": "DVR", "make": "…", "model": "…" },   // null if none; never serial/IMEI/MAC
    "labelUrl": "<PUBLIC_WEB_URL>/verify?label=…"
  },
  "uploadedBy": {
    "name": "…", "role": "IO", "roleLabel": "Investigating Officer",
    "authorityId": "…", "unit": "…"           // the case's stationName when it is the officer's station, else their station/lab/court code
  },
  "case": {
    "firNumber": "0124/2026", "cnrNumber": "UPLK01-…", "stationCode": "…", "stationName": "…",
    "courtName": "…", "stage": "CHARGESHEET_FILED", "stageLabel": "Chargesheet filed"
  },
  "certificate": {                            // null for NO_CERTIFICATE
    "certificateId": "…", "templateVersion": "v3.0", "status": "ACTIVE",
    "statute": "Bharatiya Sakshya Adhiniyam, 2023 — section 63", "issuedAt": "…",
    "exhibitCode": "EX-0124-001", "cnrNumber": "…", "firNumber": "0124/2026",
    "evidenceHash": "…", "hashAlgorithm": "SHA-256", "pdfSha256": "…",
    "pdfIntegrity": "PDF_INTACT | PDF_MODIFIED | PDF_MISSING",
    "signedBy": "LEXX Certificate Authority", "authorityKeyFingerprint": "…",
    "verificationUrl": "<PUBLIC_WEB_URL>/verify?token=…",
    "lastVerification": { "result": "VERIFIED", "at": "…", "byRole": "COURT" }   // or null
  },
  "forensic": { "status": "EXAMINED", "examinedAt": "…", "labName": "…" },      // or NOT_EXAMINED, examinedAt null
  "lifecycle": [        // abbreviated: every entry also carries description, actor and proofs (public variant, §11)
    { "key": "UPLOADED",             "label": "Evidence uploaded",             "state": "done",           "at": "…" },
    { "key": "CERTIFICATE_ISSUED",   "label": "Section 63 certificate issued", "state": "done",           "at": "…" },
    { "key": "FORENSIC_EXAMINATION", "label": "Forensic examination",          "state": "done",           "at": "…" },
    { "key": "CHARGESHEET_FILED",    "label": "Chargesheet filed",             "state": "done",           "at": "…" },
    { "key": "COGNIZANCE_TAKEN",     "label": "Cognizance taken",              "state": "current",        "at": null },
    { "key": "COMMITTED",            "label": "Committed for trial",           "state": "not_applicable", "at": null },
    { "key": "TRIAL",                "label": "Trial",                         "state": "upcoming",       "at": null },
    { "key": "CLOSED",               "label": "Case closed",                   "state": "upcoming",       "at": null }
  ],
  "disclosure": "This verifier reports the integrity and progress of an evidence record: …",
  "valid": true,
  "issuer": "LEXX"
}
```

`GET /public/verify/:token` returns the same object plus `copy` (`{ sha256, match: CURRENT |
EARLIER_VERSION | NO_MATCH, supersededAt }`, only when a well-formed `?copy=` digest is sent; `null`
otherwise). In the rare case the certificate's exhibit record cannot be loaded, `evidence`,
`uploadedBy`, `case` and `forensic` are `null` and `lifecycle` is `[]`.

**Lifecycle rules** (`lifecycleFor`):

- Milestones, in order: `UPLOADED` (always done) · `CERTIFICATE_ISSUED` (done when the exhibit's
  ACTIVE certificate is issued — for a system certificate, signed *and* recorded in the ledger) ·
  `FORENSIC_EXAMINATION` (done when an opinion is recorded or the report is filed) ·
  `CHARGESHEET_FILED` · `COGNIZANCE_TAKEN` · `COMMITTED` · `TRIAL` · `CLOSED` (done by stage rank;
  further investigation ranks with investigation, `DISPOSED` with `CLOSED`).
- `COMMITTED` is `not_applicable` when the offence does not require committal.
- Exactly one milestone is `current`: the first applicable, not-done milestone **after the last done
  one**. An earlier gap stays `upcoming` — e.g. a forensic examination never reported is `upcoming`,
  not `current`, once the chargesheet is filed.
- Once the case is `CLOSED` / `DISPOSED`, nothing is current and every milestone that never happened
  is `not_applicable`.
- `at` is given only for `done` milestones (upload time, issue time, `reportedAt`, and the case's
  `chargesheetFiledOn` / `cognizanceTakenOn` / `committedOn` / `trialStartedOn` / `closedOn`).
- Each milestone then gets its `description`, `actor` and `proofs` from `lifecycleDetails.js` (§11).
  The public variant names no forensic examiner and carries no court note, opinion or AI data.

**Title withheld** when the case is victim-protected or its `sensitivityClass` is not `ORDINARY`
(e.g. POCSO).

**Never exposed publicly:** the description; device serial number, IMEI/UID or MAC address; victim,
accused, witness or party names; the AI analysis in any form; the forensic opinion or examination
summary; ledger internals, storage keys or encryption data. The builder lists every field
explicitly rather than spreading a document.

`GET /api/certificates/authority-key` →

```jsonc
{ "issuer": "LEXX Certificate Authority", "algorithm": "ECDSA-P256-SHA256 (IEEE P1363)",
  "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "fingerprint": "…", "signedMessage": "The UTF-8 hex string of the certificate body canonical SHA-256 hash (certificateHash)." }
```

States on an exhibit card: `ISSUED`, `PENDING_ISSUE` (briefly, or until a failed issue is
repaired), `SUPERSEDED`. At boot, every exhibit without an issued `v3.0` certificate gets one; a
legacy `v1.0`/`v2.0` certificate is marked `SUPERSEDED` (`REPLACED_BY_SYSTEM_CERTIFICATE`), linked to
its replacement and recorded as `CERTIFICATE_SUPERSEDED` — never deleted.

## 6 · Forensic laboratory

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/fsl/cases?state=ALL\|PENDING\|REVIEWED` | FSL | Work **grouped by case**; groups and exhibits ordered by AI priority. Default `ALL` |
| GET | `/api/fsl/queue?state=PENDING\|REVIEWED\|ALL` | FSL | Flat queue ordered by AI priority, with `counts { pending, reviewed, byPriority }`. Default `PENDING` |
| POST | `/api/evidence/:id/forensic-verdict` | FSL (evidence in the lab's scope) | The one-step verdict, below |
| POST | `/api/evidence/:id/refer-fsl` | SHO | Optional: a named question to a named lab `{ labCode, discipline, questionsPosed }` |
| GET | `/api/fsl/referrals` | FSL | Referrals to this lab |
| POST | `/api/fsl/referrals/:id/accept` | FSL | Take a referral on |
| POST | `/api/fsl/referrals/:id/report` | FSL | multipart: `report` PDF + `opinion`, `examinationSummary`, `reportSha256`, `reportSignature` |

A lab's evidence scope is: exhibits referred to it, plus the digital evidence registered in the
state it serves. Both queues return an empty result to any non-FSL session.

`POST /api/evidence/:id/forensic-verdict` — multipart: `opinion` (`AUTHENTIC | MANIPULATED |
INCONCLUSIVE`), `examinationSummary`, `verdictSha256`, `verdictSignature`, optional `report` PDF.
The browser signs `SHA-256("LEXX-FSL-VERDICT|v1|<exhibitCode>|<opinion>|<summary>|<reportSha256 or ->")`;
the server recomputes it and verifies the examiner's key. Recorded **once**
(`409 VERDICT_ALREADY_RECORDED`); fails closed if the audit writer is unhealthy. `201` →

```jsonc
{
  "forensic": { "opinion": "MANIPULATED", "examinationSummary": "…", "labId": "UP-FSL-LKO", "labName": "…",
                "section79ARef": "…", "examinerName": "…", "reportSha256": null, "reportedAt": "…",
                "basis": "DIRECT_REVIEW" },
  "ledgerSeq": 88, "entryHash": "…",
  "basisNote": "Recorded as a signed forensic opinion without a separate report document. It is independent of automated triage."
}
```

The verdict is the official forensic conclusion, visible to police, court and counsel. It is not
written into the certificate, and the certificate's verification does not depend on it.

## 7 · Chargesheet and the Court

| Method | Path | Role | Transition |
|---|---|---|---|
| POST | `/api/cases/:id/file-chargesheet` | IO, SHO | `UNDER_INVESTIGATION / FURTHER_INVESTIGATION → CHARGESHEET_FILED`; registers with the court the router selects, allots the CNR |
| POST | `/api/cases/:id/transition` `{ action: "TAKE_COGNIZANCE", note? }` | COURT | `CHARGESHEET_FILED → COGNIZANCE_TAKEN` |
| … | `COMMIT_FOR_TRIAL` | COURT | `COGNIZANCE_TAKEN → COMMITTED` — Sessions/Special-court cases only |
| … | `BEGIN_TRIAL` | COURT | `COMMITTED → TRIAL`, or `COGNIZANCE_TAKEN → TRIAL` when no committal applies |
| … | `DIRECT_FURTHER_INVESTIGATION` (note required) | COURT | `COGNIZANCE_TAKEN → FURTHER_INVESTIGATION` (police file re-opens) |
| … | `CLOSE_CASE` (note required; optionally a signed PDF, below) · or POST `/api/cases/:id/close { reason }` | COURT | `COGNIZANCE_TAKEN / COMMITTED / TRIAL → CLOSED` |
| GET | `/api/cases/:id/closure-document` | READ on the case | The signed closing document, below |
| POST | `/api/cases/:id/record-order` | COURT | `{ orderType, text, effectiveOn }` — a judicial order in the ledger; changes no stage |

Every transition is validated by `services/caseWorkflow.js` (`409` with the reason when invalid, or
`400 NOTE_REQUIRED`), authorised as `ORDER` (court only), guarded against concurrent updates
(`409 CONCURRENT_UPDATE`), written to the ledger with `action`, `from`, `to`, `note` (`reason` for a
closing), `orderedByAuthorityId`, and returned as `{ case, workflow, ledgerSeq, entryHash, note }` —
`case` carries the `closure` view and `workflow.lifecycle` is described (§11). A second closing is
refused with `403`. `transition` and `close` fail closed if the audit writer is unhealthy. No route
sets a stage directly.

### Closing with a signed document

`CLOSE_CASE` on `POST /api/cases/:id/transition`, and `POST /api/cases/:id/close`, accept either JSON
(as before) or `multipart/form-data`. Multipart is parsed in memory and **only after `ORDER` is
established**, so nobody without it has bytes buffered (`closureDocumentUpload`; one file, ≤ 12
fields of ≤ 8 KiB). Blank form fields count as absent. Without a `document` the case closes exactly
as before.

| Field | Required | Notes |
|---|---|---|
| `action` | `/transition` only | `CLOSE_CASE` |
| `note` (`/transition`) · `reason` (`/close`) | yes | ≤ 2000 chars (`reason` ≥ 3) — the reason for closing |
| `document` | no | The PDF, **≤ 20 MB** |
| `documentKind` | with a document | `FINAL_JUDGMENT` · `DECLARATION` · `ORDER` |
| `documentSha256` | with a document | SHA-256 of the file as 64 hex chars, computed in the judge's browser |
| `documentSignature` | with a document | ECDSA P-256 / SHA-256 in IEEE P1363 form (r‖s, 64 bytes) over the UTF-8 string of `documentSha256` **exactly as sent** (send and sign lowercase hex), made by the judge's registered device key; sent as 128 hex chars or base64 / base64url |

Checks, in order. The first failure answers, and **a refusal writes nothing** — no stage change, no
closure, no ledger entry, nothing in the vault:

| # | Check | Refusal |
|---|---|---|
| 1 | Upload parser: file over 20 MB · other malformed multipart | `413 CLOSURE_DOCUMENT_TOO_LARGE` · `400 VALIDATION_FAILED` |
| 2 | Body schema: `action`, `note` / `reason`, a `documentKind` outside the enum, a `documentSha256` that is not 64 hex chars, a `documentSignature` over 256 chars | `400 VALIDATION_FAILED` |
| 3 | Court session; act valid at this stage; note present | `403 READ_ONLY_ROLE` · `409` with the reason · `400 NOTE_REQUIRED` |
| 4 | A document attached to any act but closing | `400 VALIDATION_FAILED` (`fields: ["document"]`) |
| 5 | A hash or signature sent with no document | `400 CLOSURE_DOCUMENT_MISSING` |
| 6 | `documentKind` present | `400 CLOSURE_DOCUMENT_KIND_REQUIRED` (with `allowed`) |
| 7 | Size again, after parsing | `413 CLOSURE_DOCUMENT_TOO_LARGE` |
| 8 | The bytes are a PDF (sniffed, not the declared type) | `400 CLOSURE_DOCUMENT_NOT_PDF` (with `detected`) |
| 9 | Both `documentSha256` and `documentSignature` present | `400 VALIDATION_FAILED` (listing the missing field) |
| 10 | Server-computed SHA-256 equals `documentSha256` | `400 HASH_MISMATCH` (with `declared`, `computed`) |
| 11 | The judge has a registered device key | `400 NO_REGISTERED_KEY` |
| 12 | The signature verifies against that key | `400 SIGNATURE_INVALID` — and a `DENY` audit row with reason `SIGNATURE_INVALID` |

On success the PDF is **sealed (envelope-encrypted) in the vault** under the case
(`services/sealedDocument.js`), and the case stores `closure`: kind, note, `signedBy` (user, name,
authority id, role), `uploadedAt`, a sanitised file name, MIME type, size, the server SHA-256, the
signature (hex), the signer key fingerprint, the signer's public JWK (pinned, so the signature stays
checkable after a key rotation) and the vault key (`select: false`, never served). The ledger entry
is `CASE_CLOSED`; with a document it also carries the judge's signature as `actorSignature` and
`actorPubKeyFingerprint`:

```jsonc
// CASE_CLOSED payload
{
  "action": "CLOSE_CASE", "from": "TRIAL", "to": "CLOSED", "reason": "…",
  "cnrNumber": "…", "courtId": "…", "orderedByAuthorityId": "UP-JUD-1180", "closedByAuthorityId": "UP-JUD-1180",
  "closureDocument": { "kind": "FINAL_JUDGMENT", "sha256": "…", "signerKeyFingerprint": "…" }   // null when closed without a document
}
```

The **closure view** (`closureView` in `services/lifecycleDetails.js`) is what every response carries —
on each case object, top-level on `GET /api/cases/:id/workflow`, and in counsel's case file:

```jsonc
"closure": {
  "kind": "FINAL_JUDGMENT", "kindLabel": "Final judgment",        // DECLARATION → "Declaration", ORDER → "Closing order"
  "fileName": "judgment 0124.pdf", "sizeBytes": 48213, "sha256": "…",
  "signedBy": { "name": "…", "roleLabel": "Court", "authorityId": "UP-JUD-1180" },
  "signerKeyFingerprint": "…", "uploadedAt": "…", "note": "…",
  "hasDocument": true
}
```

Closed **without** a document, the view is still present: `signedBy`, `uploadedAt` and `note` are set;
`kind`, `kindLabel`, `fileName`, `sizeBytes`, `sha256` and `signerKeyFingerprint` are `null`; and
`hasDocument` is `false`. It never contains the vault key, the signature bytes or the pinned key.

`GET /api/cases/:id/closure-document` — READ on the case (the court, police on the case, counsel on
record; an advocate not on record gets `403 NOT_ON_RECORD_FOR_THIS_CASE`). The document is decrypted
and re-hashed before it is sent:

| Outcome | Response |
|---|---|
| Intact | `200 application/pdf`, `Content-Disposition: inline; filename="…"`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, **`X-Lexx-Sha256: <sha256>`**; a `DOWNLOAD` audit row with reason `CLOSURE_DOCUMENT_DOWNLOAD` |
| No document was attached (or the case is not closed) | `404 NO_CLOSURE_DOCUMENT` |
| The sealed object is missing from the vault | `404 OBJECT_NOT_FOUND` |
| Stored bytes no longer match the recorded hash | `409 CLOSURE_DOCUMENT_ALTERED` |

In the client the court's close dialog hashes and signs the PDF in the browser
(`api.cases.transitionWithDocument`), and every case view shows a *Case closed* block
(`CaseClosure` in `frontend/src/components/common/CaseRecord.jsx`): when and by whom, the note, the
document's name and size, its SHA-256 and signer key (copyable), and *Open document*.

## 8 · Counsel — automatic access once on record

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/vakalatnama` | advocate | multipart: `document` PDF + `cnrNumber`, `appearingFor` (`ACCUSED\|VICTIM`), `partyName`, `documentSha256`, `documentSignature`. `201`, status `PENDING`. **Grants nothing yet** |
| GET | `/api/vakalatnama/mine` | advocate | The caller's own filings and their status |
| GET | `/api/vakalatnama/case/:caseId` | COURT | Filings on the case and who is on record |
| GET | `/api/vakalatnama/:id/document` | the filing advocate, COURT | Audited download of the filed PDF |
| POST | `/api/vakalatnama/:id/accept` | COURT | Records the appearance in the court register, then creates the access grant. Fails closed if the audit writer is unhealthy |
| POST | `/api/vakalatnama/:id/reject` | COURT | `{ note }` (≥ 10 chars) |
| POST | `/api/disclosure/:caseId/sync-representation` | COURT | Mirror accepted vakalatnamas and legal-aid orders from the court directory into grants; withdrawn/closed ones are revoked |
| GET | `/api/disclosure/case-file/:caseId` | counsel on record (anyone who may read the case) | **Counsel's case file** |
| GET | `/api/disclosure/my-pack/:caseId` | same | Deprecated alias of `case-file`, same response |

`POST /api/vakalatnama/:id/accept` →

```jsonc
{
  "filing": { "id": "…", "status": "ACCEPTED", "cnrNumber": "…", "appearingFor": "ACCUSED", … },
  "grant": { "grantId": "…", "role": "DEFENCE_COUNSEL", "grantBasis": "VAKALATNAMA", "grantRef": "VAK/…" },
  "courtRegister": "RECORDED | ALREADY_ON_RECORD",
  "access": "CASE_AND_EXHIBITS_READ_ONLY",
  "ledgerSeq": 95, "entryHash": "…"
}
```

**Being on record is the whole test.** From the moment the grant exists — an accepted vakalatnama,
a legal-aid order, or a directory sync — counsel can read the case, every exhibit in it, and each
exhibit's certificate through the ordinary endpoints (`GET /api/cases/:id`, `/api/evidence/:id`,
`/api/evidence/:id/stream`, `/api/certificates…`, `POST /api/certificates/:id/verify`,
`POST /api/evidence/:id/verify`). There is no share, serve or acknowledge step, and no watermark.

Counsel remain read-only (`READ`, `VERIFY`, `DOWNLOAD`), case-scoped, and are never shown AI
analysis or physical custody. An advocate who is not on record is refused with
`NOT_ON_RECORD_FOR_THIS_CASE`, and the refusal is in the audit feed.

`GET /api/disclosure/case-file/:caseId` →

```jsonc
{
  "caseId": "…", "cnrNumber": "…", "firNumber": "0123/2026", "title": "…", "stage": "COGNIZANCE_TAKEN", "courtId": "…",
  "onRecord": [ { "role": "DEFENCE_COUNSEL", "grantBasis": "VAKALATNAMA", "grantRef": "VAK/…", "validFrom": "…" } ],
  "clocks": { "disclosureDueOn": null, "disclosureServedOn": "…" },   // display only; gates nothing
  "exhibitCount": 5,
  "exhibits": [
    { "evidenceId": "…", "exhibitCode": "EX-0123-001", "title": "…", "description": null, "kind": "DIGITAL",
      "mimeType": "image/jpeg", "sizeBytes": 20480, "sha256": "…", "hashAlgorithm": "SHA-256",
      "capturedAt": null, "courtStatus": "NOT_PRODUCED",
      "forensic": { "status": "REPORT_FILED", "opinion": "MANIPULATED", "labName": "…", "section79ARef": "…", "reportedAt": "…" },
      "certificateId": "…", "certificate": { … },
      "label": { "token": "…", "url": "<PUBLIC_WEB_URL>/verify?label=…" }, "createdAt": "…" }
  ]
}
```

## 9 · Physical custody (optional backend capability)

Not part of the user workflow or the UI. The backend still keeps a register of physical articles
(seal numbers, one-step ledgered movements `SEIZED → IN_STORE / AT_FSL / IN_COURT → RETURNED /
DESTROYED`, freeze on a broken seal, SHO lifts a freeze). Counsel cannot read it.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/custody/items` | IO, SHO — register an article `{ caseId, description, sealNumber, evidenceId?, … }` |
| GET | `/api/custody/items?caseId=` · `/api/custody/items/:id/chain` · `/api/custody/gaps` | Register, per-item history + gap analysis, chains with findings |
| GET | `/api/custody/scan/:qrToken` | Label → article; the label authorises nothing |
| POST | `/api/custody/items/:id/move` | `{ toStatus, reason, sealIntact, custodian? }` |
| POST | `/api/custody/items/:id/lift-freeze` | SHO — `{ note, newSealNumber? }` |

## 10 · Integrity, audit, search, health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/ledger/case/:id` | Ledger for a case in scope |
| GET | `/api/ledger/verify-chain` | Recomputes the hash chain |
| GET | `/api/ledger/entry/:seq/anchor-proof` | Merkle proof for one entry |
| GET | `/api/anchors/latest` · `/api/anchors/recent` | **Public**: batch, Merkle root, network, transaction |
| GET | `/api/anchors/entry/:seq/:entryHash` | **Public**: an upload receipt checked against the anchored root |
| GET | `/api/audit` · `/api/audit/security` | SHO, DISTRICT_SP, COURT |
| GET | `/api/search` | Scope-filtered search (AI fields only for FSL) |
| GET | `/api/events/stream` | Any signed-in session — the live change feed (§12) |
| GET | `/healthz` · `/readyz` | Liveness; readiness incl. directories, anchor scheduler, audit writer |

## 11 · Lifecycle descriptions and proofs

Every lifecycle the API returns — an exhibit's or a case's — explains each milestone: what happened,
who did it, and the material a reader needs to check it. **One builder**,
`backend/services/lifecycleDetails.js`, serves every surface, and it reads only the record: the
hash-chained ledger (`CASE_CREATED`, `CASE_STAGE_CHANGED`, `CASE_CLOSED` for the case;
`EVIDENCE_UPLOADED`, `CERTIFICATE_GENERATED`, `FSL_REPORT_FILED` for the exhibit and its certificate),
the users named in it (plus the uploader, examiner and closing judge), and the anchor batches. That
is three queries per call; the ledger read is capped at 1000 entries.

Entry shape:

```jsonc
{
  "key": "COGNIZANCE_TAKEN", "label": "Cognizance taken",
  "state": "done | current | upcoming | not_applicable",
  "at": "…",                                                    // null unless done
  "description": "…",                                           // always present
  "actor": { "name": "…", "roleLabel": "Court", "authorityId": "…" },   // null when not reached
  "proofs": [ { "label": "…", "value": "…", "kind": "hash | key | ledger | anchor | text", "href": "…" } ]   // href optional
}
```

Case-strip entries (`workflow.lifecycle`) keep `stage`, `label` and `state` exactly as `workflowFor`
produced them and add `key` (= `stage`), `at`, `description`, `actor` and `proofs`.

| Proof kind | Examples |
|---|---|
| `hash` | `Evidence SHA-256` · `Certificate PDF SHA-256` · `Report SHA-256` · `Final judgment SHA-256` (the closing document, labelled by kind) |
| `key` | `Uploader key fingerprint` · `Authority key fingerprint` · `Examiner key fingerprint` · `Signer key fingerprint` |
| `ledger` | `Ledger entry #<seq>` → that entry's `entryHash` |
| `anchor` | `Awaiting anchoring` · `Queued in batch <id>` · `Recorded locally (dry run) in batch <id>` · `Submitted in batch <id> — tx <hash> (awaiting confirmation)` · `Anchored in batch <id> — tx <hash>` · `Anchoring of batch <id> failed; it will be retried`. Submitted and anchored proofs carry `href` = `<ANCHOR_EXPLORER_BASE>/tx/<hash>` |
| `text` | `Last verification` (`VERIFIED on <time> by Court`) · `Basis` (authenticated only) |

What each milestone says when it has happened:

| Milestone | Description (abridged) | Proofs |
|---|---|---|
| Case opened (`UNDER_INVESTIGATION`) | "Case opened from FIR … of <station> by <officer>." plus each *further investigation directed by <judge>* | ledger + anchor for each |
| `UPLOADED` | "Uploaded by <name> (<role>, <authority id>). The file's SHA-256 was computed in the officer's browser, matched by the server, and signed…" | evidence hash, uploader key, ledger, anchor |
| `CERTIFICATE_ISSUED` | "Issued and signed automatically by the LEXX Certificate Authority on behalf of <officer>." | PDF hash, authority key, ledger, anchor, last verification |
| `FORENSIC_EXAMINATION` | see the variants below | report hash (if a report), examiner key, ledger, anchor, basis |
| `CHARGESHEET_FILED` | "Filed by <officer> before <court>; CNR … allotted." | ledger, anchor |
| `COGNIZANCE_TAKEN` · `COMMITTED` · `TRIAL` | "Recorded by <judge> (Court)." + the court's note | ledger, anchor |
| `CLOSED` | "Closed by <judge>." + "<Kind> attached (signed with the judge's device key)." + the reason | document hash and signer key (if a document), ledger, anchor |

A milestone not reached says what it is waiting for ("Awaiting the court's cognizance of the
offence."), and a `not_applicable` one says why ("Not applicable — this case is triable by a
Magistrate, so no committal is required."); both have `actor: null` and `proofs: []`.

| | Public variant | Authenticated variant |
|---|---|---|
| Court notes: cognizance / committal / trial notes, further-investigation note, closing reason | **no** | yes |
| Forensic examiner | **not named**: actor `{ name: null, roleLabel: "Forensic Examiner", authorityId: null }`, "Examined at <lab> by a forensic examiner." | named: "Examined at <lab> by <name>. Verdict recorded[ with a signed report document]." plus a `Basis` proof |
| Forensic opinion, AI analysis, exhibit description | never | never |
| Uploader and judge names and authority ids; hashes, key fingerprints, ledger entries, anchoring | yes | yes |

Where each variant is served:

| Endpoint | Field | Variant |
|---|---|---|
| `GET /public/evidence/:labelToken` · `GET /public/verify/:token` | `lifecycle` | public |
| `GET /api/evidence/:id/lifecycle` (**new**) | `lifecycle` | authenticated |
| `GET /api/cases/:id` (and `/by-cnr/:cnr`) · `/:id/workflow` · `/:id/overview` · `POST /:id/transition` · `/:id/close` · `/:id/file-chargesheet` | `workflow.lifecycle` | authenticated |

The case list's `summary.workflow` carries no lifecycle.

Authenticated — `CLOSED`, from `GET /api/evidence/:id/lifecycle`:

```jsonc
{
  "key": "CLOSED", "label": "Case closed", "state": "done", "at": "2026-09-12T11:40:03.000Z",
  "description": "Closed by <judge>. Final judgment attached (signed with the judge’s device key). Reason recorded: “<the closing reason>”.",
  "actor": { "name": "<judge>", "roleLabel": "Court", "authorityId": "UP-JUD-1180" },
  "proofs": [
    { "label": "Final judgment SHA-256", "value": "…", "kind": "hash" },
    { "label": "Signer key fingerprint", "value": "…", "kind": "key" },
    { "label": "Ledger entry #131", "value": "…", "kind": "ledger" },
    { "label": "Anchoring", "value": "Recorded locally (dry run) in batch 0x…", "kind": "anchor" }
  ]
}
```

Public — `FORENSIC_EXAMINATION`, from `GET /public/evidence/:labelToken`:

```jsonc
{
  "key": "FORENSIC_EXAMINATION", "label": "Forensic examination", "state": "done", "at": "2026-09-10T08:12:44.000Z",
  "description": "Examined at <laboratory> by a forensic examiner.",
  "actor": { "name": null, "roleLabel": "Forensic Examiner", "authorityId": null },
  "proofs": [
    { "label": "Examiner key fingerprint", "value": "…", "kind": "key" },
    { "label": "Ledger entry #88", "value": "…", "kind": "ledger" },
    { "label": "Anchoring", "value": "Anchored in batch 0x… — tx 0x…", "kind": "anchor",
      "href": "https://testnet.monadexplorer.com/tx/0x…" }
  ]
}
```

In the client, `LifecycleTimeline` (`frontend/src/components/common/LifecycleTimeline.jsx`) renders
any of these as a vertical timeline: a marker per state, the description, the actor line, and a
*Show proof* toggle per entry. Hashes, keys, ledger and anchor values can be copied, `href` opens in a
new tab (http/https only), and `not_applicable` entries without a description are hidden. Case views
show the strip as a collapsed *Case timeline* (`CaseTimeline` in `CaseRecord.jsx`).

## 12 · Live updates

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/events/stream` | any signed-in session (`Authorization: Bearer <access token>`) | `text/event-stream`; `401` without a valid session; `503 REALTIME_UNAVAILABLE` when the server is at its stream cap |

Pages stay current without a reload. The stream names **what** changed, never the change: the page
then refetches through the ordinary authorised routes, so the feed is never a second, weaker read
path (`backend/services/realtime.js`, mounted in `app.js`; `backend/routes/events.js`). The token goes
in the header, never in a URL, which is why the client reads the stream with `fetch` rather than
`EventSource`.

```
retry: 3000

event: ready
data: {"at":"2026-09-13T10:02:11.000Z"}

: ping

event: change
data: {"type":"EVIDENCE_UPLOADED","caseId":"66e2…","evidenceId":"66e3…","at":"2026-09-13T10:02:11.150Z"}
```

- Response headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache,
  no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- `retry: 3000` first, then `event: ready`, then a `: ping` comment every **25 s**.
- A `change` frame is **ids only**: `{ type, caseId, evidenceId, at }`. `caseId` / `evidenceId` are
  `null` when there is none, or when the value is not a plain id. There are no titles, names,
  payloads or AI output.

**Event types.** Every ledger event type, emitted after each successful append once the ledger lock
is released (`evidenceId` is the subject for an exhibit entry, else `payload.evidenceId`). Plus three
events with no ledger entry (`REALTIME_EVENT` in `backend/models/enums.js`):

| Type | Emitted when |
|---|---|
| `AI_ANALYSIS_UPDATED` | An exhibit's analysis moves to `PROCESSING`, `COMPLETED`, `FAILED` or `UNSUPPORTED` (`services/ai/analysisService.js`) |
| `CASE_ACCESS_CHANGED` | `POST /api/disclosure/:caseId/sync-representation` granted or revoked at least one grant |
| `RECORD_UPDATED` | A user-visible record changed outside the ledger: `compute-jurisdiction` stores its result; anchoring stamps ledger entries with their batch (**one event per case** whose entries were stamped) |

**Audience.** For each open stream, in arrival order:

1. **An event with a case** goes to users the access resolver allows to **READ that case**
   (`accessResolver.resolve`, which loads the case itself). The decision is cached per connection,
   per case, for **30 s**. It is dropped first when the event can change access: `CASE_CREATED`,
   `CASE_STAGE_CHANGED`, `CASE_CLOSED`, `REFERRED_TO_FSL`, `FSL_EXAMINATION_STARTED`,
   `FSL_REPORT_FILED`, `JUDICIAL_ORDER`, `REPRESENTATION_SYNCED`, `VAKALATNAMA_ACCEPTED`,
   `VAKALATNAMA_REJECTED`, `CASE_ACCESS_CHANGED`. So counsel accepted onto a case hear of the very next
   events.
2. **A vakalatnama event** also reaches the filing advocate, who cannot yet read the case but may
   read their own filing, so they hear about its ruling.
3. **`AI_ANALYSIS_UPDATED`** goes only to **FSL** sessions that may read the case.
4. **An event with no case** goes only to the actor's own streams, and is dropped when there is no
   actor.

The session is also re-read from the database every 30 s. A suspended user, or one whose role or
authority changed, has the stream closed; a changed scope clears the cache. An error while deciding
counts as a refusal. These resolver calls are not written to the audit trail, because they only
decide whether an id may be *mentioned*; the read that follows is audited as usual.

**Timing and bounds.**

- Each change is held **~150 ms** before delivery, because several write paths finish their record
  just after the ledger append (an exhibit's `ledgerSeq`, a certificate's `lastVerification`, a
  filing's `grantId`).
- Caps: **2000 streams** in total (the next request gets `503`) and **8 per user** (a ninth closes that
  user's oldest). A stream is also closed at 500 unevaluated events or 512 KiB the socket has not
  taken; the client reconnects and refetches, which is always correct.
- **A stream closes when the access token that opened it expires.** The client reconnects with a
  refreshed token. Streams also end on `SIGINT` / `SIGTERM`.
- Emitting never throws and never waits, so a ledger append succeeds whether or not anyone is
  listening. Nothing mounted before the route buffers the response; a compression middleware added
  later must skip `text/event-stream`.

**Client.**

- `frontend/src/lib/realtime.js` — reads the stream with `fetch` and an incremental SSE parser.
  - A `401` triggers one silent refresh, then a reconnect; a session that has ended stops the stream.
  - Any other failure backs off 1 s → 30 s with jitter. After a live connection it uses the server's
    `retry` of 3 s.
  - 75 s with no bytes counts as a dead connection.
  - Coming back online or back to the tab wakes a pending retry. The stream stays open in a hidden tab.
- `frontend/src/hooks/useRealtime.js` — `useRealtimeSync`, mounted once in `AppLayout` for a signed-in
  user.
  - **Debounced query invalidation:** frames are coalesced (250 ms debounce, at most 1 s) and each
    event-type family invalidates the TanStack Query families it can change, narrowed to the `caseId`
    / `evidenceId` where the query key allows. Session, anchor and health queries, and verification
    results, are never refetched by a change.
  - After a reconnect every active query refetches, because frames may have been missed.
  - **Polling fallback:** while the stream has been down for more than 20 s, the case, evidence and
    lab views on screen refetch every **20 s** (visible tab only).
- **Live dot** — `LiveIndicator` in the header: a green pulsing dot reading "Live"; muted
  "Connecting…" / "Reconnecting…" (changes still refresh periodically).
- **Public verify page** (`/verify`, no session and no stream) — re-runs the shown check every
  **60 s** while the tab is visible, and on returning to the tab after 60 s. Each re-check is a
  request against the `RATE_LIMIT_LOOKUP` budget (one open tab ≈ 15 per 15 minutes).

---

## Removed endpoints

| Removed | Replaced by |
|---|---|
| `POST /api/certificates/generate` | Automatic issue on upload |
| `POST /api/certificates/:id/sign-part-a` · `POST /api/certificates/:id/sign-part-b` | System signature by the LEXX Certificate Authority |
| `POST /api/disclosure/:caseId/share` and the prepare / approve / serve / acknowledge / packs / trace routes | Automatic counsel access once on record; `GET /api/disclosure/case-file/:caseId` |
| Watermark tokens on served copies and stream tokens (and the trace-a-leaked-copy lookup) | Nothing — watermarks are gone |
| `POST /api/custody/items/:id/initiate-transfer` · `accept-transfer` · `recipients` | One-step `move` (earlier release) |

---

## Configuration

```
# AI analysis — required; the API refuses to start without the key and the model
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_TIMEOUT_MS=90000
GEMINI_MAX_RETRIES=2                 # retries of the ONE request per exhibit (0–5)
GEMINI_RETRY_BASE_MS=1500            # backoff base when no Retry-After is given
GEMINI_MAX_INLINE_BYTES=14000000     # larger exhibits are UNSUPPORTED, never guessed at
AI_ANALYSIS_CONCURRENCY=1            # analyses in flight at once (1–8); keep 1 on a free-tier key

# Section 63 certificate authority — optional; blank = derived from MASTER_KEK
CERTIFICATE_SIGNING_KEY=

# Public links — certificate QR (/verify?token=) and exhibit QR label (/verify?label=)
PUBLIC_WEB_URL=http://localhost:5173 # must be reachable from the scanning phone: use the
                                     # machine's LAN address or a tunnel, not localhost
RATE_LIMIT_LOOKUP=60                 # per IP per 15 min, shared by both /public verifiers

# Sessions
JWT_ACCESS_TTL_SEC=900               # 15-minute access token, renewed silently
REFRESH_TTL_SEC=0                    # 0 = sessions never expire on their own
                                     # (a live-update stream closes at access-token expiry and reconnects)

# Live updates — optional tuning, read straight from the environment by services/realtime.js
# (not validated in config/env.js and not listed in .env.example)
REALTIME_HEARTBEAT_MS=25000          # ": ping" interval (minimum 10)
REALTIME_EMIT_DELAY_MS=150           # hold before a change is delivered (0 = next tick; capped at 10000)
```

The stream caps (2000 in total, 8 per user), the 30 s access-decision cache and the `retry: 3000` hint
are constants in the code, not configuration.

The AI key is read in one place (`backend/services/ai/geminiClient.js`), sent as a header, and never
reaches the browser. Analysis sends the decrypted exhibit bytes to the configured AI service, one
request per exhibit — a data-processing relationship a real deployment must approve.

`PUBLIC_WEB_URL` is joined to the stored token each time a response is built (tokens are stored,
URLs are not), so changing it updates every `label.url` and `verificationUrl` the API returns. A
sticker already printed keeps the address it was printed with — one printed while the value was
`localhost` will not open on a phone and must be reprinted.
`npm run seed` warns when it is still localhost, and `node scripts/demo-lookup.js` lists every
exhibit's label link.

## Boot-time migrations

`backend/services/migrations.js` runs before indexes are built (also `npm run migrate`). Idempotent;
nothing is deleted.

1. Court roles → `COURT`.
2. Certificates: `status` backfilled; duplicate `ACTIVE` certificates resolved to one, the rest `SUPERSEDED`.
3. Evidence: the old heuristic `triage` removed; every exhibit without an analysis queued (`PENDING`);
   `aiOnlineSourceRemoved` — stored results of the retired second AI call (`aiAnalysis.onlineSource`) unset;
   `evidenceLabelTokensBackfilled` — every exhibit without a `labelToken` given one (written only
   where none exists, before the unique index is built).
4. Custody: retired handshake field removed, duplicate seal registrations flagged, location made consistent with status.
5. Cases filed with no court binding are reported.
6. Watermark fields removed from disclosure packs and stream tokens; the watermark index dropped (ledger entries untouched).
7. System certificates: every exhibit without an issued `v3.0` certificate gets one; legacy active certificates superseded.

## How this is verified

Backend suite — 24 test files, 604 tests, all passing (Vitest, real MongoDB, real directory
services, an AI-service HTTP stub in `backend/tests/fixtures/geminiStub.js`):

- `integration/case-closure.test.js` — closing with a signed PDF:
  - refusals that write nothing: not a PDF, no kind, hash mismatch, a foreign key's signature (audited),
    over 20 MB, a document on another act, police;
  - a base64 signature accepted, the closure view with no key material, the `closureDocument` digest in
    the ledger, the PDF sealed in the vault;
  - identical bytes and `X-Lexx-Sha256` for court, police and counsel, audited; an advocate not on record
    refused;
  - the closure on list, case, overview, workflow and counsel's case file;
  - described case-strip and exhibit lifecycles with ledger / anchor proofs;
  - the public lifecycle with no notes, verdict or examiner name.
- `integration/realtime.test.js` — the stream:
  - bearer auth, `retry` + `ready`, heartbeat, release on disconnect;
  - ids-only frames to the uploading IO and to nobody who may not read the case;
  - AI updates to the lab only, never the IO;
  - counsel receive a case's events the moment they are accepted;
  - case-less events only to their actor;
  - malformed input never throws, and ledger appends work with or without listeners.

- `integration/certificate.test.js` — one signed certificate per upload, no generate/sign routes,
  idempotent issue, VERIFIED/FAILED per tampered component, independence from the verdict, public
  verifier leaks no PII, authority key, legacy supersession.
- `integration/public-evidence.test.js` — the QR label issued at upload and present on overview,
  lab and counsel views; stable across certificate replacement; `VERIFIED` / `FAILED` /
  `NO_CERTIFICATE` (without issuing); `404 LABEL_NOT_FOUND`; title withheld for a sensitive case;
  nothing private disclosed; lifecycle with exactly one current milestone; the certificate verifier
  returning the same blocks.
- `integration/gemini-analysis.test.js` — analysis success, one request per exhibit, failure modes,
  Retry-After / backoff retry, configuration, and that only the examiner is shown it.
- `integration/disclosure.test.js`, `vakalatnama.test.js` — counsel access follows the grant.
- `integration/case-workflow.test.js` — FIR 0124/2026 end to end; `fsl.test.js`, `evidence.test.js`,
  `migrations.test.js`, `auth.test.js`, `custody.test.js`, `authz/matrix.test.js`,
  `redteam/attacks.test.js`.

`npm run seed` drives the same path over HTTP: upload → automatic certificates → FSL report →
chargesheet → vakalatnama accepted → counsel access → one-click certificate verification, and
prints the QR label links of the demo exhibits.
