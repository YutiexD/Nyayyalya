# LEXX 2.0 — Security Model

Written for someone deciding whether to trust this system with evidence. Everything below was read out of the source; where the code and the design intent disagree, the code is described. Overclaiming is the failure mode this document is written to avoid, so the sections on anchoring and on known weaknesses are as detailed as the sections on what works.

Companion documents: [`API.md`](./API.md) for the endpoint surface, [`AGENT_DECISIONS.md`](./AGENT_DECISIONS.md) for the ADRs referenced throughout, [`SECURITY_FINDINGS.md`](./SECURITY_FINDINGS.md) for the vulnerability register.

---

## Contents

- [Trust boundaries](#trust-boundaries)
- [Identity and provisioning](#identity-and-provisioning)
- [Authorization](#authorization)
- [Cryptography](#cryptography)
- [Key management](#key-management)
- [Tamper evidence](#tamper-evidence)
- [What the blockchain does and does not do](#what-the-blockchain-does-and-does-not-do)
- [Known weaknesses and accepted risks](#known-weaknesses-and-accepted-risks)

---

## Trust boundaries

```
        ┌──────────────────────────────────────────────────────────────┐
        │  BROWSER  (officer / judge / examiner / advocate device)     │
        │  · holds the ECDSA P-256 PRIVATE KEY — never leaves          │
        │  · hashes files before upload, signs the hash                │
        │  · renders watermarks, renders "Review Priority" labels      │
        └───────────────────────────┬──────────────────────────────────┘
                                    │  HTTPS · Authorization: Bearer <jwt>
                    ── BOUNDARY 1 ──┤  NOTHING from here is trusted:
                                    │  not role, not scope, not stationCode,
                                    │  not a hash, not a timestamp, not a QR tag
        ┌───────────────────────────▼──────────────────────────────────┐
        │  LEXX CORE API  (backend/)                                   │
        │  ── the only trusted decision point ──                       │
        │  authenticate → resolveContext(DB) → accessResolver → ctrl   │
        │  holds: JWT_SECRET, REFRESH_SECRET, QR_SECRET, MASTER_KEK    │
        └──┬──────────────┬───────────────┬───────────────┬────────────┘
           │              │               │               │
   ─ BND 2 ─       ─ BND 3 ─        ─ BND 4 ─       ─ BND 5 ─
           │              │               │               │
  ┌────────▼──────┐ ┌─────▼───────┐ ┌─────▼─────────┐ ┌───▼────────────────┐
  │  MongoDB      │ │ OBJECT      │ │ 3 AUTHORITY   │ │ MONAD TESTNET      │
  │  lexx_core    │ │ VAULT       │ │ DIRECTORIES   │ │ chain id 10143     │
  │               │ │ (filesystem)│ │ police :6001  │ │ LexxAnchor.sol     │
  │ TRUSTED for   │ │             │ │ court  :6002  │ │                    │
  │ authority.    │ │ NOT trusted │ │ legal  :6003  │ │ NOT trusted for    │
  │ NOT trusted   │ │ for         │ │               │ │ anything but       │
  │ for integrity │ │ integrity — │ │ AUTHORITATIVE │ │ "this root existed │
  │ — every hash  │ │ every read  │ │ for identity, │ │  by this block".   │
  │ is recomputed │ │ is AEAD-    │ │ role, scope.  │ │ Receives ONLY a    │
  │ on read       │ │ verified    │ │ Lexx holds no │ │ 32-byte root and   │
  │               │ │             │ │ identities.   │ │ a seq range.       │
  └───────────────┘ └─────────────┘ └───────────────┘ └────────────────────┘
```

| Boundary | What crosses it | What is trusted | What is not |
|---|---|---|---|
| **1. Browser ↔ core API** | JWT, request bodies, multipart uploads, client-computed SHA-256, ECDSA signature, QR payloads, client timestamps | Only that the JWT was signed by us — and that is used for *lookup*, not authorization | `role`, `scope`, `stationCode`, `courtId`, `labId`, `ioUserId`, exhibit membership, timestamps, declared MIME type, the client hash. Every one is either re-derived server-side or checked against a server-loaded record. |
| **2. Core API ↔ MongoDB** | Session context, resource documents, ledger rows, audit rows | The database is the **authority on identity and entitlement** — `role`, `scope`, `status`, case assignment, grants (ADR-005) | The database is **not** trusted for integrity. Every hash on every verification path is recomputed from the underlying bytes; a stored `verified: true` would prove nothing. |
| **3. Core API ↔ object vault** | AES-256-GCM ciphertext on the local filesystem | Nothing. Paths are validated against a strict key pattern and re-resolved to prove they are inside the vault | The bytes on disk. Every full read verifies the GCM tag, and `/verify` re-derives the plaintext SHA-256 and compares it with `sha256Server`. |
| **4. Core API ↔ authority directories** | Officer, judge, registry-staff, advocate, examiner and lab records; postings, rosters, vakalatnamas, legal-aid orders, FIRs, court listings | **Authoritative for identity, role and scope.** Lexx stores no independent notion of who anyone is | Availability. A directory outage raises `DirectoryUnavailableError` → **503**, and never falls back to a cached or assumed answer — a stale "yes" would reinstate exactly the access re-verification exists to remove. |
| **5. Core API ↔ Monad Testnet** | `anchorBatch(batchId, merkleRoot, fromSeq, toSeq)` out; receipts and `verifyEntry` back | That a confirmed transaction fixes a root in time | The chain is not asked anything about evidence and told nothing about it. See [What the blockchain does and does not do](#what-the-blockchain-does-and-does-not-do). |

---

## Identity and provisioning

**Nobody self-registers.** `ALL /api/auth/register` returns **410 `SELF_REGISTRATION_DISABLED`** on every method — left in place deliberately so a reviewer sees the decision rather than a 404 that looks like an oversight.

A Lexx account exists only if the person already exists and is ACTIVE in their authority directory. `backend/controllers/auth.js` never reads `role`, `authority` or `scope` from a request body; the only things it takes from the client are an identifier, a password, an OTP and a public key.

### Resolution

`resolveIdentity` (`services/directoryClient.js:202`) probes **all five** identity endpoints in parallel — police officer, court judge, court registry staff, legal advocate, FSL examiner — and requires **exactly one** match. Zero matches is "no such person"; two or more is refused with `AMBIGUOUS_IDENTITY`, because resolving it arbitrarily could hand someone the wrong authority.

Each directory validates identifiers against its own format, so a police PIS number is legitimately a `400` at the Bar Council directory. `probe()` treats a `404` **or** a format `400` as "not mine", and only a transport failure or `5xx` as "we cannot know" — which propagates and fails closed with 503. Collapsing those two in the other direction would let a directory outage read as a valid identity (see SEC-002).

### Scope by authority

| Authority | Directory lookups | Resulting `scope` |
|---|---|---|
| POLICE | `/officer/:pis` + `/officer/:pis/posting` (+ `/station/:code`) | `{ stationCode, districtCode, stateCode }` |
| COURT (judge) | `/judge/:code` + `/judge/:code/court` (the **roster**) | `{ courtId, districtCode, stateCode }` |
| COURT (registry) | `/registry-staff/:code` (+ `/court/:code`) | `{ courtId, districtCode, stateCode }` |
| FSL | `/examiner/:code` (+ `/lab/:code`) | `{ labId, stateCode }` |
| LEGAL | `/advocate/:enrolmentNo` | `{}` — **no jurisdictional scope at all**. An advocate's access is purely per-case, via a `CaseAccessGrant`. |

### Live re-verification

The directory is re-checked on **activation**, on **every login** (step 4 of five), on **every refresh**, and before **key rotation**. On login and refresh the session then *adopts* the directory's current answer: `user.authority`, `user.role`, `user.name` and `user.scope` are overwritten and `directoryLastVerifiedAt` is stamped. Nobody in Lexx has to do anything for a personnel change to take effect.

Separately — and this is the control that matters most — `resolveContext` re-reads the user from the database on **every single request** (ADR-005). The JWT's `role`/`scope`/`authority` claims are never the authorization input.

### What happens to…

| Situation | Directory signal | Effect |
|---|---|---|
| **A suspended officer** | `serviceStatus !== 'ACTIVE'` → `OFFICER_SUSPENDED` | Login and refresh refused `DIRECTORY_REVERIFICATION_FAILED` (403); refresh additionally revokes every live refresh token. If a Lexx admin also sets `User.status = SUSPENDED`, the **next request** on an existing access token is refused `USER_NOT_ACTIVE` (403). Otherwise the outstanding 15-minute access token remains usable until it expires — see [Known weaknesses](#known-weaknesses-and-accepted-risks) W1. |
| **A transferred officer** | new posting → different `stationCode`/`districtCode` | On next login the session's scope changes silently and correctly. In the meantime, the old token's `role` still matches so no `SESSION_STALE` triggers, but the resolver reads `scope` from the database, which the login rewrote — so the effective scope is whatever the last login resolved. A re-designation (IO → SHO) *does* trigger `SESSION_STALE` (401) on the next request, forcing a fresh login. |
| **An officer with a lapsed posting** | `validTo < now`, or `isCurrent === false`, or no current posting | `POSTING_EXPIRED` / `POSTING_NOT_CURRENT` / `NO_CURRENT_POSTING` → `active: false` → login refused. The validity window is re-derived locally rather than trusting the directory's own `isCurrent` boolean. |
| **A rotated judge** | `/judge/:code/court` returns a different court, or nothing | Scope's `courtId` changes on next login, so cases in the old court now deny `CASE_NOT_LISTED_IN_YOUR_COURT`. Off the roster entirely → `NOT_ON_CURRENT_ROSTER` → login refused. Lexx never assigns a judge to a court. |
| **A lapsed advocate** | `status !== 'ACTIVE'`, or `copValidTill < now` | `ADVOCATE_*` / `CERTIFICATE_OF_PRACTICE_EXPIRED` → login and refresh refused. Independently, a withdrawn vakalatnama revokes the `CaseAccessGrant` at the next `sync-representation`, which the resolver reads live on every request. |
| **A suspended examiner** | `status !== 'ACTIVE'` → `EXAMINER_*` | Login refused. Their lab's open referrals remain; another examiner at the same lab can act on them, because FSL entitlement is scoped by `labId`, not by individual. |

### Credentials and factors

| Factor | Mechanism |
|---|---|
| Password | bcrypt, `BCRYPT_ROUNDS` default 12 (production refuses < 12). Minimum 12 characters, maximum 200. Unknown user and wrong password answer identically with `BAD_CREDENTIALS`, and bcrypt runs against a dummy hash for an unknown user so the timing does not distinguish them. |
| OTP | 6 digits from `crypto.randomInt` with rejection sampling; SHA-256 hashed at rest; single-use (atomic `findOneAndUpdate` on `consumedAt: null`); TTL `OTP_TTL_SEC` (default 300 s); purpose-bound (`ACTIVATION` \| `LOGIN`); attempt-capped at `OTP_MAX_ATTEMPTS` (default 5, counted *before* comparison so a crash mid-verify cannot reset the cap); requesting a new code deletes the previous unconsumed one so only the newest works. Sent to the phone **on record in the directory**, never to a number in the request. Echoed in the response only when `DEMO_ECHO_OTP=true`, which `config/env.js` refuses at startup under `NODE_ENV=production` (ADR-004). |
| Device signing key | ECDSA P-256 public key registered at activation. Rotation costs a live session **and** a fresh OTP, re-verifies the directory, and revokes all refresh tokens. |

---

## Authorization

### One policy point

`backend/services/accessResolver.js` is the only place an access decision is made. There is not a single ad-hoc role comparison in any route or controller — the two exceptions are documented below and both are *scope* comparisons layered on top of a resolver decision, not replacements for it.

Three middleware entry points (`backend/middleware/authorize.js`) wrap it: `authorize()` for a specific resource, `authorizeCollection()` for lists, `authorizeCreate()` for resources that do not exist yet. Every decision, allow **and** deny, is written to `audit_events` *before* the response is produced.

### Deny by default

Every branch of `evaluate()` returns an explicit decision. Falling off the end returns `NO_MATCHING_POLICY`, never an allow. `resolveCreate` refuses any resource type with no registered capability the same way.

### The two invariants

**Invariant 1 — the resolver loads its own resources (ADR-003).** Callers pass a resource *type* and an *id*; `loadResource()` fetches the record, and the case it hangs off, from MongoDB. A controller cannot hand the policy an object. Without this, an attacker posts their own `stationCode` in the request body and every jurisdiction check passes — the highest-impact bypass available in the design as specified. Where creation genuinely has nothing to load, `resolveCreate` still terminates in the **same** `evaluate()` against the parent case, so the create path cannot drift from the read path (this is the fix for SEC-001).

**Invariant 2 — the database is the authority, not the token (ADR-005).** `resolveContext` re-reads the `User` on every request; the resolver sees only that. A JWT minted before a suspension, a transfer or a roster change carries stale authority and would otherwise be honoured for its full 15 minutes.

### Actions

| Action | Meaning |
|---|---|
| `READ` | View a record. |
| `WRITE` | Authorship — creating or amending an investigative record. |
| `DOWNLOAD` | Retrieve bytes. A read action, but audited distinctly. |
| `VERIFY` | Recompute integrity. A read action. |
| `ORDER` | A judicial order. Judges alone. |
| `APPROVE` | Ruling on something another party prepared — disclosure, representation. The presiding judge (ADR-019, ADR-040). Court-only, so the investigation can never reach it. |
| `ACKNOWLEDGE` | A party confirming receipt — mutates exactly one field that party owns. Counsel only. |

`COURT_ONLY_ACTIONS = { ORDER, APPROVE }` is denied to every police and FSL branch, closing the path where an investigator could reach approval by falling through to a general `allow()`.

### The role × scope matrix

Read from `evaluate()` and `CREATE_CAPABILITY` in `services/accessResolver.js`. "✓" means the resolver allows it once the scope condition in the second column is met; a code means the denial reason.

| Authority · Role | Scope condition | READ | WRITE | VERIFY / DOWNLOAD | ORDER | APPROVE | ACKNOWLEDGE |
|---|---|---|---|---|---|---|---|
| POLICE · `IO` | `case.ioUserId == me` **and** `case.stationCode == scope.stationCode` | ✓ | ✓ *only while stage ∈ {UNDER_INVESTIGATION, FURTHER_INVESTIGATION}* | ✓ | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` |
| POLICE · `SHO` | `case.stationCode == scope.stationCode` | ✓ | ✓ *only while the case is open to writes* | ✓ | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` |
| POLICE · `DISTRICT_SP` | `case.districtCode == scope.districtCode` | ✓ | `READ_ONLY_ROLE` | ✓ | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` |
| POLICE · any, on a `CUSTODY_ITEM` | `item.stationCode == scope.stationCode` (district for the SP, read-only) | ✓ | ✓ *(survives the chargesheet and a closed case — an article still has to travel)* | ✓ | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` | — |
| COURT · `JUDGE` | `case.courtId` set **and** `== scope.courtId` | ✓ | ✓ *only on `COURT_WRITABLE` records; `READ_ONLY_ROLE` against a case or an exhibit* | ✓ | ✓ | ✓ | `READ_ONLY_ROLE` |
| COURT · `EVIDENCE_CUSTODIAN` | `case.courtId` set **and** `== scope.courtId` | ✓ | ✓ *custodial only* | ✓ | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` | ✓ |
| FSL · `FSL_EXAMINER` | `scope.labId` set **and** a referral links the resource to that lab, **or** the case is in `scope.stateCode` — see below | ✓ | ✓ *(referral, certificate, and the forensic verdict on an exhibit)* | ✓ | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` | ✗ |
| LEGAL · all counsel | a live `CaseAccessGrant` on the case | ✓ *(gated per resource — see below)* | `READ_ONLY_ROLE` | ✓ | `READ_ONLY_ROLE` | `READ_ONLY_ROLE` | ✓ *on a pack served to them* |

**A case the court has CLOSED** is read-only to every authority, including the court that closed it (`CASE_IS_CLOSED`). The one exception is a custodial write: a sealed article still has to be returned or destroyed after a case ends, and each of those is a two-scan ledgered handover rather than an edit of the record. Nothing is deleted by closing.

**`COURT_WRITABLE`** — the records a court may `WRITE`: `DISCLOSURE_PACK`, `CERTIFICATE`, `VAKALATNAMA`, `CUSTODY_ITEM`, `CASE_ACCESS_GRANT`. Not a case and not an exhibit: those are the investigation's, and a court that could edit them would be a party to the case rather than the tribunal over it. Everything else a court does to a case it does with `ORDER` or `APPROVE`.

**FSL, per resource type** — two routes in, and they are different in kind. `REFERRAL` is a named question about one exhibit, with the sealed article to go with it. `stateCode` is the state the laboratory serves, read from the FSL directory at sign-in; a session carrying no state falls back to referrals alone rather than to everything.

| Resource | Condition |
|---|---|
| `REFERRAL` | `referral.labId == scope.labId`. All actions except court-only. |
| `EVIDENCE` | a referral for this exhibit to this lab with status `OPEN`/`ACCEPTED`, **or** `case.stateCode == scope.stateCode`. `WRITE` is the forensic verdict and nothing else — no other route pairs an FSL session with a `WRITE` on an exhibit. |
| `CASE` | a live referral in this case, **or** `case.stateCode == scope.stateCode`. Read-only. |
| `CERTIFICATE` | a referral for the certificate's exhibit to this lab (**any status**, so Part B stays signable after the referral closes), or the same state rule. |
| `CUSTODY_ITEM` | a referral in the item's case only — **the state rule does not extend to custody.** A laboratory examines exhibits; it does not handle articles nobody sent it. |
| anything else | `NO_OPEN_REFERRAL_TO_YOUR_LAB`. |

**LEGAL, per resource type** — being on record gets you the case, not every exhibit in it:

| Resource | Condition |
|---|---|
| `EVIDENCE` | a `SERVED` `DisclosurePack` on the case **whose `servedTo` includes this exact user** (`NO_DISCLOSURE_PACK_SERVED`) **and** this exhibit in `pack.exhibitIds` (`EXHIBIT_NOT_IN_DISCLOSURE_SET`). Read-only. |
| `DISCLOSURE_PACK` | status `SERVED` and `servedTo` includes this user. `ACKNOWLEDGE` allowed; otherwise read-only. |
| `CUSTODY_ITEM` | always `EXHIBIT_NOT_IN_DISCLOSURE_SET`. Physical custody is a police and court matter. |
| anything else (incl. `CASE`, **`CERTIFICATE`**, `REFERRAL`) | read-only, given the grant — with **no** disclosure-set check. See W16. |

A pack served on co-accused counsel is **not** served on this advocate — `servedTo[].userId` is matched, not merely `caseId`.

### Create capabilities

Creation is checked twice: a role capability, then the case-level action.

| Resource | Who may create | Case-level action evaluated |
|---|---|---|
| `CASE` | POLICE `IO` or `SHO`, and the FIR's station (resolved server-side) must match their own | — (no parent) |
| `EVIDENCE` | POLICE `IO` or `SHO` | `WRITE` on the case |
| `CUSTODY_ITEM` | POLICE `IO` or `SHO` | `WRITE` on the case |
| `REFERRAL` | POLICE `SHO` only | `WRITE` on the case |
| `DISCLOSURE_PACK` | COURT `JUDGE` only | **`APPROVE`** on the case — the court ruling on a case it is seized of. `APPROVE` is court-only, so **no police role can reach a disclosure pack at all** |
| `CERTIFICATE` | POLICE `IO` **or** COURT `JUDGE` | **`READ`** on the case — a certificate attests to the record rather than amending it, and is normally prepared after the chargesheet closes the case to writes |
| `CASE_ACCESS_GRANT` | COURT `JUDGE` only | **`APPROVE`** on the case |
| `CUSTODY_RELEASE` | POLICE `SHO` only | `READ` on the case — lifting a seal-exception freeze must stay available after the chargesheet |
| `VAKALATNAMA` | LEGAL, advocate roles only (not a prosecutor) | a case actually listed before a court — not a case `WRITE`, since the filer is by definition not on record |

`APPROVE` rather than `WRITE` for the last three is load-bearing, not cosmetic. `WRITE` is authorship, which against a case belongs to the police; and it is refused once the case leaves investigation, which is precisely when disclosure and representation happen. Both would have been refused at exactly the moment they occur.

Putting an advocate on record, and deciding what the defence sees, are the court's acts. An investigating officer must never be able to make either (ADR-019, ADR-040, ADR-043).

### Collection scoping

List and search endpoints get a Mongo filter from `scopeFilterFor` / `materialiseScopeFilter`, which the controller must **intersect** with its query. A `null` filter means "this user sees nothing" and renders as an empty result — never as an unfiltered query. A caller-supplied `caseId` can only narrow the set, never widen it.

| Authority · Role | Filter |
|---|---|
| POLICE `IO` | `{ ioUserId, stationCode }` — but `{ stationCode }` for `CUSTODY_ITEM`: the store is the station's |
| POLICE `SHO` | `{ stationCode }` |
| POLICE `DISTRICT_SP` | `{ districtCode }` |
| COURT (all) | `{ courtId }`, or `null` when the session has no `courtId` |
| FSL | exhibits referred to `scope.labId`, **unioned with** the evidence of cases in `scope.stateCode`; custody and cases stay referral-bound |
| LEGAL | case ids with a live, in-window, unrevoked `CaseAccessGrant`; for `EVIDENCE`, narrowed further to the exhibits of packs actually served on them |

### Two scope checks layered on top of the resolver

Neither replaces a policy decision; both narrow one that already passed.

1. **`assertActingLab`** (`controllers/fsl.js:149`) requires `req.user.scope.labId === referral.labId` before accepting a referral or filing a report. The resolver's police branch would let the station SHO pass a `WRITE` on a referral in their own case; this compares *scope*, not roles, so anyone with no lab scope stops here.
2. **`violatesIoCustodyRule`** (`controllers/custody.js:363`) refuses a transfer into `IN_STORE` whose recipient is the case's `ioUserId`. Re-checked at acceptance as well as initiation, because the case may have been reassigned in between. The person who benefits from an exhibit cannot also be the only person who can account for it.

---

## Cryptography

Everything is in `backend/config/crypto.js` (primitives), `backend/services/envelope.js` (envelope encryption), `backend/services/merkle.js` (anchoring tree) and `backend/services/canonical.js` (hash input).

### Inventory

| Purpose | Algorithm | Detail | Source |
|---|---|---|---|
| Evidence & report integrity | **SHA-256** | Streaming; never buffers a whole file | `config/crypto.js:17`, `controllers/evidence.js:100` |
| Ledger payload hash | **SHA-256** over canonical JSON | `canonicalHash(payload)` | `services/canonical.js:87` |
| Ledger entry hash | **SHA-256** over a delimited, versioned string | `sha256("v1\|"+seq+"\|"+prevHash+"\|"+payloadHash+"\|"+occurredAtISO)` | `services/ledger.js:50` |
| OTP at rest | **SHA-256** | Plaintext exists only in the SMS (or the demo response) | `controllers/auth.js:96` |
| Refresh & stream & transfer tokens at rest | **SHA-256** | Only the hash is stored | `services/tokens.js`, `models/StreamToken.js`, `controllers/custody.js:443` |
| Uploader / examiner / deponent signatures | **ECDSA P-256, IEEE P1363** | 64 bytes `r‖s`, hex-encoded, over the **hex hash string** as UTF-8 | `config/crypto.js:129` |
| Content encryption | **AES-256-GCM** | Fresh 96-bit IV per operation, never caller-supplied; 128-bit tag stored alongside | `config/crypto.js:96`, `services/storage.js:68` |
| Key wrapping | **AES-256-GCM** with AAD | AAD = `"dek:" + caseId` | `services/envelope.js:35` |
| Per-case KEK derivation | **HKDF-SHA256** | `salt = kekId` (`"kek-v1"`), `info = "lexx-case-kek:" + caseId`, 32 bytes out | `config/crypto.js:83` |
| Passwords | **bcrypt** | cost `BCRYPT_ROUNDS`, default 12; production refuses < 12 | `controllers/auth.js:295` |
| QR label tags | **HMAC-SHA256** | over `itemCode`, keyed by `QR_SECRET` (≥32 chars), base64url | `services/qr.js:27` |
| Session tokens | **HMAC-SHA256 (JWT HS256)** | algorithm pinned on verification, `issuer`/`audience` checked | `services/tokens.js:51` |
| Public key fingerprint | **SHA-256** | over `"P-256:<x>:<y>"` | `config/crypto.js:155` |
| Anchoring tree | **keccak256** | Leaf = `keccak256(entryHash)`; node = `keccak256(min(a,b) ‖ max(a,b))` | `services/merkle.js` |

### Why IEEE P1363, and why DER is rejected

`verifyEcdsaP256` (`config/crypto.js:129`) verifies with `dsaEncoding: 'ieee-p1363'` and rejects anything that is not exactly 64 bytes:

```js
const sig = Buffer.from(signatureHex, 'hex');
if (sig.length !== 64) return false;   // P1363 for P-256 is exactly r(32)||s(32)
```

The Web Crypto API in the browser — which is what produces every signature this system accepts — emits P1363: the raw concatenation `r ‖ s`, fixed at 32 bytes each for P-256. Node's default verifier expects **DER**, a variable-length ASN.1 wrapper. Mixing the two is the classic "the signature always fails" bug, and in some libraries the worse variant where a length-confused parser accepts something it should not. Fixing the encoding explicitly and hard-rejecting any length but 64 removes both: a DER signature simply does not verify here, and there is no lenient path to fall through to. Every signature verification in the system — evidence upload, FSL report, certificate Part A, certificate Part B — goes through this one function.

The signed message is the **hex digest string**, UTF-8 encoded — not the 32 raw digest bytes:

```js
crypto.verify('sha256', Buffer.from(signedMessage, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig)
```

so the browser must sign the same 64-character lowercase hex string it displays. This is stated because getting it wrong produces a uniform verification failure that looks like a key problem.

A malformed key or signature returns `false`, not a thrown error — a failed verification is a finding, not a server fault.

### Canonicalisation

The ledger's trustworthiness rests on `canonicalJson` being deterministic (ADR-007). Object keys are sorted recursively; `undefined` and functions are dropped from objects but become `null` in arrays (array position is meaningful); `Date` → ISO-8601 UTC with milliseconds; `Buffer` → hex; anything with `toHexString` (Mongo `ObjectId`) → its hex string; `BigInt` → decimal string; `-0` normalises to `0`. Non-finite numbers, invalid `Date`s and cycles are **rejected** rather than silently becoming `null`. `__proto__`, `constructor` and `prototype` keys are skipped.

The entry hash input is delimited and versioned so that no two different field sets can produce the same string — undelimited concatenation lets `(seq=1, prev="23")` collide with `(seq=12, prev="3")`.

### Randomness

Every security-relevant random value comes from the Node CSPRNG. Verified by `grep -rn "Math\.random" backend/ frontend/ shared/ scripts/ seed/ contracts/ directories/`:

| Source | Bytes | Used for |
|---|---|---|
| `crypto.randomBytes(32)` → hex/base64url | 32 | data encryption keys (`generateDek`), certificate verification tokens, disclosure watermark tokens, custody transfer tokens, evidence stream tokens |
| `crypto.randomBytes(48)` → base64url | 48 | refresh tokens |
| `crypto.randomBytes(12)` | 12 | AES-GCM IVs (content encryption and key wrapping) |
| `crypto.randomBytes(12)` → hex | 12 | ledger append-lock holder id |
| `crypto.randomBytes(6)` → hex | 6 | temp-file suffixes during atomic vault writes |
| `crypto.randomInt(0, 10**6)` (rejection sampling) | — | 6-digit OTPs. Modulo of a random integer is biased, and a biased OTP is a weaker OTP |
| `crypto.randomUUID()` | — | ledger `eventId`, refresh-token `familyId`, upload temp filenames, error `incidentId` |

**`Math.random` is used nowhere security-relevant.** The grep returns exactly three hits and none of them is a secret: `services/ledger.js:90` uses it for 5–25 ms jitter on the append-lock retry loop, to avoid lockstep retries; the other two are in `backend/tests/authz/matrix.test.js:121,153`, generating test fixture labels. The claim in the header comment of `config/crypto.js` is accurate.

### Constant-time comparison

`timingSafeEqualStr` hashes both inputs with SHA-256 and compares the digests with `crypto.timingSafeEqual`, so differing lengths neither throw nor leak. Used for OTP codes, QR MACs and custody transfer tokens.

### Rejected inputs

| Check | Where |
|---|---|
| MIME allowlist **plus** magic-byte sniffing; declared type must match content; `text/plain` accepted only when nothing else sniffs | `services/fileType.js` |
| Storage keys must match `^[0-9a-f]{64}-[0-9a-f]{24}$`, and the resolved absolute path is re-checked to be inside the vault | `services/storage.js:38` |
| Directory path segments must match `^[A-Za-z0-9/_.-]+$`, must not contain `..`, and are per-segment URI-encoded | `services/directoryClient.js:94` |
| `Authorization` header must be exactly two parts, scheme `Bearer`, credential matching the three-segment base64url JWT shape | `middleware/authenticate.js:25` |
| JWT algorithm pinned to `HS256` on verification — never read from the token's own header | `services/tokens.js:54` |
| Dotted lookups in `authorize({idFrom})` skip `__proto__`, `constructor`, `prototype` | `middleware/authorize.js:19` |

---

## Key management

### The hierarchy

```
  MASTER_KEK                        env var — 32 bytes, hex (64 chars). Validated at startup.
      │                             No default. A missing value is a boot failure.
      │
      ├─ HKDF-SHA256(salt="kek-v1", info="lexx-case-kek:<caseId>")
      ▼
  per-case KEK                      32 bytes. DERIVED ON DEMAND, NEVER STORED, zeroed after use.
      │
      ├─ AES-256-GCM wrap, AAD = "dek:<caseId>"
      ▼
  per-evidence DEK                  32 random bytes. Stored ONLY wrapped.
      │
      ├─ AES-256-GCM, fresh 96-bit IV
      ▼
  evidence bytes in the vault
```

The case id is bound in as AEAD additional data, so a `wrappedDek` lifted from one case's record and pasted into another's **fails to unwrap** rather than silently decrypting under the wrong key. Compromise of one case's KEK exposes that case and nothing else. A database dump alone yields not one plaintext byte: the wrapped DEK is useless without `MASTER_KEK`.

Key material is zeroed (`buf.fill(0)`) after wrap, after unwrap, after a hash-verify read, and when a download stream closes.

### Where the master key lives, and where it belongs

`MASTER_KEK` is read from an environment variable (`config/env.js:67`, validated as exactly 64 hex characters). **In this MVP that is the whole story, and it is the single highest-value secret in the system.** Anyone with the process environment — a host compromise, a leaked `.env`, a `/proc` read, a core dump, a CI log — can derive every case KEK and decrypt the entire vault.

In production this belongs in a KMS or HSM, with the per-case KEK derivation performed inside the boundary (or the DEK unwrap delegated to it) so the master key never enters application memory. That is a deliberate, stated deferral, not an oversight (ADR-008). Alongside it: `JWT_SECRET`, `REFRESH_SECRET` and `QR_SECRET` are also plain environment values, each minimum 32 characters, with no defaults; production additionally refuses `JWT_SECRET === REFRESH_SECRET`. `ANCHOR_PRIVATE_KEY` is an environment value too — absent, anchoring runs in `DRY_RUN` rather than failing silently.

`kekId` (currently the constant `"kek-v1"`) is stored on every `Evidence.encryption` record and passed back into the derivation on unwrap, so the scheme is rotatable and auditable: a future `kek-v2` can coexist with records wrapped under `kek-v1`. There is no rotation tooling today.

### Signing keys and why rotation does not invalidate history

Each user registers an ECDSA P-256 public key at activation. `POST /api/auth/rotate-key` replaces it.

The critical detail is `Evidence.signerPublicKeyJwk`: at ingest, the **key that actually made the signature** is snapshotted onto the evidence record, immutably. Verification uses that snapshot, not the signer's current key:

```js
let verifyingKey = e.signerPublicKeyJwk ?? null;
if (!verifyingKey) { /* fall back to the signer's current key */ }
```

Without this pin, the first time an officer replaced a lost phone, every exhibit they had ever uploaded would begin reporting `signatureValid: false` — a **false integrity failure** on evidence nobody had touched. In a system whose whole value is telling a court which records are trustworthy, wrongly condemning sound evidence is as damaging as missing a real tamper, and much harder to explain afterwards. The subtler risk is worse: an operator who learns that "signature red is normal after a re-key" stops treating a red light as meaningful, and a genuinely forged signature then goes unremarked. This is SEC-005.

The fallback path exists only for records written before the field did. There are none in practice, and for those the code comments that a rotation would legitimately show as unverifiable rather than leaving it a silent path.

Rotation revokes every refresh token (`SIGNING_KEY_ROTATED`), so any session carrying the old device's context must re-authenticate. The retired key immediately stops being able to sign new evidence, while remaining forever able to verify what it already signed.

### Derived artefacts carry their own wrapped key

FSL reports and certificate PDFs are stored as self-describing containers — magic (`LEXXSEAL1` / `LEXXPDF1`), a `uint32BE` header length, a JSON envelope header, then ciphertext (ADR-018). The header holds the DEK **wrapped** under the per-case KEK, so a vault dump without `MASTER_KEK` still yields nothing, and the AEAD tag still covers the ciphertext. The property this buys is standalone recovery: a lost or corrupted database should not render every filed expert report permanently unreadable.

---

## Tamper evidence

### The ledger hash chain

One global, append-only chain covers every case (`backend/services/ledger.js`). `appendEvent` is the only way anything enters it.

```
entry N:   payloadHash = sha256(canonicalJson(payload))
           entryHash   = sha256("v1|" + seq + "|" + prevHash + "|" + payloadHash + "|" + occurredAtISO)
           prevHash    = entry N-1's entryHash   (genesis: 64 zeros)
```

`occurredAt` is set by the **server**. A client-asserted time travels inside the payload (`clientEffectiveOn`) where it is evidence, never chain input.

Serialisation is at three levels, because a forked chain silently destroys the one property the system sells: an in-process promise queue; a MongoDB-backed advisory lock with a 10 s lease and crash-safe expiry; and unique indexes on `seq` and `entryHash` as the backstop, with a bounded retry that re-reads the tail on a duplicate-key error. `seq` comes from an atomic counter, not `max(seq)+1` (ADR-006).

The **only** sanctioned mutation of an existing ledger row is `stampAnchorBatch`, which sets `anchorBatchId` on entries where it is currently `null`. It touches one field, cannot alter any hash, and is the single place in the codebase that writes to the ledger collection through the raw driver — deliberately confined to one function rather than exposed as an option.

`verifyChain()` walks the chain and, for every entry, re-derives the payload hash from the stored payload and the entry hash from the entry's own fields, then checks the link to its predecessor. It reports the **first** break and distinguishes four causes: `SEQUENCE_GAP`, `PREV_HASH_MISMATCH`, `PAYLOAD_HASH_MISMATCH`, `ENTRY_HASH_MISMATCH`.

### The four verification lights

`POST /api/evidence/:id/verify` returns four independent results. Each is computed from first principles — a stored `verified: true` would prove nothing.

| Light | Values | **What it proves** | **What it does NOT prove** |
|---|---|---|---|
| **`fileIntegrity`** | `FILE_INTACT` · `FILE_MODIFIED` · `FILE_MISSING` | The vault object decrypts under its recorded DEK, its GCM tag verifies, and the recovered plaintext hashes to `sha256Server`. The bytes on disk today are the bytes recorded. | Nothing about what the file *depicts*, whether the scene was staged, whether the file was already manipulated before it reached Lexx, or whether a copy exists elsewhere. `FILE_MISSING` is not exoneration and not proof of deletion — the ledger still holds the hash. |
| **`signatureValid`** | `true` · `false` | An ECDSA P-256 signature over `sha256Client` verifies against `Evidence.signerPublicKeyJwk` — the key snapshotted at ingest. Someone in possession of that private key signed that digest. | That the *person* named signed it. It proves possession of a key, not identity; a stolen or shared device key produces a valid signature. It also says nothing about the content, and `false` may mean a pre-snapshot record rather than a forgery. |
| **`chainIntegrity`** | `CHAIN_INTACT` · `CHAIN_BROKEN` | The **entire** ledger's hashes recompute and link, from `seq 1` to the head. No entry's payload, timestamp or link has been edited in place, and no sequence number is missing. | That the entries are *true*. The chain proves nobody rewrote what was written; it cannot prove what was written was accurate, or that something that should have been recorded was. It is also global — a break anywhere marks this light red for every exhibit, and an intact chain says nothing specific about *this* exhibit. Anyone with database write access can still **append** a false entry; the chain will happily accept and protect it. |
| **`anchorIntegrity`** | `ANCHOR_MATCH` · `ANCHOR_MISMATCH` · `NOT_ANCHORED` · `ANCHOR_UNAVAILABLE` | The Merkle root recomputed *now* from every ledger entry in this exhibit's batch equals the root published in `AnchorBatch`, **and** a proof for this entry verifies against it. | See the next section — this is where overclaiming is easiest. `NOT_ANCHORED` is the normal state for anything newer than the last batch (default interval 5 minutes) and means nothing bad. `ANCHOR_UNAVAILABLE` means the batch row is missing, not that anything was tampered with. |

The `interpretation` string exists to keep the combinations honest — in particular: *"The stored file has been modified since it was recorded. The ledger is intact — so the FILE was touched, not the log. The original hash remains provable."* A modified file with an intact chain is the system working, not the system broken.

### Custody chain analysis

Separately, `analyseChain` walks a custody item's ledger history and produces structured findings rather than a boolean, because "this chain is broken" is not actionable and "`SEIZED → AT_FSL` at seq 41 with no `IN_STORE` in between" is. It detects missing genesis events, timestamp inversions, per-item sequence discontinuities (`custodySeq`, recorded in the payload precisely so a *missing* event is detectable — the global `seq` is shared with every other subject and a hole in one item's story leaves no trace in it), unlawful state jumps against `CUSTODY_TRANSITIONS`, and divergence between the item record and its own ledger history.

### Audit

Every authorization decision, allow and deny, is written to `audit_events` before the response. The denials are the point: a log that only records successes cannot show you the advocate who reached for an exhibit outside their disclosure set.

**Audit failures never break the request they describe.** `writeAudit` catches and logs; an audit write that threw would turn a logging outage into a total outage. That is a deliberate availability-over-completeness trade, and it means the audit log is not guaranteed complete under database stress.

---

## What the blockchain does and does not do

The target is **Monad Testnet**, chain id **10143**, explorer `https://testnet.monadexplorer.com` (ADR-002). It is a testnet.

### What is submitted

Exactly one call, with exactly four arguments:

```solidity
anchorBatch(bytes32 batchId, bytes32 merkleRoot, uint64 fromSeq, uint64 toSeq)
```

A batch id derived from the sequence range, a 32-byte Merkle root over the `entryHash` values of the entries in that range, and the range itself. **That is all.** No evidence, no file content, no hashes of personal data, no case identifiers, no names, no FIR or CNR numbers, no triage output, no leaf hashes.

The root is a commitment to a *set* of ledger entry hashes and reveals nothing about them. `GET /api/anchors/latest` deliberately omits `leafHashes` for the same reason — publishing them would disclose the shape and volume of the ledger.

### What anchoring proves

**That this set of ledger entries existed, in exactly this form, no later than the block that contains the transaction.** Nothing more. If any entry in an anchored batch is altered afterwards, the root recomputed from the current ledger diverges from the published one, and `/verify` reports `ANCHOR_MISMATCH`. It converts "trust our database" into "check our arithmetic against a record we cannot edit".

### What anchoring does NOT prove

State this plainly, because the temptation to imply otherwise is the whole risk:

- **It does not prove the entries are true.** A false statement, recorded and anchored, is a permanently, verifiably preserved false statement. The chain attests to *when something was written*, never to whether it was accurate.
- **It does not prove evidence is authentic.** No file, and no hash of a file, is on chain. Authenticity of an electronic record is an expert question, answered only by an FSL examiner under s.79A of the IT Act, in `AUTHENTIC | MANIPULATED | INCONCLUSIVE`. The blockchain has no opinion.
- **It does not prove nothing was omitted.** The root commits to the entries that *were* written. An act that was never recorded leaves no gap in the chain and no discrepancy in any root. Anchoring cannot detect a silence.
- **It does not prove the file still exists or is unmodified.** That is `fileIntegrity`, computed from the vault, entirely independently. An anchored batch stays valid over an exhibit that has since been deleted from disk.
- **It does not prove who acted.** Actor identity comes from the session and, where present, from an ECDSA signature — both off chain.
- **It does not commit to the order of entries within a batch.** Sorted-pair hashing means swapping two sibling leaves yields the same root: the tree commits to the *set*, not the sequence (ADR-016). Ordering is committed twice elsewhere — each `entryHash` covers its own `seq` and its predecessor's hash, and the on-chain batch records `fromSeq`/`toSeq` — but not by the tree.
- **A confirmed transaction is not a confirmed truth about anything but a 32-byte number.** The contract validates nothing about what the root represents; it cannot.

### Operational honesty about the anchor path

- **Anchoring is off by default.** `ANCHOR_ENABLED` defaults to `false`. With it off, or with no `ANCHOR_CONTRACT_ADDRESS`/`ANCHOR_PRIVATE_KEY`, the batcher runs in **`DRY_RUN`**: roots are computed, stored and locally verifiable, and nothing is submitted. That is an honest state with its own status value, not a silent no-op — but a `DRY_RUN` batch has **no** external witness whatsoever, and `ANCHOR_MATCH` against a dry-run batch proves only that our arithmetic agrees with our own database.
- **Submitted ≠ confirmed.** A batch reaches `CONFIRMED` only after its receipt is read back with `status === 1`. A reverted or dropped transaction is marked `FAILED` with a reason and its ledger entries are left unstamped for the next cycle — never marked anchored.
- **Three anti-double-anchor guards**: the batch row is created before submission with a unique index on `(fromSeq, toSeq)`; the contract is asked `isAnchored(batchId)` first; and the contract itself reverts on a repeated `batchId`. An on-chain root that disagrees with the computed one is never overwritten — the batch is failed with `ON_CHAIN_ROOT_MISMATCH`.
- **Recomputation is from the ledger as it stands now**, which is exactly what makes divergence detectable.
- **`onChainVerified` may be `null`.** `/api/ledger/entry/:seq/anchor-proof` asks the contract's `verifyEntry` where a connection exists; when it does not, or the batch is not `CONFIRMED`, the field is `null` and the `ok` result reflects only local verification. The difference between "our arithmetic agrees with our database" and "a third party can check" is exactly this field.
- **It is a testnet.** Monad Testnet offers no economic security guarantee, can be reset, and has L2 finality characteristics unlike L1. As a demonstration of the mechanism it is sound; as a long-term evidentiary witness it is not.

---

## Known weaknesses and accepted risks

Findings already recorded in [`SECURITY_FINDINGS.md`](./SECURITY_FINDINGS.md) — SEC-001 (create-path authorization bypass), SEC-002 (directory format rejections aborting identity resolution), SEC-003 (dependency advisories), SEC-004 (lenient `Authorization` parsing), SEC-005 (key rotation invalidating past signatures) — are all `FIXED` with regression tests, and are not restated here. That document's closing table of design-level protections adopted before they could become findings is also worth reading alongside this section.

What follows is what remains open, plus what was found while writing this document.

### Accepted, by design

| # | Risk | Why it is accepted |
|---|---|---|
| **A1** | **`MASTER_KEK` lives in an environment variable.** Anyone with the process environment can derive every case KEK and decrypt the whole vault. | MVP scope. Documented as a KMS/HSM swap in production (ADR-008). The hierarchy is already shaped so that only the root moves: per-case derivation and per-evidence wrapping stay as they are. |
| **A2** | **Audit writes fail open.** `writeAudit` swallows errors and logs. Under database stress the audit log may be incomplete. | Availability over completeness: an audit write that threw would turn a logging outage into an outage of the whole system. Stated explicitly in `middleware/audit.js`. |
| **A3** | **A valid QR tag is reproducible forever.** The HMAC is static per item, so anyone who photographs a printed label can regenerate it. | Mitigated, not removed: a scan is identification only, and every custody action re-runs the resolver on the resolved item (ADR-011). The response says so in its own payload. |
| **A4** | **The Merkle tree does not commit to leaf order.** | Ordering is already committed by the hash chain and by the on-chain `fromSeq`/`toSeq`. Positional hashing would add a third, redundant commitment at the cost of a hand-rolled on-chain verifier instead of the audited OpenZeppelin one (ADR-016). |
| **A5** | **Anchoring is off by default and defaults to `DRY_RUN`.** | Honest state with its own status value. But nothing external witnesses a dry-run root — see the section above. |
| **A6** | **The vault is the local filesystem.** No replication, no object-store immutability, no separate write path. | MVP scope. The integrity story does not depend on the vault being trustworthy — every read is AEAD-verified and every hash recomputed — but availability and durability do. |
| **A7** | **Anyone with database write access can append a true-looking ledger entry.** | Inherent to a self-hosted hash chain. The chain prevents *rewriting* history, not *adding* to it. Anchoring narrows the window (an entry appended after a batch cannot be back-dated into it) but does not close it. |

### Open

| # | Weakness | Detail |
|---|---|---|
| **W1** | **Suspension does not revoke an outstanding access token unless the local `User.status` changes.** Directory-side suspension is caught on the next login or refresh; `resolveContext` checks `User.status`, which only login/refresh update. A user suspended in the directory keeps their current access token for up to 15 minutes and, since `logout` also does not invalidate access tokens, so does anyone who signed out. | `middleware/authenticate.js:66`, `controllers/auth.js:558` |
| **W2** | **Evidence *list* endpoints are scoped by case, not by disclosure set or referral.** `GET /api/evidence`, `GET /api/evidence/queue/triage` and `GET /api/search` filter on `materialiseScopeFilter(user, CASE)` and then query `Evidence` by those case ids, without re-applying the per-exhibit tests that `GET /api/evidence/:id` enforces. An advocate on record therefore sees every exhibit in the case in a list — including exhibits *excluded from their disclosure pack* — and `triageQueue`/`search` additionally expose `triage.priority`, which `exhibitView` deliberately withholds from `my-pack` precisely so a machine review-priority is never handed to a party as if it were a finding. The same widening applies to an FSL examiner with one referral in a case. **This is the most significant open finding.** No test covers a `LEGAL` or `FSL` caller on these routes. | `controllers/evidence.js:408,687`, `controllers/search.js:69` |
| **W3** | ~~**`POST /api/disclosure/:packId/serve` is not registrar-restricted.**~~ **CLOSED by ADR-040/043.** No police role can reach a `DISCLOSURE_PACK` at all — the resolver's police branch has no policy that admits one, and `DISCLOSURE_PACK` is in `COURT_WRITABLE`. The authz matrix asserts it. | `services/accessResolver.js` |
| **W4** | **`GET /api/audit/security` is not scope-filtered.** Gated on role only, it then returns every `LOGIN` audit row in the deployment — `authorityId`, decision, reason and source IP — regardless of station, district or court. An SHO at one station sees failed login attempts against officers everywhere. `GET /api/audit` is properly scoped; this feed is not, and the code says so. | `controllers/audit.js:98` |
| **W5** | **`POST /api/auth/verify-identity` is an unauthenticated identity oracle.** For any valid identifier it returns the person's real name, authority, Lexx role, full jurisdictional scope, masked phone, and whether they hold a Lexx account. Rate-limited at 60 per 15 minutes per IP and audited — but the limiter is skipped for loopback whenever `NODE_ENV !== production`, and behind a reverse proxy every request arrives from loopback. | `controllers/auth.js:170`, `routes/auth.js:30` |
| **W6** | **`GET /api/ledger/verify-chain` discloses ledger volume to any authenticated session.** ADR-012 describes it as scope-filtered; in fact no scoping happens. Any active session — including an advocate with a single grant — learns `entriesChecked`, `firstSeq`, `lastSeq` and `brokenAtSeq` for the whole deployment. No entry content is returned, so the leak is metadata (total size and growth rate), not case data. | `routes/system.js:25`, `controllers/ledger.js:65` |
| **W7** | **`GET /api/custody/gaps` silently returns nothing for an IO and for every court role.** `scopeFilterFor(user, CUSTODY_ITEM)` returns `{ ioUserId, stationCode }` for an IO and `{ courtId }` for court roles, but `CustodyItem` has neither field. The endpoint is not insecure — it fails closed — but a supervisor could reasonably read an empty gap report as "no gaps". | `services/accessResolver.js:456`, `models/CustodyItem.js:33-57` |
| **W8** | **Every `LEGAL` user is provisioned as `DEFENCE_COUNSEL`.** `resolveAdvocate` hardcodes `ROLE.DEFENCE_COUNSEL` regardless of how the advocate appears, and `login` overwrites `user.role` from the directory on every sign-in — so `VICTIM_COUNSEL`, `LEGAL_AID_COUNSEL` and `PUBLIC_PROSECUTOR` can never be a `User.role`. The resolver's grant lookup matches on the **grant's** role (which `sync-representation` does set correctly), so entitlement is still right in practice; but the public-prosecutor branch at `accessResolver.js:284-286` is dead code, and any future check on `user.role` for a legal user would be wrong. | `services/directoryClient.js:378`, `controllers/auth.js:399` |
| **W9** | **`putEncryptedFile` failure leaks a DEK into the heap.** In `uploadEvidence` the `try { stored = await putEncryptedFile(...) } finally { }` block has an empty `finally`, and `dek.fill(0)` runs only on the success path after `wrapDek`. A storage write failure therefore leaves the 32-byte DEK unzeroed. Low impact — the write failed, so there is no ciphertext to decrypt — but it is the one place the zeroing discipline is not followed. | `controllers/evidence.js:260-268` |
| **W10** | ~~**A malkhana custodian's branch returns a bare `allow()`.**~~ **CLOSED by ADR-040.** The role is gone, and the custody branch that replaced it denies `ORDER` and `APPROVE` explicitly before it checks the station. | `services/accessResolver.js` |
| **W11** | **Rate limiting protects only `/api/auth/*`.** No limiter is applied to evidence upload, search, verification or any other authenticated route. A single authenticated session can drive an unbounded number of full-ledger `verifyChain` walks, full-vault decryptions via `/verify`, or 256 MB uploads. | `routes/auth.js` is the only file importing `express-rate-limit` |
| **W12** | **`DENY_REASON.GRANT_REVOKED` is unreachable.** `liveGrantFor` filters on `revokedAt: null`, so a revoked grant surfaces as `NOT_ON_RECORD_FOR_THIS_CASE`. Cosmetic, but it means an audit trail cannot distinguish "never on record" from "taken off record". | `services/accessResolver.js:117` |
| **W13** | **`sign-part-a` requires `WRITE` where `generate` deliberately requires only `READ`.** `CREATE_IMPLIES_ACTION[CERTIFICATE] = READ` exists precisely because a s.63 certificate is prepared at or after the chargesheet, when the case has closed to investigative writes. Signing was not given the same treatment, so an IO who can generate a certificate on a `CHARGESHEET_FILED` case is then refused `CASE_STAGE_CLOSED_TO_WRITES` when they try to sign it. A correctness/usability defect rather than a security hole — it fails closed. | `routes/certificate.js:58`, `services/accessResolver.js:182` |
| **W14** | **Two controller doc-comments describe a superseded authorization design.** In `controllers/disclosure.js`, acknowledgement is described as authorised with `VERIFY`, and `sync-representation` as a case `WRITE` that "admits the station's IO/SHO as well". Both were fixed by ADR-019 and the routes are now correct. Stale security comments are their own hazard: a reviewer who trusts them will mis-assess the system. | `controllers/disclosure.js` |
| **W16** | **A certificate is readable by any advocate on record, regardless of the disclosure set.** The `LEGAL` branch of `evaluate()` handles `EVIDENCE`, `DISCLOSURE_PACK` and `CUSTODY_ITEM` explicitly, then falls through to a bare `allowReadOnly(action)` for everything else — including `CERTIFICATE`. So `GET /api/certificates/:id` and `GET /api/certificates/:id/pdf` (`DOWNLOAD` is a read action) succeed for counsel holding only a live `CaseAccessGrant`, even for an exhibit deliberately excluded from the pack served on them. The certificate discloses considerably more than `my-pack` does: the full `mannerOfProduction` ledger narrative, the conditions statement, device make/model/colour/serial/IMEI, the deponent's name and designation, and the Part B expert opinion. The same fall-through covers `REFERRAL`, which no read route currently exposes. | `services/accessResolver.js:325-331`, `routes/certificate.js:49,74` |
| **W15** | **`scripts/check-network-references.js` does not check Markdown.** Its own comment says Markdown "is checked separately below", but no such check exists — `CODE_EXTENSIONS` covers only `.js/.mjs/.cjs/.json/.sol/.html/.yml/.yaml` plus `.env.example`. A stale network reference in documentation would pass the gate. | `scripts/check-network-references.js:31` |

### Not weaknesses, but worth stating

- **The system fails closed on directory outage.** Every login, refresh, key rotation and representation sync returns **503** rather than proceeding on cached authority. That is correct, and it means the three directories are hard availability dependencies for authentication.
- **A `RESOURCE_NOT_FOUND` is deliberately ambiguous.** A missing resource and a forbidden one look identical from outside, so an unauthorised caller cannot probe which case ids exist.
- **Denial reasons are designed to be safe to display.** Each may reveal *why the caller is not entitled*, never anything about the resource. `EXHIBIT_NOT_IN_DISCLOSURE_SET` is safe because the advocate already knows the case exists.
- **Triage is not a verdict, and the system is built so it cannot be mistaken for one.** `TRIAGE_PRIORITY` has three values, no scores and no percentages; the UI label is fixed at `"Review Priority"`; the disclaimer travels with the data; and no triage output is ever written to the chain or into a certificate. The only authenticity vocabulary anywhere is `FORENSIC_OPINION`, producible only by an FSL examiner. (W2 is the one place this separation currently leaks.)
