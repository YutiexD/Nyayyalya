# LEXX 2.0 — Agent Context & Workflow Brief

> **Audience: AI agents.** You are reading this because you have been asked to understand the LEXX 2.0 system and produce submission documents for **Smart India Hackathon (SIH)**. This file is the single source of truth for onboarding. Read it fully before generating anything.
>
> **If a fact is not in this file or verifiable in the repository, do not assert it.** §14 lists claims that are forbidden because they are false. Overclaiming is the single most damaging failure mode for this project — see §14 before writing a single sentence of output.

---

## 1. What LEXX is — one paragraph

- **LEXX 2.0** is an AI-assisted, blockchain-backed **digital evidence registry** for the Indian criminal justice chain.
- It manages the lifecycle of digital and physical evidence from **seizure → investigation → forensic examination → disclosure → court**, with cryptographic integrity guarantees at every step.
- Its three defining claims, stated exactly as they should be repeated:
  - *"LEXX holds no identities of its own. Officers, judges, advocates and examiners exist in their own authority directories — we verify against them and can create none of them."*
  - *"Nothing is ever deleted. Status changes, and every change is signed by whoever ordered it."*
  - *"Only the forensic laboratory decides authenticity. Our AI decides what gets looked at first."*

---

## 2. Problem context

- Digital evidence in Indian criminal proceedings faces four recurring challenges:
  - **Tamper-evidence** — proving a file has not changed between seizure and trial.
  - **Chain of custody** — proving who held physical evidence, when, and that no link is missing.
  - **Confidentiality** — ensuring counsel sees exactly what was disclosed to them and nothing more.
  - **Statutory compliance** — producing a valid **BSA s.63** certificate, respecting **BNSS** timelines, and honouring **IT Act s.79A** (only a notified laboratory gives an expert authenticity opinion).
- LEXX addresses each with a specific, testable mechanism rather than a general claim — see §4.

---

## 3. Current status — state this accurately

| Dimension | Status |
|---|---|
| Maturity | **Working prototype**, feature-complete against its design specification |
| Backend tests | **448 passing**, 15 suites, 0 skipped, 0 failing |
| Contract tests | **36 passing** |
| Lint | 0 errors (10 documented false-positive warnings) |
| API surface | **56 routes**, all documented in `docs/API.md` |
| Architecture decisions | **29 ADRs** recorded in `docs/AGENT_DECISIONS.md` |
| Security findings | **6 found, 6 fixed**, each with a regression test (`docs/SECURITY_FINDINGS.md`) |
| Smart contract | **Deployed and live** on Monad Testnet — see §8 |
| Live anchoring | **Not active** — runs in `DRY_RUN`; see §8 for the exact nuance |
| Cloud deployment | **Not deployed.** Runs locally / on a single machine |
| Independent security audit | **Never performed.** Do not imply otherwise |

- The codebase is roughly **48,500 lines** across 151 files (backend, three directory services, frontend, contracts, tests, docs).

---

## 4. Features — the twelve, with the mechanism behind each

State the *mechanism*, not just the feature name. The mechanism is what makes each claim credible.

- **F1 — Provisioned authentication.** No self-registration; `POST /api/auth/register` returns **410 Gone**. Accounts exist only if the person is already ACTIVE in an authority directory. Role and jurisdiction are read from that directory, never from the request body.
- **F2 — Case creation + jurisdiction router.** Cases are created only from an FIR that already exists in the police directory. A pure function computes the correct court (Magistrate / Sessions / Special) and **shows its reasoning on screen** — e.g. *"Maximum punishment 20 years — triable by a Court of Session"*, *"Victim is a minor — POCSO designated court required"*.
- **F3 — Evidence upload with client-side hash + signature.** The browser computes SHA-256 and signs it with an **ECDSA P-256 key that is non-extractable and never leaves the device**. The server recomputes the hash from the bytes it received and verifies the signature against the key registered at activation. Failure of either check is refused *and written to the ledger*.
- **F4 — QR-based physical custody chain.** Two-scan handshake: the sender initiates (minting a single-use token, 5-minute TTL), the receiver accepts. Broken seals freeze custody. Gap detection reports structured findings (`ILLEGAL_STATE_TRANSITION`, `SEQUENCE_DISCONTINUITY`, `STATE_DIVERGENCE`).
- **F5 — Integrity verification (four independent lights).** File integrity, uploader signature, ledger chain, on-chain anchor — each recomputed from first principles and reported **separately, never merged into one verdict**.
- **F6 — AI triage.** Produces a **Review Priority** (HIGH/MEDIUM/LOW) plus indicators. Never a verdict. See §6 — this boundary is the most important thing in the system.
- **F7 — FSL review.** An examiner sees only exhibits referred to *their* laboratory. They file a signed report with an opinion of `AUTHENTIC | MANIPULATED | INCONCLUSIVE` — **the only authenticity vocabulary in the entire system**.
- **F8 — Disclosure sets + advocate scoping.** An advocate on record sees only the served exhibit set. One outside it gets `EXHIBIT_NOT_IN_DISCLOSURE_SET`; one not on record gets `NOT_ON_RECORD_FOR_THIS_CASE`. Both denials are audited. Per-recipient watermarking makes leaks traceable.
- **F9 — BSA s.63 certificate.** Part A auto-fills from the evidence record and ledger timeline. Part B can only come from a filed FSL report. **Generation is refused if any Part A field is missing**, returning the exact missing-field list — refusing to produce an incomplete legal document is a feature, and should be presented as one.
- **F10 — Audit log.** Every authorization decision, **allow and deny**, is recorded. Audit rows are append-only.
- **F11 — Merkle anchoring.** Ledger entries are batched into a Merkle tree; only the **root** goes on chain. See §8.
- **F12 — Search.** Scope filter is applied **before** the query, never as a post-filter on results.

---

## 5. Roles — twelve, across four authorities

Roles are **derived from external directories**, never assigned inside LEXX.

- **POLICE authority**
  - `IO` — Investigating Officer. Owns their own cases only; cannot write once the case leaves investigation.
  - `SHO` — Station House Officer. Sees all cases at their station; refers exhibits to FSL.
  - `MALKHANA_CUSTODIAN` — Evidence store keeper. Custody items only; **no case access at all**.
  - `DISTRICT_SP` — District Superintendent. District-wide **read-only** oversight.
- **COURT authority**
  - `JUDGE` — Reached via the court **roster**, never assigned by LEXX. Sees only cases listed in their court.
  - `REGISTRAR` — Court registry. Approves and serves disclosure; puts advocates on record.
  - `EVIDENCE_CUSTODIAN` — Court-side evidence handling.
- **FSL authority**
  - `FSL_EXAMINER` — Sees only exhibits referred to their own laboratory. The only role that can state an authenticity opinion.
- **LEGAL authority**
  - `DEFENCE_COUNSEL`, `VICTIM_COUNSEL`, `LEGAL_AID_COUNSEL`, `PUBLIC_PROSECUTOR` — Case-scoped, read-only, and only via an accepted vakalatnama or legal-aid order.

**Key architectural point to convey:** advocates get **no jurisdictional scope at all**. Their access is purely per-case, granted by a court-asserted fact.

---

## 6. The compliance boundary — the most important section in this file

- **AI triage produces ONLY:** a `Review Priority` of `HIGH | MEDIUM | LOW`, a list of indicators, a model name/version, and a fixed statutory disclaimer.
- **AI triage NEVER produces:** an authenticity verdict, a confidence score, a percentage, or the words `AUTHENTIC`, `MANIPULATED`, `VERIFIED`.
- **Only an `FSL_EXAMINER` produces** `AUTHENTIC | MANIPULATED | INCONCLUSIVE`, and only after examining an exhibit referred to their laboratory.
- **The disclaimer text, verbatim, always attached:**
  > *Automated triage only. Not expert opinion under BSA s.39 / IT Act s.79A.*
- This separation is **enforced structurally, not by convention**:
  - Two disjoint vocabularies in `backend/models/enums.js` (`TRIAGE_PRIORITY` vs `FORENSIC_OPINION`).
  - An automated test asserts the triage output can never contain a verdict word or a percentage.
  - The UI renders them as visually distinct components with separate attribution.
- **Why it matters legally:** BSA s.39 / s.45A and IT Act s.79A require a *certified examiner's* opinion for authenticity. An algorithm asserting authenticity would be inadmissible and a liability.
- **When writing submission material:** never describe LEXX's AI as "detecting fake evidence", "verifying authenticity", or "validating evidence". Correct phrasing: *"prioritises which exhibits a human examiner should look at first."*

---

## 7. Tech stack — complete

- **Runtime & language**
  - Node.js **22.x** (requires ≥20.10), ES Modules throughout (`"type": "module"`)
  - Vanilla JavaScript — no TypeScript, no frontend framework
- **Backend**
  - **Express 4.22** — core API on port `5000`
  - **Mongoose 8** — ODM over MongoDB
  - **MongoDB 7/8** — databases: `lexx_core`, `dir_police`, `dir_court`, `dir_legal`
  - **zod** — request validation on every endpoint
  - **pino** + **pino-http** — structured logging with secret redaction
  - **helmet**, **cors**, **express-rate-limit** — HTTP hardening
  - **multer 2.x** — multipart upload, disk-streamed (never buffered in memory)
  - **jsonwebtoken** — HS256, algorithm pinned at verification
  - **bcryptjs** — password hashing, cost 12 (production refuses below 12)
  - **pdfkit** — s.63 certificate PDF generation
  - **qrcode** — custody label and certificate QR generation
  - **ethers 6** — blockchain interaction
- **Frontend**
  - **Vite** multi-page application, 8 HTML entry points
  - Vanilla JS, no framework, no CDN dependencies (works offline)
  - **Web Crypto API** — SHA-256 hashing and ECDSA P-256 signing in-browser
  - **IndexedDB** — stores the non-extractable private key
- **Blockchain**
  - **Solidity 0.8.24**, EVM target `paris`
  - **Hardhat 2.22** + **@nomicfoundation/hardhat-toolbox**
  - **OpenZeppelin Contracts v5** — `AccessControl`, `MerkleProof`
  - **Monad Testnet** — chain ID **10143**
- **Testing**
  - **Vitest 5** — 448 backend tests across unit / integration / authz / redteam
  - **supertest** — HTTP-level integration testing
  - **mongodb-memory-server** — real `mongod` binary per test suite (not a mock)
  - **Hardhat/Mocha/Chai** — 36 contract tests
- **Tooling**
  - **ESLint 9** flat config, **dotenv**, **concurrently**

---

## 8. Blockchain — state this precisely

- **Network:** Monad Testnet · **Chain ID 10143** · RPC `https://testnet-rpc.monad.xyz` · Explorer `https://testnet.monadexplorer.com`
- **Contract:** `LexxAnchor.sol` — OpenZeppelin `AccessControl`, custom errors, no hardcoded addresses
- **Deployed address:** `0x835611e0d85D130d313EfC0F80F69DaAFfc5Aaa8`
- **Deployment block:** 59571226 — **verified live on chain** (bytecode present, deploy transaction `status = 1`)
- **What goes on chain:** a batch ID, a **Merkle root**, and the sequence range it covers. Nothing else.
- **What NEVER goes on chain:** evidence, file contents, hashes of PII, names, case identifiers, AI triage output.
- **Current anchoring state — do not misrepresent this:**
  - `ANCHOR_ENABLED=false`, so the batcher runs in **`DRY_RUN`**: Merkle roots *are* computed, stored, and locally verifiable, but **no transaction is submitted** to the deployed contract.
  - Correct phrasing: *"The anchoring contract is deployed and live on Monad Testnet; the batching pipeline is implemented and verified end-to-end, and runs in dry-run mode pending a funded signer key."*
  - Incorrect phrasing: *"Evidence is anchored on the blockchain"* (present tense, as if transactions are flowing).
- **What anchoring proves:** that a set of ledger entries existed in exactly that form at that time.
- **What anchoring does NOT prove:** that the entries are true, that evidence is authentic, or that nothing was omitted.
- **Verified integration:** the backend's Merkle implementation is cross-checked against the deployed contract at **nine tree sizes** — every backend-generated proof verifies on-chain, and forged leaves are rejected on-chain (`contracts/scripts/cross-check-backend-merkle.js`).

---

## 9. Architecture

```
CLIENT (Vite, :5173) — 7 role views + public verifier
  · SHA-256 hash + ECDSA P-256 sign in-browser, key non-extractable in IndexedDB
        │  JWT (15 min) + rotating refresh token
LEXX CORE API (Express :5000, db lexx_core)
  · authenticate → resolveContext → authorize → audit
  · services/accessResolver.js  ← THE single policy point
  · modules: auth · case · evidence · custody · fsl · disclosure
             certificate · ledger · audit · search · anchor
        │                    │                      │
   MongoDB            Object vault            Anchor service
   lexx_core          ./vault                 Merkle batcher →
   + append-only      AES-256-GCM             MONAD TESTNET
     hash chain       envelope-encrypted      (root only)

EXTERNAL AUTHORITY DIRECTORIES (mock government systems, read-only to LEXX)
  POLICE :6001 (CCTNS)   COURT :6002 (eCourts)   LEGAL/FSL :6003 (BCI + FSL LIMS)
```

- **Three authority directories** are **deliberate mocks** standing in for CCTNS, eCourts and FSL LIMS. They are separate services with separate databases, and **every route except one registrar endpoint is a GET, enforced by middleware** — LEXX has no write path into them at all.
- **Repository layout:**
  - `backend/` — core API (config, middleware, models, services, controllers, routes, tests)
  - `directories/` — the three authority services (`common/`, `police/`, `court/`, `legal/`)
  - `frontend/` — Vite MPA (`lib/`, `pages/`, 8 HTML entries)
  - `contracts/` — `LexxAnchor.sol` + Hardhat (own package)
  - `seed/`, `scripts/`, `shared/`, `docs/`

---

## 10. Security model — summary

- **Authorization:** one function (`backend/services/accessResolver.js`), deny-by-default, with two invariants:
  - It **loads resources from the database itself** — a controller can never hand it a request-derived object (prevents body-injected scope bypass).
  - **The database is the authority, not the token** — session context is re-read every request, so a suspension takes effect on the *next request*, not the next login.
  - Verified by a **58-assertion cross-scope authorization matrix**.
- **Cryptography inventory:**
  - SHA-256 — evidence hashing (browser + server recompute)
  - ECDSA P-256, **IEEE P1363** encoding over the hex hash string — DER is explicitly rejected
  - AES-256-GCM — content encryption, fresh 96-bit IV per operation
  - HKDF-SHA256 — per-case KEK derivation from a master key
  - keccak256 — Merkle tree, sorted pairs, leaves pre-hashed once
  - HMAC-SHA256 — QR label authenticity
  - bcrypt — passwords
  - All randomness from `crypto.randomBytes` / `crypto.randomInt`; `Math.random` appears nowhere security-relevant
- **Envelope encryption:** master key → per-case KEK (derived, never stored) → per-evidence DEK (stored wrapped). A database dump without the master key yields no plaintext.
- **Tamper evidence:** append-only ledger, enforced at three levels — no update/delete route exists; Mongoose middleware refuses every mutating operation; each entry's hash chains to its predecessor. **Only the third one truly matters** — the first two stop mistakes, the third makes tampering *detectable*.
- **Red-team suite:** 40 adversarial tests covering privilege escalation, JWT forgery (`alg:none`, wrong secret, tampered payload), NoSQL injection, prototype pollution, IDOR, ledger tampering, path traversal, MIME spoofing, token replay, and information disclosure.
- **Six security findings, all fixed with regression tests.** The most serious (**SEC-001**) allowed any investigating officer to upload evidence into **any** case in the system — found by a test written against the intended policy, fixed by routing creation through the same `evaluate()` used by every other write.

---

## 11. The eleven demo beats

Each maps to a problem-statement requirement. Full script in `docs/DEMO_SCRIPT.md`.

- **Beat 1** — A fake authority identity (`UP-GZB-9999`) is rejected and the attempt is audited.
- **Beat 2** — Case created from FIR; the jurisdiction router shows its reasoning on screen.
- **Beat 3** — Evidence upload: hash and signature computed in-browser, verified server-side, receipt downloaded.
- **Beat 4** — QR custody timeline; a deliberately broken chain reports structured gap findings.
- **Beat 5** — ★ **The winning beat.** Tamper the stored file from a terminal; click Verify; the **file light goes red while the ledger light stays green** — proving the file was touched, not the log.
- **Beat 6** — AI triage shows *Review Priority: HIGH* with its disclaimer, never a verdict.
- **Beat 7** — An FSL examiner sees only their own laboratory's referrals; files a signed opinion.
- **Beat 8** — An advocate on record sees the served set; one not on record is **denied and logged live**.
- **Beat 9** — One-click s.63 certificate → PDF → scan its QR → public verifier confirms it, with no login.
- **Beat 10** — The audit feed shows the denial that just happened.
- **Beat 11** — The Merkle anchor batch and its Monad Testnet record; root only.

---

## 12. Roadmap — where this is going

Full plan in `docs/PRODUCTION_ROADMAP.md`. Five phases, seven workstreams, no cloud spend required.

- **Phase A** — CI/CD gating, branch protection, a `KeyProvider` abstraction so every secret goes through one interface; key-compromise runbook; data-retention policy.
- **Phase B** — **RAG-based deepfake-detection triage pipeline** (see §13).
- **Phase C** — Containerization, two-replica concurrency verification, backup/**rehearsed** restore, load testing to justify rate limits.
- **Phase D** — Observability: metrics, dashboards, and one alert that matters (`CHAIN_BROKEN`).
- **Phase E** — A second red-team pass against the newly added surface, UX polish, rehearsed demo.

---

## 13. The planned AI upgrade — describe carefully

- **What is planned:** replacing the current metadata-only heuristic with a **RAG-grounded, LLM-assisted analysis pipeline** for deepfake-oriented review prioritisation.
- **Architecture:** a pluggable `TriageProvider` interface. The existing heuristic becomes `heuristicProvider`; the new one is `ragDeepfakeProvider`. Both return an **identical output shape**.
- **RAG design:** a curated, versioned knowledge base of forensic manipulation indicators; local feature extraction (EXIF, error-level analysis, frequency-domain statistics, frame consistency); retrieval of the most relevant indicator descriptions; the model reasons over **extracted features plus retrieved indicators**.
- **Data-handling stance (recommended and planned):** the external model receives **extracted features only — never raw evidentiary media**. This is a deliberate decision, recorded as an ADR, because case evidence may include sensitive material (the demo case is a POCSO matter).
- **Availability:** circuit breaker + budget cap + hard timeout, with automatic fallback to the deterministic heuristic. **An evidence upload must never fail because the AI pipeline is unavailable.**
- **The boundary does not move.** The new provider must pass the *same* compliance test as the old one: never a verdict, never a percentage, always `Review Priority` with the disclaimer.
- **Tense discipline:** this is **planned/in-progress**, not shipped. Write it as roadmap, never as a current capability.

---

## 14. Rules for agents generating submission documents

**Forbidden claims — these are false. Never write them.**

- ❌ "Integrated with CCTNS / eCourts / FSL LIMS." → ✅ *"Integrates with three authority directory services that model CCTNS, eCourts and the FSL LIMS; the integration contract is designed so real systems can be substituted."*
- ❌ "AI detects fake/forged evidence" or "AI verifies authenticity." → ✅ *"AI prioritises which exhibits a human examiner reviews first; only a notified laboratory determines authenticity."*
- ❌ "Evidence is stored on the blockchain." → ✅ *"Only a Merkle root is written on chain; evidence never leaves encrypted off-chain storage."*
- ❌ "Evidence is currently being anchored on-chain." → ✅ *"The anchoring contract is deployed and live on Monad Testnet; the pipeline runs in dry-run mode pending a funded signer key."*
- ❌ "Security audited" / "certified" / "compliant." → ✅ *"Adversarially tested with a 40-attack red-team suite; no independent third-party audit has been performed."*
- ❌ "Production-deployed" / "live in the cloud." → ✅ *"Runs locally; deployment is a configuration change, not a rewrite."*
- ❌ Any accuracy percentage for the AI (e.g. "95% accurate deepfake detection"). **No such figure exists or ever will** — the system deliberately never emits a percentage.
- ❌ Inventing metrics, user counts, pilot deployments, partnerships, or endorsements.

**Required practices**

- Prefer the **mechanism** over the adjective. Not *"highly secure"* — say *"one deny-by-default policy point, verified by a 58-assertion authorization matrix."*
- Use exact numbers from §3; do not round up or estimate.
- Preserve controlled vocabulary exactly: **"Review Priority"**, not "AI score"; **"forensic opinion"**, not "AI verdict".
- When describing a limitation, state it plainly. `docs/PRODUCTION_READINESS.md` is deliberately unflattering — that honesty is a strength to mirror, not a weakness to hide.
- Cite the repository file that substantiates a claim wherever practical.

---

## 15. Documents to generate for SIH submission

Typical SIH deliverables and where the substance for each lives:

- **Idea / solution summary** — §1, §2, §4. Lead with the three defining claims.
- **Technical approach** — §7 (stack), §9 (architecture), §10 (security). Include the architecture diagram.
- **Feasibility & viability** — §3 (proven with test counts), §12 (roadmap), plus `docs/PRODUCTION_READINESS.md` §7 for honest limitations and their mitigations.
- **Impact & benefits** — §2 mapped to §4; frame each feature as the specific courtroom problem it removes.
- **Innovation / differentiators** — strongest four:
  - The **AI/forensic separation enforced in code**, not policy — a legally defensible design most systems get wrong.
  - **Client-side hashing and signing** with a non-extractable key — integrity established before a byte is uploaded.
  - **Four independent verification lights** that are never merged into one verdict — a modified file with an intact ledger tells you precisely *which* record moved.
  - **Federated identity with live re-verification** — a transferred officer or suspended advocate loses access on their next request, with no administrator action.
- **References / research** — BSA 2023 (s.39, s.45A, s.63), BNSS 2023 (s.176(3), s.230), IT Act s.79A, MeitY notification framework for forensic laboratories.
- **Demo plan** — §11, expanded from `docs/DEMO_SCRIPT.md`.

---

## 16. Repository map for verification

Verify before asserting. Key files:

| Claim to verify | File |
|---|---|
| Authorization model | `backend/services/accessResolver.js` |
| AI/forensic vocabulary separation | `backend/models/enums.js` |
| Current triage behaviour | `backend/services/triage.js` |
| Ledger hash chain + immutability | `backend/services/ledger.js`, `backend/models/Ledger.js` |
| Cryptographic primitives | `backend/config/crypto.js` |
| Browser hashing/signing | `frontend/lib/crypto.js` |
| Smart contract | `contracts/contracts/LexxAnchor.sol` |
| Deployment record | `contracts/deployments/monad-testnet.json` |
| All architectural decisions (21) | `docs/AGENT_DECISIONS.md` |
| Security findings (6) | `docs/SECURITY_FINDINGS.md` |
| Honest limitations | `docs/PRODUCTION_READINESS.md` |
| Full API reference (56 routes) | `docs/API.md` |
| Demo script | `docs/DEMO_SCRIPT.md` |
| Production plan | `docs/PRODUCTION_ROADMAP.md` |

- **Commands to confirm status:** `npm test` (448 tests) · `npm run contracts:test` (36) · `npm run routes` (56) · `npm run health` (6 checks)
