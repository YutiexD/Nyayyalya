# LEXX 2.0 — Demo Script

Eleven beats, eleven problem-statement requirements, one case file.

Every beat below has been executed against a running system. Where a beat depends on something that is off by default (blockchain anchoring), that is stated plainly rather than implied.

---

## Before you start

Three terminals:

```bash
npm run mongo:dev      # 1
```
```bash
npm run dev            # 2
```
```bash
npm run reset --yes && npm run seed    # 3
```

Then `npm run health` — six green lines before you present anything.

The seed prints the shared password and the **storage key of the tamper target**. Copy that key; beat 5 needs it.

**Rehearse the reset.** `npm run reset --yes && npm run seed` takes about 20 seconds and restores everything, including un-tampering the file you break in beat 5. You will need it between run-throughs.

---

## The case

```
FIR 0123/2026 · Kavi Nagar PS, Ghaziabad
BNS 65(2), 3(5) · maximum punishment 20 years · POCSO · victim protected
IO: SI Rakesh Kumar (UP-GZB-4471)

EX-01232026-001  CCTV still          Review Priority MEDIUM   → the certificate
EX-01232026-002  Mobile video        Review Priority HIGH     → referred to FSL
EX-01232026-003  Witness statement   Review Priority LOW      → excluded from disclosure
EX-01232026-004  Seized phone photo                           → THE TAMPER TARGET

IT-01232026-001  Samsung A54, seal SEAL-GZB-88231   complete chain
IT-01232026-002  USB drive                          chain deliberately broken

Court: Sessions Court No. 2, Ghaziabad (POCSO designated), CNR UPGB010012342026
Judge UP-JUD-2291 — reached via the roster, never assigned by Lexx
Advocates: UP/1234/2015 (on record) · UP/9876/2019 (NOT on record — the denial)
```

---

## BEAT 1 — A fake authority identity is rejected, and the attempt is audited

**Do:** on the login page, enter PIS number `UP-GZB-9999`.

**Shows:** `IDENTITY_NOT_VERIFIED · IDENTITY_NOT_IN_DIRECTORY`.

**Say:** *"Lexx holds no identities. That PIS number does not exist in the police directory, so there is no account for us to create and no way to make one. The attempt is now in the audit log."*

Then log in as SHO `UP-GZB-4402` and show the denial in the security feed.

> If asked "could you not just insert a row?" — the directories are separate services with separate databases, and every route on them except one registrar endpoint is a GET, enforced by middleware. Lexx has no write path into them at all.

---

## BEAT 2 — Case from FIR, with the jurisdiction reasoning on screen

**Do:** log in as IO `UP-GZB-4471`. Create a case from FIR `0123/2026`.

**Shows:**

```
SPECIAL (POCSO)
  · Maximum punishment 20 years — triable by a Court of Session
  · Victim is a minor — POCSO designated court required
  · Committal by a Magistrate required before trial
  · BNS sections invoked: 65(2), 3(5)
```

**Say:** *"There is no free-text case creation. Every fact here — the station, the sections, the maximum punishment, the sensitivity class — comes from the FIR record in the police directory. The routing is a pure function of those facts, and it shows its working."*

> The reasoning is the point. Anyone can output "Sessions Court". Showing *why* is what a judge can check.

---

## BEAT 3 — Upload: hashed and signed in the browser, verified on the server

**Do:** upload a file as the IO. Watch the four steps: **hashing → signing → uploading → server verified**. Download the receipt.

**Say:** *"The SHA-256 is computed in the browser before a byte is uploaded, and signed with a private key that is non-extractable and never leaves the device. The server recomputes the hash from what it actually received, and verifies the signature against the key registered at activation. If either check fails the upload is refused and the failure goes in the ledger."*

Open the receipt JSON:

```json
{ "exhibitCode": "...", "sha256": "...", "ledgerSeq": 12,
  "entryHash": "...", "signedAt": "...", "anchorNetwork": "monad-testnet" }
```

**Say:** *"That is the officer's own copy. It is a check on our entire system — they can prove later what they handed over without relying on us at all."*

---

## BEAT 4 — QR custody chain, and a broken one

**Do:** scan or enter `IT-01232026-001`. Show the full timeline: SEIZED → IN_STORE, two signatures, seal intact.

Then open custody gaps and show `IT-01232026-002`.

**Shows:** structured findings — `ILLEGAL_STATE_TRANSITION`, `SEQUENCE_DISCONTINUITY`, `STATE_DIVERGENCE` — naming the lawful route that was skipped ("a lawful route would have passed through IN_STORE").

> This item's gap is not something the app itself could produce — the two-scan transfer API correctly *refuses* an illegal SEIZED → AT_FSL jump, which is exactly the point. The seed writes this one event straight to the ledger, the way a real gap would actually arise: a record migrated from a legacy system, or a custody move that happened before Lexx was in use. The detector exists for exactly that case.

**Say:** *"Transfer is a two-scan handshake. The sending officer initiates, which mints a single-use token valid for five minutes; the receiving officer accepts, and both signatures go in the ledger. The custody history is not a field we update — it is derived from the append-only ledger, so it cannot be quietly rewritten."*

Two guards worth naming:
- A valid QR proves the **label** is genuine. It grants no authority — every action still goes through the access resolver. Anyone who photographs a printed tag can reproduce it, so treating a scan as permission would be forgeable.
- The IO of a case cannot be the malkhana custodian for their own case's evidence. One `if`, and it is the kind of thing a defence counsel asks about.

---

## BEAT 5 — Tamper the file. Watch the right light go red. ★

**This is the beat that wins the round. Rehearse it.**

**Do:** first click Verify on `EX-01232026-004`. Four green lights.

Then, in a terminal:

```bash
echo "x" >> vault/<first-2>/<next-2>/<the storage key the seed printed>
```

Click Verify again.

**Shows:**

```
File integrity      FILE_MODIFIED     ● red
Signature           valid             ● green
Ledger chain        CHAIN_INTACT      ● green
Anchor              …
```

> "The stored file has been modified since it was recorded. The ledger is intact — so the FILE was touched, not the log. The original hash remains provable."

**Say:** *"Note which light went red. The file changed; the log did not. That distinction is the whole design — we are not claiming files cannot be modified, we are claiming modification cannot be hidden. The original hash is still there, still signed, still chained."*

Then click Verify on `EX-01232026-001` — still green — to show the detection is specific, not a blanket alarm.

> If someone asks what happens when the *log* is attacked, tamper a ledger row directly in MongoDB. `chainIntegrity` becomes `CHAIN_BROKEN` and reports the exact sequence number. There is a test for it.

---

## BEAT 6 — AI triage: review priority, never a verdict

**Do:** log in as SHO. Open the triage queue.

**Shows:** **Review Priority: HIGH** on the mobile video, with its indicators, and the disclaimer visible:

> *Automated triage only. Not expert opinion under BSA s.39 / IT Act s.79A.*

**Say:** *"This is a queue-ordering tool. It says what a human should look at first. It does not say whether anything is authentic, it never emits a percentage, it is never written to the ledger or the blockchain, and it is labelled 'Review Priority' in every surface. The one opinion that matters in law comes from a notified laboratory, and that is the next beat."*

> The separation is enforced, not just conventional: triage and forensic opinion have separate vocabularies in `models/enums.js`, and a test asserts the triage output can never contain the words `AUTHENTIC`, `MANIPULATED` or `VERIFIED`, or any percentage.

---

## BEAT 7 — FSL: the examiner sees only their own referrals

**Do:** log in as examiner `FSL-LKO-0091`.

**Shows:** exactly one referral — the mobile video referred to State FSL Lucknow. Nothing else in the case is visible.

Accept it, then file the report: opinion **MANIPULATED**, with the examination summary, signed.

**Say:** *"An examiner's world is defined entirely by referrals to their own lab. No referral, no visibility — not the case, not the other exhibits. And this is the only place in the entire system that the word 'authentic' can be produced. The report is signed with the examiner's key and carries the lab's s.79A notification reference."*

---

## BEAT 8 — Disclosure: the advocate on record, and the one who is not

**Do:** log in as `UP/1234/2015`. Show the served disclosure set — and the watermark carrying their name, enrolment number and the time of service.

Point out that the witness statement is **not** in the set: it was excluded, with a reason, and the exclusion was approved by the registrar.

Now log in as `UP/9876/2019`.

**Shows:**

```
403  NOT_ON_RECORD_FOR_THIS_CASE
```

**Say:** *"This advocate is real, active, and in good standing with the Bar Council. They are simply not on record for this case — there is no accepted vakalatnama. That grant is not something Lexx decides; it mirrors what the court asserted."*

Then show the same advocate, once on record, being refused a single exhibit outside the served set:

```
403  EXHIBIT_NOT_IN_DISCLOSURE_SET
```

**Say:** *"Being on record gets you the case. It does not get you every exhibit in it."*

---

## BEAT 9 — The Section 63 certificate, and its public verifier

**Do:** generate the s.63 certificate for `EX-01232026-001`. Open the PDF; scan the QR on it.

**Shows:** the public verifier — **no login** — confirming the certificate is genuine, the PDF hash matches, and which parts are signed.

**Say:** *"Part A auto-fills from the evidence record and the ledger timeline — the device, the hash, the manner of production. Part B can only come from a filed FSL report; Lexx never authors an expert opinion. And if any Part A field is missing, generation is refused with the list of what is missing."*

> **Show the refusal if you have time.** Refusing to produce an incomplete legal document is the difference between helping and amplifying errors, and it is worth saying out loud.

Note what the public verifier does *not* return: no case narrative, no accused names, no evidence content. A token holder learns validity, not contents. There is a test asserting sixteen PII strings never appear in that response.

---

## BEAT 10 — The audit feed, including the denial that just happened

**Do:** as SHO or SP, open the audit feed filtered to denials.

**Shows:** the `NOT_ON_RECORD_FOR_THIS_CASE` denial from beat 8, with the actor, the case, the time and the reason code — plus the fake-identity attempt from beat 1.

**Say:** *"Every authorization decision is recorded, allow and deny. The denials are the interesting ones: a log that only records successes cannot show you the advocate who reached for an exhibit they were not entitled to. Audit rows are append-only too — there is no code path that edits or deletes one."*

---

## BEAT 11 — The Merkle anchor on Monad Testnet

**Do:** open the anchor panel, or `GET /api/anchors/latest`.

**Shows:**

```json
{ "merkleRoot": "0x27a7…", "fromSeq": 1, "toSeq": 17, "leafCount": 17,
  "network": "monad-testnet", "chainId": 10143, "status": "..." }
```

**Say:** *"Every five minutes the ledger's new entries are batched into a Merkle tree and the root goes on Monad Testnet. Only the root. No evidence, no file contents, no names, no case identifiers, no AI scores — a root is a commitment and it discloses nothing about what it commits to."*

Then be precise about what it proves:

*"This proves that this set of ledger entries existed in exactly this form at that time. It does not prove the entries are true, and it does not prove the evidence is authentic. Those are different claims, made by different people — the officer who signed the upload, and the laboratory that examined it."*

### Honesty note

With no funded signing key, the batcher runs in `DRY_RUN`: roots are computed and stored, nothing is submitted, and the status field says so. Do not present a dry run as an on-chain transaction.

To anchor for real, deploy the contract and set `ANCHOR_ENABLED=true`, `ANCHOR_CONTRACT_ADDRESS` and `ANCHOR_PRIVATE_KEY`. The status becomes `CONFIRMED` only after the transaction receipt has been read back with `status === 1` — a submitted transaction is not a confirmed one, and a reverted transaction must never sit in the database looking like proof.

If you are anchoring live, open the `testnet.monadexplorer.com` link and show the transaction input: a batch id, a root, two sequence numbers. Nothing else.

---

## Questions you should expect

**"How do we know the AI isn't deciding guilt?"**
It produces one of three words and orders a queue. It cannot write to the ledger or the chain, and it has no vocabulary for authenticity — that vocabulary exists only in the FSL module. There are tests asserting both.

**"What if someone has database access?"**
They can change a row. They cannot make the change undetectable: every ledger entry hashes its predecessor, and the verify endpoint recomputes the whole chain and reports the exact sequence where it breaks. There is a test that does precisely this attack.

**"What if the officer's phone is stolen?"**
The key is non-extractable in the browser, so it cannot be exported — but a stolen unlocked device is a real risk. The officer re-keys with `POST /api/auth/rotate-key`, which costs a live session and a fresh OTP. Past evidence stays verifiable because each record pins the public key that actually signed it.

**"Why not put the evidence hash on the chain?"**
A hash of a photograph of an identifiable victim is still linked to that victim, permanently and publicly. Roots only.

**"Is this production-ready?"**
No, and `docs/PRODUCTION_READINESS.md` says exactly what is missing. The master key is in an environment variable and belongs in an HSM; the directories are mocks; there is no HA story. What *is* solid is the security model, and it has 423 tests behind it.
