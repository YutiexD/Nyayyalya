# LEXX — Demo Script

**Five minutes, one case file, eight moves.** Everything below has been executed against a
running system. Where something is off by default, that is stated plainly rather than implied.

The second half of this document is the long form — the material to reach for when a judge
asks a question, or when you have fifteen minutes instead of five.

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
npm run reset -- --yes && npm run seed    # 3
```

Then `npm run health` — six green lines before you present anything.

The seed prints the shared password, the **storage key of the tamper target** (move 7 needs
it) and the certificate's **verify link**. Every other value you might paste is shown on
screen where it belongs, and all of them are listed by:

```bash
node scripts/demo-lookup.js
```

Accounts were activated by the seed on a different "device", so the first sign-in in your
browser asks you to **Register this device** (one extra code). That is the key-rotation flow
working, not an error. Do this for every account you plan to sign anything with, BEFORE you
present — it costs thirty seconds each and it is the only thing in the run that looks like a
hitch when it is not one.

**After pulling new code, restart `npm run dev`** — the API and directories read their code
once at start. On Windows, Ctrl+C can leave the child processes running; if the new servers
cannot bind their ports, stop the old `node` processes before starting again.

**Rehearse the reset.** `npm run reset -- --yes && npm run seed` takes about twenty seconds
and restores everything, including un-tampering the file you break in move 7.

### The accounts

One password for all of them, printed by the seed.

```
Police   UP-GZB-4471  investigating officer      UP-GZB-4402  station house officer
         UP-GZB-4455  keeps the station store    UP-GZB-9001  district SP (read-only)
Court    UP-JUD-2291  Sessions Court No. 2       UP-GZB-EVC-01  its evidence room
         UP-JUD-1180  Court of the CJM           UP-GZB-EVC-02  its evidence room
FSL      FSL-LKO-0091 examiner, State FSL Lucknow
Counsel  UP/1234/2015 on record   ·   UP/9876/2019 not on record (the denial)
```

There is no malkhana custodian and no registrar. Both were roles whose only function in the
workflow was to be waited for, and both are gone — the station keeps its own store, and the
presiding judge holds the whole of the court's authority. If someone asks, that is the answer:
*we removed the two steps that added a login and no decision.*

### The case

```
FIR 0123/2026 · Kavi Nagar PS, Ghaziabad · State v. Ramesh Singh
BNS 65(2), 3(5) · maximum 20 years · POCSO · victim protected

EX-…-001  CCTV still, clean provenance            Review Priority  LOW
EX-…-002  Mobile video, editor tag + duration gap Review Priority  CRITICAL  → examined: MANIPULATED
EX-…-003  Witness statement (scanned)             Review Priority  LOW       → withheld from counsel
EX-…-004  Seized phone photo, provenance gaps     Review Priority  HIGH      → THE TAMPER TARGET
EX-…-005  Forwarded screenshot                    Review Priority  HIGH

IT-…-001  Samsung A54, seal SEAL-GZB-88231   complete chain
IT-…-002  USB drive                          chain deliberately broken

Court: Sessions Court No. 2 (POCSO and SC/ST designated) · CNR UPGB010012342026
Counsel: UP/1234/2015 on record and served · UP/9876/2019 not on record

In the police directory, not yet cases:
  FIR 0124/2026 — 3 years, ordinary → Magistrate   ← opened by the seed, still under investigation
  FIR 0125/2026 — 7 years, SC/ST Act → Special     ← open it live in move 1
```

---

# The five-minute run

Eight moves. Each is one screen and one sentence. Times are cumulative and are what the run
actually takes once rehearsed — the slack is in moves 7 and 8, which are the ones worth
slowing down for.

---

## 1 · A case exists because an FIR does — 0:00

**As** the investigating officer `UP-GZB-4471`.

**Do:** **Open a case** → FIR `0125/2026`.

**Shows:** the case appears with its station, sections, maximum punishment and sensitivity
class already filled in, and a lifecycle strip showing where it is and what is ahead of it.

> *"There is no free-text case creation. Every jurisdictional fact here came from the FIR
> record in the police directory — we verify against it and can create nothing in it."*

---

## 2 · Evidence is hashed and signed before it is sent — 0:40

**Do:** on that case, **Register evidence** → attach any image → fill in the device
particulars → **Hash, sign and upload**.

**Shows:** four steps, all visible — *hash in this browser → sign in this browser → upload →
server verification* — then the two digests side by side, one computed here and one
recomputed by the server from the bytes it received.

> *"The SHA-256 is computed in the browser before a byte is uploaded, and signed with a key
> that never leaves the device. The server recomputes both and refuses anything that
> disagrees. This is not a claim that files cannot be altered — it is a claim that alteration
> cannot be hidden."*

---

## 3 · The system prioritises it, nobody else does — 1:20

**Do:** stay on that screen. The receipt panel shows **Review priority, assigned
automatically** with the reasons underneath.

**Shows:** a band — CRITICAL, HIGH, MEDIUM or LOW — and the sentences behind it: *no capture
timestamp*, *editing software tag present*, *container and stream durations disagree by 19s*.

> *"Nobody was asked for that. There is no field for it on the form and no endpoint that sets
> it: it is computed from the file's own metadata, the integrity of this upload, its media
> type and the gravity of the case. It says what a human should look at first. It never says
> whether anything is authentic — that word does not exist in this part of the system."*

> **What you will see, and the answer to the question it invites.** A plain photograph with
> no EXIF has three provenance gaps and lands at **MEDIUM** on an ordinary case. Uploaded into
> FIR 0125/2026 — SC/ST Act, seven years — the *same file* lands at **HIGH**. That is the
> model's one deliberate asymmetry, and it is worth stating before anyone asks: gravity moves
> an exhibit up the queue by exactly one band, only when something was actually observed about
> it, and never into CRITICAL. A file nothing was observed about stays LOW however serious the
> case, because otherwise every exhibit on a serious case arrives pre-elevated and the queue
> stops being ordered at all.
>
> The seeded POCSO case carries the rest of the scale: a clean CCTV still at LOW, a forwarded
> screenshot at HIGH, and a video with an editor tag and a nineteen-second container/stream
> disagreement at CRITICAL. The FSL queue in move 4 shows the counts by band on one screen.

---

## 4 · The laboratory works a queue in that order — 2:00

**As** the examiner `FSL-LKO-0091`.

**Shows:** *Evidence to review* — the queue, worst first, with the counts by band across the
top. Open the CRITICAL exhibit: **why this priority**, then the verdict form.

> *"The laboratory sees the digital evidence registered in the state it serves, in the order
> the system says it should be looked at. Before, an exhibit reached a lab only when a police
> supervisor remembered to refer it — so the exhibits most likely to be manipulated sat in a
> station queue, unseen."*

---

## 5 · The verdict is one form and one signature — 2:40

**Do:** choose **Manipulated**, write a sentence, **Sign and record the verdict**.

**Shows:** the queue count drops, the exhibit moves to *Reviewed*, and the opinion is now on
the exhibit, in the case timeline and in the ledger.

> *"Three words, and no others: authentic, manipulated, inconclusive. This is the only
> authenticity vocabulary in the system and only a notified laboratory can produce it. The
> verdict was hashed and signed in this browser over a statement the server rebuilds from what
> it received — the opinion cannot be swapped after it is signed."*

---

## 6 · The court reads everything, and is waiting on nobody — 3:10

**As** the judge `UP-JUD-2291`.

**Shows:** the cause list, then one case panel carrying the whole of it — the lifecycle strip,
counsel, every exhibit with its forensic state, and the line that matters:

> **3 of 5 exhibits have no laboratory opinion yet. Nothing here waits on one.**

**Do:** in **Counsel**, take the waiting advocate on record. Then **Share the case file**.

> *"Two things people expect to be blocked and are not. The court reads the case file whether
> or not a laboratory has reported — forensic review runs alongside the investigation, not in
> front of the court. And sharing that file with the defence is one decision by the court that
> holds it: composed, ruled on and served in a single act, with a separate watermark minted
> for each recipient."*

---

## 7 · Tamper the file. Watch the right light go red — 3:50 ★

**This is the move that wins the round. Rehearse it.**

**Do:** open `EX-…-004`, expand **Check this exhibit** → four green lights. Then, in a
terminal:

```bash
echo "x" >> vault/<first-2>/<next-2>/<the storage key the seed printed>
```

Check it again.

```
Stored file        FILE_MODIFIED    ● red
Uploader signature verified         ● green
Ledger chain       CHAIN_INTACT     ● green
Anchored root      ANCHOR_MATCH     ● green
```

> *"Note which light went red. The file changed; the log did not. We are not claiming files
> cannot be modified — we are claiming modification cannot be hidden, and that the record of
> what the file used to be is still there, still signed, still chained."*

Then check `EX-…-001` — still green — so the detection is specific, not a blanket alarm.

---

## 8 · Anyone can check it, and the court can close it — 4:30

**Do:** open `/verify` in a private window — **no login**. Paste the certificate link the seed
printed, or drop the certificate PDF onto the page.

**Shows:** the certificate is genuine, this copy matches the registered document, and which
parts are signed — and, under **Anchoring history**, the Merkle root on Monad Testnet with a
link to the transaction.

> *"Every five minutes the ledger's new entries are batched into a Merkle tree and the root
> goes on chain. Only the root — no evidence, no names, no case identifiers. It proves this
> set of entries existed in exactly this form at that time. It does not prove they are true;
> that is what the signatures are for."*

**Close:** back as the judge, **Close the case** → a reason, type CLOSE.

> *"Closed, and nothing was deleted. Every exhibit, opinion, certificate, custody record and
> ledger entry is exactly where it was and stays readable. Closing stops the record; it does
> not remove it. There is no delete endpoint anywhere in this system."*

**5:00.**

---

# The long form

The material below is what to reach for when you have longer, or when a specific question is
asked. None of it is needed for the five-minute run.

---

## Identity: Lexx holds none

**Do:** on the login page, enter PIS number `UP-GZB-9999`.

**Shows:** `IDENTITY_NOT_VERIFIED · IDENTITY_NOT_IN_DIRECTORY`. Then, as the SHO, Station →
**Sign-in refusals**: the attempt is the top row.

> If asked "could you not just insert a row?" — the directories are separate services with
> separate databases, and every route on them is a GET, enforced by middleware, except two
> simulated court-registry acts (accepting a vakalatnama, registering a chargesheet), each of
> which checks its own records before it writes. Lexx cannot create an officer, a judge, an
> advocate or an examiner.

## Jurisdiction, with its reasoning on screen

**Do:** as the IO, on a case still under investigation, **Compute jurisdiction**.

```
Court type  Special (SC/ST designated)
Court       Sessions Court No. 2, Ghaziabad · UP-GZB-SESS-02
  · Maximum punishment 7 years — triable by a Court of Session
  · SC/ST (Prevention of Atrocities) Act — Special Court required
  · Committal by a Magistrate required before trial
```

Filing the chargesheet registers the case with that court, which allots the CNR — and it
appears on that judge's cause list and on no other. FIR 0124/2026 routes to the Magistrate
instead, and appears only on `UP-JUD-1180`'s.

> The reasoning is the point. Anyone can output "Sessions Court". Showing *why* is what a
> judge can check against the statute.

## The officer's own receipt

The upload downloads a receipt automatically:

```json
{ "exhibitCode": "...", "sha256": "...", "ledgerSeq": 12,
  "entryHash": "...", "signedAt": "...", "anchorNetwork": "monad-testnet" }
```

> *"That is the officer's own copy, and it is a check on our entire system — they can prove
> later what they handed over without relying on us at all."* **Check this receipt on the
> public verifier** does exactly that, with no account.

## Custody: a two-scan handshake, and a chain that does not add up

**Do:** as the IO, open a case → **Physical custody** → open `IT-…-001`. Show the printed
label: QR, item code, seal number, FIR, IMEI, who seized it. Scan it with a phone (it opens
`/scan?label=…`) or paste it into **Resolve a label**.

Hand it over live: choose a destination and a named receiver, **Start handover** → a one-time
code, shown once, valid five minutes. In a second window, as the receiver, open the same label
and enter the code with "seal intact" ticked → **Accept custody**. Two more ledger entries.

Then, as the SHO, Station → **Chain of custody** → `IT-…-002`:

```
SEQUENCE_DISCONTINUITY    Expected custody event 2, found 4. 2 events are missing.
ILLEGAL_STATE_TRANSITION  SEIZED → AT_FSL is not a lawful move. A lawful route
                          would have passed through IN_STORE.
STATE_DIVERGENCE          The ledger's last state is AT_FSL; the item record says SEIZED.
```

> This gap is not something the app could produce — the transfer API correctly *refuses* an
> illegal SEIZED → AT_FSL jump, which is the point. The seed writes the event straight to the
> ledger, the way a real gap actually arises: a record migrated from a legacy system, or a
> move that happened before Lexx was in use. The detector exists for exactly that case.

Two guards worth naming:

- A valid QR proves the **label** is genuine. It grants no authority — every action still goes
  through the access resolver. Anyone who photographs a printed tag can reproduce it, so
  treating a scan as permission would be forgeable.
- The investigating officer on a case cannot be the store keeper for that case's own evidence.
  That rule survived the removal of the custodian role; it is now enforced against whoever
  would actually end up holding the article.

## Counsel: on record, and served, are two different things

**Do:** as `UP/9876/2019` — a real advocate in good standing, on no case — there is nothing.
Then **File a vakalatnama** against CNR `UPGB010012342026`, attach a signed PDF, **Sign and
file**. Still nothing.

As the judge: the case panel now shows the filing under **Counsel** with the document
attached. **Take on record.** The toast says *Court register: Recorded*.

Then **Share the case file**. Back as the advocate, the case and the served set appear.

> *"Filing grants nothing. The court's acceptance is written to the court's own register
> first, and only then does Lexx open the case — so if the vakalatnama is withdrawn at the
> court, the next re-check withdraws access here."*

Two refusals worth showing:

```
403  NOT_ON_RECORD_FOR_THIS_CASE       an advocate who has not been taken on record
403  EXHIBIT_NOT_IN_DISCLOSURE_SET     an advocate on record, reaching for a withheld exhibit
```

> *"Being on record gets you the case. It does not get you every exhibit in it."*

The withheld exhibit is reported to counsel as a COUNT and a GROUND, never as an item — naming
it would disclose the very thing the withholding was for. Paste a recipient's watermark token
into **Trace a leaked copy** and the court is told whose copy it was.

## The Section 63 certificate, and its two parties

**Do:** open any exhibit → **Section 63 certificate**. Part A auto-fills from the evidence
record and the ledger timeline — the device, the digest, the manner of production. Part B can
only come from a laboratory's report.

The panel carries the verification link, its QR, and the PDF. Hand the PDF to someone: they
open `/verify`, drop the file on **"Were you handed a certificate?"** — no token needed, it is
read out of the PDF, and the file is hashed in their browser and never uploaded. The answer is
about *their copy*: **Identical to the registered document**, **An earlier version**, or **Not
the registered document**. Edit one byte and drop it again to show the third.

> Generation is REFUSED if any Part A particular is missing, with the list of what is missing.
> Refusing to produce an incomplete legal document is the difference between helping and
> amplifying errors, and it is worth saying out loud.

The public response carries no case narrative, no accused names and no evidence content. There
is a test asserting sixteen PII strings never appear in it.

## The audit feed

**Do:** as the SHO or the district SP, Station → **Refusals**.

> *"Every authorization decision is recorded, allow and deny. The denials are the interesting
> ones: a log that only records successes cannot show you the advocate who reached for an
> exhibit they were not entitled to. Audit rows are append-only too — there is no code path
> that edits or deletes one."*

## Anchoring is live

The local `.env` runs with `ANCHOR_ENABLED=true`, the deployed contract and a signer holding
`ANCHOR_ROLE` and testnet MON. The seed's last step submits a root; after that the API submits
every five minutes. On the public verifier, **Anchoring history** lists each batch with its
block and a link to the transaction — open it and show the input: a batch id, a root, two
sequence numbers. Nothing else. A batch becomes `CONFIRMED` only after the receipt has been
read back with `status === 1`.

**Restart the API after changing `.env`** — configuration is read once at start. If the wallet
runs dry or the RPC is down, batches go `FAILED` or stay `DRY_RUN`, the verifier shows them
amber, and you must say so rather than present a dry run as on chain.

---

## Questions you should expect

**"How does the AI decide what is important?"**
From the file's own metadata, the integrity of its upload, its media type and the gravity of
the case — and it shows its working as sentences, not a score. What was *observed about the
file* sets the band; how grave the case is can move it up one place and never into CRITICAL.
It runs on every exhibit at ingest, and there is no endpoint that sets a priority, so nobody
can push their own work up the queue.

**"How do we know the AI isn't deciding guilt?"**
It produces one of four band names and orders a queue. It cannot write to the ledger or the
chain, and it has no vocabulary for authenticity — that vocabulary exists only in the FSL
module. There are tests asserting both, including one that fails if the triage output ever
contains the words `AUTHENTIC`, `MANIPULATED` or `VERIFIED`, or any percentage.

**"What if someone has database access?"**
They can change a row. They cannot make the change undetectable: every ledger entry hashes its
predecessor, and the verify endpoint recomputes the whole chain and reports the exact sequence
where it breaks. There is a test that performs precisely this attack.

**"What if the officer's phone is stolen?"**
The key is non-extractable in the browser, so it cannot be exported — but a stolen unlocked
device is a real risk. The officer re-keys, which costs a live session and a fresh OTP. Past
evidence stays verifiable because each record pins the public key that actually signed it.

**"Why not put the evidence hash on the chain?"**
A hash of a photograph of an identifiable victim is still linked to that victim, permanently
and publicly. Roots only.

**"Why did you remove the malkhana custodian and the registrar?"**
Because neither made a decision. The custodian's real contribution was a rule — the officer on
a case must not keep that case's evidence — and that rule is still enforced, against whoever
would actually hold the article. The registrar's was a second court login between a judge's
decision and its effect. Both were steps the workflow waited on and learned nothing from.

**"Is this production-ready?"**
No, and `docs/PRODUCTION_READINESS.md` says exactly what is missing. The master key is in an
environment variable and belongs in an HSM; the directories are mocks; there is no HA story.
What *is* solid is the security model, and it has the test suite behind it.
