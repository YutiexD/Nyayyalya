# LEXX 2.0 — Implementation Status

**Last updated:** 2026-09-04 (build complete)
**Assessed against:** `LEXX-MVP-Technical-Design.md`

> The original assessment section is preserved at the end. It recorded that the repository was **empty** at the start, and listed the specification risks found before any code was written. Keeping it makes the delta visible.

---

## 1. Current state

| | |
|---|---|
| Backend tests | **455 passing**, 15 suites, 0 skipped, 0 failing |
| Contract tests | **36 passing** |
| ESLint | **0 errors** (10 warnings, all one documented false-positive class) |
| `npm audit` | **0 vulnerabilities** |
| Frontend build | **Passing** (8 pages, ~50 kB gzipped JS total) |
| Network check | **Passing** — no stale Sepolia configuration |
| API routes | **56** live, **56** documented, 0 phantom, 0 undocumented |
| Security findings | 6 found, **6 fixed**, each with a regression test or control |

Verified end-to-end against a live system, not only in tests: the full 17-stage seed, the beat-5 tamper demo, and an anchor cycle producing a verified Merkle inclusion proof.

---

## 2. Specification coverage

### 2.1 Features (spec §1)

| # | Feature | Status | Evidence |
|---|---|---|---|
| F1 | Provisioned auth against three authority directories | **DONE** | `auth.test.js` (34) — run against the real directory services |
| F2 | Case creation + jurisdiction router | **DONE** | Reasoning rendered; `services.test.js` pins each routing path |
| F3 | Evidence upload with client-side hash + signature | **DONE** | `evidence.test.js` (30) |
| F4 | QR-based physical custody chain | **DONE** | `custody.test.js` (22) |
| F5 | Integrity verification + tamper detection | **DONE** | Four independent lights; verified live |
| F6 | AI triage → forensic review queue | **DONE** | Priority only; vocabulary asserted by test |
| F7 | FSL review and report upload | **DONE** | `fsl.test.js` (29) |
| F8 | Disclosure set + lawyer scoping | **DONE** | `disclosure.test.js` (44) |
| F9 | Section 63 certificate generator | **DONE** | `certificate.test.js` (39), incl. the completeness refusal |
| F10 | Audit log (grants **and** denials) | **DONE** | Append-only; denial feed |
| F11 | Merkle anchoring to chain | **DONE** | Monad Testnet; `DRY_RUN` until a key is configured |
| F12 | Search across case documents | **DONE** | Scope filter applied **before** the query |

### 2.2 Authority directories (spec §3)

| Component | Status |
|---|---|
| Police directory `:6001` (`dir_police`) | **DONE** — officers, stations, postings, FIRs |
| Court directory `:6002` (`dir_court`) | **DONE** — courts, judges, roster, listings, registry staff, vakalatnamas, legal aid |
| Legal/FSL directory `:6003` (`dir_legal`) | **DONE** — advocates, labs, examiners |
| Read-only enforcement | **DONE** — middleware rejects every non-GET except the two simulated court-registry writes |
| Seeds (idempotent) | **DONE** — including suspended, expired-posting and lapsed-COP fixtures |

### 2.3 Backend (spec §4–§8)

| Component | Status |
|---|---|
| Validated env config, structured logging, central error handling | **DONE** |
| Mongoose models (15 collections) + controlled vocabulary | **DONE** |
| `directoryClient.js` — timeouts, bounded retries, fails **closed** | **DONE** |
| `accessResolver.js` — the single policy point | **DONE** — 58-assertion matrix |
| Auth: verify-identity / request-otp / activate / login / refresh / rotate-key | **DONE** |
| Live directory re-verification on login and refresh | **DONE** |
| Case module + jurisdiction router | **DONE** |
| Evidence ingest, envelope encryption, content-addressed storage, receipts | **DONE** |
| Append-only ledger + hash chain + verification | **DONE** |
| Custody: QR, two-scan transfer, seal-break freeze, gap detection | **DONE** |
| AI triage | **DONE** |
| FSL referral / accept / report | **DONE** |
| Disclosure packs + advocate scoping + watermarking | **DONE** |
| BSA s.63 certificate + PDF + public verifier | **DONE** |
| Audit events (allow and deny) | **DONE** |
| Authorization-scoped search | **DONE** |
| Merkle batcher + anchor service | **DONE** |

### 2.4 Blockchain (spec §8 F11)

| Component | Status |
|---|---|
| `LexxAnchor.sol` — AccessControl, anti-replay, Merkle verification | **DONE** (36 tests) |
| Hardhat config + deploy script with chain-id guard | **DONE** |
| **Monad Testnet** (10143) everywhere | **DONE** — enforced by `npm run verify:no-stale-sepolia` |
| Backend ↔ contract Merkle agreement | **DONE** — cross-checked on-chain at 9 tree sizes |
| Deployed contract address | **DEPLOYED** — `0x835611e0d85D130d313EfC0F80F69DaAFfc5Aaa8` on Monad Testnet, block 59571226. Verified live on chain (bytecode present, deploy tx `status=1`). |
| Live anchoring | **NOT ACTIVE** — `ANCHOR_ENABLED=false`, so the batcher runs in `DRY_RUN`: roots are computed, stored and locally verifiable, but no transaction is submitted to the deployed contract |

### 2.5 Frontend (spec §9)

| Component | Status |
|---|---|
| login / officer / sho / fsl / court / lawyer / verify (public) | **DONE** |
| `lib/crypto.js` — non-extractable P-256 in IndexedDB, P1363 signatures | **DONE** — round-trip proven against the real server verifier |
| `lib/api.js`, `lib/qr.js`, `lib/verify.js`, shared UI | **DONE** |
| Compliance rules in the UI (Review Priority, disclaimer, denial reasons) | **DONE** |

### 2.6 Tooling and docs

| Component | Status |
|---|---|
| `.env.example`, `bootstrap-env`, `mongo:dev`, `health`, `seed`, `reset` | **DONE** |
| Test suites: unit / integration / authz / negative / redteam | **DONE** |
| README, API, SECURITY, SECURITY_FINDINGS, ADRs, demo script, readiness report | **DONE** |

---

## 3. Specification deviations

Twenty-nine decisions are recorded in `docs/AGENT_DECISIONS.md`. The ones that change behaviour a reader of the spec would not expect:

| ADR | Deviation |
|---|---|
| 002 | **Arbitrum Sepolia**, not Ethereum Sepolia (user requirement) |
| 003 | The resolver loads its own resources; callers cannot pass a resource object |
| 004 | OTP hardened; the demo echo is flag-gated and refused in production |
| 005 | JWT claims are a routing hint; the database is the authority on every request |
| 009 | Storage key carries a per-evidence discriminator, so identical files do not collide |
| 010 | Single-use, user-bound stream tokens instead of a signed URL |
| 012 | `verify-chain` requires a session (the spec marked it public) |
| 015 | Judges cannot see a case before it is bound to their court |
| 016 | The Merkle tree commits to the leaf *set*; ordering is committed by the hash chain |
| 018 | FSL reports and certificate PDFs use a self-describing encrypted container |
| 019 | `APPROVE` and `ACKNOWLEDGE` added as first-class actions |

---

## 4. Known gaps

Nothing in the specification is unimplemented. The gaps are operational, and are enumerated with severity in `docs/PRODUCTION_READINESS.md` §7 — the load-bearing ones being the master key in an environment variable (B1), no backup or restore (B3), and no independent security review (B5).

Two smaller items found during the build and left deliberately:

- **Response id field names are inconsistent** across modules (`_id` / `id` / `packId` / `certificateId`). Real but cosmetic; normalising would ripple through four test suites.
- ~~**No pack-lookup endpoint for court users.**~~ Closed: `GET /api/disclosure/case/:caseId/packs`, and the court now shares a case file in one act rather than by pack id at all.

---
---

# Appendix — original assessment (2026-09-04, before any code)

## A.0 Headline finding

**The repository was empty.** Zero files, zero directories, no git history, no `package.json`, no dependencies, no tests, no prior implementation. This was a greenfield build, so "compare repository against specification" produced a trivial result: everything was missing.

The useful output of the assessment phase was therefore an **environment readiness** check and a **specification risk register**.

## A.1 Environment assessment

| Dependency | Present on host | Impact |
|---|---|---|
| Node.js v22.16.0, npm 10.9.2, git 2.53.0 | Yes | None |
| npm registry | Reachable | None |
| **MongoDB server** | **NOT INSTALLED** | **Blocking** — resolved by ADR-001 (`npm run mongo:dev` starts a real `mongod`) |
| Docker | NOT INSTALLED | Removed the usual container workaround |

## A.2 Specification risk register

Fourteen risks (R1–R14) were identified before implementation began — the blockchain network, resolver resource-trust, OTP echo, JWT authority, ledger concurrency, hash ambiguity, KEK derivation, storage-key collisions, replayable stream URLs, static QR HMACs, the public chain walk, undefined resolver helpers, the missing `victimIsMinor` field, and judge access to unbound cases.

**All fourteen were addressed.** Each became an ADR in `docs/AGENT_DECISIONS.md` with its reasoning, alternatives, security impact and the test that holds it in place.
