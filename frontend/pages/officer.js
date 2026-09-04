/**
 * Investigating officer's view.
 *
 * Four things happen here, and three of them are demo beats:
 *
 *   Cases      — create a case from an FIR that already exists in the police
 *                directory, then show the jurisdiction router's REASONING, not just
 *                its answer (beat 2).
 *   Evidence   — upload an exhibit as four visible steps: hashed in this browser,
 *                signed in this browser, uploaded, verified by the server. The
 *                officer leaves with a downloadable receipt (beat 3), and can
 *                re-verify any exhibit into the four independent lights (beat 5).
 *   Disclosure — propose the set that will be served on the defence, with a stated
 *                reason for anything withheld.
 *   Custody    — register a physical item and print its label (beat 4).
 */
import { api } from '../lib/api.js';
import { getOrCreateKeyPair, hashFile, signHashHex } from '../lib/crypto.js';
import { custodyLabel } from '../lib/qr.js';
import { verificationReport } from '../lib/verify.js';
import { boot } from './shell.js';
import {
  el,
  mount,
  clear,
  append,
  section,
  field,
  input,
  select,
  table,
  kv,
  hash,
  shortHash,
  notice,
  denial,
  showError,
  spinner,
  reviewPriority,
  forensicOpinion,
  downloadJson,
  downloadBlob,
  fmtDate,
  fmtBytes,
  humanise,
  withBusy,
} from '../lib/ui.js';

const SOURCE_TYPES = [
  'MOBILE',
  'COMPUTER',
  'DVR',
  'CD_DVD',
  'FLASH_DRIVE',
  'SERVER',
  'CLOUD',
  'OTHER',
];

const CUSTODY_LOCATIONS = ['FIELD', 'MALKHANA', 'FSL', 'COURT'];

/** Shared across tabs: which case the officer is working in. */
const store = { cases: [], selectedCaseId: null };

const selectedCase = () => store.cases.find((c) => String(c._id) === store.selectedCaseId) ?? null;

async function loadCases() {
  const { cases } = await api.cases.list({ limit: 100 });
  store.cases = cases ?? [];
  if (!store.selectedCaseId && store.cases.length) store.selectedCaseId = String(store.cases[0]._id);
  return store.cases;
}

/** A case picker every working tab shares, so the officer sets context once. */
function casePicker(onChange) {
  if (!store.cases.length) return notice('No case is open to you yet. Create one from an FIR first.', 'warn');

  const control = select(
    {
      onChange: (e) => {
        store.selectedCaseId = e.target.value;
        onChange();
      },
    },
    store.cases.map((c) => ({
      value: String(c._id),
      label: `FIR ${c.firNumber} · ${c.stationCode} · ${humanise(c.stage)}`,
    }))
  );
  control.value = store.selectedCaseId ?? '';
  return field('Working case', control);
}

// ============================================================== 1. CASES ====

/**
 * The jurisdiction router's output.
 *
 * `reasons` is rendered as a list, prominently, because the reasoning is what makes
 * this credible — anyone can print "Sessions Court". Showing the statutory working
 * is what says these people did the homework.
 */
function jurisdictionPanel(result) {
  const j = result.jurisdiction ?? result;
  const reasons = j.reasons ?? [];

  return el('div.stack', [
    el('div.verdict', [
      el('span.verdict__label', 'Court type'),
      el('span.verdict__value', j.courtType ?? '—'),
      j.requiredDesignation ? el('span.verdict__label', 'Designation') : null,
      j.requiredDesignation ? el('span.verdict__value', j.requiredDesignation) : null,
    ]),
    el('div', [
      el('div.verdict__label', 'Because'),
      reasons.length
        ? el('ol.reasons', reasons.map((r) => el('li', String(r))))
        : el('p.empty', 'The router returned no reasons for this case.'),
    ]),
    j.requiresCommittal
      ? notice('Committal by a Magistrate is required before trial can begin.', 'warn')
      : null,
    result.court
      ? notice(
          `Matched court: ${result.court.name ?? result.court.code}${
            Array.isArray(result.court.designations) && result.court.designations.length
              ? ` (designated: ${result.court.designations.join(', ')})`
              : ''
          }`,
          'ok'
        )
      : null,
    result.note ? notice(String(result.note), 'warn') : null,
    result.courtLookupError
      ? notice(
          `The court directory could not be reached (${result.courtLookupError}). No court was matched — that is a directory outage, not a finding that no court is required.`,
          'bad'
        )
      : null,
  ]);
}

function renderCases(root) {
  const listSlot = el('div');
  const createSlot = el('div');
  const jurisdictionSlot = el('div');

  const firInput = input({ placeholder: '0123/2026', spellcheck: 'false' });
  const createBtn = el('button.btn', { type: 'submit' }, 'Create case from FIR');

  const refresh = async () => {
    mount(listSlot, spinner('Loading cases…'));
    try {
      await loadCases();
      mount(
        listSlot,
        table(
          [
            { header: 'FIR', cell: (c) => el('code', c.firNumber) },
            { header: 'Title', cell: (c) => c.title ?? '—' },
            { header: 'Station', cell: (c) => c.stationCode ?? '—' },
            { header: 'Stage', cell: (c) => el('span.pill', humanise(c.stage)) },
            { header: 'Sensitivity', cell: (c) => el('span.pill', humanise(c.sensitivityClass)) },
            { header: 'Max punishment', cell: (c) => (c.maxPunishmentYears ? `${c.maxPunishmentYears} yrs` : '—') },
            { header: 'CNR', cell: (c) => (c.cnrNumber ? el('code', c.cnrNumber) : '—') },
            {
              header: '',
              cell: (c) =>
                el(
                  'button.btn.btn--secondary.btn--small',
                  {
                    type: 'button',
                    onClick: async (e) => {
                      store.selectedCaseId = String(c._id);
                      await withBusy(e.currentTarget, 'Computing…', async () => {
                        mount(jurisdictionSlot, spinner('Asking the jurisdiction router…'));
                        try {
                          const result = await api.cases.computeJurisdiction(c._id);
                          mount(
                            jurisdictionSlot,
                            section(
                              `Jurisdiction — FIR ${c.firNumber}`,
                              'Computed from the statutory facts on the FIR: sections, maximum punishment, and sensitivity class.',
                              jurisdictionPanel(result)
                            )
                          );
                        } catch (error) {
                          showError(jurisdictionSlot, error);
                        }
                      });
                    },
                  },
                  'Compute jurisdiction'
                ),
            },
          ],
          store.cases,
          { empty: 'No cases are open to you.' }
        )
      );
    } catch (error) {
      showError(listSlot, error);
    }
  };

  const form = el(
    'form',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        const firNumber = firInput.value.trim();
        if (!firNumber) return;
        clear(createSlot);
        await withBusy(createBtn, 'Creating…', async () => {
          try {
            const { case: created } = await api.cases.fromFir(firNumber);
            store.selectedCaseId = String(created._id);
            mount(
              createSlot,
              notice(`Case created for FIR ${created.firNumber} at ${created.stationCode}.`, 'ok')
            );
            await refresh();
            // Beat 2 runs straight off the back of creation: the router's reasoning
            // is the first thing the officer sees about their new case.
            mount(jurisdictionSlot, spinner('Computing jurisdiction…'));
            const jurisdiction = await api.cases.computeJurisdiction(created._id);
            mount(
              jurisdictionSlot,
              section(
                `Jurisdiction — FIR ${created.firNumber}`,
                'Computed from the statutory facts on the FIR: sections, maximum punishment, and sensitivity class.',
                jurisdictionPanel(jurisdiction)
              )
            );
          } catch (error) {
            mount(createSlot, denial(error, { heading: 'Case not created' }));
          }
        });
      },
    },
    [
      field(
        'FIR number',
        firInput,
        'The FIR must already exist in the police directory. There is no free-text case creation in this system — a case inherits its station, sections, sensitivity and investigating officer from the FIR record.'
      ),
      el('div.row', [createBtn]),
    ]
  );

  append(root, [
    el('h2.page-title', 'Cases'),
    el(
      'p.page-lede',
      'A case is created only from an FIR the police directory already holds, so its jurisdictional facts are directory facts rather than anyone’s assertions.'
    ),
    el('div.grid.grid--2', [
      section('Create a case from an FIR', null, [form, createSlot]),
      el('div', jurisdictionSlot),
    ]),
    el('div', { style: 'height:18px' }),
    section('Your cases', 'Scope-filtered by the access resolver — you see the cases you are on record for.', listSlot),
  ]);

  refresh();
}

// ============================================================ 2. EVIDENCE ====

const STEP_LABELS = [
  ['Hash in this browser', 'SHA-256 over the file bytes, computed before anything is sent.'],
  ['Sign in this browser', 'ECDSA P-256 over the hex digest, with a private key that cannot leave this device.'],
  ['Upload', 'The bytes, the digest and the signature travel together.'],
  ['Server verification', 'The server recomputes the digest from what it received and checks the signature against your registered key.'],
];

function stepRow(index, title, detail, status, state) {
  return el(`div.step${state ? `.step--${state}` : ''}`, [
    el('div.step__num', String(index)),
    el('div', [el('div.step__title', title), detail ? el('div.step__detail', detail) : null]),
    el('div.step__status', status),
  ]);
}

/** The upload progress panel: four steps, each one visibly distinct. */
function uploadSteps() {
  const container = el('div.steps');
  const states = STEP_LABELS.map(() => ({ status: 'waiting', detail: '', state: '' }));

  const paint = () => {
    clear(container);
    STEP_LABELS.forEach(([title, hint], i) => {
      const s = states[i];
      append(
        container,
        stepRow(i + 1, title, s.detail || hint, s.status, s.state)
      );
    });
  };

  paint();
  return {
    node: container,
    start(i, status = 'running') {
      states[i] = { ...states[i], status, state: 'active' };
      paint();
    },
    done(i, detail, status = 'done') {
      states[i] = { detail: detail ?? states[i].detail, status, state: 'done' };
      paint();
    },
    fail(i, detail) {
      states[i] = { detail: detail ?? states[i].detail, status: 'failed', state: 'failed' };
      paint();
    },
  };
}

function ingestSummary(evidence) {
  const pill = (ok, okText, badText) =>
    el(`span.pill.pill--${ok ? 'ok' : 'bad'}`, ok ? okText : badText);

  return kv([
    ['Exhibit code', el('code', evidence.exhibitCode)],
    ['Hash (client, in browser)', hash(evidence.sha256Client)],
    ['Hash (server, recomputed)', hash(evidence.sha256Server)],
    ['Hashes agree', pill(evidence.hashMatchedOnIngest, 'MATCHED', 'MISMATCH')],
    ['Signature', pill(evidence.signatureValidOnIngest !== false, 'VERIFIED', 'INVALID')],
    ['Signing key fingerprint', el('code', shortHash(evidence.signerPubKeyFingerprint, 16))],
    ['Size', fmtBytes(evidence.sizeBytes)],
    ['Type', el('code', evidence.mimeType ?? '—')],
  ]);
}

function renderEvidence(root) {
  const pickerSlot = el('div');
  const uploadSlot = el('div');
  const listSlot = el('div');
  const verifySlot = el('div');

  const rerender = () => {
    mount(pickerSlot, casePicker(rerender));
    renderUploadForm();
    loadExhibits();
  };

  // ---------------------------------------------------------------- upload --
  function renderUploadForm() {
    const caseDoc = selectedCase();
    if (!caseDoc) {
      mount(uploadSlot, notice('Select a case before uploading an exhibit.', 'warn'));
      return;
    }

    const fileInput = el('input.input', { type: 'file', required: true });
    const titleInput = input({ placeholder: 'CCTV clip, gate camera, 14:02–14:09', required: true });
    const descInput = el('textarea.input', { placeholder: 'How this exhibit came into police possession.' });
    const sourceSelect = select({}, SOURCE_TYPES);
    const makeInput = input({ placeholder: 'Samsung' });
    const modelInput = input({ placeholder: 'Galaxy A54' });
    const colourInput = input({ placeholder: 'Black' });
    const serialInput = input({ placeholder: 'RZ8N70…' });
    const imeiInput = input({ placeholder: '35xxxxxxxxxxxxx' });
    const capturedInput = el('input.input', { type: 'datetime-local' });

    const submitBtn = el('button.btn', { type: 'submit' }, 'Hash, sign and upload');
    const progressSlot = el('div');

    const form = el(
      'form',
      {
        onSubmit: async (e) => {
          e.preventDefault();
          const file = fileInput.files?.[0];
          if (!file) return;

          const steps = uploadSteps();
          mount(progressSlot, steps.node);

          await withBusy(submitBtn, 'Working…', async () => {
            let sha256;
            let signature;

            // ---- step 1: hash, here, before anything leaves the machine ----
            try {
              steps.start(0);
              sha256 = await hashFile(file);
              steps.done(0, sha256);
            } catch (error) {
              steps.fail(0, error.message);
              append(progressSlot, notice(`Could not hash this file: ${error.message}`, 'bad'));
              return;
            }

            // ---- step 2: sign the hex digest with the device key ----
            try {
              steps.start(1);
              const keyPair = await getOrCreateKeyPair();
              signature = await signHashHex(sha256, keyPair.privateKey);
              steps.done(1, signature);
            } catch (error) {
              steps.fail(1, error.message);
              append(
                progressSlot,
                notice(
                  `Could not sign in this browser: ${error.message}. Without a signature the upload would be unattributable, so it has not been sent.`,
                  'bad'
                )
              );
              return;
            }

            // ---- step 3: upload ----
            const form1 = new FormData();
            form1.set('file', file);
            form1.set('caseId', String(caseDoc._id));
            form1.set('title', titleInput.value.trim());
            form1.set('description', descInput.value.trim());
            form1.set('sha256Client', sha256);
            form1.set('signature', signature);
            form1.set('sourceType', sourceSelect.value);
            for (const [key, control] of [
              ['make', makeInput],
              ['model', modelInput],
              ['colour', colourInput],
              ['serialNumber', serialInput],
              ['imeiOrUid', imeiInput],
            ]) {
              if (control.value.trim()) form1.set(key, control.value.trim());
            }
            if (capturedInput.value) form1.set('capturedAt', new Date(capturedInput.value).toISOString());

            let result;
            try {
              steps.start(2, `sending ${fmtBytes(file.size)}`);
              result = await api.evidence.upload(form1);
              steps.done(2, `${fmtBytes(file.size)} transferred`);
            } catch (error) {
              steps.fail(2, error.code ?? 'failed');
              steps.fail(3, 'refused');
              append(progressSlot, denial(error, { heading: 'Upload refused' }));
              return;
            }

            // ---- step 4: what the server proved on receipt ----
            const evidence = result.evidence;
            const ok = evidence.hashMatchedOnIngest && evidence.signatureValidOnIngest !== false;
            if (ok) steps.done(3, 'digest recomputed and matched; signature verified');
            else steps.fail(3, 'server could not confirm the record');

            append(progressSlot, [
              el('div', { style: 'height:12px' }),
              section('Server verification', null, ingestSummary(evidence)),
              el('div', { style: 'height:12px' }),
              section(
                'Your receipt',
                'An independent copy of what you handed over. Keep it: it lets you prove later what you submitted, without relying on this system at all.',
                [
                  kv([
                    ['Ledger sequence', el('code', String(result.receipt?.ledgerSeq ?? '—'))],
                    ['Entry hash', hash(result.receipt?.entryHash)],
                    ['Previous hash', hash(result.receipt?.prevHash)],
                    ['Receipt hash', hash(result.receipt?.receiptHash)],
                    ['Signed at', fmtDate(result.receipt?.signedAt)],
                    ['Anchor network', el('code', result.receipt?.anchorNetwork ?? 'monad-testnet')],
                  ]),
                  el('div.row', { style: 'margin-top:12px' }, [
                    el(
                      'button.btn',
                      {
                        type: 'button',
                        onClick: () =>
                          downloadJson(
                            `lexx-receipt-${result.receipt?.exhibitCode ?? 'exhibit'}.json`,
                            result.receipt
                          ),
                      },
                      'Download receipt (JSON)'
                    ),
                  ]),
                ]
              ),
            ]);

            form.reset();
            loadExhibits();
          });
        },
      },
      [
        field('File', fileInput, 'Hashed in this browser before it is sent. Nothing is uploaded first and checked later.'),
        field('Title', titleInput),
        field('Description', descInput),
        el('div.grid.grid--3', [
          field('Source type', sourceSelect, 'BSA s.63 Schedule, Part A.'),
          field('Make', makeInput),
          field('Model', modelInput),
          field('Colour', colourInput),
          field('Serial number', serialInput),
          field('IMEI / UID', imeiInput),
        ]),
        field('Captured at', capturedInput),
        el('div.row', [submitBtn]),
      ]
    );

    mount(uploadSlot, [form, progressSlot]);
  }

  // -------------------------------------------------------------- exhibits --
  async function loadExhibits() {
    const caseDoc = selectedCase();
    if (!caseDoc) {
      mount(listSlot, notice('Select a case to see its exhibits.', 'warn'));
      return;
    }
    mount(listSlot, spinner('Loading exhibits…'));
    try {
      const { evidence } = await api.evidence.list({ caseId: String(caseDoc._id), limit: 100 });
      mount(
        listSlot,
        (evidence ?? []).length
          ? el(
              'div.stack',
              evidence.map((e) => exhibitCard(e))
            )
          : el('p.empty', 'No exhibits have been uploaded to this case yet.')
      );
    } catch (error) {
      showError(listSlot, error);
    }
  }

  function exhibitCard(e) {
    const integrityPill = el(
      `span.pill.pill--${e.hashMatchedOnIngest && e.signatureValidOnIngest !== false ? 'ok' : 'bad'}`,
      e.hashMatchedOnIngest && e.signatureValidOnIngest !== false
        ? 'HASH MATCHED · SIGNATURE VERIFIED AT INGEST'
        : 'INTEGRITY EXCEPTION AT INGEST'
    );

    const certSlot = el('div');

    return el('div.panel', [
      el('div.panel__head', [
        el('h2.panel__title', `${e.exhibitCode} — ${e.title ?? ''}`),
        el('p.panel__note', [
          el('span.pill', humanise(e.kind)),
          ' ',
          el('span.pill', e.mimeType ?? '—'),
          ' ',
          el('span.pill', fmtBytes(e.sizeBytes)),
          ' ',
          integrityPill,
        ]),
      ]),
      el('div.panel__body.stack', [
        kv([
          ['Recorded digest', hash(e.sha256Server)],
          ['Court status', el('span.pill', humanise(e.courtStatus))],
          ['Uploaded', fmtDate(e.createdAt)],
          ['Source device', [e.sourceDevice?.sourceType, e.sourceDevice?.make, e.sourceDevice?.model].filter(Boolean).join(' · ') || '—'],
        ]),
        el('div.grid.grid--2', [reviewPriority(e.triage), forensicOpinion(e.forensic)]),
        el('div.row', [
          el(
            'button.btn',
            {
              type: 'button',
              onClick: (ev) =>
                withBusy(ev.currentTarget, 'Verifying…', async () => {
                  mount(verifySlot, spinner('Recomputing hash, signature, chain and anchor…'));
                  try {
                    const result = await api.evidence.verify(e._id);
                    mount(
                      verifySlot,
                      section(
                        `Integrity verification — ${result.exhibitCode}`,
                        'Four independent checks, recomputed from first principles. Nothing here is read back from a stored “verified” flag.',
                        verificationReport(result)
                      )
                    );
                    verifySlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  } catch (error) {
                    showError(verifySlot, error);
                  }
                }),
            },
            'Verify integrity'
          ),
          el(
            'button.btn.btn--secondary',
            {
              type: 'button',
              onClick: (ev) =>
                withBusy(ev.currentTarget, 'Generating…', async () => {
                  mount(certSlot, spinner('Building the section 63 certificate…'));
                  try {
                    const { certificate, partBNote } = await api.certificates.generate(e._id);
                    mount(certSlot, [
                      notice('Section 63 certificate generated.', 'ok'),
                      kv([
                        ['Certificate', el('code', certificate.certificateId)],
                        ['Statute', 'Bharatiya Sakshya Adhiniyam, 2023 — section 63'],
                        ['Part A complete', certificate.partAComplete ? 'Yes' : 'No'],
                        ['Part B complete', certificate.partBComplete ? 'Yes' : 'No'],
                        ['PDF digest', hash(certificate.pdfSha256)],
                        [
                          'Public verification',
                          el(
                            'a.link',
                            {
                              href: `verify.html?token=${encodeURIComponent(certificate.verificationToken)}`,
                              target: '_blank',
                              rel: 'noopener',
                            },
                            'open the public verifier'
                          ),
                        ],
                        [
                          'PDF',
                          el(
                            'button.btn.btn--secondary.btn--small',
                            {
                              type: 'button',
                              onClick: (dl) =>
                                withBusy(dl.currentTarget, 'Fetching…', async () => {
                                  try {
                                    const blob = await api.certificates.pdfBlob(certificate.certificateId);
                                    downloadBlob(`lexx-s63-${e.exhibitCode}.pdf`, blob);
                                  } catch (error) {
                                    mount(certSlot, denial(error, { heading: 'Certificate PDF refused' }));
                                  }
                                }),
                            },
                            'Download the signed PDF'
                          ),
                        ],
                      ]),
                      partBNote ? notice(partBNote, 'warn') : null,
                    ]);
                  } catch (error) {
                    mount(certSlot, denial(error, { heading: 'Certificate not generated' }));
                  }
                }),
            },
            'Generate s.63 certificate'
          ),
        ]),
        certSlot,
      ]),
    ]);
  }

  append(root, [
    el('h2.page-title', 'Evidence'),
    el(
      'p.page-lede',
      'The file is hashed and signed on this machine before it is sent. The server recomputes both and refuses anything that does not agree — and records the refusal.'
    ),
    pickerSlot,
    el('div.grid.grid--2', [
      section('Upload an exhibit', 'Four steps, all of them visible.', uploadSlot),
      el('div', verifySlot),
    ]),
    el('div', { style: 'height:18px' }),
    section('Exhibits on this case', null, listSlot),
  ]);

  (async () => {
    if (!store.cases.length) await loadCases().catch(() => {});
    rerender();
  })();
}

// ========================================================== 3. DISCLOSURE ====

function renderDisclosure(root) {
  const pickerSlot = el('div');
  const bodySlot = el('div');

  const rerender = () => {
    mount(pickerSlot, casePicker(rerender));
    renderForm();
  };

  function renderForm() {
    const caseDoc = selectedCase();
    if (!caseDoc) {
      mount(bodySlot, notice('Select a case first.', 'warn'));
      return;
    }

    const resultSlot = el('div');
    const exclusionSlot = el('div');
    const exclusions = [];

    const addExclusion = () => {
      const idInput = input({ placeholder: 'exhibit id (24 hex characters)' });
      const reasonInput = input({ placeholder: 'Reason a registrar can rule on (at least 10 characters)' });
      const row = el('div.row', [
        idInput,
        reasonInput,
        el(
          'button.btn.btn--secondary.btn--small',
          {
            type: 'button',
            onClick: () => {
              const index = exclusions.findIndex((x) => x.row === row);
              if (index >= 0) exclusions.splice(index, 1);
              row.remove();
            },
          },
          'Remove'
        ),
      ]);
      exclusions.push({ row, idInput, reasonInput });
      append(exclusionSlot, row);
    };

    const prepareBtn = el('button.btn', { type: 'button' }, 'Propose the disclosure set');
    prepareBtn.addEventListener('click', (ev) =>
      withBusy(ev.currentTarget, 'Preparing…', async () => {
        const payload = {
          excludedItems: exclusions
            .map((x) => ({ itemId: x.idInput.value.trim(), reason: x.reasonInput.value.trim() }))
            .filter((x) => x.itemId && x.reason),
        };
        try {
          const { pack } = await api.disclosure.prepare(caseDoc._id, payload);
          mount(resultSlot, [
            notice(
              'Disclosure set proposed. It is a DRAFT until the registrar rules on the exclusions and serves it.',
              'ok'
            ),
            kv([
              ['Pack id', el('code', pack.packId)],
              ['Status', el('span.pill', pack.status)],
              ['Exhibits included', String(pack.exhibitCount ?? 0)],
              ['Exclusions requested', String((pack.excludedItems ?? []).length)],
              ['Due on', fmtDate(pack.dueOn)],
            ]),
            notice(
              'Hand this pack id to the registrar — the court view approves and serves by pack id.',
              'info'
            ),
          ]);
        } catch (error) {
          mount(resultSlot, denial(error, { heading: 'Disclosure set not prepared' }));
        }
      })
    );

    mount(bodySlot, [
      section(
        `Prepare disclosure — FIR ${caseDoc.firNumber}`,
        'Everything on the case goes to the defence unless a stated reason says otherwise. An exclusion without a reason is not an exclusion a registrar can rule on, so the server refuses it.',
        [
          el('div.row', [
            el('button.btn.btn--secondary.btn--small', { type: 'button', onClick: addExclusion }, 'Request an exclusion'),
            prepareBtn,
          ]),
          exclusionSlot,
          resultSlot,
        ]
      ),
    ]);
  }

  append(root, [
    el('h2.page-title', 'Disclosure'),
    el(
      'p.page-lede',
      'The investigating officer proposes the set. Only a registrar can approve exclusions and serve it, and the defence sees nothing until then.'
    ),
    pickerSlot,
    bodySlot,
  ]);

  (async () => {
    if (!store.cases.length) await loadCases().catch(() => {});
    rerender();
  })();
}

// ============================================================= 4. CUSTODY ====

function renderCustody(root) {
  const pickerSlot = el('div');
  const formSlot = el('div');
  const labelSlot = el('div');

  const rerender = () => {
    mount(pickerSlot, casePicker(rerender));
    renderForm();
  };

  function renderForm() {
    const caseDoc = selectedCase();
    if (!caseDoc) {
      mount(formSlot, notice('Select a case first.', 'warn'));
      return;
    }

    const descInput = input({ placeholder: 'Samsung Galaxy A54, black', required: true });
    const sealInput = input({ placeholder: 'SEAL-GZB-88231', required: true });
    const imeiInput = input({ placeholder: 'IMEI' });
    const serialInput = input({ placeholder: 'Serial number' });
    const locationSelect = select({}, CUSTODY_LOCATIONS);
    const detailInput = input({ placeholder: 'Rack B14' });
    const createBtn = el('button.btn', { type: 'submit' }, 'Register item and print label');

    const form = el(
      'form',
      {
        onSubmit: async (e) => {
          e.preventDefault();
          await withBusy(createBtn, 'Registering…', async () => {
            try {
              const result = await api.custody.create({
                caseId: String(caseDoc._id),
                description: descInput.value.trim(),
                sealNumber: sealInput.value.trim(),
                identifiers: {
                  imei: imeiInput.value.trim() || null,
                  serialNumber: serialInput.value.trim() || null,
                },
                location: locationSelect.value,
                locationDetail: detailInput.value.trim() || null,
              });
              mount(labelSlot, [
                notice(`Item ${result.item?.itemCode ?? ''} registered at ledger sequence ${result.ledgerSeq}.`, 'ok'),
                await custodyLabel(result.qr),
              ]);
              form.reset();
            } catch (error) {
              mount(labelSlot, denial(error, { heading: 'Item not registered' }));
            }
          });
        },
      },
      [
        field('Description', descInput),
        field('Seal number', sealInput),
        el('div.grid.grid--2', [field('IMEI', imeiInput), field('Serial number', serialInput)]),
        el('div.grid.grid--2', [field('Location', locationSelect), field('Location detail', detailInput)]),
        el('div.row', [createBtn]),
      ]
    );

    mount(formSlot, form);
  }

  append(root, [
    el('h2.page-title', 'Physical custody'),
    el(
      'p.page-lede',
      'Every physical exhibit gets a signed label. The label proves the tag was printed by this system; it grants no authority to move the item, and every movement is authorised separately.'
    ),
    pickerSlot,
    el('div.grid.grid--2', [section('Register a seized item', null, formSlot), el('div', labelSlot)]),
  ]);

  (async () => {
    if (!store.cases.length) await loadCases().catch(() => {});
    rerender();
  })();
}

// ------------------------------------------------------------------ boot ----

boot({
  title: 'Investigating officer',
  subtitle: 'Case file, evidence ingest and custody',
  roles: ['IO', 'SHO'],
  tabs: [
    { id: 'cases', label: 'Cases', render: renderCases },
    { id: 'evidence', label: 'Evidence', render: renderEvidence },
    { id: 'disclosure', label: 'Disclosure', render: renderDisclosure },
    { id: 'custody', label: 'Custody', render: renderCustody },
  ],
});
