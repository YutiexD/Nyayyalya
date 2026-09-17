# LEXX 2.0 — The Idea and the Workflow, in Plain Language

> **Who this is for:** anyone who has to explain LEXX without a technical background — a
> presenter, a judge, a police officer, a lawyer, a friend. No code, no jargon. Where a
> technical word cannot be avoided, it is explained in the glossary at the end.

---

## 1. The problem, as a story

A woman's phone is seized in a criminal case. On it is a video that could decide the trial.

Months later, the video is played in court. The defence lawyer stands up and asks three questions:

1. **"Is this the same file that was collected — or has someone edited it since?"**
2. **"Has anyone checked whether this video is a deepfake, or simply copied from the internet?"**
3. **"Where is the legal certificate for it — and how do we know the certificate is genuine?"**

Today, answering those questions means digging through paper registers, emails between the
police station and the forensic lab, and a certificate typed up and signed by hand at the last
minute. Pieces go missing. Cases get delayed, and sometimes genuine evidence is thrown out simply
because nobody can *prove* it was handled properly.

At the same time, AI tools now make fake photos and videos easy to create. Courts are
receiving digital evidence that no one can confidently trust.

---

## 2. The idea

**LEXX is one trusted record that follows a piece of evidence from the police station all
the way to the courtroom.**

Every time something happens to the evidence — it is uploaded, certified, examined, or the case
moves forward in court — LEXX writes it down in a way that **cannot be quietly changed
afterwards**. Anyone who needs to can later check that the evidence and its history are exactly
as they were.

It rests on three simple promises:

- **Nothing is ever deleted.** Things can change status, but every change is recorded with
  who did it and when.
- **The AI helps the lab decide what to look at first. Only the forensic lab decides what is
  real. Only the court decides the case.** These three are never mixed up.
- **LEXX does not create people.** Police officers, judges, lawyers and lab examiners already
  exist in official government records. LEXX checks those records; it cannot invent an
  officer or a judge.

---

## 3. The people in the story

| Person | What they do in real life | What they do in LEXX |
|---|---|---|
| **Investigating Officer (IO)** | The police officer investigating the case | Opens the case, uploads evidence, files the chargesheet |
| **Station House Officer (SHO)** | The officer in charge of the police station | Watches over every case at the station. Can step in if something looks wrong — but nobody has to wait for their approval |
| **Forensic Lab Examiner (FSL)** | The scientist at the government forensic lab | Sees the AI's first look, examines the evidence, and gives the official answer: real, edited, or can't tell |
| **Court** | The judge and court staff | Receives the case after the chargesheet, moves it through the court stages, and accepts lawyers onto the case |
| **Lawyer** | Defence lawyer, victim's lawyer | Once the court accepts them, sees the case and all its evidence automatically |
| **The public** | Anyone | Can check that a certificate is genuine, without logging in |

---

## 4. The journey of one piece of evidence

### Step 1 — The case is opened
The officer types in the FIR number. LEXX fetches the details from the police records
(sections, station, how serious the offence is) and **works out which court the case will
eventually go to** — explaining why, in plain words (for example, *"victim is a minor —
special court required"*).

### Step 2 — The officer uploads the evidence
The officer picks the photo, video or document, gives it a **title**, and (if they like) a short
description. That is all they have to fill in. Details about the phone or computer it came from
are optional.

Behind the scenes, before the file even leaves the officer's computer, LEXX takes its **digital
fingerprint** (a unique code that changes completely if even one pixel of the file changes) and
the officer's computer **signs** it — like a personal seal only that officer's device can make.
The officer does not have to do anything for this.

When the file arrives, LEXX checks the fingerprint and the seal again. If they don't match,
the upload is refused and the refusal itself is recorded.

The file is stored locked (encrypted), so even someone who steals the database cannot open it.

### Step 3 — The Section 63 certificate is created automatically
Indian law (Bharatiya Sakshya Adhiniyam, Section 63) says digital evidence in court needs a
certificate. **LEXX creates it the moment the evidence is uploaded — nobody has to fill it in or
sign it by hand.**

- It is filled from the record: what the file is, its digital fingerprint, who uploaded it and
  when, and how it came into the system.
- It is **signed by LEXX itself**, as the "LEXX Certificate Authority" — like an official stamp
  that only the system can apply, and that anyone can check.
- There is **exactly one certificate per piece of evidence**. The system will not make a second.
- It has a QR code and a link anyone can use to check it is genuine.

**A QR label comes with it.** Every piece of evidence also gets its own permanent QR code. The officer
can print it as a sticker and put it on the phone, the hard disk or the evidence bag. Anyone who scans
it — no login needed — sees whether the evidence and its certificate still check out, who uploaded
it and when, which case and court it belongs to, and where it is in its journey: uploaded,
certificate issued, examined by the lab, chargesheet filed, taken up by the court, and so on. It never
shows the lab's verdict or the AI's analysis.

The certificate is about the **record** — that this is the file that was uploaded, unchanged. It
does not say whether the video is real or fake; that is the lab's job, and it is kept separate.

### Step 4 — The AI takes a first look (for the lab only)
In the background, the file is sent to an AI model, which looks at the actual photo or video and
reports:

- whether it seems genuine or possibly manipulated (a deepfake),
- a score out of 100,
- **in its own words, why** — for example, *"lighting on the face does not match the background"*,
- the specific warning signs it noticed,
- how urgently a human expert should look at it: **Critical, High, Medium or Low**,
- and whether it recommends a full forensic examination.

Important things to say about the AI:

- **Only the forensic lab sees the AI result.** Police, the court and lawyers never see it — not
  the score, not the priority, not even the order it would put evidence in. It exists to help the
  lab decide what to examine first, and nothing else.
- **Everything shown comes from the AI itself.** LEXX does not make up scores or explanations.
- **If the AI fails** (no internet, busy, can't read the file), LEXX says so honestly and the lab
  gets a *Retry* button. It never fills in a fake result. The upload and the certificate are not
  affected.
- **The AI is a helper, not a judge.** Every AI result is clearly labelled *"automated
  preliminary assessment — not a forensic finding"*.

### Step 5 — The forensic lab examines it
The lab examiner opens their screen and sees **cases, not a pile of files**. Each case shows
its evidence sorted by how urgent the AI thinks it is, and whether a verdict already exists.

Where an examination is needed, the examiner looks at the evidence and records the **official
verdict**: **Authentic, Manipulated, or Inconclusive** — signed with their own seal.

On screen, the AI's opinion and the lab's verdict are **shown in visibly different boxes**, so
no one can confuse a machine's guess with an expert's finding. A verdict, once recorded,
**cannot be overwritten**. Unlike the AI result, the lab's verdict *is* visible to the police, the
court and the lawyers — it is the official finding.

**One-click certificate check.** Anyone working on the case — the lab, the police, the court, a
lawyer on record — can press **Verify** on the certificate. LEXX re-checks five things on the spot:

1. the certificate document has not been changed,
2. it really carries LEXX's signature,
3. the evidence file is still exactly what was uploaded,
4. it is the current certificate for that evidence,
5. its entry in the tamper-proof record is intact.

The answer is simply **Verified** or **Failed** (with which check failed). This check does not
depend on the lab's verdict: a video can be *Manipulated* and still have a perfectly valid
certificate, because the certificate proves the file was not changed *after* it was collected.

### Step 6 — The chargesheet is filed
When the investigation is finished, the officer files the chargesheet. From that moment the
investigation record is locked, and **the case appears on the court's screen immediately**.

### Step 7 — The case moves through court
The court sees exactly what needs its attention and the **next step it can take**. The steps
follow the real court process, in order:

> **Chargesheet filed → Court takes cognizance → (Committed to Sessions Court, for serious
> cases) → Trial begins → Case closed**

- The court cannot skip steps. For example, a trial cannot begin before committal in a
  Sessions case — and the screen explains why.
- Some steps ask for a short note, like a line in the court's order sheet.
- Every screen updates **live**: when the police file the chargesheet, the case appears on the
  court's screen within a second, without anyone refreshing — and the same for evidence, lab
  verdicts, lawyers and closing.
- The case's **CNR** (its court registration number) has a copy button wherever it is shown.
- If needed, the court can also send the case back for **further investigation**.

### Step 8 — Lawyers come on record, and see the evidence automatically
A lawyer files a **vakalatnama** (the document that says "I represent this person") through
LEXX. Until the court accepts it, the lawyer **cannot open the case at all** — and the attempt
is recorded.

**The moment the court accepts the vakalatnama, the lawyer can see the case, every piece of
evidence in it, and each certificate.** Nobody has to remember a second step to "share" anything.
The lawyer can view, download and verify — but cannot change anything, and never sees the AI
result.

### Step 9 — The case is closed
The judge closes the case with a short reason and can **attach the final judgment, a declaration or
an order** as a PDF. Just like evidence, the document is fingerprinted and signed by the judge's own
device, stored locked, and its fingerprint becomes part of the case record. Police, the court and the
lawyers on the case can open it.

Closing a case stops new activity. **Nothing is deleted.** Every piece of evidence, verdict,
certificate and record remains readable.

### Following every step — the timeline
Each case and each piece of evidence has a **timeline**. Every step in it says, in plain words,
**what happened, who did it and when** — for example *"Uploaded by SI Ramesh Kumar (Investigating
Officer)"* or *"Closed by the Court; final judgment attached"*. Open **Show proof** on a step to see
what backs it up: the file's fingerprint, the signing key that was used, the entry in the chain of
records, and the blockchain transaction that locked it in. The public page reached by scanning the QR
label shows the same timeline, without private notes, the lab's verdict or the AI result.

---

## 5. How we prove nothing was changed (the blockchain part, simply)

Every action in LEXX is written into a **chain of records**, where each entry includes a
fingerprint of the one before it. Change one old entry, and every entry after it stops
matching — like tearing a page out of a numbered, glued notebook.

Every few minutes LEXX takes a single fingerprint of all recent entries and publishes **just
that fingerprint** on a public blockchain (Monad Testnet). Once it is there, nobody — not even
us — can change it.

- **What goes on the blockchain:** only that one fingerprint.
- **What never goes on the blockchain:** evidence, names, case details, AI results.

So if anyone ever edits the evidence file or the record, a single **Verify** click shows
exactly what changed:

- 🔴 *File modified* — the evidence file itself was tampered with, or
- 🟢 *Record intact* — the history of who did what was not.

---

## 6. Why this is different

1. **The certificate makes itself.** No typing, no chasing signatures — every piece of evidence
   gets its legal certificate the moment it is uploaded, and anyone can check it in one click.
2. **The AI is powerful but kept in its place.** It analyses the media, explains itself and even
   checks whether a photo came from the internet — but only the lab sees it, and the law's
   requirement that a certified lab decides authenticity is built into the system.
3. **Proof starts on the officer's own computer**, before the file is even uploaded.
4. **The court sees every case the moment it's filed**, with its next legal step laid out.
5. **Lawyers get the evidence as soon as the court accepts them** — no forgotten "share" step.
6. **Anyone can verify a certificate** — no account, no phone call to the police station.
7. **Access follows real authority.** A transferred officer or a lawyer not on record loses
   access automatically, on their very next click. People stay signed in while they work; they are
   not thrown out every few minutes.

---

## 7. What is real today, and what is not (be honest about this)

**Working today (a complete prototype):**
- The full journey above, from FIR to closed case, on screen.
- Automatic, system-signed Section 63 certificates with one-click verification.
- AI analysis of uploaded evidence, for the lab.
- A permanent, printable QR label for every piece of evidence that shows its checks and lifecycle when scanned.
- A step-by-step timeline for every case and piece of evidence, with who did what and the proof behind it.
- Live screens that update on their own, and a judge's signed final judgment attached at closing.
- The tamper-proof record and publishing to the Monad test blockchain.
- Hundreds of automatic tests that check every step and every permission.

**Not yet:**
- It is **not connected to real government systems**. The police, court and lawyer records
  are realistic stand-ins built to behave like the real ones (CCTNS, eCourts, FSL systems).
- It is **not deployed** for real users; it runs on a laptop.
- It has **not had an independent security audit**.
- The certificate's signing key is held by the server; a real rollout would keep it in secure
  government key hardware.
- Sending evidence to an outside AI service would need government data-handling approval in a real
  rollout.

**Never say:** "the AI detects fake evidence", "evidence is stored on the blockchain",
"integrated with CCTNS/eCourts", "the certificate proves the video is real", or any accuracy
percentage for the AI.

**Say instead:** "the AI helps the lab decide what to examine first", "only a fingerprint is
stored on the blockchain", "designed to plug into CCTNS and eCourts", "the certificate proves the
file hasn't changed since it was collected".

---

## 8. Simple answers to likely questions

**"Is the AI deciding if evidence is fake?"**
No. It gives the lab a first opinion and a priority. The official answer comes only from the
forensic lab, and the court decides the case.

**"Why can't the police, the court or the lawyers see the AI result?"**
Because it is a machine's guess, not a finding. Keeping it with the lab means nobody can use it to
sway the case. What everyone else sees is the lab's official verdict.

**"What if the AI is wrong?"**
That's exactly why it can't make the final call. Its job is to help the lab work on the most
urgent evidence first.

**"What if the internet or the AI is down?"**
Evidence is still saved, the certificate is still created, and the case continues. The lab sees
the AI result as *failed* with a *Retry* button — nothing is made up.

**"Who signs the certificate?"**
LEXX itself, as the LEXX Certificate Authority, on behalf of the officer who uploaded the
evidence. Anyone can check that signature with one click, or by scanning the QR code.

**"What does scanning the QR label show?"**
Whether the evidence and its certificate are still intact, who uploaded it and when, the case and
court, and each step the evidence has been through. It does not show the lab's verdict or the AI
result, and it does not need a login.

**"If the lab says a video is manipulated, is the certificate invalid?"**
No. The certificate proves the file is exactly what was collected. Whether what it shows is real
is a separate question, answered by the lab.

**"Can a police officer delete evidence?"**
No. There is no delete button anywhere in the system.

**"Can someone change the evidence later?"**
They could try, but it would be caught instantly. The digital fingerprint would no longer
match, the certificate check would fail, and the published blockchain fingerprint can't be changed.

**"Why would a court trust this?"**
Because the court doesn't have to trust us. Every claim can be checked independently.

**"Who can see the evidence?"**
Only people with a real role in the case: the investigating officer, their station, the
lab, the court, and lawyers the court has accepted.

---

## 9. Glossary

| Word | Meaning |
|---|---|
| **FIR** | First Information Report — the police record that starts a criminal case |
| **IO** | Investigating Officer — the police officer handling the case |
| **SHO** | Station House Officer — the officer in charge of the police station |
| **FSL** | Forensic Science Laboratory — the government lab that examines evidence |
| **Chargesheet** | The police report sent to court when the investigation is finished |
| **Cognizance** | The court formally taking up the case |
| **Committal** | A magistrate sending a serious case to the Sessions Court for trial |
| **Section 63 certificate** | The legal certificate required for digital evidence under the Bharatiya Sakshya Adhiniyam |
| **LEXX Certificate Authority** | The name under which LEXX itself signs every certificate |
| **Vakalatnama** | The document authorising a lawyer to represent someone |
| **Deepfake** | A photo, video or audio clip faked or altered using AI |
| **AI model** | A computer program trained to analyse media; LEXX uses one to give the lab a first look at evidence |
| **QR label** | A permanent QR sticker for a piece of evidence; scanning it shows the evidence's checks and lifecycle |
| **Digital fingerprint** | A short code calculated from a file; changes completely if the file changes even slightly |
| **Digital signature** | A seal only one person's device (or the LEXX system) can create, proving who produced something |
| **Blockchain** | A public record that nobody can edit once something is written to it |
