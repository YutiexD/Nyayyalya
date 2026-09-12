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
| Backend tests | **525 passing**, 18 suites, 0 skipped, 0 failing |
| Contract tests | **36 passing** |
| Lint | 0 errors (26 `require-atomic-updates` warnings — the documented false-positive pattern in the anchor service and in sequential test setup) |
| API surface | **71 routes**, all documented in `docs/API.md` |
| Architecture decisions | **39 ADRs** recorded in `docs/AGENT_DECISIONS.md` |
| Security findings | **6 found, 6 fixed**, each with a regression test (`docs/SECURITY_FINDINGS.md`) |
| Smart contract | **Deployed and live** on Monad Testnet — see §8 |
| Live anchoring | **Active in the local deployment** (`ANCHOR_ENABLED=true` in `.env`): Merkle roots are submitted and confirmed on Monad Testnet — see §8 |
| Cloud deployment | **Not deployed.** Runs locally / on a single machine |
| Independent security audit | **Never performed.** Do not imply otherwise |

- The codebase is roughly **48,500 lines** across 151 files (backend, three directory services, frontend, contracts, tests, docs).

---

## 4. Features — the twelve, with the mechanism behind each

State the *mechanism*, not just the feature name. The mechanism is what makes each claim credible.

- **F1 — Provisioned authentication.** No self-registration; `POST /api/auth/register` returns **410 Gone**. Accounts exist only if the person is already ACTIVE in an authority directory. Role and jurisdiction are read from that directory, never from the request body.
- **F2 — Case creation + jurisdiction router.** Cases are created only from an FIR that already exists in the police directory. A pure function computes the correct court (Magistrate / Sessions / Special), picks it from the district's courts as the court directory lists them, and **shows its reasoning on screen** — e.g. *"Maximum punishment 20 years — triable by a Court of Session"*, *"Victim is a minor — POCSO designated court required"*. **Filing the chargesheet registers the case with that court**, which allots the CNR (a simulated eCourts registration, ADR-035); a designation no local court holds is refused, never routed to an ordinary court. Filing starts the fourteen-day BNSS s.230 disclosure clock.
- **F3 — Evidence upload with client-side hash + signature.** The browser computes SHA-256 and signs it with an **ECDSA P-256 key that is non-extractable and never leaves the device**. The server recomputes the hash from the bytes it received and verifies the signature against the key registered at activation. Failure of either check is refused *and written to the ledger*.
- **F4 — QR-based physical custody chain.** Booking an item prints a **custody label**: a QR that opens the item in Lexx (`/scan?label=…`) plus the particulars checked against the bag by eye (item code, seal number, FIR, IMEI/serial, who seized it). Movement is a two-scan handshake done on screen: the holder picks a **named** receiver and gets a single-use code (5-minute TTL), the receiver scans the label (or opens the row in any custody register — officer, station, court, lab) and enters the code with the seal condition. Handovers continue after the chargesheet (articles still travel to court); booking a *new* article does not (ADR-036). Broken seals freeze custody until the **SHO records a decision** (optionally re-sealing); the exception stays in the chain. Gap detection reports structured findings (`ILLEGAL_STATE_TRANSITION`, `SEQUENCE_DISCONTINUITY`, `STATE_DIVERGENCE`).
- **F5 — Integrity verification (four independent lights).** File integrity, uploader signature, ledger chain, on-chain anchor — each recomputed from first principles and reported **separately, never merged into one verdict**. Available to the officer, the court and counsel on the same exhibit. The **public verifier** (no account) checks a s.63 certificate — by its token, or by **dropping the PDF itself**, which it hashes in the browser and reports as the current registered document, an earlier version, or not the registered document (ADR-039) — an officer's **upload receipt** (ledger sequence + entry hash, against the register and the anchored root, with the contract's own `verifyEntry`), and lists anchored batches with explorer links.
- **F6 — Automatic review priority.** **Every** exhibit is banded the moment it is registered — `CRITICAL | HIGH | MEDIUM | LOW` — from the file's own metadata, the integrity of its upload, its media type and the gravity of the case. Nobody is asked for it: there is no field on any form and no endpoint that sets one, so no role can push its own work up a laboratory's queue. Each band comes with the sentences behind it ("container and stream durations disagree by 19s"). What was *observed about the file* sets the band; how grave the case is can move it up one place and never into `CRITICAL`. Never a verdict. See §6 — this boundary is the most important thing in the system.
- **F7 — FSL review.** An examiner's queue is the digital evidence registered in the state their laboratory serves, plus anything formally referred to it, **in review-priority order** (ADR-042). They record a signed opinion of `AUTHENTIC | MANIPULATED | INCONCLUSIVE` — **the only authenticity vocabulary in the entire system** — in one step, with a report document optional; the record says which route produced it. The formal referral pipeline (refer → accept → report) is unchanged and is how a station puts *named questions* to a *named* laboratory about a sealed article it has sent.
- **F8 — Vakalatnama e-filing, disclosure sets + advocate scoping.** An advocate comes on record **only** by filing a signed vakalatnama through Lexx (PDF hashed and signed in the browser); filing grants nothing. The **presiding judge** accepts or refuses it; on acceptance the appearance is written to the **court register first** — which verifies the judge against the roster order placing them in that court today — and only then mirrored as access (ADR-030, ADR-040). **Disclosure is the court's, start to finish** (ADR-043): the police have no route to a disclosure pack at all, and `POST /api/disclosure/:caseId/share` composes the set, rules on every withholding and serves it in one act, writing all three ledger entries. The court rules on each withholding request **both ways** — withhold, or refuse and disclose (ADR-037); an unruled request blocks service. An advocate on record sees only the served exhibit set, and never machine triage on any read path (ADR-038). One outside the set gets `EXHIBIT_NOT_IN_DISCLOSURE_SET`; one not on record gets `NOT_ON_RECORD_FOR_THIS_CASE` — both reachable from counsel's **Open by reference** (case by CNR, exhibit by code), both audited. Per-recipient watermarking makes leaks traceable, and the court can **trace** a leaked page's watermark token back to its recipient.
- **F9 — BSA s.63 certificate.** Part A auto-fills from the evidence record and ledger timeline. Part B can only come from a filed FSL report. **Generation is refused if any Part A field is missing**, returning the exact missing-field list — refusing to produce an incomplete legal document is a feature, and should be presented as one. Issued, signed by **both parties** (the deponent signs Part A on the officer's exhibit screen; the examiner signs Part B on the Lab screen) and downloaded from the exhibit screens; each certificate shows its verification link, QR and copy buttons for the public verifier. A certificate issued before the laboratory reported is flagged: a fresh one is needed to carry Part B.
- **F10 — Audit log.** Every authorization decision, **allow and deny**, is recorded. Audit rows are append-only.
- **F11 — Merkle anchoring.** Ledger entries are batched into a Merkle tree; only the **root** goes on chain. See §8.
- **F12 — Search.** Scope filter is applied **before** the query, never as a post-filter on results.

---

## 5. Roles — ten, across four authorities

Roles are **derived from external directories**, never assigned inside LEXX.

- **POLICE authority**
  - `IO` — Investigating Officer. Owns their own cases; cannot write once the case leaves investigation. Opens cases from FIRs, registers evidence, books articles into custody, files the chargesheet.
  - `SHO` — Station House Officer. Sees every case and every exhibit at their station in review-priority order, and the chains of custody that do not add up. **No workflow waits on an SHO.** What only they can do is lift a custody freeze after a broken seal, and put named questions to a named laboratory.
  - `DISTRICT_SP` — District Superintendent. District-wide **read-only** oversight.
- **COURT authority**
  - `JUDGE` — Reached via the court **roster**, never assigned by LEXX. Holds the whole of the court's authority over the cases listed in their court: the exhibits, the physical articles, the ledger, judicial orders (only a judge can), ruling on vakalatnamas, sharing the case file with counsel, issuing s.63 certificates, tracing a leaked copy, and **closing the case**. What they cannot do is write the investigation: a `WRITE` against a case or an exhibit is refused.
  - `EVIDENCE_CUSTODIAN` — Court-side evidence room. Receives and keeps the physical articles produced in court, and reads the cases it holds them for. It rules on nothing.
  - Seeded courts: Sessions Court No. 2 (POCSO and SC/ST designated — judge `UP-JUD-2291`, evidence room `UP-GZB-EVC-01`) and the Court of the CJM (judge `UP-JUD-1180`, evidence room `UP-GZB-EVC-02`).
- **FSL authority**
  - `FSL_EXAMINER` — Sees the digital evidence registered in the state their laboratory serves, plus anything referred to it, ordered by review priority. The only role that can state an authenticity opinion. Signs Part B of the certificate; receives a sealed article while their lab holds a referral in its case, and hands it back after reporting.
- **LEGAL authority**
  - `DEFENCE_COUNSEL`, `VICTIM_COUNSEL`, `LEGAL_AID_COUNSEL`, `PUBLIC_PROSECUTOR` — Case-scoped and read-only. An advocate **files a vakalatnama through Lexx**; access exists only once the court accepts it and the court register records it (or via a legal-aid order). Counsel can open, verify and read the certificate of each exhibit served on them — nothing else.

### Two roles this product deliberately does not have

`MALKHANA_CUSTODIAN` and `REGISTRAR` were removed (ADR-040), and the reason is the same for both: **neither made a decision.** Each was an account the workflow had to wait for.

- The custodian's real contribution was a rule — *the officer on a case must not keep that case's evidence* — and that rule is unchanged, now enforced against whoever would actually end up holding the article. The station store is still a place, every movement is still a two-scan ledgered handover, and the custody register is station-wide because an article in the store is kept by the station.
- The registrar was a second court login standing between a judge's decision and its effect. It is where rehearsals stalled: an advocate filed a vakalatnama, the judge could see it and could not act on it, and the defence saw nothing.

If asked, say it plainly: *we removed the two steps that added a login and no decision.*

**Key architectural point to convey:** advocates get **no jurisdictional scope at all**. Their access is purely per-case, granted by a court-asserted fact.

---

## 6. The compliance boundary — the most important section in this file

- **AI triage produces ONLY:** a `Review Priority` of `CRITICAL | HIGH | MEDIUM | LOW`, a list of indicators, a model name/version, and a fixed statutory disclaimer.
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
  - JavaScript, no TypeScript
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
  - **React 18** single-page app on **Vite 7**, **React Router 7**, **TanStack Query 5**, **Redux Toolkit 2**
  - **Tailwind CSS 3** + shadcn/Radix components, GSAP for motion, `qrcode` for labels and certificate QRs; no CDN dependencies (works offline)
  - **Web Crypto API** — SHA-256 hashing and ECDSA P-256 signing in-browser (evidence, FSL reports, vakalatnamas, certificate signatures)
  - **IndexedDB** — stores the non-extractable private key
- **Blockchain**
  - **Solidity 0.8.24**, EVM target `paris`
  - **Hardhat 2.22** + **@nomicfoundation/hardhat-toolbox**
  - **OpenZeppelin Contracts v5** — `AccessControl`, `MerkleProof`
  - **Monad Testnet** — chain ID **10143**
- **Testing**
  - **Vitest 5** — 525 backend tests across unit / integration / authz / redteam
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
- **When things go on chain:** every ledger write (upload, custody move, referral, report, vakalatnama ruling, disclosure step, order, certificate) is appended to the hash-chained ledger. Every `ANCHOR_INTERVAL_MS` (5 min), and once at the end of `npm run seed`, the new entries are batched into a Merkle tree and **one root** is submitted to `LexxAnchor.anchorBatch`. A batch is `CONFIRMED` only after its receipt is read back with `status === 1`.
- **Current anchoring state — state it exactly:**
  - The local `.env` runs with `ANCHOR_ENABLED=true` and a signer holding `ANCHOR_ROLE` (funded with testnet MON). Roots **are submitted and confirmed** on Monad Testnet — first live batches confirmed in blocks 61687401–61687421, and the contract's `verifyEntry` confirmed a ledger entry's Merkle proof. `.env.example` still defaults to `false` (DRY_RUN) for a fresh checkout without a funded key.
  - Switching submission on also promotes earlier `DRY_RUN` batches to the chain, oldest first (ADR-033). Batch ids commit to their root, so a reset ledger never collides with batches already on chain (ADR-032).
  - Correct phrasing: *"Merkle roots of the ledger are anchored on Monad Testnet every five minutes; each confirmed batch has a transaction anyone can open on the explorer."*
  - Incorrect phrasing: *"Evidence is stored on the blockchain"* — only roots go on chain. If a deployment runs with `ANCHOR_ENABLED=false`, the verifier shows roots amber as "recorded locally, nothing submitted" and it must be described as dry-run.
- **Outcomes are read from receipts.** Once a transaction is sent, an RPC error while waiting is settled from the transaction receipt; an unanswered batch stays `SUBMITTED` and nothing new is batched over it; one recorded `FAILED` despite a mined transaction is corrected on the next cycle (ADR-039 — found live: batch 27–28 was mined in block 61704167 but recorded `FAILED`).
- **What anchoring proves:** that a set of ledger entries existed in exactly that form at that time.
- **What anchoring does NOT prove:** that the entries are true, that evidence is authentic, or that nothing was omitted.
- **Verified integration:** the backend's Merkle implementation is cross-checked against the deployed contract at **nine tree sizes** — every backend-generated proof verifies on-chain, and forged leaves are rejected on-chain (`contracts/scripts/cross-check-backend-merkle.js`).

---

## 9. Architecture

```
CLIENT (React SPA on Vite, :5173) — role views + /scan + public verifier
  · SHA-256 hash + ECDSA P-256 sign in-browser, key non-extractable in IndexedDB
        │  JWT (15 min) + rotating refresh token
LEXX CORE API (Express :5000, db lexx_core)
  · authenticate → resolveContext → authorize → audit
  · services/accessResolver.js  ← THE single policy point
  · modules: auth · case · evidence · custody · fsl · disclosure
             vakalatnama · certificate · ledger · audit · search · anchor
        │                    │                      │
   MongoDB            Object vault            Anchor service
   lexx_core          ./vault                 Merkle batcher →
   + append-only      AES-256-GCM             MONAD TESTNET
     hash chain       envelope-encrypted      (root only)

EXTERNAL AUTHORITY DIRECTORIES (mock government systems, read-only to LEXX)
  POLICE :6001 (CCTNS)   COURT :6002 (eCourts)   LEGAL/FSL :6003 (BCI + FSL LIMS)
```

- **Three authority directories** are **deliberate mocks** standing in for CCTNS, eCourts and FSL LIMS. They are separate services with separate databases, and **every route is a GET, enforced by middleware, except two simulated court-registry acts** in the court directory. LEXX's only writes into any directory are relaying **the presiding judge's acceptance of a vakalatnama** (carrying the judge's own code, which the directory verifies against its judges *and* against the roster order placing them in that court today, before recording anything — ADR-030, ADR-040) and **registering a filed chargesheet** with the court the jurisdiction router chose, which allots the CNR (the directory refuses a court it does not hold — ADR-035). It cannot create identities, postings or rosters, and cannot choose a court the statute does not point at.
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
- **Beat 4** — Print a custody label (QR + seal particulars), scan it, hand the item over to a named receiver with a one-time code; a deliberately broken chain reports structured gap findings.
- **Beat 5** — ★ **The winning beat.** Tamper the stored file from a terminal; click Verify; the **file light goes red while the ledger light stays green** — proving the file was touched, not the log.
- **Beat 6** — AI triage shows *Review Priority: HIGH* with its disclaimer, never a verdict.
- **Beat 7** — An FSL examiner sees only their own laboratory's referrals; files a signed opinion.
- **Beat 8** — An advocate on record sees the served set; one not on record is **denied and logged live** — then files a vakalatnama through Lexx, the presiding judge accepts it, the court register records it, and the case file is shared with them, with their own watermark.
- **Beat 9** — One-click s.63 certificate → PDF → scan its QR → public verifier confirms it, with no login. The officer's upload receipt is checked there too.
- **Beat 10** — The audit feed shows the denial that just happened.
- **Beat 11** — The Merkle anchor batch and its **confirmed Monad Testnet transaction** on the explorer; root only.

### Where to get what you paste (demo mode)

| What | Where it appears in the app | In demo mode |
|---|---|---|
| Certificate verification link / token | QR on the certificate PDF; copy buttons on every certificate panel (officer exhibit, court Exhibits tab, counsel's served exhibit, lab Part B) | printed at the end of `npm run seed` (EX-…-001, and EX-…-002 awaiting the examiner's Part B); `node scripts/demo-lookup.js` |
| A certificate PDF someone handed you | nothing to paste — drop the file on `/verify` ("Were you handed a certificate?"); its token is read from the file | Download PDF on any certificate panel |
| A case or exhibit counsel is not entitled to | Counsel → Open by reference: CNR `UPGB010012342026` (as `UP/9876/2019`), exhibit `EX-01232026-003` (as `UP/1234/2015`) | — |
| Upload receipt (ledger seq + entry hash) | receipt JSON downloaded at upload; "Check this receipt" link on the officer's exhibit panel | `node scripts/demo-lookup.js` prints ready `/verify?seq=…&entry=…` links |
| Custody label | QR + text on the printed label; "Print label" / "Copy label text" on every custody register | `node scripts/demo-lookup.js` prints each label and its `/scan` link |
| Handover code | shown once to the sender after "Start handover" (copy button + QR) | — (one-time, 5 minutes) |
| Pack / exclusions / recipients | picked on screen ("Use this pack", tick boxes by exhibit code and advocate name) | — |
| Watermark token (leak trace) | the recipient's watermark banner and every served page; the serve result | `node scripts/demo-lookup.js` |
| Vakalatnama CNR | case's CNR on the court cause list | `UPGB010012342026` |
| Anchor transactions | public verifier → "Anchoring history" | `node scripts/demo-lookup.js` prints explorer links |

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
- ❌ "Evidence is being anchored on-chain." → ✅ *"Merkle roots of the ledger — never evidence — are anchored on Monad Testnet every five minutes."* (True of the local deployment with `ANCHOR_ENABLED=true`; for a deployment without a funded key, say it runs in dry-run.)
- ❌ "Lexx assigns / approves lawyers." → ✅ *"An advocate files a vakalatnama through Lexx; the presiding judge accepts it and the court register records it; Lexx then mirrors that record as access."*
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
| Browser hashing/signing | `frontend/src/lib/crypto.js` |
| Vakalatnama e-filing (lawyer on record) | `backend/controllers/vakalatnama.js`, `frontend/src/features/vakalatnama/Vakalatnama.jsx` |
| Custody labels, scan, hand-over | `backend/controllers/custody.js`, `frontend/src/features/custody/CustodyKit.jsx` |
| Certificate panel (link, QR, signing) | `frontend/src/features/certificates/CertificatePanel.jsx` |
| Public receipt check, anchor history | `backend/controllers/ledger.js`, `frontend/src/features/verify/VerifyPage.jsx` |
| Every value to paste in a demo | `scripts/demo-lookup.js` |
| Smart contract | `contracts/contracts/LexxAnchor.sol` |
| Deployment record | `contracts/deployments/monad-testnet.json` |
| All architectural decisions (34) | `docs/AGENT_DECISIONS.md` |
| Security findings (6) | `docs/SECURITY_FINDINGS.md` |
| Honest limitations | `docs/PRODUCTION_READINESS.md` |
| Full API reference (71 routes) | `docs/API.md` |
| Demo script | `docs/DEMO_SCRIPT.md` |
| Production plan | `docs/PRODUCTION_ROADMAP.md` |

- **Commands to confirm status:** `npm test` (525 tests) · `npm run contracts:test` (36) · `npm run routes` (71) · `npm run health` (6 checks)
