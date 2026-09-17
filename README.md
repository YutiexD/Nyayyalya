# LEXX 2.0

**An AI-assisted, blockchain-backed digital evidence registry.**

Lexx holds no identities of its own. Officers exist in the police directory, judges and registry staff in the court directory, advocates and examiners in the legal/FSL directory. We verify against them and can create none of them.

Nothing is ever deleted. Status changes, and every change is signed by whoever ordered it.

Only the forensic laboratory decides authenticity. The AI analysis — shown to the laboratory alone — decides what it looks at first.

---

## What this is

| | |
|---|---|
| **Stack** | Node 20+ · Express · MongoDB · Vite (React) · Solidity |
| **Anchoring** | **Monad Testnet**, chain ID **10143** — Merkle roots only |
| **Identity** | Three external authority directories; no self-registration |
| **Tests** | 604 backend (24 files) + 36 contract, all passing |
| **Dependencies** | `npm audit`: 0 vulnerabilities |

### The workflow in one line

Police upload evidence (file + title) → the **Section 63 certificate is issued and signed automatically** and the exhibit gets a **permanent QR label** for the physical article → **AI analysis** runs in the background for the forensic lab → the lab records its verdict where required and anyone on the case can **verify the certificate in one click** → chargesheet → the court takes cognizance, commits, tries and closes — **optionally attaching a judgment, declaration or order signed with the judge's device key** → the court accepts an advocate's vakalatnama → **that advocate reads the case and every exhibit automatically**.

Every step is described on the lifecycle — who did it, with the hashes, key fingerprints, ledger entry and anchoring that prove it — and **every open screen that may read the case updates live**, without a reload.

---

## Quick start

You need **Node 20+**. You do *not* need MongoDB installed — there is a script for that.

```bash
npm run install:all          # root + frontend + contracts
node scripts/bootstrap-env.js  # writes .env with CSPRNG secrets
```

Then add the AI analysis settings to `.env` — the API will not start without them:

```
GEMINI_API_KEY=<your key>
GEMINI_MODEL=gemini-2.5-flash
```

Each exhibit costs one AI request. `AI_ANALYSIS_CONCURRENCY` defaults to `1`, and a rate-limited answer waits out the provider's `Retry-After` (up to 120 s) or backs off with jitter, at most `GEMINI_MAX_RETRIES` times — keep those defaults on a free-tier key.

Optionally set `CERTIFICATE_SIGNING_KEY` (the key that signs every Section 63 certificate); left blank, it is derived from `MASTER_KEK`. Its public half is served at `GET /api/certificates/authority-key`.

**Scanning QR codes from a phone:** set `PUBLIC_WEB_URL` to an address the phone can reach — this machine's LAN address (e.g. `http://192.168.1.20:5173`) or a tunnel — not `localhost`. Every certificate QR and exhibit QR label encodes it; `npm run seed` warns if it is still localhost. `RATE_LIMIT_LOOKUP` (default 60 per IP per 15 minutes) limits both public verifiers; loopback is exempt outside production.

Then, in **three terminals**:

```bash
npm run mongo:dev            # 1 — a real mongod on 127.0.0.1:27017, persistent
```

```bash
npm run dev                  # 2 — police:6001 court:6002 legal:6003 api:5000 web:5173
```

```bash
npm run seed                 # 3 — builds the full demo state
```

Open **http://localhost:5173**. Every demo account's password is printed by the seed.

Check everything is alive at any time:

```bash
npm run health
```

### Already have MongoDB?

Skip `npm run mongo:dev` entirely and point `MONGO_URI` at your server. Nothing else changes — no service knows how the database got there. If the URI carries a password, remember that `@`, `:`, `/`, `<` and `>` must be percent-encoded inside a Mongo URI.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                 CLIENT (React SPA on Vite, :5173)                   │
│   /login · /officer · /station · /court · /lab · /counsel           │
│   /verify (public, no session: ?token= certificate · ?label= exhibit)   │
│   src/lib/crypto.js  SHA-256 + ECDSA P-256 (Web Crypto)             │
│                      private key non-extractable, in IndexedDB      │
└────────────────────────────┬────────────────────────────────────────┘
                             │ JWT (15 min, renewed silently)
                             │ + rotating refresh token (no expiry)
┌────────────────────────────┴────────────────────────────────────────┐
│                    LEXX CORE API (Express :5000)                    │
│                                                                     │
│   authenticate → resolveContext → authorize → audit                 │
│                            ↓                                        │
│                   services/accessResolver.js                        │
│            ONE policy point · role × jurisdiction × case × time     │
│                                                                     │
│   auth · case · evidence · fsl · vakalatnama · disclosure           │
│   certificate (LEXX Certificate Authority) · ledger · audit         │
│   search · anchor · custody (optional backend capability)           │
│   events (live change feed, server-sent events, ids only)           │
└──────┬──────────────────────┬───────────────────────┬───────────────┘
       │                      │                       │
┌──────┴───────┐   ┌──────────┴──────────┐   ┌────────┴──────────────┐
│  MongoDB     │   │  Object vault       │   │  Anchor service       │
│  lexx_core   │   │  ./vault            │   │  Merkle batcher →     │
│              │   │  content-addressed  │   │  MONAD TESTNET        │
│  + ledger    │   │  AES-256-GCM        │   │  (root only)          │
│  append-only │   │  envelope-encrypted │   │  every 5 minutes      │
│  hash chain  │   │                     │   │                       │
└──────────────┘   └─────────────────────┘   └───────────────────────┘

╔═════════════════════════════════════════════════════════════════════╗
║          EXTERNAL AUTHORITY DIRECTORIES (mock govt systems)         ║
║  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────────┐   ║
║  │ POLICE  :6001    │ │ COURT   :6002    │ │ LEGAL/FSL  :6003   │   ║
║  │ (CCTNS)          │ │ (eCourts)        │ │ (BCI + FSL LIMS)   │   ║
║  │ officers         │ │ courts, judges   │ │ advocates          │   ║
║  │ stations         │ │ roster           │ │ fsl_labs           │   ║
║  │ postings ← expiry│ │ vakalatnamas     │ │ fsl_examiners      │   ║
║  │ firs             │ │ legal aid        │ │                    │   ║
║  └──────────────────┘ └──────────────────┘ └────────────────────┘   ║
║           Read-only to Lexx. Lexx can NEVER write to these.         ║
╚═════════════════════════════════════════════════════════════════════╝
```

In production these three become CCTNS, eCourts and the FSL LIMS. The interfaces are the same.

---

## Repository layout

```
lexx/
├── directories/          three authority services (:6001 :6002 :6003)
│   ├── common/           shared plumbing: config, app factory, read-only guard
│   ├── police/  court/  legal/     each: server.js models/ routes/ seed.js
│
├── backend/              core API (:5000, db lexx_core)
│   ├── config/           env.js (validated) · crypto.js
│   ├── middleware/       authenticate · authorize · audit · errorHandler
│   ├── services/         accessResolver · ledger · merkle · anchor · envelope
│   │                     storage · directoryClient · jurisdiction · caseWorkflow
│   │                     caseOverview · migrations
│   │                     certificateIssuer · certificateVerifier · systemSigner
│   │                     certificateState · certificatePdf
│   │                     publicEvidenceView · evidenceLabel · lifecycleDetails
│   │                     realtime (change feed) · sealedDocument
│   │                     ai/ (client · prompt · schema · analysis queue · visibility)
│   │                     qr · canonical · tokens · fileType
│   ├── models/           collections + enums.js (the controlled vocabulary)
│   ├── controllers/ routes/
│   └── tests/            unit · integration · authz · redteam
│
├── frontend/             Vite SPA — React 18, Redux Toolkit, TanStack Query, Tailwind, shadcn/ui, Magic UI, GSAP
├── contracts/            LexxAnchor.sol + Hardhat (its own package)
├── seed/                 seed-all.js · reset.js
├── scripts/              bootstrap-env · mongo-dev-server · health-check · migrate
│                         check-network-references · demo-lookup
└── docs/                 see below
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run mongo:dev` | Start a real `mongod` on 27017 with persistent storage |
| `npm run dev` | All five services with colour-coded logs |
| `npm run seed` | Build the full demo state **through the real API** |
| `npm run reset` | Drop `lexx_core` and clear the vault (`--directories` to reseed those too) |
| `npm run migrate` | Apply the boot-time data migrations (incl. issuing system certificates) and build indexes, without starting the API |
| `npm run health` | Check MongoDB, all three directories, the API and the RPC |
| `npm test` | The whole backend suite (604 tests, 24 files) |
| `npm run test:authz` | Just the authorization matrix |
| `npm run test:redteam` | Just the adversarial suite |
| `npm run lint` | ESLint across backend, directories, frontend, scripts |
| `npm run build` | Production frontend build |
| `npm run contracts:test` | Solidity tests (36) |
| `npm run contracts:deploy` | Deploy `LexxAnchor` to Monad Testnet |
| `npm run verify:no-stale-sepolia` | Fail if a bare `sepolia` reappears in config |
| `node scripts/demo-lookup.js` | Read-only: print every certificate link, exhibit QR label link, receipt and custody label a presenter might paste |

`npm run seed` is also an end-to-end test. It authenticates, passes the access resolver, computes hashes and signatures in the client, appends to the hash chain, confirms every upload was issued exactly one signed certificate, puts an advocate on record through an accepted vakalatnama, and runs a one-click certificate verification — if it completes, the demo path works.

---

## Blockchain — Monad Testnet

Submitting to the chain is **off by default in `.env.example`** (`ANCHOR_ENABLED=false`) because it needs a funded key; this project's local `.env` runs with it **on**, and roots are confirmed on Monad Testnet (see the public verifier's *Anchoring history*). Switching it on also submits any earlier DRY_RUN batches, oldest first. The batcher itself runs (`ANCHOR_BATCHING_ENABLED=true`), computing and storing Merkle roots with status `DRY_RUN`, so the pipeline is exercised and locally verifiable without one. A `DRY_RUN` root is not evidence of anything on chain, and the verifier says so in those words.

To anchor for real:

```bash
cd contracts && npm run deploy:monadTestnet
# then in .env:
#   ANCHOR_ENABLED=true
#   ANCHOR_CONTRACT_ADDRESS=0x...
#   ANCHOR_PRIVATE_KEY=0x...   ← a throwaway testnet key, never a mainnet one
```

| | |
|---|---|
| Network | Monad Testnet |
| Chain ID | 10143 |
| RPC | `https://testnet-rpc.monad.xyz` |
| Explorer | `https://testnet.monadexplorer.com` |

**What goes on chain:** a batch id, a Merkle root, and the sequence range it covers.

**What never goes on chain:** evidence, file contents, PII, names, case identifiers, AI analysis results. A root is a commitment; it discloses nothing about what it commits to.

The backend's Merkle implementation is cross-checked against the deployed contract at nine tree sizes by `contracts/scripts/cross-check-backend-merkle.js` — every proof the backend generates verifies on-chain, and forged leaves are rejected on-chain.

---

## Documentation

| Document | What it is for |
|---|---|
| [WORKFLOW.md](WORKFLOW.md) | The idea and the workflow in plain language, for a non-technical presenter |
| [docs/WORKFLOW_ENDPOINTS.md](docs/WORKFLOW_ENDPOINTS.md) | **The current API reference for the lifecycle**: roles and visibility, automatic certificates and one-click verification, permanent QR labels, the public verification and lifecycle endpoints, FSL-only AI analysis and its rate-limit handling, court transitions and closing with a signed document, automatic counsel access, lifecycle descriptions and proofs, live updates (SSE), configuration, migrations, removed endpoints |
| [PRESENTATION.md](PRESENTATION.md) | The five-minute demonstration, beat by beat (being revised for the simplified workflow) |
| [docs/API.md](docs/API.md) | Endpoint, request/response and error-code reference (predates the automatic-certificate and counsel-access changes — where it disagrees, WORKFLOW_ENDPOINTS.md is current) |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | The earlier long-form demo narrative (predates the AI, certificate, custody and court changes) |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust boundaries, cryptography, what the chain does and does not prove |
| [docs/SECURITY_FINDINGS.md](docs/SECURITY_FINDINGS.md) | Every vulnerability found, its fix, and its regression test |
| [docs/AGENT_DECISIONS.md](docs/AGENT_DECISIONS.md) | ADRs — every deviation from the design spec, with reasoning |
| [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) | Honest assessment: what is solid, what is MVP, what blocks production |
| [docs/PRODUCTION_ROADMAP.md](docs/PRODUCTION_ROADMAP.md) | The phased plan to close those gaps for a SIH showcase |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | Feature-by-feature status against the specification |
| [docs/ENGINEERING_PLAN.md](docs/ENGINEERING_PLAN.md) | The phase plan and its test gates |

---

## Things worth knowing before you read the code

**1. There is one authorization function.** `backend/services/accessResolver.js`. Every protected route goes through it, there are no role checks scattered in controllers, and it loads resources from the database itself so a request body can never supply the facts a policy decision is made on.

**2. The ledger is append-only at three levels.** No update or delete route exists; Mongoose middleware refuses every mutating operation; and each entry's hash chains to its predecessor. Only the third one really matters — the first two stop mistakes, the third makes tampering *detectable*.

**3. The Section 63 certificate is issued by the system, not by people.** Uploading evidence issues exactly one certificate per exhibit (`backend/services/certificateIssuer.js`), filled from the record and signed with the **LEXX Certificate Authority** key (`systemSigner.js` — ECDSA P-256, from `CERTIFICATE_SIGNING_KEY` or derived from `MASTER_KEK`), and its issue is written to the ledger. There is no generate route and no Part A / Part B user signature. `POST /api/certificates/:id/verify` is a one-click check returning `VERIFIED | FAILED` with five named checks — document unchanged, system signature valid, evidence file unchanged, active certificate, ledger record intact (`certificateVerifier.js`) — and the public verifier `GET /public/verify/:token` returns the same checks plus the public evidence view (see 8). Verification never consults the forensic verdict. A boot migration supersedes legacy certificates (never deleting them) and issues system ones.

**4. The AI analysis and the forensic opinion are never the same thing, and only the lab sees the AI.** Every exhibit is analysed on upload (`backend/services/ai/`): a structured response — deepfake assessment, score, the model's own explanation, detected indicators, recommended review priority and its reason, whether FSL review is recommended — validated against a schema and stored as returned. It is **one request per exhibit**, through one queue (`AI_ANALYSIS_CONCURRENCY`, default 1); a 429 or 503 waits for the provider's `Retry-After` (for a 429 also a `retryDelay` in the error body), otherwise backs off exponentially with jitter, and a wait over 120 s is not sat out — the exhibit is marked `FAILED` (retryable) instead. No score is ever mapped to a priority in this codebase, no explanation is written by it, and a failed analysis is recorded as failed with nothing invented. The analysis is visible to **FSL examiners only** (`ai/visibility.js`): police, court and counsel receive no analysis, no AI priority and no AI ordering. Responses never name the AI provider or model, and error codes are `AI_*`. Only an FSL examiner produces `AUTHENTIC | MANIPULATED | INCONCLUSIVE`; the AI output is never written to the ledger or the chain.

**5. Counsel access follows the court.** When the court accepts a vakalatnama (or a legal-aid order is mirrored from the court directory), a case access grant is created and counsel can immediately read the case, every exhibit and each certificate — read-only, never AI analysis or physical custody. `GET /api/disclosure/case-file/:caseId` is counsel's case file. There is no share / serve / acknowledge step and no watermark.

**6. A case moves by acts, not by setting a stage.** `backend/services/caseWorkflow.js` defines every transition — file the chargesheet (police); take cognizance, commit for trial, begin trial, direct further investigation, close (court) — with the stages it may happen from and what else must be true. The court is one role scoped to the district, so a chargesheet routed to any bench reaches the Court dashboard the moment it is filed, with its next judicial act named.

**7. Sessions do not time out.** The 15-minute access token is renewed silently; with `REFRESH_TTL_SEC=0` the refresh token never expires, so a session ends only on sign-out, a failed directory re-verification, or refresh-token reuse.

**8. Every exhibit has a permanent QR label, and anyone can scan it.** At upload the exhibit gets a random, unique, immutable `labelToken` (older exhibits get one from a boot migration). Its `label: { token, url }` — `url` = `PUBLIC_WEB_URL/verify?label=<token>` — is on the upload response, the exhibit, the evidence list, case-overview and FSL cards and counsel's case file, and the client prints it as a 70 × 40 mm sticker (after upload, in exhibit dialogs, in evidence-table rows). It survives a certificate being superseded. A scan opens `GET /public/evidence/:labelToken`, which shares one builder (`services/publicEvidenceView.js`) with `GET /public/verify/:token`: the certificate result (`VERIFIED | FAILED | NO_CERTIFICATE` — the label route never issues a certificate or records anything), the exhibit's identity and SHA-256 (title withheld for sensitive cases), who registered it and their unit, the FIR/CNR, station, court and stage, whether a lab has examined it (never the opinion), and a lifecycle strip from upload to case closed. Both routes are rate-limited. Never shown publicly: the description, device serial/IMEI, party names, AI output, the forensic opinion.

**9. Screens update live, and the feed carries ids, not content.** `GET /api/events/stream` (`services/realtime.js`) is a server-sent-event stream opened with the ordinary bearer token. It sends `retry: 3000`, then `event: ready`, then a `: ping` every 25 s. A change frame is only `{ type, caseId, evidenceId, at }`, and the page refetches through the normal authorised routes.
- **What produces events:** every ledger append, plus `AI_ANALYSIS_UPDATED`, `CASE_ACCESS_CHANGED` and `RECORD_UPDATED` (jurisdiction computed; one per case when anchoring stamps its entries).
- **Who receives them:** a frame goes only to users the access resolver allows to read that case. The decision is cached 30 s per connection and reset by access-changing events, so counsel accepted onto a case hear its next events. AI updates go to the lab only, and case-less events only to their actor.
- **Limits:** delivery waits ~150 ms; there are at most 2000 streams in total and 8 per user; a stream closes when its access token expires, and the client reconnects with a refreshed one.
- **Client behaviour:** frames invalidate queries after a short debounce; reconnects back off with jitter; the case, evidence and lab views on screen are polled every 20 s while the stream is down; a *Live* dot sits in the header; the public verify page re-checks every 60 s.

**10. Closing a case can attach a signed document, and every lifecycle step shows its proof.**
- **Closing with a document:** the court may attach a PDF (≤ 20 MB) to `CLOSE_CASE` — a final judgment, declaration or order — with its SHA-256 and an ECDSA P-256 signature by the judge's registered device key. The hash, PDF type, signature and key are all checked before anything is written. The document is sealed in the vault, its digest goes into the `CASE_CLOSED` ledger entry, and every case response carries a `closure` view (`hasDocument: false` when closed without one).
- **Reading it back:** `GET /api/cases/:id/closure-document` is an audited download with an `X-Lexx-Sha256` header, answering `409 CLOSURE_DOCUMENT_ALTERED` if the stored bytes changed.
- **Lifecycle proofs:** every lifecycle comes from one builder (`services/lifecycleDetails.js`), and each milestone carries a description, the actor, and proofs (hashes, key fingerprints, ledger entry, anchoring with an explorer link). It is served publicly on the label and certificate pages without court notes or the examiner's name, and in full at `GET /api/evidence/:id/lifecycle` and on `workflow.lifecycle` of the case routes. `GET /api/cases/:id/workflow` returns `{ caseId, closure, workflow }` and is open to counsel on record.
- **Copying the CNR:** wherever the CNR appears in the client, it has a copy button.

---

## Deliberately out of scope

Judge assignment, real DSC/eSign integration, real CCTNS/ICJS connectors, multi-state deployment, HSM-backed keys, a mobile capture app.

The physical-custody register (seals, movements, freezes) still exists in the backend (`/api/custody/*`) but is not part of the user workflow or the UI.

Deliberately removed: an admin role, all DELETE endpoints, self-registration, public file URLs, and the steps that made the workflow wait without making it safer —

- separate court roles per bench (every court identity is now the one `COURT` role);
- the two-scan custody handshake (a movement is one ledgered act with a reason and a seal check);
- the hardcoded triage heuristic (the review priority is the AI analysis's recommendation);
- the second, web-search-grounded AI call per image (one AI request per exhibit now);
- manual certificate generation and Part A / Part B signing (`POST /api/certificates/generate`, `/:id/sign-part-a`, `/:id/sign-part-b`) — the system issues and signs every certificate;
- the disclosure-pack flow (`POST /api/disclosure/:caseId/share` and the prepare / approve / serve / acknowledge / packs / trace routes) — counsel on record read the case file directly;
- per-recipient watermarks on served copies and downloads.
