# LEXX 2.0 — Architecture Decision Record

Every decision that deviates from, disambiguates, or hardens `LEXX-MVP-Technical-Design.md`. Format: decision · reason · affected components · alternatives · security impact · testing impact.

Source-of-truth order: user requirements → technical design spec → intentional existing behaviour → engineering best practice.

---

## ADR-001 — MongoDB: one local `mongod` on a fixed port; in-process server for tests

**Decision.** Every service connects to `MONGO_URI` with a `dbName`, exactly as the spec intends — no service knows anything about "memory mode". For hosts without MongoDB installed, `npm run mongo:dev` starts a **real `mongod` binary** (fetched and cached by `mongodb-memory-server`) on a **fixed port with a persistent `dbPath`** at `.data/mongo`. The automated tests separately spin an ephemeral in-process server per test run.

**Reason.** No MongoDB, no Docker on the build host. Without this, nothing could be run or verified.

Binding the dev server to a fixed port with a persistent path — rather than letting each process start its own ephemeral instance — matters for three reasons: the four databases must be visible to each other's tooling, `seed/` and `reset/` run as *separate processes* and must reach the same data, and demo state must survive a service restart. An ephemeral-per-process design would have broken all three.

**Verified.** A cached `mongod` starts in ~0.5 s on this host.

**Affected.** `shared/mongo.js`, the three directory services, backend, test harness, `.env.example`, README.

**Alternatives.** (a) Require MongoDB install — blocks all verification. (b) Swap to SQLite/Postgres — violates the spec's locked stack decision and the "no rewrites" rule. (c) Mock the data layer in tests — would not exercise real indexes, unique constraints or the append-only guards, which are load-bearing security properties here.

**Security impact.** In-memory mode has no authentication and no durability. It is gated behind an explicit flag, refuses to start when `NODE_ENV=production`, and is documented as dev/test only.

**Testing impact.** Enables the entire suite. Tests run against real Mongo semantics, including the unique `seq` index that backs ledger integrity.

---

## ADR-002 — Blockchain network: Monad Testnet (supersedes Ethereum Sepolia)

**Decision.** The anchoring layer targets **Monad Testnet**, chain ID **10143**, explorer `https://testnet.monadexplorer.com`. Every reference to Ethereum Sepolia in the spec is superseded.

**Reason.** Explicit user requirement, which outranks the design document.

**Affected.** `contracts/`, Hardhat config, deploy scripts, `anchor.js`, `AnchorBatch.network` (value `monad-testnet`), `.env.example`, frontend explorer links, health checks, seed config, tests, README, all docs.

**Alternatives.** None considered — this is a directive, not a trade-off.

**Security impact.** Neutral. Monad Testnet is a high-performance EVM testnet; the trust properties of root-only anchoring are unchanged. Finality characteristics differ from L1 and are documented as a known limitation.

**Testing impact.** Anchor tests assert `network === "monad-testnet"` and chain ID `10143`. A grep-based regression test fails the build if a stale bare `sepolia` reference reappears in a network-configuration position.

---

## ADR-003 — The access resolver loads resources itself

**Decision.** `accessResolver.resolve()` accepts a resource **identifier and type**, and loads the record from the database internally. It never accepts a caller-supplied resource object as the basis for a policy decision.

**Reason.** Spec §5 shows `resolve({ user, action, resourceType, resource })`. If any controller passes something derived from the request body, an attacker sets `stationCode` to their own and every jurisdiction check passes. This is the single highest-impact bypass available in the design as written.

**Affected.** `services/accessResolver.js`, `middleware/authorize.js`, every controller.

**Alternatives.** Trust controllers to pass DB-loaded objects — rejected: it is a convention, not a control, and one mistake in one controller is a total bypass.

**Security impact.** Removes the primary authorization-bypass class (IDOR via body-injected scope fields).

**Testing impact.** Red-team tests post forged `stationCode`, `districtCode`, `courtId`, `labId`, `ioUserId` in request bodies and assert denial.

---

## ADR-004 — OTP hardening

**Decision.** OTPs are 6 digits from a CSPRNG, hashed (SHA-256) at rest, single-use, TTL-bounded, purpose-bound (`ACTIVATION` | `LOGIN`), attempt-capped, and rate-limited per authority ID. The plaintext OTP is returned in the API response **only** when `DEMO_ECHO_OTP=true`, which defaults to off and is refused when `NODE_ENV=production`.

**Reason.** Spec §7 says "Demo: returns it in the response". Left unconditional, that makes the OTP factor decorative for any direct API caller — which is exactly the attacker model the spec asks us to assume.

**Affected.** `models/OtpChallenge.js`, auth controller, `.env.example`, README, demo script.

**Alternatives.** Remove OTP from login — rejected, spec §4.2 is explicit. Always echo — rejected, it is a self-inflicted bypass.

**Security impact.** Prevents OTP replay, brute force and enumeration-by-timing. Keeps the demo workable through an explicit, visible flag.

**Testing impact.** Negative tests: reused OTP, expired OTP, wrong-purpose OTP, over-attempt lockout, rate limit.

---

## ADR-005 — JWT claims are a hint; the database is the authority

**Decision.** After signature verification, `resolveContext` re-reads the user from `lexx_core` and builds the session context from the **stored** `role`, `authority`, `scope` and `status`. JWT claims are used for lookup and for detecting staleness, never as the authorization input.

**Reason.** Spec §4.3 places `role` and `scope` in the JWT while §4.3's own note says never to trust `role` from the client. A JWT is client-held; a token minted before a suspension, transfer or roster change would otherwise carry stale authority for its full lifetime.

**Affected.** `middleware/authenticate.js`, `middleware/resolveContext.js`, `accessResolver.js`.

**Alternatives.** Short JWT lifetime alone — reduces the window but does not close it, and 15 minutes of a suspended officer's access is still a finding.

**Security impact.** Suspension, deactivation and scope change take effect on the **next request**, not the next login. Costs one indexed read per request.

**Testing impact.** Test: mint a valid token, suspend the user, assert the next request is denied.

---

## ADR-006 — Ledger sequence allocation is atomic

**Decision.** `seq` is allocated by an atomic `findOneAndUpdate({_id:"ledger"}, {$inc:{value:1}})` on a counter collection. The unique index on `seq` is the backstop; duplicate-key errors trigger a bounded retry with re-read of `prevHash`.

**Reason.** Spec requires "strictly increasing, unique" but gives no concurrency strategy. `max(seq)+1` under concurrency produces duplicate-key failures at best and a forked chain at worst.

**Affected.** `services/ledger.js`, `models/Counter.js`, `models/Ledger.js`.

**Alternatives.** Mongo transactions — require a replica set, which the memory-server dev path does not guarantee. A single-writer queue — simpler, but hides the race rather than solving it, and does not survive multiple processes.

**Security impact.** A forked or gapped chain destroys the tamper-evidence property that the whole system rests on.

**Testing impact.** Concurrency test fires N parallel appends and asserts a gapless, strictly-increasing, correctly-linked chain.

---

## ADR-007 — Canonical, delimited hash input; server-authoritative timestamps

**Decision.** `payloadHash = sha256(canonicalJson(payload))` with sorted keys and stable number/date encoding. `entryHash = sha256("v1|" + seq + "|" + prevHash + "|" + payloadHash + "|" + occurredAtISO)`. `occurredAt` is set by the server. Client-asserted times are preserved as `payload.clientOccurredAt` and are never chain input.

**Reason.** Undelimited concatenation is ambiguous (`"1"+"23"` collides with `"12"+"3"`). Client-controlled chain input lets a caller influence the hash.

**Affected.** `services/ledger.js`, `services/canonical.js`, verification endpoint, frontend verifier.

**Alternatives.** JCS (RFC 8785) — heavier; our canonicaliser implements the same essential guarantees for the value types actually used, and is unit-tested against ordering, unicode and nesting.

**Security impact.** Removes hash-ambiguity collisions and client influence over the chain.

**Testing impact.** Canonicalisation unit tests: key order, nesting, unicode, numeric forms, null vs missing.

---

## ADR-008 — Envelope encryption: HKDF per-case KEK

**Decision.** Per-evidence DEK is 32 random bytes. The case KEK is `HKDF-SHA256(masterKey, salt=kekId, info="lexx-case-kek:" + caseId)`. DEK is wrapped with AES-256-GCM under the KEK. Content is encrypted AES-256-GCM with a fresh 96-bit IV; the auth tag is stored alongside.

**Reason.** Spec fixes the shape ("per-evidence DEK, wrapped by a case KEK, master key in env") but not the derivation or rotation identity. Without a defined `kekId` the scheme cannot be rotated or audited.

**Affected.** `services/envelope.js`, `config/crypto.js`, evidence model.

**Alternatives.** One global KEK — loses per-case blast-radius containment. Random per-case KEK stored in the DB — an extra secret at rest for no gain over derivation.

**Security impact.** Compromise of one case's KEK does not expose other cases. Master key remains the single high-value secret; documented as an HSM/KMS swap in production.

**Testing impact.** Round-trip tests, wrong-KEK failure, tampered-ciphertext auth-tag failure, tampered-IV failure.

---

## ADR-009 — Storage key carries a per-evidence discriminator

**Decision.** Integrity identity remains the plaintext `sha256Server`. The stored object key is `sha256Server` combined with the evidence id.

**Reason.** Spec says `storageKey == sha256Server`. Because each evidence record encrypts under its own DEK, two records of the same file produce different ciphertext; a shared key means the second write destroys the first record's decryptable object.

**Affected.** `services/storage.js`, evidence model, verify endpoint.

**Alternatives.** Deduplicate by sharing one DEK for identical plaintext — leaks the fact that two cases hold the same file and couples their blast radius.

**Security impact.** Prevents cross-case data loss and cross-case coupling. Content addressing is preserved where it matters: the hash still identifies the plaintext.

**Testing impact.** Test: two cases upload byte-identical files; both remain independently decryptable and verifiable.

---

## ADR-010 — Single-use, bound stream tokens

**Decision.** Evidence streaming uses a server-stored token bound to `userId`, `evidenceId` and purpose, single-use, short TTL, consumed atomically on first use. Every access writes an audit event.

**Reason.** Spec's "signed 60s URL" is a bearer credential: anyone who obtains it inside the window replays it, and URLs leak through logs, referrers and screen shares.

**Affected.** `models/StreamToken.js`, evidence controller, frontend download flow.

**Security impact.** Removes replay and accidental-leak reuse. Audit remains attributable to a specific user.

**Testing impact.** Negative tests: reuse, expiry, use by a different user, use for a different evidence id.

---

## ADR-011 — QR authenticates the tag, not the bearer

**Decision.** QR payload stays as specified: `LEXX:v1:<itemCode>:<base64url HMAC-SHA256>`. Verified HMAC proves the tag was issued by Lexx. It grants **no** authority: every custody action re-runs `accessResolver`.

**Reason.** The HMAC is static per item, so a photograph of a printed tag reproduces it indefinitely. Treating a valid QR as authorization would make custody transfer forgeable by anyone who has seen the tag.

**Affected.** `services/qr.js`, custody controller, custody UI copy.

**Security impact.** Prevents the most tempting misuse. The UI states plainly that a valid tag means "this label is genuine", not "this person may move the item".

**Testing impact.** Red-team tests: forged HMAC rejected; valid QR + unauthorized user still denied.

---

## ADR-012 — `verify-chain` requires authentication

**Decision.** `GET /api/ledger/verify-chain` requires a session and is scope-filtered. Public, unauthenticated surfaces are limited to `/public/verify/:token` and `GET /api/anchors/latest`.

**Reason.** Spec §7 marks it `any`. An unauthenticated global chain walk leaks case identifiers, event types and volumes — a confidentiality regression in a system whose pitch is confidentiality.

**Affected.** Ledger routes, frontend verifier, public verifier page.

**Security impact.** Preserves the independent-verifiability story (anchors and certificates stay public) without leaking case metadata.

**Testing impact.** Test: unauthenticated `verify-chain` returns 401; public verifier still works unauthenticated.

---

## ADR-013 — Resolver helpers defined; FSL branch is resource-type aware

**Decision.** `allow()`, `allowReadOnly(action)`, `allowReadPlusOrders(action)` and `deny(reason)` are concrete functions with defined action sets. The FSL branch resolves the referral by the resource's own linkage rather than assuming an `exhibitId` field on every resource type.

**Reason.** Spec §5 is pseudocode; the helpers are referenced but undefined, and the FSL branch would throw or silently deny on a non-evidence resource.

**Affected.** `services/accessResolver.js`.

**Security impact.** Removes undefined behaviour in the single policy point. Default remains deny.

**Testing impact.** Matrix tests cover each helper's action set, including the read/write boundary for SP and judge.

---

## ADR-014 — `victimIsMinor` is derived, not supplied

**Decision.** `victimIsMinor = (sensitivityClass === "POCSO") || isVictimProtected`, computed server-side from the FIR record pulled from the police directory.

**Reason.** Spec §8 F2's `computeJurisdiction` takes `victimIsMinor`, but no such field exists in the FIR schema (§3.1). Accepting it from a request would let a caller steer court selection.

**Affected.** `services/jurisdiction.js`, case controller.

**Security impact.** Jurisdiction cannot be influenced by client input; it is a pure function of directory data.

**Testing impact.** Unit tests pin the reasoning strings for each classification path.

---

## ADR-015 — Judges act only on cases bound to their court

**Decision.** A case with no `courtId` (pre-chargesheet) denies all judge access with `CASE_NOT_LISTED_IN_YOUR_COURT`. Court binding happens at chargesheet filing, from the court directory.

**Reason.** Spec §5's judge policy compares `resource.courtId` to the roster-derived `user.scope.courtId`; §6 populates `courtId` only at chargesheet filing. The interaction is correct but implicit, and a reader could mistake the resulting denial for a bug.

**Affected.** `accessResolver.js`, case controller, court UI copy.

**Security impact.** Prevents judicial access to cases still under investigation and not yet before any court — the legally correct posture.

**Testing impact.** Test: judge denied on pre-committal case; allowed after chargesheet binds the case to their court; denied for another court's case.

---

## ADR-016 — The Merkle tree commits to the leaf set, not the leaf order

**Decision.** Anchoring uses sorted-pair hashing (`keccak256(min(a,b) || max(a,b))`), matching OpenZeppelin's `MerkleProof`. A consequence is that swapping two sibling leaves yields the same root: the tree commits to the *set* of entries, not to their order.

**Reason.** Discovered while testing — an assertion that the root is order-sensitive failed. The code was right and the assertion was wrong, but the property is worth stating rather than quietly correcting.

Ordering is already committed elsewhere, twice over: each `entryHash` covers its own `seq` and its predecessor's hash, so the ledger chain fixes the order; and the on-chain batch records `fromSeq`/`toSeq`. The tree's job is membership proof. Positional (unsorted) hashing would add a third, redundant ordering commitment at the cost of carrying direction bits in every proof and diverging from the audited OpenZeppelin verifier.

**Affected.** `services/merkle.js`, `LexxAnchor.sol`, anchor verification, `docs/PRODUCTION_READINESS.md`.

**Alternatives.** Positional pair hashing — rejected: more proof data, a hand-rolled on-chain verifier instead of an audited library, and no property gained that the hash chain does not already provide.

**Security impact.** None negative. An attacker cannot substitute, add or remove an entry without changing the root. They could in principle present two sibling entries in the opposite order, which the hash chain then rejects.

**Testing impact.** Asserted explicitly in `services.test.js`, and cross-checked against the deployed contract by `contracts/scripts/cross-check-backend-merkle.js` at tree sizes 1, 2, 3, 4, 5, 8, 9, 17 and 33 — every backend-generated proof verifies on-chain, and forged entries are rejected on-chain.

---

## ADR-017 — Dependency vulnerabilities fixed at intake, not deferred

**Decision.** The initial dependency set carried known advisories: `multer` 1.x (multiple CVEs), a `qs` DoS/bypass chain reachable through Express 4's `body-parser`, and critical advisories in `vitest` 2.x. All were resolved before any feature code was written — multer upgraded to 2.x, `qs` pinned forward via an npm `overrides` entry, vitest and its coverage provider moved to 5.0.0 (pinned exactly, because the coverage package declares an exact peer).

**Reason.** `npm audit` now reports **0 vulnerabilities**, and a build that starts clean can be kept clean by a CI check. Starting with nine known advisories means nobody can distinguish a new problem from the existing noise.

**Affected.** Root `package.json` (dependencies, devDependencies, `overrides`).

**Security impact.** Removes a reachable DoS in the request-parsing path — `qs` parses every query string this API receives — and the file-upload CVEs in the multer version that would otherwise have handled every evidence upload.

**Testing impact.** `npm audit` is part of the final gate.

---

## ADR-018 — Self-describing encrypted containers for derived artefacts

**Decision.** Evidence files store their envelope metadata in the `Evidence.encryption` subdocument, as specified. Two *derived* artefacts — FSL reports and generated certificate PDFs — instead store it inside the object itself, as a self-describing container: an 8-byte magic (`LEXXSEAL1` / `LEXXPDF1`), a `uint32BE` header length, a JSON envelope header, then the ciphertext.

**Reason.** Neither `Evidence.forensic` nor `Certificate` has a field for envelope metadata; both carry only a key and a hash. Two independent engineers hit this and both chose a container rather than editing a model they did not own — which was the right instinct, and on review it is also the better design for these two cases.

A stored object that carries its own (wrapped) key material is recoverable from the filesystem alone, given `MASTER_KEK`. For a forensic system that matters: a lost or corrupted database should not render every filed expert report permanently unreadable. Evidence itself does not need this, because its record *is* the thing being attested to — if the evidence row is gone there is nothing to recover it for.

**Affected.** `services/certificatePdf.js`, `controllers/fsl.js` (`storeSealedReport`), the vault layout.

**Alternatives.** Add `forensic.reportEncryption` and `pdfEncryption` subdocuments — more consistent with `Evidence.encryption`, and rejected only because it loses the standalone-recovery property. Reconsider if a third container format ever appears; at that point the duplication would outweigh the benefit.

**Security impact.** None negative. The header holds the DEK **wrapped** under the per-case KEK, which is itself derived from `MASTER_KEK` — a vault dump without the master key yields nothing. The AEAD tag still covers the ciphertext, so a tampered object fails to open.

**Testing impact.** Round-trip and tamper tests in the FSL and certificate suites. The format is confined to one write function and one read function per artefact type.

---

## ADR-019 — `APPROVE` and `ACKNOWLEDGE` are first-class actions

**Decision.** Two actions added to the vocabulary:
- **`APPROVE`** — ruling on something another party prepared. Held by `REGISTRAR` and `JUDGE`.
- **`ACKNOWLEDGE`** — a party confirming receipt. Held by counsel, on a pack served to *them*.

**Reason.** Both were flagged during implementation as things the existing verbs could not express, and both were being approximated in ways that were subtly wrong.

Spec §7 gives disclosure approval to "REGISTRAR / JUDGE". With only `WRITE` and `ORDER`, that pair is inexpressible: `WRITE` excludes the judge (who does not author investigative records) and `ORDER` excludes the registrar (who does not issue judicial orders). Approval had therefore been implemented as `WRITE`, silently dropping the judge.

Acknowledgement had been implemented as `VERIFY`, because advocates are read-only. But it genuinely mutates state, and labelling a write as a read is the kind of small dishonesty that later gets relied on. `ACKNOWLEDGE` mutates exactly one field the acknowledging party owns.

**Affected.** `models/enums.js`, `services/accessResolver.js`, `routes/disclosure.js`.

**Alternatives.** Widen `WRITE` for judges — rejected: it would let a judge author investigative records. Leave acknowledgement as `VERIFY` — rejected: a misnamed action becomes a misunderstood one.

**Security impact.** Net tightening. `COURT_ONLY_ACTIONS` now explicitly denies `APPROVE` and `ORDER` to police and FSL roles, closing a path where an investigator could have reached approval by falling through to a general `allow()`. Putting an advocate on record (`CASE_ACCESS_GRANT`) is now registrar-only — previously any officer with case write access could have done it, meaning an investigator could decide who represents the accused.

**Testing impact.** Nine assertions in `authz/matrix.test.js`: judge and registrar may approve; IO and SHO may not; registrar still cannot issue an order; an advocate may acknowledge their own service but not another's, and acknowledging confers no general write; only a registrar may grant representation.

---

## ADR-020 — The seed manufactures its custody gap by direct ledger write, not through the API

**Decision.** `seed/seed-all.js` builds every piece of demo state through the real HTTP API — that is the whole point of driving the seed that way (see the file's own header comment). One exception: the second custody item (`IT-...-002`, the "gap demo") gets its illegal `SEIZED → AT_FSL` transition written directly to the ledger via `services/ledger.js`'s `appendEvent`, bypassing `POST /api/custody/items/:id/initiate-transfer` entirely.

**Reason.** Found during functional testing: the seed created the item and simply left it at `SEIZED`, described in its own log line as "the gap demo" and promised by `docs/DEMO_SCRIPT.md` to show `ILLEGAL_STATE_TRANSITION` and `SEQUENCE_DISCONTINUITY` findings. It showed neither — `GET /api/custody/gaps` reported `findingCount: 0`. An item sitting at its own valid starting state is not a gap by any definition the detector uses.

The deeper reason it could not be fixed by calling the transfer API with different arguments: the API is *supposed* to refuse this. `custody.test.js` already asserts "illegal state jump rejected" as a security property. The two-scan handshake validates every transition against `CUSTODY_TRANSITIONS`, so no sequence of legitimate API calls can produce an illegal jump — which is correct, and is exactly why the gap detector exists: for records that arrive some *other* way (a legacy-system migration, a paper record entered late, an event that never got entered at all). The seed's demo item needed to be manufactured the same way a real one would occur, which the test suite already does.

**Affected.** `seed/seed-all.js`, `docs/DEMO_SCRIPT.md` (beat 4 clarified).

**Alternatives.** Add a `--force-illegal-transition` debug flag to the custody API — rejected: it would be a permanent hole in a control that is otherwise absolute, kept alive only to make a demo easier. Leave the seed's claim uncorrected and describe a different, real gap scenario — rejected: "left at SEIZED, never deposited" is not a data-integrity gap and never will be, no matter how the demo narrates it; the detector should not be made to lie.

**Security impact.** None. The write goes through `appendEvent`, so it is properly hash-chained (`ledger/verify-chain` reports `intact: true` afterward) — this reproduces a *custody-state* anomaly, not a *ledger-integrity* one, which is precisely the distinction `docs/DEMO_SCRIPT.md` beat 5 already draws for the tamper demo. The `CustodyItem` document is deliberately left unmodified, so its own `status` field disagrees with the ledger's account — producing the `STATE_DIVERGENCE` finding on top of the other two, matching what `custody.test.js` already proves the detector catches.

**Testing impact.** Verified live: `GET /api/custody/gaps` now returns `findingCount: 3` (`SEQUENCE_DISCONTINUITY`, `ILLEGAL_STATE_TRANSITION`, `STATE_DIVERGENCE`) for `IT-...-002`, matching `custody.test.js`'s assertions exactly, and `0` for the clean item. The ledger chain remains intact (18 entries checked, 0 breaks) after the manufactured event.

---

## ADR-021 — `scripts/health-check.js` uses the app's own Mongo timeout, not a separate hardcoded one

**Decision.** `checkMongo()` now passes `env.MONGO_SERVER_SELECTION_MS` (the same value the API server itself uses) instead of a hardcoded `3000`.

**Reason.** Found during live functional testing against a real MongoDB Atlas cluster: the very first run of `npm run health` reported `MongoDB: DOWN — Server selection timed out after 3000 ms`, while the API server's own `/healthz` (a live connection already open) reported fine, and a second immediate run of the health check itself succeeded. The cause is a cold DNS SRV lookup plus TLS handshake on a fresh `mongodb+srv://` connection, which routinely takes longer than 3 seconds on a first attempt and did here — a local `mongod` never has this problem, which is presumably why the original 3-second budget looked sufficient in earlier testing.

The file's own header states its purpose: *"Written for the five minutes before a demo, when 'it doesn't work' needs to become 'the court directory isn't running' as fast as possible."* A tool with that job description producing a false `DOWN` for a perfectly healthy Atlas-backed deployment is worse than useless — it sends the operator hunting for a problem that does not exist, at exactly the moment they can least afford it.

**Affected.** `scripts/health-check.js`.

**Alternatives.** Raise the hardcoded value to something larger (e.g. 8000) — rejected: it would just be a second number to keep in sync with `MONGO_SERVER_SELECTION_MS` by hand, and the two had already drifted apart once.

**Security impact.** None.

**Testing impact.** Verified live: a fresh cold-start run against Atlas reproduced the false negative with the old 3000ms budget; the same run against the same cluster passed cleanly after the fix.

---

## ADR-022 — A s.63 certificate is scoped to the served disclosure set, not to the case grant

**Decision.** The resolver's LEGAL branch now handles `RESOURCE_TYPE.CERTIFICATE` explicitly, applying the same three tests it applies to `EVIDENCE`: a `SERVED` pack must exist on the case, it must have been served to *this* user, and `certificate.evidenceId` must be in that pack's `exhibitIds`. Failing any of them returns `NO_DISCLOSURE_PACK_SERVED` or `EXHIBIT_NOT_IN_DISCLOSURE_SET`.

**Reason.** Found by review, not by a test. `GET /api/certificates/:id` is guarded by `authorize(READ, CERTIFICATE)`. The LEGAL branch handled `EVIDENCE` and `DISCLOSURE_PACK` explicitly and then fell through to a bare `allowReadOnly(action)` for everything else — which included certificates. So an advocate correctly refused an excluded exhibit could fetch the certificate *about* that exhibit and read the exhibit code, the SHA-256 digest, the source device's make, model, serial number and IMEI, and the laboratory's opinion. That is most of what the exclusion existed to withhold, delivered through a side door, and the PDF endpoint leaked the same thing.

The general principle now stated in the code: a fall-through to `allowReadOnly` is safe only for resource types that carry no exhibit-level detail. Every type that does must be handled above that line.

**Affected.** `backend/services/accessResolver.js` (LEGAL branch).

**Alternatives.** Guard the route with a bespoke check in `controllers/certificate.js` — rejected outright: it would put a second authorization path next to the resolver, which is the exact defect ADR-003 and SEC-001 exist to prevent.

**Security impact.** Closes a confidentiality leak of the same class as SEC-001, reachable by any advocate legitimately on record.

**Testing impact.** Five tests in `integration/disclosure.test.js` ("a certificate is scoped to the same served set as its exhibit"). Verified as a genuine regression test: with the new branch removed, four of the five fail and the positive case still passes.

---

## ADR-023 — The anchor scheduler is started at boot and its state is reported on `/readyz`

**Decision.** `backend/server.js` calls `startAnchorScheduler()` after `syncIndexes` and before `app.listen`, records `active` / `disabled` / `failed` in the new `backend/services/health.js`, and calls `stopAnchorScheduler()` on shutdown. `/readyz` reports `anchorScheduler.{state, detail, since, network, submitting}` and is `degraded` unless the state is `active` or `disabled`.

**Reason.** `startAnchorScheduler` existed, was exported, was tested — and was never called by anything except tests. Every running instance therefore anchored nothing at all, while `/readyz` returned `ready` and the documentation described a five-minute batching cycle. A claim about integrity anchoring that is false in every deployment is worse than an absent feature, because nobody looks for it.

`disabled` counts as ready because anchoring off is a configuration (`ANCHOR_ENABLED=false`), not a fault. `submitting` is reported separately so a viewer can tell "computing Merkle roots in DRY_RUN" from "sending transactions to Monad" — the two look identical in the batch records otherwise.

**Affected.** `backend/server.js`, `backend/app.js` (`/readyz`), `backend/services/health.js` (new).

**Alternatives.** Start the scheduler from `createApp()` — rejected: `createApp` is called by every integration test, which would have every test process racing a background chain-anchoring timer.

**Security impact.** None directly; it makes an integrity control observable rather than assumed.

**Testing impact.** Six tests in `integration/resilience.test.js` plus four in `unit/health.test.js`.

---

## ADR-024 — Audit writes stay fail-open, with two exceptions that fail closed

**Decision.** `writeAudit` and `writeAuthAudit` still never throw into the request they describe. But failures are now counted: `AUDIT_UNHEALTHY_THRESHOLD` (3) consecutive failures flip the instance to `audit.healthy = false`, which makes `/readyz` degraded and makes the new `requireHealthyAudit` middleware refuse two operations with `AUDIT_UNAVAILABLE` 503 — `POST /api/disclosure/:packId/serve` and `POST /api/fsl/referrals/:id/report`. The counter resets on the first successful write.

**Reason.** Fail-open was and remains the right default: a logging outage must not become an outage of the system it describes. But nothing bounded it, so "every authorization decision is recorded" could quietly degrade to "every decision we managed to record", with no signal anywhere — including while disclosure was being served on the accused.

Two acts do not tolerate that. Serving disclosure starts the BNSS s.230 clock and mints per-recipient watermarks; filing a forensic report records the laboratory's opinion on authenticity. Both are things this system asks a court to rely on, and neither is acceptable as an event that happened with no reliable account of who authorised it. Everything else — reads, listings, uploads — continues to fail open.

The threshold is consecutive, not cumulative, because one transient failure is noise and a sustained run is an incident.

**Affected.** `backend/middleware/audit.js`, `backend/services/health.js`, `backend/routes/disclosure.js`, `backend/routes/fsl.js`, `backend/app.js`.

**Alternatives.** Fail closed on every write — rejected: it converts a Mongo hiccup into a total outage, which is the trade the original design deliberately refused. Persist the health state — rejected: the question `/readyz` answers is "is this instance healthy right now", and a restart *should* reset it.

**Security impact.** Narrows a documented availability-over-completeness trade at the two points where completeness matters most, without widening it anywhere.

**Testing impact.** Six tests in `integration/resilience.test.js`, including one that confirms the fail-open half still works, and seven in `unit/health.test.js`.

---

## ADR-025 — Temp uploads are reaped on the response lifecycle, not in the controller

**Decision.** New `reapTempUpload` middleware sits between `uploadMiddleware` and `authorizeCreate` on `POST /api/evidence/upload`. It registers an `res.on('close')` handler that removes `req.file.path`.

**Reason.** The route's own comment claimed the controller's `finally` discarded the staged bytes "on every failure path, including denial". It did not. On denial `authorizeCreate` calls `next(err)`, Express skips the controller entirely, and its `finally` never runs — so **every rejected upload left its full plaintext temp file in the OS temp directory, forever**. On a system whose entire premise is custody of evidence, that is both an unbounded disk leak and an uncontrolled copy of material that was refused.

`close` rather than `finish`, deliberately: an aborted upload never finishes, and an abort is precisely when a stray file is most likely.

**Affected.** `backend/controllers/evidence.js`, `backend/routes/evidence.js` (the false comment is now replaced with a statement of what was untrue).

**Alternatives.** Move authorization before multer — rejected: `caseId` arrives in the multipart body, so there is nothing to authorise against until it is parsed. A periodic sweep of the temp directory — rejected as the primary mechanism: it leaves a window, and the correct fix is not to leak in the first place.

**Security impact.** Removes an uncontrolled plaintext copy of refused evidence.

**Testing impact.** Three tests in `integration/resilience.test.js` covering denial, validation failure and the success path. Verified as a genuine regression test: with the middleware removed, the denial case fails with a leaked `.part` file.

---

## ADR-026 — Search reports a database failure as a failure

**Decision.** `controllers/search.js` no longer wraps each query in `.catch(() => [])`. A failure is logged with the real error and returned as `SEARCH_UNAVAILABLE` 503, with a message that says explicitly it is not a statement that no records matched.

**Reason.** The old shape made a dropped connection, a missing text index and a genuine empty result indistinguishable — all three rendered as `{ cases: [], evidence: [], total: 0 }`. For a search over evidence that is the worst available failure mode: an investigator concludes a record does not exist when the truth is that the system failed to look, and there is nothing on screen to suggest otherwise.

The audit row is still written before the query runs, so a failed search is not an unrecorded one.

**Affected.** `backend/controllers/search.js`.

**Security impact.** None. It is an integrity-of-information fix, not an access-control one.

**Testing impact.** Four tests in `integration/resilience.test.js`, including one confirming a genuinely empty result is still a 200.

---

## ADR-027 — The court discovers disclosure packs through `APPROVE`, not `READ`

**Decision.** New `GET /api/disclosure/case/:caseId/packs`, guarded by `authorize({ action: APPROVE, resourceType: CASE })`.

**Reason.** `approve` and `serve` both take a `packId` and nothing returned one. The registrar had to be told the id out of band, which made a statutory step depend on someone copying a hex string by hand — the kind of gap that only shows up when a real user tries to complete the workflow.

The guard is the interesting part. `READ` on the case is held by the advocate on record, so a `READ`-gated listing would have handed the draft pack list — exclusion counts and all — to the party the exclusions are directed against. `APPROVE` is in `COURT_ONLY_ACTIONS`, so the resolver grants it to the judge and registry staff of the court the case is listed in and refuses it to the IO who authored the pack, to FSL, and to counsel. No role comparison was added anywhere; the existing policy already expressed exactly the right rule.

The response is a summary rather than `packView`, and deliberately omits `servedTo[].watermarkToken` — that token identifies one named advocate's copy and belongs in the serve response to the registrar who minted it.

A consequence worth stating: the court sees nothing until the case is actually listed before it, because court scope comes from `Case.courtId`, which is set by filing the chargesheet. A pack prepared during investigation is an investigative document, and the same rule that keeps the registry out of the case keeps it out of the pack.

**Affected.** `backend/controllers/disclosure.js`, `backend/routes/disclosure.js`, `docs/API.md`.

**Security impact.** Positive: it removes the practice of passing pack ids around out of band.

**Testing impact.** Eight tests in `integration/disclosure.test.js`, including the two refusals (advocate, authoring IO), the not-yet-listed case, and an assertion that no watermark token appears in the payload.

---

## ADR-028 — `POST /directory/vakalatnama` is labelled and gated as an authority simulator

**Decision.** The court directory's single write endpoint is refused unless `config.allowSimulatedFilings` is set — which defaults to on outside `NODE_ENV=production` and off inside it, overridable with `DIRECTORY_ALLOW_SIMULATED_FILINGS=true`. Every successful response carries `simulated: true` and a `notice` naming eCourts as the real authority.

**Reason.** In the real world eCourts owns this act; here it exists so the demo can show an advocate coming on record, because the grant it produces is what unlocks disclosure. Nothing in Lexx calls it — not the API, not the seed, not the frontend — which makes it simultaneously the most misreadable thing in the repository and the least likely to be noticed if its label came off. A reviewer who took it for a product feature would conclude that Lexx grants itself lawyer access, which inverts the entire trust model; and with a real dataset behind it and no authentication in front of it, an unauthenticated caller could put any advocate on record for any listed case.

**Affected.** `directories/common/config.js`, `directories/court/routes/directory.js`, `directories/court/server.js`.

**Alternatives.** Delete it and seed vakalatnamas directly — rejected: the demo needs to *show* the act happening, and a seeded row shows only its result.

**Security impact.** Removes an unauthenticated write path from any production-mode run of the simulator.

**Testing impact.** New suite `integration/directory-simulator.test.js` (6 tests), covering the label, the gate both ways, that a refusal writes nothing, and that reads are unaffected.

---

## ADR-029 — A DRY_RUN batch is `ANCHOR_LOCAL_ONLY`, never `ANCHOR_MATCH`

**Decision.** `verifyAnchorForEvidence` returns the new `ANCHOR_INTEGRITY.ANCHOR_LOCAL_ONLY` when the recomputed root matches the stored root and the entry proves as a member of it **but the batch carries no transaction hash**. `ANCHOR_MATCH` now requires a submitted transaction. The verify response also carries `anchorSubmitted` and `anchorBatchStatus`, and the verifier UI renders `ANCHOR_LOCAL_ONLY` amber with the sentence "both roots are held by this system, so this shows internal consistency only".

**Reason.** Found while adding the DRY_RUN banner the review asked for, and it is worse than the banner it was meant to accompany. The comparison in `verifyAnchorForEvidence` is between a root recomputed from the ledger and a root stored in `anchor_batches`. When the batch was never submitted — which is every batch in this deployment, since `ANCHOR_ENABLED=false` — **both sides of that comparison are ours**. The result was reported as `ANCHOR_MATCH`, and the verifier painted it as a green light reading *"equals the root published on chain"*. Nothing was published on any chain. The system was showing a court a self-comparison and describing it as independent corroboration, on the page whose entire purpose is to let someone with no account check our claims.

This is the same class of overstatement the project forbids elsewhere ("AI never determines authenticity", "no accuracy percentages"), applied to the blockchain claim, and it was live in the demo path.

The state is deliberately *not* folded into `ANCHOR_MISMATCH`: the roots genuinely do agree, and reporting a red light would be its own falsehood. It is a third thing — internally consistent, externally unattested — and it needed a third name.

**Affected.** `backend/models/enums.js`, `backend/controllers/evidence.js`, `frontend/lib/verify.js`, `frontend/lib/ui.js` (DRY RUN banner on the anchoring panel), `frontend/pages/court.js` ("In anchor batch", not "Anchored in batch"), `docs/API.md`.

**Alternatives.** Keep `ANCHOR_MATCH` and rely on the banner — rejected: the banner is on a different panel from the light, and the light is what a viewer reads as the verdict. Suppress the anchor light entirely in DRY_RUN — rejected: the check is genuinely informative (it detects post-hoc ledger edits), it just must not be mislabelled.

**Security impact.** Removes a false integrity claim from the public verifier. No access control changes.

**Testing impact.** Four tests in `integration/evidence.test.js`, covering DRY_RUN, a confirmed batch, and a divergence in each mode — because `ANCHOR_LOCAL_ONLY` must not become a catch-all that masks a real mismatch.
