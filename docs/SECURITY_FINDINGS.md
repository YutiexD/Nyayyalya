# LEXX 2.0 — Security Findings

Every vulnerability found during the build, how it was fixed, and the regression test that now prevents it returning.

Findings are recorded whether they were found by review, by a test, or by the adversarial pass. A finding with no regression test is not closed.

**Status key:** `FIXED` — corrected and covered by a test. `ACCEPTED` — a deliberate, documented trade-off. `OPEN` — known and not yet fixed.

---

## SEC-001 — Any investigating officer could upload evidence into any case

| | |
|---|---|
| **Severity** | **High** — broken access control (OWASP A01), evidence injection |
| **Status** | FIXED |
| **Found by** | Integration test written against the intended policy, before the code was trusted |
| **Component** | `backend/services/accessResolver.js` → `resolveCreate` |

**What was wrong.** Creation was authorised by ROLE alone. `resolveCreate` for `EVIDENCE` asked only "is this user a police IO or SHO?" and never asked "may they write *this* case". Because uploads carry `caseId` in the request body, any authenticated investigating officer could upload evidence into any case in the system — another officer's case, another station's, another district's — and it would be accepted, stored, hashed, signed and written into the ledger as a legitimate exhibit for that case.

**Why it mattered.** This is worse than an information leak. It is a *write* into the evidentiary record of a case the attacker has no relationship to, and every downstream artefact — the ledger entry, the receipt, the s.63 certificate — would then attest to it. It also defeated the case-stage rule: evidence could be added to a case already at trial.

**How it was found.** A test asserting the intended behaviour: *"rejects an upload to a case the officer is not on"*. It returned `201` where `403` was expected. The read path had been tested thoroughly and was correct; the create path had a separate, weaker policy that nothing had exercised.

**The fix.** Not another bespoke check — the root cause was having two policies. Creating something *under* a case is a WRITE to that case, so `resolveCreate` now loads the case from the database and runs the **same** `evaluate()` used by every other write. Station scope, IO assignment, case stage and court binding all apply automatically, and can no longer drift apart from the read path. Role remains a capability pre-check (`CREATE_CAPABILITY`), but it is no longer the whole test.

**Regression tests.**
- `backend/tests/integration/evidence.test.js` — "rejects an upload to a case the officer is not on"
- `backend/tests/authz/matrix.test.js` — the full cross-scope matrix (49 assertions) re-run and green after the change
- `backend/tests/redteam/*` — body-injected `caseId` / scope fields

**Lesson recorded.** Any second authorization path is a second place to be wrong. Where a code path genuinely cannot use the main policy entry point, it should still terminate in the same `evaluate()` rather than reimplement its own version of the rules.

---

## SEC-002 — Directory format rejections aborted identity resolution

| | |
|---|---|
| **Severity** | Low — availability, not access control |
| **Status** | FIXED |
| **Component** | `backend/services/directoryClient.js` → `resolveIdentity` |

**What was wrong.** Identity resolution probes all five directory endpoints in parallel. Each directory validates identifiers against its own format, so a police PIS number (`UP-GZB-4471`) is correctly rejected as a malformed Bar Council enrolment number with a `400`. The client treated any non-404 `4xx` as fatal, so **every** login and activation failed.

**Why it mattered.** Total authentication outage. It failed closed, so it was not an access-control issue — but a system that cannot authenticate anyone is not a working system.

**The fix.** `probe()` distinguishes three outcomes: a `404` or a format `400` means "this directory has no such person"; a transport failure or `5xx` means "we cannot know", propagates, and the caller fails closed with `503`. The distinction is now explicit and commented, because collapsing "absent" into "unavailable" in the other direction would be a genuine security bug — it would let a directory outage read as a valid identity.

**Regression tests.** `backend/tests/integration/auth.test.js` — the full activation and login suite (34 assertions) exercises all five probes on every call.

---

## SEC-003 — `qs`, `multer` and `vitest` shipped with known advisories

| | |
|---|---|
| **Severity** | Moderate (reachable DoS) / High (file-upload CVEs) |
| **Status** | FIXED |
| **Component** | Dependency set |

**What was wrong.** The initial install carried nine advisories: `multer` 1.x (multiple CVEs, and it handles *every evidence upload*), a `qs` DoS and array-limit bypass reachable through Express 4's `body-parser` (it parses *every query string*), and critical advisories in `vitest` 2.x.

**The fix.** Resolved at intake, before any feature code was written: multer to 2.x, `qs` pinned forward via an npm `overrides` entry, vitest and its coverage provider to 5.0.0 (pinned exactly — the coverage package declares an exact peer). `npm audit` now reports **0 vulnerabilities**.

**Regression control.** `npm audit` is part of the final gate. Starting clean is what makes it possible to keep clean: with nine pre-existing advisories, nobody can tell a new problem from the background noise. See ADR-017.

---

## SEC-004 — Lenient `Authorization` header parsing

| | |
|---|---|
| **Severity** | Low — hardening; not independently exploitable |
| **Status** | FIXED |
| **Found by** | Red-team pass, `attacks.test.js` |
| **Component** | `backend/middleware/authenticate.js` |

**What was wrong.** The header was split on whitespace and the second field taken as the token, so `Authorization: Bearer <token> anything-else` was accepted.

**Why it mattered.** Not exploitable alone — the token still had to verify against our secret, so no forged session was possible. It is recorded because lenient header parsing is the raw material of request-smuggling and proxy-desync attacks: when a front proxy and an origin disagree about where a header value ends, they disagree about who the request is from. There is no legitimate client that sends this shape.

**The fix.** Exactly two whitespace-separated parts, scheme `Bearer`, and the credential must match the three-segment base64url shape of a JWT. Anything else is rejected before verification is attempted.

**Regression test.** `backend/tests/redteam/attacks.test.js` — "rejects a malformed Authorization header" (covers empty, scheme-only, wrong scheme, trailing junk, lowercase-only).

---

## SEC-005 — Rotating a signing key would have invalidated all past signatures

| | |
|---|---|
| **Severity** | Medium — evidentiary integrity, false-negative integrity reporting |
| **Status** | FIXED |
| **Found by** | Design review while working out how a demo operator on a new device signs anything |
| **Component** | `backend/models/Evidence.js`, `backend/controllers/evidence.js` |

**What was wrong.** Verification looked up the signer's **current** public key (`User.publicKeyJwk`) to check a signature made months earlier. There was also no way to register a new key at all, so the latent bug was hidden behind a missing feature.

**Why it mattered.** The moment key rotation existed — and it must, because officers lose phones — every exhibit that officer had ever uploaded would begin reporting `signatureValid: false`. Not a crash, not an error: a **false integrity failure** on evidence nobody had touched. In a system whose entire value is telling a court which records are trustworthy, wrongly marking sound evidence as unverifiable is as damaging as missing a real tamper, and far harder to explain afterwards.

The inverse is the subtler risk: an operator who learns that "signature red is normal after a re-key" stops treating a red signature light as meaningful, and a genuinely forged signature then goes unremarked.

**The fix.** Two parts.

1. `Evidence.signerPublicKeyJwk` pins the public key that **actually made** the signature, at ingest, immutably. Verification uses that snapshot. A signature is a statement made at a moment by a specific key, and it stays checkable against that key forever.
2. `POST /api/auth/rotate-key` registers a new device key. It costs a live session **and** a fresh OTP to the phone on record, re-verifies the directory (a suspended officer cannot re-key), revokes all refresh tokens, and is audited. The retired key immediately stops being able to sign new evidence.

**Regression tests.** `backend/tests/integration/evidence.test.js` — "keeps an old exhibit verifiable after the officer re-keys a new device"; "pins the signing key on the evidence record at ingest"; "rejects uploads signed with the OLD key after rotation"; plus refusals without a session and without a valid OTP.

**Note on scope.** Records created before this field existed fall back to the signer's current key, and for those a rotation would legitimately show as unverifiable. There are none in practice — the field was added before any deployment — and the fallback is commented as such rather than left as a silent path.

---

## SEC-006 — The seed wrote private keys to a file that was not gitignored

| | |
|---|---|
| **Severity** | Medium — credential exposure risk (self-inflicted, in tooling) |
| **Status** | FIXED |
| **Found by** | Final review, checking our own output rather than the product |
| **Component** | `seed/seed-all.js`, `.gitignore` |

**What was wrong.** `npm run seed` writes `seed/.demo-identities.json` containing the **ECDSA private keys** of all nine demo accounts, so a demo operator can sign from any machine. The file was written with mode `600`, but `.gitignore` covered `.env*`, `*.pem` and `*.key` — and matched none of them. A routine `git add -A` would have committed nine signing keys.

**Why it mattered.** These are demo keys with no real-world authority, so the direct impact is low. It is recorded at Medium anyway because the failure mode is the one that actually causes credential leaks in practice: not a weak algorithm, but a secret written to a path nobody thought to exclude. The repository had no commits yet, so nothing was exposed — but that was timing, not design.

**The fix.** Explicit `.gitignore` entries for `seed/.demo-identities.json` and `**/.demo-identities.json`, with a comment stating what the file contains and why it must never be committed. Verified with `git check-ignore -v`.

**Worth noting about the design.** The file exists because signing keys are normally non-extractable and never leave the browser — which is correct, and which makes seeded demo state awkward. The production answer is already implemented: `POST /api/auth/rotate-key` lets an officer on a new device register a fresh key, and past evidence stays verifiable because each record pins the key that signed it (SEC-005). The identities file is a demo convenience, and is labelled as one inside its own contents.

---

## Design-level protections adopted before they could become findings

These were not bugs found in this codebase — they are known failure modes in the *design as specified*, closed during implementation. Each is recorded as an ADR with its reasoning.

| Risk | Where it would have bitten | Control | ADR |
|---|---|---|---|
| Body-injected scope (`stationCode`, `courtId`, `labId`) bypassing every jurisdiction check | Spec §5 passes a `resource` object into the resolver | Resolver loads resources from the database itself; controllers cannot supply them | ADR-003 |
| Stale authority in a still-valid JWT (suspended, transferred, roster-rotated) | Spec §4.3 puts `role`/`scope` in the token | Session context re-read from the database on every request; token claims are a hint | ADR-005 |
| OTP factor rendered decorative by the demo echo | Spec §7 "Demo: returns it in the response" | Hashed, single-use, purpose-bound, attempt-capped, rate-limited; echo behind a flag refused in production | ADR-004 |
| Forked or gapped hash chain under concurrent writes | Spec requires strictly-increasing `seq` with no concurrency strategy | Atomic counter + cross-process advisory lock + unique index backstop | ADR-006 |
| Hash-input ambiguity and client-controlled chain input | `sha256(seq\|prevHash\|payloadHash\|occurredAt)`, undelimited | Delimited, versioned canonical string; server-authoritative timestamps | ADR-007 |
| Cross-case key exposure | "master key in env", no KEK derivation defined | Per-case KEK via HKDF, case id bound as AEAD additional data | ADR-008 |
| Silent cross-case data loss | `storageKey == sha256Server` | Per-evidence discriminator in the object key | ADR-009 |
| Replayable download URLs | "signed 60s URL" | Single-use tokens bound to user + resource + purpose, consumed atomically | ADR-010 |
| A photographed QR tag treated as authority | QR HMAC is static per item | A valid tag is identification only; every action re-runs the resolver | ADR-011 |
| Case metadata leak via an unauthenticated chain walk | `verify-chain` marked access `any` | Authenticated and scope-filtered; public surface limited to anchors and certificate validity | ADR-012 |
| MIME spoofing on evidence upload | Not addressed in spec | Allowlist plus magic-byte sniffing; declared type must match content | `services/fileType.js` |
| Path traversal via storage keys | Content-addressed paths | Keys must match a strict pattern; resolved path re-checked to be inside the vault | `services/storage.js` |
| Algorithm confusion on JWTs (`alg: none`) | Not addressed in spec | Verification algorithm pinned to HS256; asserted by test | `services/tokens.js` |
| Refresh-token theft | Not addressed in spec | Hashed at rest, single-use, rotated; reuse revokes the whole family | `services/tokens.js` |
| User enumeration via login errors | Not addressed in spec | Uniform `BAD_CREDENTIALS`; bcrypt comparison runs even for unknown users | `controllers/auth.js` |
