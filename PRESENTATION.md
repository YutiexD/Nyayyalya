# LEXX 2.0 — Demo Run-book

**A 3-minute demo (with an optional 2-minute extension for a 5-minute slot): the setup, the
logins, what is on each screen, what to click, and what to say.**

For the plain-language explanation of the idea, read `WORKFLOW.md` first.

The story you are showing:

> **Police upload evidence → the certificate and a QR label are created automatically → the lab
> sees the AI analysis and gives its verdict → the case goes to court → the court accepts the lawyer
> → the lawyer sees the evidence automatically → anyone can scan the QR or open the link to verify
> the evidence and its whole lifecycle.**

---

## Part 1 — Before the judges arrive (30 minutes early)

### 1.1 Check `.env`

```
GEMINI_API_KEY=<your key>
GEMINI_MODEL=gemini-2.5-flash
DEMO_ECHO_OTP=true
REFRESH_TTL_SEC=0
```

- **AI key:** https://aistudio.google.com/apikey → *Create API key*.
- **Model code:** https://ai.google.dev/gemini-api/docs/models → copy the code exactly.
- `DEMO_ECHO_OTP=true` shows sign-in codes on screen (no phone needed).
- `REFRESH_TTL_SEC=0` — you are never logged out automatically.

The app refuses to start without the AI key and model, and says which one is missing.

### 1.2 Start and load the demo data

```bash
npm run dev
```

In a second terminal, once everything is listening:

```bash
npm run reset -- --yes --directories
```
```bash
npm run seed
```
```bash
npm run health
```

The seed ends with a summary. **Keep it visible** — it prints the certificate **Verify link** and
the **QR label** links for Tab 5. (Lost them? Run `node scripts/demo-lookup.js`.)

**Optional — scanning with a phone on stage:** a phone can only open the QR if the address inside it
is reachable from the phone. Set `PUBLIC_WEB_URL=http://<laptop-LAN-IP>:5173` in `.env`, make the web
app listen on the network, and connect the phone to the same Wi-Fi. Otherwise open the link on the
laptop instead of scanning.

### 1.3 Accounts

**Password for every account:** `LexxDemo!2026#Seed`

| Login ID | Who | Screen | Used in |
|---|---|---|---|
| `UP-GZB-4471` | Investigating Officer (police) | `/officer` — **Your cases** | **Tab 1** |
| `FSL-LKO-0091` | Forensic lab examiner | `/lab` — **Lab cases** | **Tab 2** |
| `UP-JUD-2291` | Court (one login for every court in the district) | `/court` — **Court** | **Tab 3** |
| `UP/9876/2019` | Lawyer — not on any case yet | `/counsel` — **Your cases** | **Tab 4** (5-min version) |
| `UP/1234/2015` | Lawyer — already on record for FIR 0123/2026 | `/counsel` | Backup |
| `UP-GZB-4402` | Station House Officer | `/station` — **Station cases** | Q&A |
| `UP-GZB-9999` | **Fake ID** — not in any directory | `/login` | Q&A |

### 1.4 Signing in (same for everyone)

1. `http://localhost:5173/login` → type the **Login ID** → continue.
2. Ask for the code → **the code appears on screen** ("Demo code").
3. Type the code and the password → sign in.
4. **First time in this browser only:** **Register this device** appears → send the code again →
   type it → **Register this device**. Needed once per account per browser, so the browser can sign.

### 1.5 Cases already loaded

| FIR | State after seeding | Used for |
|---|---|---|
| `0124/2026` | Under investigation, **no evidence yet** | **The live demo** |
| `0123/2026` | 5 exhibits with certificates, lab verdict on one, chargesheet filed, a lawyer on record | Backup, and the Verify link |
| `0125/2026` | In police records but not yet a case | Q&A: "open a case from an FIR" |

### 1.6 Browser tabs

One window, zoom 125%. Open each tab with **Ctrl+T** (not "Duplicate tab" — each tab keeps its own
login). Sessions never expire, so tabs can sit ready.

| Tab | Signed in as | Leave it on |
|---|---|---|
| **1 — Police** | `UP-GZB-4471` | **Your cases** → FIR **0124/2026** selected |
| **2 — Lab** | `FSL-LKO-0091` | **Lab cases** |
| **3 — Court** | `UP-JUD-2291` | **Court** → **Needs action** |
| **4 — Lawyer** | `UP/9876/2019` | **Your cases** (5-min version only) |
| **5 — Public** | *not signed in* | the **QR label** link for EX-01232026-001 from the seed summary |

### 1.7 Files on the desktop

- **`fake.jpg`** — an obviously AI-generated or edited photo (a face swap works well).
- **`genuine.jpg`** — a normal phone photo, as a backup.
- **`vakalatnama.pdf`** — any small PDF, for the lawyer's filing in the 5-minute version.
- **`judgment.pdf`** — any small PDF, attached by the judge when closing the case (5-minute version).

### 1.8 Rehearsal checklist

- [ ] `npm run health` all green
- [ ] A practice upload shows the AI analysis on the Lab screen within ~20 s (then reset + seed again)
- [ ] Tabs 1–5 signed in, device registered in Tabs 1–4
- [ ] A printer (or "Save as PDF") ready for **Print QR label**; optionally a sticker sheet
- [ ] Notifications off, other apps closed

---

## Part 2 — The 3-minute script

**Say** = speak it. **Do** = click it. Never read codes or hashes aloud.

---

### 0:00 – 0:20 · The problem · *Tab 1*

**Say:**
> "When digital evidence reaches court, three questions decide whether it counts: Is this the same
> file? Is it fake — or just copied from the internet? And where is its legal certificate? Today
> that takes weeks of paperwork. With LEXX it takes one upload."

---

### 0:20 – 0:50 · Police upload — the certificate makes itself · *Tab 1 (Police)*

**Do:** FIR **0124/2026** → **Upload evidence** → choose `fake.jpg` → keep the title → **Upload**.

**Point at:** the three steps completing — *Fingerprint · Upload · Certificate issued* — and the
**QR code** that appears with it.

**Do:** **Print QR label** → show the sticker in the print preview → print it (or cancel).

**Say:**
> "I'm the investigating officer. I choose the file and give it a title — that's all. LEXX
> fingerprints it on my laptop, uploads it, and the Section 63 certificate is created and signed by
> the system instantly. It also gives the evidence a permanent QR label — stick it on the phone or the
> evidence bag, and anyone can scan it to check the evidence and its whole history."

*Note: the police screen shows no AI result — by design.*

---

### 0:50 – 1:35 · The lab — AI analysis and one-click verification · *Tab 2 (Lab)*

**Do:** click FIR **0124/2026** (it is already there — every screen updates live, no refresh) → click
the new exhibit.

**Point at (left):** the **AI analysis** — assessment and score, reasoning, warning signs and
review priority.

**Say:**
> "Only the forensic lab sees this. The AI gives a first opinion — is it manipulated, why, and how
> urgently an expert should look at it."

**Do (right):** **Verify certificate**.

**Point at:** the green **Verified** result.

**Say:**
> "One click checks everything: the file hasn't changed, the certificate is genuine and the record
> is intact."

**Do:** choose **Manipulated**, type one line (e.g. *"Face region inconsistent with the rest of the image"*)
→ **Sign and record verdict**.

**Say:**
> "The official verdict comes from the lab, not the AI — signed, and it can never be overwritten."

---

### 1:35 – 1:45 · Chargesheet · *Tab 1 (Police)*

**Do:** FIR **0124/2026** → **File chargesheet** → confirm.

**Say:** "Investigation complete. Chargesheet filed."

---

### 1:45 – 2:20 · The court takes it up · *Tab 3 (Court)*

**Do:** **Needs action** → FIR **0124/2026** has appeared on its own (badge *Next: Take cognizance*) →
open it. Point at the CNR's copy button.

**Point at:** the stage stepper and the **next judicial step** button.

**Do:** **Take cognizance** → note *"Chargesheet perused"* → confirm.

**Point at:** the next step now offered (*Frame charges and begin trial*) and the evidence table with
its verdict and certificate columns.

**Do:** open **Case timeline** → expand **Show proof** on *Cognizance taken*.

**Say:**
> "The moment the chargesheet was filed, the case reached the court with its next legal step ready —
> no refresh. The court moves it forward in the real legal order and can't skip a step. And every
> step says who did it, when, and the fingerprints and blockchain record that prove it."

---

### 2:20 – 2:50 · Scan the label — verify the evidence and its lifecycle · *Tab 5 (Public)*

**Do:** open the **QR label** link (or scan the printed label with a phone — see 1.2).

**Point at:** the large **Verified** card, then **Uploaded by** (officer, role, station), **Case**
(FIR, court, current stage), **Section 63 certificate**, and the **Lifecycle** timeline — uploaded,
certificate issued, forensic examination, chargesheet, cognizance… Expand **Show proof** on one step:
who did it, the file fingerprint, the signing key and the blockchain transaction.

**Say:**
> "Anyone can scan the QR on the evidence — no login. It re-checks the file and the certificate on the
> spot, shows who uploaded it and when, and exactly where the evidence is in its journey through the
> case. Every step is chained together and anchored on a public blockchain. Change one byte of the
> evidence, and this turns red."

---

### 2:50 – 3:00 · Close

**Say:**
> "Police upload. The certificate makes itself. The AI helps the lab. The lab decides what's real.
> The court decides the case. LEXX proves nothing changed along the way. Thank you."

---

## Part 3 — Extension to 5 minutes (insert after 2:20)

### + 0:45 · The lawyer gets the evidence automatically · *Tab 4 → Tab 3 → Tab 4*

**Do (Tab 4, lawyer `UP/9876/2019`):** **File vakalatnama** → pick FIR 0124/2026's case by its CNR
(shown on the court screen) → appearing for the accused → attach any PDF → file.

**Say:** "A lawyer files their vakalatnama. Until the court accepts it, they see nothing."

**Do (Tab 3, court):** FIR **0124/2026** → **Lawyers** → the filing is already listed → **Accept**.

**Do (Tab 4):** without refreshing, FIR **0124/2026** appears → open it → the evidence table is there
→ **Verify** on the certificate.

**Say:**
> "The court only accepts the lawyer. There is no 'share evidence' step — the case and its evidence
> are available to that lawyer immediately. And the lawyer never sees the AI analysis."

### + 0:30 · The judge closes the case with the final judgment · *Tab 3 (Court)*

**Do:** FIR **0124/2026** → **Close case** → reason note → **Attach final judgment / declaration** →
kind *Final judgment* → choose `judgment.pdf` → **Close case**.

**Point at:** *Fingerprint · Sign · Close*, then the **Case closed** block — closed by, document,
SHA-256 and the judge's signing key — and **Open document**. Tabs 1 and 4 show it closed within a
second.

**Say:**
> "The judge closes the case and attaches the final judgment. The document is fingerprinted and
> signed by the judge's own device, stored encrypted, and its fingerprint joins the case record."

### + 1:15 · Tampering is caught · *terminal → Tab 3 or Tab 5*

**Do:** in a terminal:

```bash
npm run tamper -- EX-01232026-004
```

Then as the court (or on Tab 5 with EX-01232026-004's link from `node scripts/demo-lookup.js`), open
exhibit **EX-01232026-004** → **Verify certificate**.

**Point at:** **Failed** — *Evidence file is unchanged since it was uploaded* is red, while the other
checks stay green.

**Say:**
> "Someone edited the file directly on the server. One click, and LEXX shows exactly what changed —
> the file — and that the record itself is intact."

*(After the demo, reset and seed again.)*

---

## Part 4 — If something goes wrong

| Problem | What to do |
|---|---|
| AI analysis still *Pending* after 30 s | Keep going; verify the certificate and record the verdict, return to it at the end |
| AI analysis *Failed* | *"No internet or quota — and it says so honestly instead of inventing a result."* Click **Retry** |
| Upload refused `SIGNATURE_INVALID` | That tab skipped **Register this device**. Use FIR **0123/2026** as backup |
| Case not under **Needs action** | Check the **Live** dot in the top bar; if it says *Reconnecting*, wait a few seconds or refresh. Otherwise use FIR **0123/2026**, already waiting for the court |
| Signed out | Sign in again (1.4) — 20 seconds |
| Scanned QR won't open on a phone | `PUBLIC_WEB_URL` still points at `localhost` — open the link on the laptop instead |
| Anything else | Tab 5 always works — finish the story there |

---

## Part 5 — Quick Q&A demos (30 seconds each)

- **Fake officer:** sign in as `UP-GZB-9999` → rejected, not in the official directory, and recorded.
- **Lawyer not on the case:** as `UP/9876/2019`, before acceptance, the case isn't available.
- **Station chief:** `UP-GZB-4402` → **Station cases** — every case and its evidence, no approvals
  needed from them, no AI shown.
- **Open a case from an FIR:** Tab 1 → **Open case** → `0125/2026`.

---

## Part 6 — Quick answers

| Question | Answer |
|---|---|
| Who creates the Section 63 certificate? | The system, automatically, the moment evidence is uploaded — one per exhibit, signed by the LEXX Certificate Authority. |
| How is it verified? | One click. It checks the file, the certificate's signature, that it is the current one, and the record. It doesn't depend on the lab verdict. |
| Does AI decide if evidence is fake? | No. It gives the lab a first opinion and a priority. The official verdict comes only from the forensic lab. |
| Who sees the AI analysis? | Only the forensic lab. Police, court and lawyers never see it. |
| What is the QR label? | A permanent QR created with every upload. Printed and stuck on the physical item, anyone can scan it to check the evidence, its certificate, who uploaded it and its lifecycle — without a login, and without revealing the lab verdict or the AI analysis. |
| How do lawyers get evidence? | The court accepts their vakalatnama; the evidence is available to them immediately. No sharing step. |
| Is evidence on the blockchain? | No — only a fingerprint of the records. |
| Can evidence be deleted? | No. There is no delete function anywhere. |
| Connected to CCTNS / eCourts? | Not yet. Realistic stand-ins behave the same way, so real systems can plug in. |
| Is it live? | A working prototype running locally, with 564 automated backend tests. |

**Never say:** "AI detects fake evidence", "evidence is on the blockchain", "integrated with
eCourts", any AI accuracy percentage — and don't name the AI provider on stage.
