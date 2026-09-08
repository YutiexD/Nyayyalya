# LEXX 2.0 — Presentation Roadmap

**Smart India Hackathon · complete run-book, from a cold machine to the closing line.**

This is the operational document. `docs/DEMO_SCRIPT.md` holds the longer narrative; this one
is what you keep open on the second screen. Everything here has been executed end to end
against a real database, three running directory services, the API and a browser.

---

## 0 · The one-paragraph pitch

> Indian courts increasingly receive digital evidence they have no way to test. Under BSA
> 2023 s.63 an electronic record needs a certificate; under BNSS 2023 the accused must be
> served the material. Neither says how anyone checks that the file in court is the file
> that was seized. LEXX is a register that answers that: every exhibit is hashed and signed
> **in the officer's browser** before a byte is uploaded, every action lands in an
> append-only hash-chained ledger, the ledger's Merkle root is anchored to a public
> blockchain, and every access decision runs through a single policy point that reads the
> government's own directories rather than anything a user types. It never claims evidence
> is authentic — only a forensic laboratory does that, and the system keeps the two claims
> visibly apart.

---

## 1 · Before you walk in

### 1.1 Start the stack — four terminals

```bash
npm run mongo:dev
```
```bash
npm run dev
```
```bash
npm run reset -- --yes && npm run seed
```
```bash
npm run health
```

> **The `--` matters.** `npm run reset --yes` gives the flag to *npm*, not to the script,
> and the reset then stops on an interactive prompt. Always `npm run reset -- --yes`.

`npm run dev` starts all three directory services, the API and the web client together.

### 1.2 The six-line health check

`npm run health` must print six green lines. If MongoDB says DOWN, run it again — a cold
Atlas connection does a DNS SRV lookup and a TLS handshake on its first attempt.

### 1.3 Read the seed's closing block

It prints the exhibit codes, the tamper target, the unregistered FIR and the shared
password. Keep that terminal visible.

### 1.4 Set this before the room fills

If judges will scan the certificate QR with their own phones, `localhost` resolves to
nothing on their device. In `.env`:

```
PUBLIC_WEB_URL=http://<your-LAN-ip>:5173
```

Then re-seed so the certificate is generated with a scannable URL.

### 1.5 Browser setup

- One window, **two tabs**: the app, and the public verifier at `/verify`.
- Zoom to **125%**. Hashes are the point; they have to be readable from the back.
- Decide light or dark **now** and stay there. The toggle is in the header — show it once,
  in passing, and move on.

---

## 2 · The cast

Password for every account: `LexxDemo!2026#Seed`
One-time codes are echoed on screen while `DEMO_ECHO_OTP=true` (the server refuses to do
this in production, and says so on the form).

| Identifier | Role | Used in |
|---|---|---|
| `UP-GZB-4471` | Investigating Officer | Beats 2, 3, 5, 7 |
| `UP-GZB-4402` | SHO | Beats 6, 11 |
| `UP-GZB-4455` | Malkhana custodian | Beat 5 |
| `UP-GZB-9001` | District SP | (spare — supervisory scope) |
| `FSL-LKO-0091` | FSL examiner | Beat 8 |
| `UP-JUD-2291` | Judge | (spare — court scope) |
| `UP-GZB-REG-01` | Registrar | Beat 9 |
| `UP/1234/2015` | Defence counsel — **on record** | Beat 9 |
| `UP/9876/2019` | Defence counsel — **not on record** | Beat 9 (the refusal) |
| `UP-GZB-9999` | **Does not exist** | Beat 1 |

### The three FIRs, and why there are three

| FIR | Punishment | Class | State after seeding | Routes to |
|---|---|---|---|---|
| `0123/2026` | 20 yrs | POCSO | Chargesheet filed, full history | Designated Sessions court |
| `0124/2026` | 3 yrs | Ordinary | Open, no exhibits | Magistrate |
| `0125/2026` | 7 yrs | SC/ST | **Not a case at all** | Sessions |

`0125/2026` sits in the police directory as a real FIR and nothing more. **You create the
case from it live, on stage.** That is beat 2, and it is the one step that cannot be
mistaken for seeded state.

---

## 3 · The run — eleven beats, about eight minutes

Timings assume you talk while things load. **Never read a hash aloud.** Point at it, say
what it is, move on.

---

### Beat 1 · An identity that does not exist — 30s

**Do.** `/login`. Enter `UP-GZB-9999`. Check the directory.

**Shows.** A refusal, with a machine code and a plain sentence.

> *"Lexx holds no identities of its own. Officers live in the police directory, judges and
> registrars in the court directory, advocates in the Bar Council roll. There is no
> sign-up. If the directory has no record of you, there is nothing here to create — and
> the attempt is already in the audit log."*

---

### Beat 2 · A case from an FIR that already exists — 60s ★

**Do.** Sign in as `UP-GZB-4471`. Cases tab → FIR **`0125/2026`** → *Create case from FIR*.
Then *Compute jurisdiction* on that row, and on `0123/2026`.

**Shows.** The case inherits station, sections, sensitivity and officer from the directory
record. The two cases route to **different courts**.

> *"I did not type any of this. The station, the sections, the maximum punishment, the
> victim-protection flag — all of it came from the FIR record. And notice the routing
> decides: seven years and SC/ST goes to Sessions, three years ordinary goes to a
> Magistrate, POCSO goes to a designated court. The statute decides, not the officer."*

**If it fails:** you still have `0124/2026` open. Move on; do not debug on stage.

---

### Beat 3 · Hashed and signed before it is sent — 90s ★★

**Do.** Evidence tab. Working case → the case you just made (or `0124/2026`). Choose any
file. Fill Title. Fill **Make / Model / Serial / IMEI** — beat 10 needs them. Upload.

**Shows.** Four steps, each reporting what it produced:
1. **Hash in this browser** — a 64-character SHA-256
2. **Sign in this browser** — a 128-character ECDSA P-256 signature
3. **Upload** — bytes transferred
4. **Server verification** — *digest recomputed and matched; signature verified*

Then two digests side by side: **client** and **server**.

> *"The hash was computed here, on this machine, before a byte left it. The signature uses
> a private key generated in this browser that is marked non-extractable — I could not
> export it if I wanted to. The server then recomputed the hash from the bytes it actually
> received. Those two digests are computed independently and they match, which is how we
> know what was stored is what was signed. If they disagreed, the upload would be refused
> and the refusal would go into the ledger."*

---

### Beat 4 · The review priority is not a verdict — 30s

**Do.** Select the exhibit you just uploaded.

**Shows.** **Review Priority: HIGH/MEDIUM/LOW**, with the system's own disclaimer beside it.

> *"This is the only thing the automated step produces: an ordering for a human reviewer.
> It is not a percentage, not a confidence, and the word 'verified' appears nowhere near
> it. Authenticity is a forensic finding, and you will see who actually makes it in a
> moment."*

---

### Beat 5 · Custody, and a chain with a hole in it — 45s

**Do.** Custody tab — the register for this case. Then sign in as `UP-GZB-4455` at
`/station` → Custody. Show `IT-01232026-001` (complete) and the gap report flagging
`IT-01232026-002`.

**Shows.** Every movement is a two-scan handshake. The gap report names the missing step
and the ledger sequence where the chain jumps.

> *"The second item went from seized straight to the laboratory. The malkhana deposit never
> happened. Nobody filed a complaint about that — the system found it, because the ledger
> knows what a lawful sequence looks like."*

---

### Beat 6 · Break the file. Watch the right light go red. — 90s ★★★

**This is the beat that wins the room.**

**Do.** In a terminal, append a byte to the tamper target using the storage key the seed
printed:

```bash
npm run tamper -- EX-01232026-004
```

It resolves the vault path itself (the vault fans out by the first four characters of the
storage key, which is easy to get wrong under pressure) and prints exactly what the two
lights should now say.

Then, as the IO, open `EX-01232026-004` → **Verify this exhibit**.

**Shows.**

| | |
|---|---|
| Stored file | **FILE MODIFIED** — red |
| Signature | Verified |
| Ledger chain | **CHAIN INTACT** — green |
| Anchored root | matches |

> *"I corrupted that file from outside the application, the way someone with server access
> would. The file light is red — and the ledger light is still green. That distinction is
> the whole product. The file was touched; the log was not. The original hash is still
> provable, so a court can be told exactly what changed and when it was last known good.
> A system that went entirely red here would tell you something is wrong. This one tells
> you **what**."*

---

### Beat 7 · Refer it to the laboratory — 20s

**Do.** As the SHO (`UP-GZB-4402`) at `/station` → Queue, refer the mobile video to FSL.

---

### Beat 8 · The examiner sees only their own referrals — 45s

**Do.** Sign in as `FSL-LKO-0091` at `/lab`.

**Shows.** Referrals to this lab only. Accept, then file a report with an opinion.

> *"An examiner sees exhibits referred to their laboratory and nothing else — not the rest
> of the case, not the other exhibits. And this is the only place an authenticity finding
> enters the system. It is signed by the examiner, attributed to the laboratory and its
> s.79A notification number, and it is deliberately rendered differently from the machine
> priority you saw earlier, because they are different kinds of claim."*

---

### Beat 9 · Disclosure — the advocate on record, and the one who is not — 75s ★★

**Do.**
1. As the IO: Disclosure tab, exclude one exhibit with a reason, prepare the pack.
2. As `UP-GZB-REG-01` at `/court` → Disclosure: **find the pack from the case**, rule on
   the exclusion, serve it.
3. As `UP/1234/2015` at `/counsel`: the served pack, and the acknowledgement that stops the
   BNSS s.230 clock.
4. As `UP/9876/2019`: **refused** — `NOT_ON_RECORD_FOR_THIS_CASE`.

> *"The second advocate is a real, practising advocate in the Bar Council directory. They
> are simply not on record for this case, so there is nothing here for them — and that
> refusal is now in the audit log. Notice also that the withheld exhibit is not merely
> hidden from the pack: counsel cannot list it, cannot search it, and cannot reach its
> certificate. The exclusion hides the exhibit, not just the bytes."*

---

### Beat 10 · The s.63 certificate and its public verifier — 60s ★★

**Do.** As the IO, generate a certificate for the exhibit you uploaded in beat 3. Open the
PDF. Then switch to the second tab — the **public verifier** — and either scan the QR with
a phone or paste the token.

**Shows.** Part A auto-filled from the record — never typed. The verifier answers **without
any sign-in at all**, and discloses validity, never contents.

> *"This is the certificate the Bharatiya Sakshya Adhiniyam asks for, and every field in
> Part A came from the record rather than from someone's memory. The QR on it goes to a
> page anyone can open with no account — a judge, defence counsel, a journalist. It tells
> them the certificate is on the register and its digest still matches. It tells them
> nothing about the case."*

---

### Beat 11 · The Merkle anchor — 60s ★★

**Do.** On the verifier page, the **Anchoring record** panel.

**Shows.** The batch, the Merkle root, the ledger range, network `monad-testnet`, chain
`10143` — and an amber **DRY RUN** banner.

> *"Every few minutes the new ledger entries are batched into a Merkle tree and the root is
> anchored. Only the root. No evidence, no filenames, no personal data, no case
> identifiers, no AI scores — a root is a commitment, and it discloses nothing about what
> it commits to."*

**Now say the honest part. Do not skip it.**

> *"And I want you to see this banner. This deployment has no funded signing key, so the
> root was computed and stored locally and **not** submitted to any chain. The system says
> so, in those words, rather than showing you a green tick. We built it that way
> deliberately: an unanchored root presented as an anchored one is exactly the kind of
> claim this project exists to prevent."*

That admission is worth more than the feature. It is also the answer to the first hard
question you will be asked.

---

## 4 · Closing — 30s

> *"Three claims, and we keep them separate. The **officer** signed what they uploaded.
> The **laboratory** gave an opinion on authenticity. The **ledger** proves nothing has
> changed since. Our software makes none of those claims itself — it makes each one
> checkable, by someone who does not have to trust us. Four hundred and fifty-three tests
> stand behind that, including a red-team suite that attacks the API assuming a hostile
> client."*

---

## 5 · Questions you will get

**"Is this production ready?"**
No, and `docs/PRODUCTION_READINESS.md` says exactly what is missing: the master key belongs
in an HSM, the directories are simulated, there is no HA story. What is solid is the
security model, and there are 453 tests behind it.

**"Why not put the evidence on the blockchain?"**
Because that would put case data on a public, permanent, unredactable ledger. We publish a
Merkle root — a commitment that proves a set of records existed in exactly that form,
and discloses nothing about them. Putting evidence on-chain would be a privacy incident
with extra steps.

**"How do I know the AI isn't deciding guilt?"**
It produces one field: a review priority for a human queue. It is labelled that way in the
API, in the database and on screen, it never produces a percentage, and the word "verified"
is never attached to it. Authenticity comes from a s.79A laboratory and is signed by a
named examiner.

**"What if an insider with database access edits a record?"**
That is beat 6, and it is the case we designed for. The file changed and the ledger caught
it, because the ledger's hashes are chained and its root is committed elsewhere. An insider
would have to rewrite every subsequent entry *and* the anchored root, and the root is not
theirs to rewrite.

**"Why Monad and not Ethereum?"**
Cost and finality for a testnet demonstration, and the contract is chain-agnostic — it is
Solidity 0.8.24 with OpenZeppelin access control. The design does not depend on the chain;
it depends on the root being somewhere we cannot quietly change.

**"Can a police officer delete evidence?"**
There is no delete endpoint anywhere in the system. Where another design would remove a
record, this one records a court order and changes a status. The ledger is append-only and
the model enforces it.

---

## 6 · If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| Reset stops at a prompt | `npm run reset --yes` | `npm run reset -- --yes` |
| Search returns 503 | Indexes gone | Reset rebuilds them; otherwise restart the API |
| Upload refused `SIGNATURE_INVALID` | Browser key not registered | Sign in again — the login flow detects it and offers to register the device |
| Upload refused `CASE_STAGE_CLOSED_TO_WRITES` | Working case is chargesheeted | Switch to `0124/2026` or the case from beat 2 |
| Anchor panel says nothing anchored | Batcher had nothing new | Expected right after a reset; the seed anchors what it creates |
| A directory is down | Service not started | `npm run dev` starts all of them |

**The rule on stage:** if a beat fails, say *"that one's not cooperating"* and move to the
next. Beats 6, 10 and 11 carry the presentation on their own.

---

## 7 · What to have open

1. Terminal with the seed output (the tamper storage key)
2. Terminal ready for the tamper command
3. Browser tab — the app
4. Browser tab — `/verify`
5. This file, on the second screen

---

## 8 · The thirty-second version

If you get cut short, do **beat 3** and **beat 6**. Hash and sign in the browser, then
break the file and show the file light red while the ledger light stays green. That pair is
the entire thesis.
