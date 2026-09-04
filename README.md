# LEXX 2.0

**An AI-assisted, blockchain-backed digital evidence registry.**

Lexx holds no identities of its own. Officers exist in the police directory, judges and registry staff in the court directory, advocates and examiners in the legal/FSL directory. We verify against them and can create none of them.

Nothing is ever deleted. Status changes, and every change is signed by whoever ordered it.

Only the forensic laboratory decides authenticity. The AI decides what gets looked at first.

---

## What this is

| | |
|---|---|
| **Stack** | Node 20+ · Express · MongoDB · Vite (vanilla JS) · Solidity |
| **Anchoring** | **Monad Testnet**, chain ID **10143** — Merkle roots only |
| **Identity** | Three external authority directories; no self-registration |
| **Tests** | 369 backend + 36 contract, all passing |
| **Dependencies** | `npm audit`: 0 vulnerabilities |

---

## Quick start

You need **Node 20+**. You do *not* need MongoDB installed — there is a script for that.

```bash
npm run install:all          # root + frontend + contracts
node scripts/bootstrap-env.js  # writes .env with CSPRNG secrets
```

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

Skip `npm run mongo:dev` entirely and point `MONGO_URI` at your server. Nothing else changes — no service knows how the database got there.

> **Note on the current `.env`:** it contains a MongoDB Atlas connection string whose password is still the placeholder `<Xmind@401>`. Services will not start against it (`querySrv EBADNAME`). Either fill in the real password **percent-encoded** (`<`, `>`, `@`, `:`, `/` must all be escaped in a Mongo URI), or set `MONGO_URI=mongodb://127.0.0.1:27017` to use the local server.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CLIENT (Vite, :5173)                            │
│   login · officer · sho · fsl · court · lawyer · verify (public)    │
│   lib/crypto.js  SHA-256 + ECDSA P-256 (Web Crypto)                 │
│                  private key non-extractable, in IndexedDB          │
└────────────────────────────┬────────────────────────────────────────┘
                             │ JWT (15 min) + rotating refresh
┌────────────────────────────┴────────────────────────────────────────┐
│                    LEXX CORE API (Express :5000)                    │
│                                                                     │
│   authenticate → resolveContext → authorize → audit                 │
│                            ↓                                        │
│                   services/accessResolver.js                        │
│            ONE policy point · role × jurisdiction × case × time     │
│                                                                     │
│   auth · case · evidence · custody · fsl · disclosure               │
│   certificate · ledger · audit · search · anchor                    │
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
│   │                     storage · directoryClient · triage · jurisdiction
│   │                     qr · canonical · tokens · fileType · certificatePdf
│   ├── models/           15 collections + enums.js (the controlled vocabulary)
│   ├── controllers/ routes/
│   └── tests/            unit · integration · authz · redteam
│
├── frontend/             Vite MPA, vanilla JS, no framework
├── contracts/            LexxAnchor.sol + Hardhat (its own package)
├── seed/                 seed-all.js · reset.js
├── scripts/              bootstrap-env · mongo-dev-server · health-check
│                         check-network-references
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
| `npm run health` | Check MongoDB, all three directories, the API and the RPC |
| `npm test` | The whole backend suite (369 tests) |
| `npm run test:authz` | Just the authorization matrix |
| `npm run test:redteam` | Just the adversarial suite |
| `npm run lint` | ESLint across backend, directories, frontend, scripts |
| `npm run build` | Production frontend build |
| `npm run contracts:test` | Solidity tests (36) |
| `npm run contracts:deploy` | Deploy `LexxAnchor` to Monad Testnet |
| `npm run verify:no-stale-sepolia` | Fail if a bare `sepolia` reappears in config |

`npm run seed` is also an end-to-end test. It authenticates, passes the access resolver, computes hashes and signatures in the client, and appends to the hash chain — if it completes, the demo path works.

---

## Blockchain — Monad Testnet

Anchoring is **off by default**. The batcher still computes and stores Merkle roots (status `DRY_RUN`), so the pipeline is exercised and locally verifiable without a funded key.

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

**What never goes on chain:** evidence, file contents, PII, names, case identifiers, AI triage scores. A root is a commitment; it discloses nothing about what it commits to.

The backend's Merkle implementation is cross-checked against the deployed contract at nine tree sizes by `contracts/scripts/cross-check-backend-merkle.js` — every proof the backend generates verifies on-chain, and forged leaves are rejected on-chain.

---

## Documentation

| Document | What it is for |
|---|---|
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | The eleven demo beats, in order, with exact commands |
| [docs/API.md](docs/API.md) | Every endpoint, request shape, response shape and error code |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust boundaries, cryptography, what the chain does and does not prove |
| [docs/SECURITY_FINDINGS.md](docs/SECURITY_FINDINGS.md) | Every vulnerability found, its fix, and its regression test |
| [docs/AGENT_DECISIONS.md](docs/AGENT_DECISIONS.md) | 19 ADRs — every deviation from the design spec, with reasoning |
| [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md) | Honest assessment: what is solid, what is MVP, what blocks production |
| [docs/PRODUCTION_ROADMAP.md](docs/PRODUCTION_ROADMAP.md) | The phased plan to close those gaps for a SIH showcase, incl. the RAG deepfake-triage pipeline |
| [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) | Feature-by-feature status against the specification |
| [docs/ENGINEERING_PLAN.md](docs/ENGINEERING_PLAN.md) | The phase plan and its test gates |

---

## Three things worth knowing before you read the code

**1. There is one authorization function.** `backend/services/accessResolver.js`. Every protected route goes through it, there are no role checks scattered in controllers, and it loads resources from the database itself so a request body can never supply the facts a policy decision is made on.

**2. The ledger is append-only at three levels.** No update or delete route exists; Mongoose middleware refuses every mutating operation; and each entry's hash chains to its predecessor. Only the third one really matters — the first two stop mistakes, the third makes tampering *detectable*.

**3. AI triage and forensic opinion are never the same thing.** Triage produces `HIGH | MEDIUM | LOW` with a statutory disclaimer, is labelled "Review Priority" everywhere, is never written to the chain, and never produces a percentage. Only an FSL examiner produces `AUTHENTIC | MANIPULATED | INCONCLUSIVE`. The separation is enforced by separate vocabularies in `models/enums.js` and asserted by tests.

---

## Deliberately out of scope

Judge assignment, real DSC/eSign integration, real CCTNS/ICJS connectors, multi-state deployment, HSM-backed keys, a mobile capture app.

Deliberately removed: an admin role, all DELETE endpoints, self-registration, public file URLs.
