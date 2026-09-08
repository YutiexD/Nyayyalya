# LEXX 2.0 — Production Readiness Report

**Date:** 2026-09-04
**Verdict:** **Not production-certified. A sound MVP with a genuinely tested security model.**

This document is deliberately unflattering where that is accurate. A readiness report that claims everything is fine is worth nothing, and the specific gaps below are more useful to whoever inherits this than any summary of what works.

---

## 1. Summary

| | |
|---|---|
| Backend tests | **423 passing**, 15 suites, 0 skipped |
| Contract tests | **36 passing** |
| `npm audit` | **0 vulnerabilities** (production and dev) |
| ESLint | 0 errors |
| Security findings | 6 recorded, **6 fixed**, each with a regression test or control |
| Source | ~11 000 lines backend/directories, 6 300 lines tests, 5 500 frontend, 338 Solidity |
| Anchoring | Monad Testnet (10143) — root only |

**What is genuinely strong:** the authorization model, the ledger's tamper evidence, the identity federation, and the discipline separating AI triage from forensic opinion. These are tested adversarially, not just optimistically.

**What is genuinely not production-ready:** key custody, the authority directories (they are mocks by design), operational maturity (no HA, backup, monitoring or rate-limit tuning), and the absence of any independent security review.

---

## 2. Architecture

### 2.1 Components

| Component | Port | Database | Role |
|---|---|---|---|
| Police directory | 6001 | `dir_police` | Stands in for CCTNS. Officers, stations, postings, FIRs |
| Court directory | 6002 | `dir_court` | Stands in for eCourts. Courts, judges, roster, vakalatnamas |
| Legal/FSL directory | 6003 | `dir_legal` | Stands in for BCI + FSL LIMS. Advocates, labs, examiners |
| Core API | 5000 | `lexx_core` | Everything else |
| Frontend | 5173 | — | Vite MPA, vanilla JS |
| Anchor service | in-process | — | Merkle batcher → Monad Testnet |

### 2.2 Trust boundaries

| Boundary | Trusted | Not trusted |
|---|---|---|
| Browser → API | Nothing | Every field. `role`, `authority`, `scope`, `userId`, `caseId` ownership are all derived server-side |
| API → directories | Their answers about identity | Their availability. A directory outage fails **closed** (503), never open |
| API → MongoDB | Availability | Integrity. The ledger hash chain assumes an attacker may hold database access |
| API → object vault | Availability | Integrity. Every read is hash-verified and AEAD-authenticated |
| API → Monad Testnet | Immutability of what was written | Availability. RPC failure never marks a batch anchored |
| Public → verifier | — | Discloses validity, never contents |

### 2.3 External dependencies

MongoDB 7 (via `mongodb-memory-server` binary in development), three directory services, a Monad Testnet RPC endpoint (optional — `DRY_RUN` without it), the local filesystem for the object vault.

---

## 3. Security

### 3.1 Authentication

| Property | Implementation |
|---|---|
| Provisioning | Directory-verified only. `POST /api/auth/register` returns **410 Gone** |
| Role and scope | Read from the authority directory at activation and re-read at every login |
| Password | bcrypt, cost 12 (configurable; production refuses below 12) |
| Second factor | 6-digit CSPRNG OTP — hashed at rest, single-use, purpose-bound, attempt-capped, rate-limited |
| Access token | HS256 JWT, 15 minutes, algorithm **pinned** at verification |
| Refresh token | Hashed at rest, single-use, rotated; reuse revokes the whole family |
| Re-verification | Live directory check on **login and refresh** — a transferred officer, suspended advocate or rotated judge loses access with no admin action |
| Key rotation | `POST /api/auth/rotate-key` — session + fresh OTP + directory re-check |
| Enumeration | Uniform `BAD_CREDENTIALS`; bcrypt runs even for unknown users |

### 3.2 Authorization

One function — `backend/services/accessResolver.js` — deny by default. Two invariants make it trustworthy:

1. **It loads its own resources.** Callers pass a type and an id; the resolver fetches from the database. No controller can hand it a request-derived object.
2. **The database is the authority, not the token.** Session context is re-read every request, so suspension takes effect on the *next request*, not the next login.

Verified by a **58-assertion matrix** covering every role against own/other station, district, court, lab, and advocate — plus revoked, expired and not-yet-valid grants.

### 3.3 Cryptography

| Purpose | Algorithm |
|---|---|
| Evidence hashing | SHA-256, computed in the browser and recomputed server-side |
| Signatures | ECDSA P-256, IEEE **P1363** encoding over the hex hash string. DER is explicitly rejected |
| Content encryption | AES-256-GCM, fresh 96-bit IV per operation |
| Key wrapping | AES-256-GCM under a per-case KEK, with the case id bound as AEAD additional data |
| KEK derivation | HKDF-SHA256 from `MASTER_KEK` |
| Ledger chain | SHA-256 over a delimited, versioned canonical string |
| Merkle tree | keccak256, sorted pairs, leaves pre-hashed once |
| QR tags | HMAC-SHA256 |
| Passwords | bcrypt |
| Randomness | `crypto.randomBytes` / `crypto.randomInt` throughout. `Math.random` appears nowhere security-relevant |

Private keys are generated **non-extractable** in the browser and stored in IndexedDB. They never reach the server.

### 3.4 Storage

Envelope encryption: `MASTER_KEK` → per-case KEK (derived, never stored) → per-evidence DEK (stored wrapped). A database dump without the master key yields no plaintext. Storage keys must match a strict pattern and the resolved path is re-checked to be inside the vault.

### 3.5 Attack surface and red-team results

40 adversarial tests, all currently passing. Attempted and defeated:

| Attack class | Result |
|---|---|
| Role/scope injection via request body | Discarded; directory values win |
| Privilege escalation at activation | Refused |
| JWT forgery — wrong secret, `alg:none`, tampered payload, wrong audience/issuer | All rejected |
| NoSQL operator injection | 400 before the database is touched |
| Prototype pollution | No effect on `Object.prototype` |
| IDOR across every id-bearing route | Denied; enumeration yields only own resources |
| Ledger update/delete/reorder/forge via API | No route exists; chain detects DB-level tampering |
| Path traversal via storage keys | Rejected |
| MIME spoofing (executable labelled JPEG) | Rejected by magic-byte sniffing |
| Signature forgery, cross-user signatures, DER-encoded signatures | Rejected |
| Download-token replay, wrong user, wrong resource | Rejected |
| Custody: forged QR, replayed token, wrong recipient, illegal state jump | Rejected |
| Information disclosure — stack traces, paths, driver detail, secrets | None leaked |

Six findings were discovered and fixed during the build; see `docs/SECURITY_FINDINGS.md`. The most serious (**SEC-001**) allowed any investigating officer to upload evidence into any case in the system. The last (**SEC-006**) was in our own tooling rather than the product: the seed wrote demo signing keys to a path `.gitignore` did not cover.

---

## 4. Reliability

### 4.1 Failure modes and handling

| Failure | Behaviour |
|---|---|
| Authority directory unreachable | **503, fail closed.** Never falls back to cached authority |
| Directory returns a format 400 | Treated as "not this directory's identifier", not as an outage |
| MongoDB unreachable | Bounded server-selection timeout; queries fail rather than buffer indefinitely |
| Object missing from the vault | `FILE_MISSING`; the recorded hash and history survive |
| Object modified on disk | `FILE_MODIFIED` via AEAD tag failure or hash mismatch |
| Ledger tampered | `CHAIN_BROKEN` with the exact sequence and the reason |
| Blockchain RPC down | Batch marked `FAILED`; ledger entries stay unstamped and retry next cycle |
| Transaction reverted | Batch `FAILED`. **Never** marked anchored without a receipt with `status === 1` |
| Duplicate anchor attempt | Three independent guards: unique `(fromSeq,toSeq)` index, on-chain `isAnchored` pre-check, contract-level revert |
| Upload too large / wrong type | 413 / 400 before any crypto work |
| Concurrent ledger appends | Serialised; gapless chain verified under 40 parallel writes |

### 4.2 Concurrency and idempotency

- **Ledger sequence** — atomic counter, plus a MongoDB advisory lock that holds across processes, plus a unique index as the backstop. Tested with 40 concurrent appends producing a gapless, correctly-linked chain.
- **Custody transfer** — single-use token consumed atomically; replay and wrong-recipient both refused.
- **OTP** — consumed atomically; two concurrent logins cannot both succeed on one code.
- **Refresh tokens** — rotation with reuse detection.
- **Anchoring** — idempotent by construction.

### 4.3 Database

39 indexes across 15 collections, each justified by an actual query path — including partial indexes for un-anchored ledger entries and live referrals, unique partial indexes preventing duplicate live grants and duplicate live referrals, and TTL indexes on OTP, refresh and stream tokens.

**Not done:** no query plans have been measured under load. Index choices are reasoned from the code's access patterns, not from production telemetry.

---

## 5. Testing

| Suite | Tests | Covers |
|---|---|---|
| `unit/canonical` | 14 | Determinism of the hash input — key order, unicode, non-finite rejection, cycles, prototype pollution |
| `unit/ledger` | 21 | Chaining, concurrency, five classes of tamper detection, immutability guards |
| `unit/services` | 46 | Jurisdiction, QR, Merkle, envelope encryption, triage, ECDSA |
| `unit/health` | 11 | Scheduler state, audit-failure counting, recovery, reason truncation |
| `integration/auth` | 34 | Directory → auth → session, against the **real** directory services |
| `integration/evidence` | 34 | Upload, ingest refusals, tamper detection, anchor honesty (`ANCHOR_LOCAL_ONLY`), streaming, key rotation |
| `integration/custody` | 20 | Two-scan transfer, forged QR, seal break, gap detection |
| `integration/fsl` | 14 | Lab scoping, report signing, opinion vocabulary |
| `integration/disclosure` | 47 | Serving, scoping, exclusions, certificate scoping, court pack listing, denial logging |
| `integration/certificate` | 37 | Part A completeness refusal, Part B from FSL only, public verifier non-disclosure |
| `integration/anchor` | 22 | Batching, idempotency, root mismatch detection, public surface |
| `integration/resilience` | 20 | `/readyz` scheduler + audit health, temp-file reaping, `SEARCH_UNAVAILABLE`, fail-closed audit |
| `integration/directory-simulator` | 6 | The one directory write endpoint is labelled simulated and gated |
| `authz/matrix` | 58 | The full cross-scope authorization matrix |
| `redteam/attacks` | 39 | Direct API attacks assuming a hostile frontend |
| **Total** | **423** | |
| `contracts/` | 36 | Anti-replay, access control, Merkle proofs, second-preimage resistance |

Integration tests run against **real directory services as child processes** and a **real MongoDB**, not mocks — the unique indexes and append-only guards are security controls, and a mock would let a test pass while the real constraint was broken.

**Additionally verified end-to-end against a live system:** the full seed (17 stages, including nine directory-verified activations, four signed uploads, a two-scan custody transfer, an FSL report and a served disclosure pack); the beat-5 tamper demo; and a live anchor cycle producing a verified inclusion proof.

**Cross-component:** `contracts/scripts/cross-check-backend-merkle.js` deploys the real contract and confirms that proofs generated by the backend verify **on-chain** at nine tree sizes. This is the integration that would otherwise fail silently.

### Not tested

- Load and soak. No throughput or latency figures exist.
- Browser compatibility beyond the Web Crypto contract (verified separately by a Node round-trip against the real server verifier).
- Recovery drills — no restore-from-backup has been rehearsed, because there is no backup story.

---

## 6. Blockchain

| | |
|---|---|
| Network | **Monad Testnet** |
| Chain ID | **10143** |
| RPC | `https://testnet-rpc.monad.xyz` |
| Explorer | `https://testnet.monadexplorer.com` |
| Contract | `LexxAnchor.sol`, Solidity 0.8.24, OpenZeppelin AccessControl |
| Deployed address | `0x835611e0d85D130d313EfC0F80F69DaAFfc5Aaa8` — deployed to Monad Testnet, block 59571226, verified live on chain |
| Live anchoring | **Not active.** `ANCHOR_ENABLED=false`, so the batcher runs in `DRY_RUN`: Merkle roots are computed, stored and locally verifiable, but nothing is submitted to the deployed contract. Turning it on requires a funded signer key. |

**On chain:** batch id, Merkle root, `fromSeq`, `toSeq`, timestamp, anchoring address.
**Never on chain:** evidence, file contents, hashes of PII, names, case identifiers, AI triage.

No hardcoded addresses or keys anywhere; roles come from constructor arguments. Re-anchoring a batch id reverts.

### What anchoring proves, and what it does not

It proves **this set of ledger entries existed in exactly this form at that time**.

It does **not** prove the entries are true, that any evidence is authentic, that nothing was omitted from the ledger, or that the off-chain data still exists. Those are separate claims made by different parties — the officer who signed the upload, and the laboratory that examined the exhibit.

A stale bare `sepolia` in any configuration position fails the build (`npm run verify:no-stale-sepolia`).

---

## 7. Known limitations

### 7.1 MVP limitations — acceptable for this scope, documented

| # | Limitation | Note |
|---|---|---|
| 1 | The three authority directories are **mocks** | Deliberate, per spec. The interfaces are shaped for CCTNS / eCourts / FSL LIMS |
| 2 | OTP is not delivered by SMS | `DEMO_ECHO_OTP` returns it in the response; **refused when `NODE_ENV=production`** |
| 3 | Object storage is the local filesystem | The interface is small; S3/MinIO is a contained change |
| 4 | Ledger is MongoDB with an application-level hash chain | Postgres with database-level append-only constraints is the production shape. The migration path is the entry format, which is already canonical and versioned |
| 5 | Triage is heuristic, metadata-only | Deliberately explainable. A model would be less defensible in court, not more |
| 6 | Watermarking is an overlay plus a recorded token | Not steganographic; a determined leaker can crop it |
| 7 | Response id field names are inconsistent | `_id` / `id` / `packId` / `certificateId` across modules. Cosmetic but real; normalising would ripple through four test suites |
| 8 | Compliance clocks are stored but not enforced | `disclosureDueOn` is computed; nothing escalates when it passes |
| 9 | No pack-lookup endpoint for court users | A registrar must be handed a `packId` rather than listing packs for a case |
| 10 | `POST /api/evidence/:id/verify` requires a session | So the four lights cannot be driven from the fully public page |

### 7.2 Production blockers — must be fixed before any real deployment

| # | Blocker | Why it blocks |
|---|---|---|
| **B1** | **`MASTER_KEK` lives in an environment variable** | It decrypts every case KEK, and therefore every piece of evidence. Belongs in a KMS or HSM with audited access. This is the single highest-value secret in the system |
| **B2** | **`ANCHOR_PRIVATE_KEY` in an environment variable** | Lower value (it can only anchor roots), but still a signing key in a file |
| **B3** | **No backup or restore** | The vault and the ledger are the system of record and neither has a rehearsed recovery path |
| **B4** | **No HA** | Single API instance, single MongoDB. The ledger lock is cross-process and would survive scaling out, but this has never been run that way |
| **B5** | **No independent security review** | Everything here was found by the team that wrote it, which is the weakest form of assurance |
| **B6** | **No monitoring or alerting** | Structured logs exist; nothing consumes them. A `CHAIN_BROKEN` result should page a human, and currently nothing does |
| **B7** | **Real directory integration unbuilt** | CCTNS/eCourts/FSL LIMS have their own authentication, availability and data-shape realities |
| **B8** | **Rate limits are untuned, and loopback is exempt in development** | The exemption is hard-refused in production, but the limits themselves have never been tested against real traffic |
| **B9** | **No key-compromise procedure** | Rotation exists; there is no documented process for what happens when a key is known to be compromised |
| **B10** | **Data retention and deletion are undefined** | Nothing is ever deleted, which is right for evidence and wrong for indefinite PII retention. A real deployment needs a lawful retention policy |

### 7.3 Future improvements

Postgres-backed ledger with database-level append-only enforcement · S3/MinIO object storage · real DSC/eSign · steganographic watermarking · compliance-clock escalation · a pack-lookup endpoint · normalised response id fields · load testing · a public, token-scoped verify endpoint so the four lights work without a session · per-tenant KEK hierarchies for multi-state deployment.

---

## 8. Honest assessment

**Trust this system's security model.** It was designed against a stated attacker, implemented with one policy point, and attacked deliberately. Where the design specification was unsafe or ambiguous — nine separate places, recorded as ADRs — the implementation diverged and said why. Six real issues were found during the build, and each one has a regression test or an enforced control rather than a note promising to look at it later.

**Do not trust this system with real evidence yet.** The master key is in a file, nothing is backed up, no one outside the team has reviewed it, and the authority directories it federates to do not exist. Those are not implementation details; they are the difference between a system that demonstrates a security model and a system that operates one.

The gap between the two is roughly B1–B10, and none of them is a redesign.
