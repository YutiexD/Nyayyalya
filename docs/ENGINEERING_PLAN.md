# LEXX 2.0 — Engineering Plan

Dependency-aware implementation phases. Derived from `LEXX-MVP-Technical-Design.md` §10 build plan, re-sequenced for a single coordinated build rather than four parallel humans.

**Governing rule:** a phase is not "done" when it runs. It is done when its tests pass, including the negative and authorization tests for that phase.

---

## Dependency graph (what blocks what)

```
P0 Foundation ─┬─> P1 Identity ──> P2 Authorization ─┬─> P3 Cases ──┬─> P9 Disclosure
               │        ^                             │              │
               │        └── directories ──────────────┘              ├─> P10 Certificate
               │                                                     │
               └─> P5 Ledger ──┬─> P4 Evidence Integrity ────────────┤
                               │        │                            │
                               │        ├─> P6 Custody               │
                               │        ├─> P7 AI Triage             │
                               │        └─> P8 FSL ──────────────────┘
                               │
                               └─> P11 Blockchain anchoring
                                            │
                              P12 Search ───┴─> P13 Full integration + demo
```

The three authority directories block **everything** in P1 onward. The ledger blocks every write-side feature, because every material action emits a ledger event. Authorization (P2) gates P3+ by policy: if cross-scope authorization is broken, later phases inherit the hole.

---

## Phase table

| Phase | Deliverable | Exit criteria (test gate) |
|---|---|---|
| **P0 Foundation** | Repo layout, workspaces, env schema + validation, structured logger, central error handler, Mongo connection with in-memory fallback, health checks, test harness, seed/reset scaffolding | App boots; `/healthz` green; env validation rejects a missing secret; test runner executes |
| **P1 Identity** | 3 directory services + seeds; `directoryClient` with timeout and typed failures; verify-identity → OTP → activate; password login; **live directory re-verification**; JWT + refresh; ECDSA public key registration | Fake PIS rejected and audited; suspended officer denied; expired posting denied; rotated judge lands in the right court; OTP single-use |
| **P2 Authorization** | `accessResolver.js` as the single policy point; `resolveContext` / `authorize` / `audit` middleware; DB-loaded resources (never client-supplied) | **Full cross-scope authorization matrix passes** — every role against own/other station, district, court, lab, advocate. No later phase starts until green |
| **P3 Cases** | FIR lookup, case-from-FIR, jurisdiction router with visible reasoning, court directory lookup, chargesheet filing → CNR + court binding | Jurisdiction reasons reproducible; no free-text case creation; cross-station case read denied |
| **P4 Evidence integrity** | Browser SHA-256 + ECDSA sign; server hash recompute and signature verify; envelope encryption (DEK/KEK); content-addressed storage; signed receipt; immutable evidence record | Hash mismatch rejected + `INTEGRITY_EXCEPTION` logged; forged signature rejected; oversized/bad-MIME upload rejected |
| **P5 Ledger** | Append-only ledger, deterministic canonicalisation, atomic sequence allocation, hash chain, chain verification, immutability guards | Update/delete/reorder attempts all fail; concurrent appends produce a gapless strictly-increasing chain; tampered entry detected at the right seq |
| **P6 Custody** | QR generation + HMAC verification, custody state machine, two-scan transfer with TTL token, seal-break freeze, gap detection, IO-cannot-be-own-custodian guard | Forged QR rejected; replayed transfer token rejected; wrong recipient rejected; state jump detected |
| **P7 AI triage** | Heuristic triage: priority + indicators + disclaimer. Never a verdict, never on-chain, never persisted as a percentage | Output shape asserted; no percentage anywhere; not written to ledger or chain |
| **P8 FSL** | Referral, lab scoping, accept, report upload + opinion + signature, ledger event, feeds certificate Part B | Examiner sees only their lab's referrals; other lab denied |
| **P9 Disclosure** | Vakalatnama → case access grant, pack preparation, exclusion approval, serving with per-recipient watermark tokens, advocate-scoped access, denial logging | Advocate on record sees served set only; not-on-record denied and audited; out-of-set exhibit denied; revoked grant denied |
| **P10 Certificate** | s.63 Part A auto-fill, Part B from FSL, completeness refusal, PDF + PDF hash, verification QR, public verifier | Incomplete certificate refused with the missing-field list; public verify returns green for a real token, red for a forged one |
| **P11 Blockchain** | `LexxAnchor.sol`, Merkle tree, batcher, **Monad Testnet** anchoring, receipt confirmation before marking anchored, idempotency, failure handling | Duplicate anchor prevented; failed tx never marks a batch anchored; root-only on chain; proof verifies |
| **P12 Search** | Text search intersected with the resolver scope filter, every query logged | Cross-scope results never returned |
| **P13 Integration** | Full 11-beat demo from clean seed; failure injection; red-team pass; final audit | Every demo beat passes from a clean reset; red-team findings fixed or documented |

---

## Cross-cutting workstreams

These run alongside, not after:

- **Security (Agent 5)** — reviews each phase as it lands; every finding becomes a regression test before the phase closes.
- **Red team (Agent 7)** — attacks each phase's API directly, bypassing the frontend. Successful attacks become regression tests.
- **QA (Agent 6)** — owns the suite structure: `unit/`, `integration/`, `authz/`, `negative/`, `redteam/`.
- **Compliance (Agent 9)** — checks each phase against the AI/forensics/identity/deletion invariants.
- **Docs (Agent 12)** — keeps README, API docs and demo script synchronised; documents nothing that does not exist.

---

## Cut list (spec §10, if time-constrained)

In order: compliance clocks → search → break-glass → Merkle anchoring → QR gap detection.

**Never cut:** directory auth, hash chain, verify endpoint, lawyer scoping denial, certificate generator.

---

## Test gate protocol (applies at every phase boundary)

1. Run the phase's tests.
2. Inspect failures; fix root causes, not symptoms.
3. Re-run.
4. Run the security/negative tests for that phase.
5. Confirm no regression in earlier phases.
6. Only then proceed.

Failing tests are never deleted to make a phase look green.
