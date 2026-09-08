/**
 * Station house officer / district supervision.
 *
 *   Review queue  — exhibits ordered by machine review priority, so the officer
 *                   decides what to look at first. It is never a verdict, so the
 *                   API's own disclaimer is pinned above the queue and repeated on
 *                   every row (beat 6). Referral to a s.79A laboratory happens here.
 *   Denials       — the live audit feed of refusals (beat 10). A red badge, because
 *                   the refusals are the interesting rows: a log that shows only
 *                   successes cannot show you the advocate who reached for an exhibit
 *                   outside their disclosure set.
 *   Custody gaps  — items whose ledger history does not make a lawful chain (beat 4).
 *   Verify        — the four independent lights for any exhibit in the station's
 *                   scope (beat 5).
 */
import { api } from '../lib/api.js';
import { verificationReport } from '../lib/verify.js';
import { parseQrPayload } from '../lib/qr.js';
import { boot } from './shell.js';
import {
  el,
  mount,
  append,
  section,
  field,
  input,
  select,
  table,
  kv,
  hash,
  notice,
  denial,
  showError,
  spinner,
  reviewPriority,
  forensicOpinion,
  fmtDate,
  humanise,
  withBusy,
} from '../lib/ui.js';

const DISCIPLINES = ['MEDIA_FORENSICS', 'MOBILE_FORENSICS', 'COMPUTER_FORENSICS'];

// ========================================================= 1. REVIEW QUEUE ====

function renderQueue(root) {
  const queueSlot = el('div');
  const detailSlot = el('div');

  async function load() {
    mount(queueSlot, spinner('Loading the review queue…'));
    try {
      const result = await api.evidence.triageQueue();
      const items = result.queue ?? [];

      mount(queueSlot, [
        // The disclaimer travels with the data and is pinned above the queue, not
        // tucked into a footnote.
        notice(
          result.disclaimer ??
            'Automated triage only. Not expert opinion under BSA s.39 / IT Act s.79A.',
          'warn'
        ),
        el('div', { style: 'height:12px' }),
        table(
          [
            { header: 'Exhibit', cell: (e) => el('code', e.exhibitCode) },
            { header: 'Title', cell: (e) => e.title ?? '—' },
            { header: result.uiLabel ?? 'Review Priority', cell: (e) => reviewPriority(e.triage) },
            {
              header: 'Forensic status',
              cell: (e) =>
                el(
                  `span.pill${e.forensic?.status === 'REPORT_FILED' ? '.pill--ok' : ''}`,
                  humanise(e.forensic?.status ?? 'NOT_REFERRED')
                ),
            },
            { header: 'Uploaded', cell: (e) => fmtDate(e.createdAt) },
            {
              header: '',
              cell: (e) =>
                el('div.row', [
                  el(
                    'button.btn.btn--secondary.btn--small',
                    { type: 'button', onClick: () => openExhibit(e._id) },
                    'Open'
                  ),
                ]),
            },
          ],
          items,
          { empty: 'Nothing is queued for review in your scope.' }
        ),
      ]);
    } catch (error) {
      showError(queueSlot, error);
    }
  }

  async function openExhibit(id) {
    mount(detailSlot, spinner('Loading exhibit…'));
    try {
      const { evidence } = await api.evidence.get(id);
      mount(detailSlot, exhibitDetail(evidence));
    } catch (error) {
      showError(detailSlot, error);
    }
  }

  function referralForm(evidence) {
    const labInput = input({ placeholder: 'UP-FSL-LKO', required: true });
    const disciplineSelect = select({}, DISCIPLINES);
    const questionsInput = el('textarea.input', {
      placeholder: 'What is the laboratory being asked to determine?',
    });
    const resultSlot = el('div');
    const referBtn = el('button.btn', { type: 'submit' }, 'Refer to laboratory');

    return el('div.stack', [
      el(
        'form',
        {
          onSubmit: async (e) => {
            e.preventDefault();
            await withBusy(referBtn, 'Referring…', async () => {
              try {
                const result = await api.evidence.referFsl(evidence._id, {
                  labCode: labInput.value.trim(),
                  discipline: disciplineSelect.value,
                  questionsPosed: questionsInput.value.trim(),
                });
                mount(resultSlot, [
                  notice('Referral created. Only that laboratory can see it.', 'ok'),
                  kv([
                    ['Referral', el('code', result.referral.id)],
                    ['Laboratory', result.referral.labName ?? result.referral.labId],
                    ['s.79A notification', el('code', result.referral.section79ARef ?? 'not recorded')],
                    ['Discipline', humanise(result.referral.discipline)],
                    ['Ledger sequence', el('code', String(result.ledgerSeq))],
                  ]),
                ]);
              } catch (error) {
                mount(resultSlot, denial(error, { heading: 'Referral refused' }));
              }
            });
          },
        },
        [
          field('Laboratory code', labInput, 'Resolved against the FSL directory. Its s.79A notification reference is read from there, never from this form.'),
          field('Discipline', disciplineSelect),
          field('Questions posed', questionsInput),
          el('div.row', [referBtn]),
        ]
      ),
      resultSlot,
    ]);
  }

  function exhibitDetail(e) {
    const verifySlot = el('div');
    return el('div.stack', [
      section(`${e.exhibitCode} — ${e.title ?? ''}`, null, [
        kv([
          ['Recorded digest', hash(e.sha256Server)],
          ['Signer fingerprint', el('code', e.signerPubKeyFingerprint ?? '—')],
          ['Hash matched at ingest', e.hashMatchedOnIngest ? 'Yes' : 'No'],
          ['Court status', el('span.pill', humanise(e.courtStatus))],
        ]),
        el('div', { style: 'height:12px' }),
        el('div.grid.grid--2', [reviewPriority(e.triage), forensicOpinion(e.forensic)]),
        el('div.row', { style: 'margin-top:12px' }, [
          el(
            'button.btn',
            {
              type: 'button',
              onClick: (ev) =>
                withBusy(ev.currentTarget, 'Verifying…', async () => {
                  mount(verifySlot, spinner('Recomputing…'));
                  try {
                    mount(verifySlot, verificationReport(await api.evidence.verify(e._id)));
                  } catch (error) {
                    showError(verifySlot, error);
                  }
                }),
            },
            'Verify integrity'
          ),
        ]),
        verifySlot,
      ]),
      section(
        'Refer to a forensic science laboratory',
        'Machine triage decides what gets looked at first. Only a notified laboratory decides authenticity.',
        referralForm(e)
      ),
    ]);
  }

  append(root, [
    el('h2.page-title', 'Review queue'),
    el(
      'p.page-lede',
      'Ordered by machine review priority so scarce examiner time goes to the right exhibits first. This ordering is not a finding about any exhibit.'
    ),
    el('div.grid.grid--2', [section('Queue', null, queueSlot), el('div', detailSlot)]),
  ]);

  load();
}

// ============================================================== 2. DENIALS ====

function renderDenials(root) {
  const feedSlot = el('div');
  const headSlot = el('div');

  async function load(decision) {
    mount(feedSlot, spinner('Loading the audit feed…'));
    try {
      const result = await api.audit.list({ decision, limit: 100 });
      const events = result.events ?? [];
      const denials = events.filter((e) => e.decision === 'DENY');

      mount(headSlot, [
        el('div.row', [
          el('span.feed-badge', `${denials.length} denial${denials.length === 1 ? '' : 's'}`),
          el('span.muted', `${events.length} events in your scope`),
        ]),
      ]);

      mount(
        feedSlot,
        table(
          [
            { header: 'When', cell: (e) => fmtDate(e.at) },
            { header: 'Who', cell: (e) => el('div', [el('div', e.actorName ?? '—'), el('div.muted', e.authorityId ?? '')]) },
            { header: 'Role', cell: (e) => el('span.pill', e.role ?? '—') },
            { header: 'Action', cell: (e) => e.action ?? '—' },
            { header: 'Resource', cell: (e) => el('code', e.resourceLabel ?? e.resourceType ?? '—') },
            {
              header: 'Decision',
              cell: (e) => el(`span.pill.pill--${e.decision === 'DENY' ? 'bad' : 'ok'}`, e.decision),
            },
            {
              header: 'Reason',
              cell: (e) =>
                el('div', [
                  el(`code${e.decision === 'DENY' ? '.reason-code' : ''}`, e.reason ?? '—'),
                  el('div.muted', explainReason(e.reason)),
                ]),
            },
          ],
          events,
          { empty: 'No audit events in your scope.' }
        )
      );

      // Colour the denial rows after render; the table helper renders text, not markup.
      const rows = feedSlot.querySelectorAll('tbody tr');
      events.forEach((e, i) => {
        if (e.decision === 'DENY') rows[i]?.classList.add('audit-deny');
      });
    } catch (error) {
      showError(feedSlot, error);
    }
  }

  const filter = select(
    {
      onChange: (e) => load(e.target.value || undefined),
    },
    [
      { value: 'DENY', label: 'Denials only' },
      { value: '', label: 'All decisions' },
      { value: 'ALLOW', label: 'Grants only' },
    ]
  );

  append(root, [
    el('h2.page-title', 'Audit feed'),
    el(
      'p.page-lede',
      'Every access decision this system makes is written down — the refusals as well as the grants. The feed is itself scoped: you see decisions inside your own jurisdiction, not the whole deployment.'
    ),
    section('Decisions', null, [
      el('div.row', [field('Show', filter), headSlot]),
      feedSlot,
    ]),
  ]);

  load('DENY');
}

/** Short readings for the codes that show up in the feed. */
function explainReason(code) {
  const map = {
    NOT_ON_RECORD_FOR_THIS_CASE: 'Advocate is not on record for that case.',
    EXHIBIT_NOT_IN_DISCLOSURE_SET: 'Exhibit is outside the disclosure set served on them.',
    NO_DISCLOSURE_PACK_SERVED: 'No pack has been served on that recipient.',
    OUT_OF_JURISDICTION: 'Record belongs to another station.',
    NOT_ASSIGNED_IO: 'Not the investigating officer on that case.',
    NO_OPEN_REFERRAL_TO_YOUR_LAB: 'No referral to that examiner’s laboratory.',
    CASE_NOT_LISTED_IN_YOUR_COURT: 'Case is not listed in that court.',
    CLIENT_SERVER_HASH_MISMATCH: 'Uploaded bytes did not match the browser hash.',
    LOGIN_SUCCESS: 'Signed in.',
    IDENTITY_VERIFIED: 'Directory confirmed the identity.',
    BAD_CREDENTIALS: 'Wrong identifier or password.',
    IDENTITY_NOT_IN_DIRECTORY: 'No such identity in the authority directory.',
  };
  return map[code] ?? '';
}

// ========================================================= 3. CUSTODY GAPS ====

function renderCustody(root) {
  const gapsSlot = el('div');
  const scanSlot = el('div');
  const chainSlot = el('div');

  async function loadGaps() {
    mount(gapsSlot, spinner('Walking custody histories…'));
    try {
      const result = await api.custody.gaps({ limit: 100 });
      const items = result.items ?? [];

      mount(gapsSlot, [
        el('div.row', [
          el(
            `span.pill.pill--${result.withFindings ? 'bad' : 'ok'}`,
            `${result.withFindings ?? 0} of ${result.total ?? 0} items with findings`
          ),
          result.broken?.length ? el('span.muted', `Broken: ${result.broken.join(', ')}`) : null,
        ]),
        el('div', { style: 'height:12px' }),
        table(
          [
            { header: 'Item', cell: (r) => el('code', r.itemCode ?? '—') },
            {
              header: 'Chain',
              cell: (r) => el(`span.pill.pill--${r.intact ? 'ok' : 'bad'}`, r.intact ? 'INTACT' : 'BROKEN'),
            },
            {
              header: 'Findings',
              cell: (r) =>
                (r.findings ?? []).length
                  ? el(
                      'ul',
                      { style: 'margin:0;padding-left:18px' },
                      r.findings.map((f) =>
                        el('li', [
                          el('code', f.code ?? f.type ?? 'FINDING'),
                          f.detail || f.message ? ` — ${f.detail ?? f.message}` : '',
                          f.ledgerSeq !== undefined && f.ledgerSeq !== null ? ` (ledger seq ${f.ledgerSeq})` : '',
                        ])
                      )
                    )
                  : el('span.muted', 'none'),
            },
            {
              header: '',
              cell: (r) =>
                r.itemId
                  ? el(
                      'button.btn.btn--secondary.btn--small',
                      { type: 'button', onClick: () => loadChain(r.itemId) },
                      'Chain'
                    )
                  : '—',
            },
          ],
          items,
          { empty: 'No custody items in your scope.' }
        ),
      ]);
    } catch (error) {
      showError(gapsSlot, error);
    }
  }

  async function loadChain(itemId) {
    mount(chainSlot, spinner('Reading the custody chain…'));
    try {
      const result = await api.custody.chain(itemId);
      mount(chainSlot, custodyChainView(result));
    } catch (error) {
      showError(chainSlot, error);
    }
  }

  function custodyChainView(result) {
    const item = result.item ?? {};
    const analysis = result.analysis ?? {};
    return section(`Custody chain — ${item.itemCode ?? ''}`, null, [
      kv([
        ['Description', item.description ?? '—'],
        ['Seal', el('code', item.sealNumber ?? '—')],
        ['Seal intact', el(`span.pill.pill--${item.sealIntact === false ? 'bad' : 'ok'}`, item.sealIntact === false ? 'BROKEN' : 'INTACT')],
        ['Status', el('span.pill', humanise(item.status))],
        ['Location', el('span.pill', humanise(item.currentLocation))],
        ['Chain', el(`span.pill.pill--${analysis.intact ? 'ok' : 'bad'}`, analysis.intact ? 'INTACT' : 'BROKEN')],
      ]),
      (analysis.findings ?? []).length
        ? el(
            'div',
            { style: 'margin-top:12px' },
            (analysis.findings ?? []).map((f) =>
              notice(
                `${f.code ?? f.type ?? 'FINDING'}${f.detail || f.message ? ` — ${f.detail ?? f.message}` : ''}${
                  f.ledgerSeq !== undefined && f.ledgerSeq !== null ? ` (ledger seq ${f.ledgerSeq})` : ''
                }`,
                'bad'
              )
            )
          )
        : null,
      el('div', { style: 'height:12px' }),
      el(
        'ul.timeline',
        (result.events ?? []).map((e) =>
          el(
            `li.timeline__item${e.eventType === 'INTEGRITY_EXCEPTION' ? '.timeline__item--exception' : ''}`,
            [
              el('div.timeline__head', [
                el('span.timeline__type', humanise(e.eventType)),
                el('span.timeline__meta', `${fmtDate(e.occurredAt)} · ${e.actorRole ?? '—'} · ledger seq ${e.seq}`),
              ]),
              e.payload?.toStatus || e.payload?.status
                ? el('div.timeline__meta', `State: ${humanise(e.payload.toStatus ?? e.payload.status)}`)
                : null,
              el('div.timeline__hash', `entry ${e.entryHash ?? '—'}`),
            ]
          )
        )
      ),
    ]);
  }

  // Scanning: paste or type the label payload. The HMAC is checked by the server —
  // it holds the secret, and a client-side "looks valid" would mean nothing.
  const scanInput = input({ placeholder: 'LEXX:v1:IT-0123-2026-002:…' });
  const scanBtn = el('button.btn', { type: 'submit' }, 'Resolve label');

  const scanForm = el(
    'form',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        const parsed = parseQrPayload(scanInput.value);
        if (!parsed.ok) {
          mount(scanSlot, notice('That is not a LEXX custody label. Expected LEXX:v1:<item code>:<signature>.', 'bad'));
          return;
        }
        await withBusy(scanBtn, 'Resolving…', async () => {
          mount(scanSlot, spinner('Resolving…'));
          try {
            const result = await api.custody.scan(parsed.payload);
            mount(scanSlot, [
              notice(result.notice ?? 'Label authentic.', 'ok'),
              kv([
                ['Item', el('code', result.item?.itemCode ?? '—')],
                ['Status', el('span.pill', humanise(result.item?.status))],
                ['Location', el('span.pill', humanise(result.item?.currentLocation))],
                ['Permitted next states', (result.nextStates ?? []).map(humanise).join(', ') || 'none'],
                ['Actions open to you', (result.allowedActions ?? []).join(', ') || 'none'],
              ]),
              result.item?.id
                ? el(
                    'button.btn.btn--secondary.btn--small',
                    { type: 'button', onClick: () => loadChain(result.item.id) },
                    'Show the chain'
                  )
                : null,
            ]);
          } catch (error) {
            mount(scanSlot, denial(error, { heading: 'Label resolved, access refused' }));
          }
        });
      },
    },
    [field('Label payload', scanInput), el('div.row', [scanBtn])]
  );

  append(root, [
    el('h2.page-title', 'Custody'),
    el(
      'p.page-lede',
      'A lawful chain has no timestamp inversions and no state jumps that skip the malkhana. Anything else is a finding a supervisor has to answer for.'
    ),
    el('div.grid.grid--2', [
      section('Chain gap detection', null, gapsSlot),
      el('div.stack', [
        section('Resolve a label', 'Authenticity of a label is not authority over the item.', [scanForm, scanSlot]),
        el('div', chainSlot),
      ]),
    ]),
  ]);

  loadGaps();
}

// -------------------------------------------------------------------- boot ----

boot({
  title: 'Station supervision',
  subtitle: 'Review priority, referrals, audit and custody',
  roles: ['SHO', 'DISTRICT_SP', 'MALKHANA_CUSTODIAN'],
  tabs: [
    { id: 'queue', label: 'Review queue', render: renderQueue },
    { id: 'denials', label: 'Audit & denials', render: renderDenials },
    { id: 'custody', label: 'Custody gaps', render: renderCustody },
  ],
});
