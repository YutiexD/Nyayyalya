/**
 * Forensic examiner's view (beat 7).
 *
 * An examiner's entire world is the referrals to THEIR laboratory. There is no
 * "browse all forensic cases" affordance on this page because there is no such
 * endpoint: `GET /api/fsl/referrals` returns what the access resolver's lab scope
 * allows and nothing else, and a session with no lab scope gets an empty list rather
 * than everything.
 *
 * Filing a report is the one place in this system where an authenticity opinion can
 * be produced. The report file is hashed and signed in this browser, exactly as
 * evidence is, so the lab's document carries the examiner's own signature over its
 * digest.
 */
import { api } from '../lib/api.js';
import { getOrCreateKeyPair, hashFile, signHashHex } from '../lib/crypto.js';
import { boot } from './shell.js';
import {
  el,
  mount,
  append,
  section,
  field,
  select,
  table,
  kv,
  hash,
  notice,
  denial,
  showError,
  spinner,
  forensicOpinion,
  fmtDate,
  fmtBytes,
  humanise,
  withBusy,
} from '../lib/ui.js';

const OPINIONS = ['AUTHENTIC', 'MANIPULATED', 'INCONCLUSIVE'];

const STATUS_TONE = { OPEN: 'warn', ACCEPTED: '', REPORTED: 'ok', WITHDRAWN: '' };

function renderReferrals(root) {
  const listSlot = el('div');
  const detailSlot = el('div');
  const labSlot = el('div');

  async function load(status) {
    mount(listSlot, spinner('Loading referrals to your laboratory…'));
    try {
      const result = await api.fsl.referrals(status ? { status } : undefined);
      const referrals = result.referrals ?? [];

      mount(labSlot, [
        result.labId
          ? notice(
              `You are acting for laboratory ${result.labId}. This queue contains only exhibits referred to it — nothing else in the system is visible to this session.`,
              'info'
            )
          : notice(
              'This session carries no laboratory scope, so it has no referrals. That is the access policy answering, not an empty database.',
              'warn'
            ),
      ]);

      mount(
        listSlot,
        table(
          [
            { header: 'Exhibit', cell: (r) => el('code', r.exhibitCode ?? '—') },
            { header: 'Discipline', cell: (r) => humanise(r.discipline) },
            {
              header: 'Status',
              cell: (r) => {
                const tone = STATUS_TONE[r.status];
                return el(`span.pill${tone ? `.pill--${tone}` : ''}`, r.status);
              },
            },
            { header: 'Referred', cell: (r) => fmtDate(r.referredAt) },
            { header: 'Accepted', cell: (r) => fmtDate(r.acceptedAt) },
            {
              header: '',
              cell: (r) =>
                el(
                  'button.btn.btn--secondary.btn--small',
                  { type: 'button', onClick: () => openReferral(r) },
                  'Open'
                ),
            },
          ],
          referrals,
          { empty: 'No referrals to your laboratory.' }
        )
      );
    } catch (error) {
      showError(listSlot, error);
    }
  }

  function openReferral(referral) {
    const actionSlot = el('div');

    const acceptBtn = el(
      'button.btn',
      {
        type: 'button',
        disabled: referral.status !== 'OPEN',
        onClick: (ev) =>
          withBusy(ev.currentTarget, 'Accepting…', async () => {
            try {
              const result = await api.fsl.accept(referral.id);
              mount(actionSlot, notice('Referral accepted. The exhibit is now under examination.', 'ok'));
              await load();
              openReferral(result.referral ?? { ...referral, status: 'ACCEPTED' });
            } catch (error) {
              mount(actionSlot, denial(error, { heading: 'Could not accept' }));
            }
          }),
      },
      referral.status === 'OPEN' ? 'Accept this referral' : `Referral is ${referral.status}`
    );

    mount(detailSlot, [
      section(`Referral — ${referral.exhibitCode ?? ''}`, null, [
        kv([
          ['Referral id', el('code', referral.id)],
          ['Laboratory', referral.labName ?? referral.labId ?? '—'],
          ['IT Act s.79A notification', el('code', referral.section79ARef ?? 'not recorded')],
          ['Discipline', humanise(referral.discipline)],
          ['Questions posed', referral.questionsPosed || '—'],
          ['Status', el('span.pill', referral.status)],
          ['Referred at', fmtDate(referral.referredAt)],
        ]),
        el('div.row', { style: 'margin-top:12px' }, [acceptBtn]),
        actionSlot,
      ]),
      referral.status === 'ACCEPTED' || referral.status === 'REPORTED'
        ? reportForm(referral)
        : notice('Accept the referral before filing a report.', 'info'),
    ]);
  }

  function reportForm(referral) {
    const fileInput = el('input.input', { type: 'file', required: true });
    const opinionSelect = select({}, OPINIONS);
    const summaryInput = el('textarea.input', {
      required: true,
      placeholder: 'What was examined, by what method, and what the examination showed.',
    });
    const statusSlot = el('div');
    const fileBtn = el('button.btn', { type: 'submit' }, 'Sign and file the report');

    const form = el(
      'form',
      {
        onSubmit: async (e) => {
          e.preventDefault();
          const file = fileInput.files?.[0];
          if (!file) return;

          await withBusy(fileBtn, 'Signing…', async () => {
            mount(statusSlot, spinner('Hashing the report in this browser…'));
            let sha256;
            let signature;
            try {
              sha256 = await hashFile(file);
              const keyPair = await getOrCreateKeyPair();
              signature = await signHashHex(sha256, keyPair.privateKey);
            } catch (error) {
              mount(statusSlot, notice(`Could not hash and sign the report: ${error.message}`, 'bad'));
              return;
            }

            mount(statusSlot, spinner('Filing…'));
            const body = new FormData();
            body.set('report', file);
            body.set('opinion', opinionSelect.value);
            body.set('examinationSummary', summaryInput.value.trim());
            body.set('reportSha256', sha256);
            body.set('reportSignature', signature);

            try {
              const result = await api.fsl.report(referral.id, body);
              mount(statusSlot, [
                notice('Report filed. This is now the source for Part B of the section 63 certificate.', 'ok'),
                el('div', { style: 'height:12px' }),
                forensicOpinion({
                  status: 'REPORT_FILED',
                  opinion: result.forensic?.opinion,
                  labName: result.forensic?.labName,
                  labId: result.forensic?.labId,
                  section79ARef: result.forensic?.section79ARef,
                  examinationSummary: result.forensic?.examinationSummary,
                  reportedAt: result.forensic?.reportedAt,
                }),
                el('div', { style: 'height:12px' }),
                kv([
                  ['Report digest (browser)', hash(sha256)],
                  ['Report digest (server)', hash(result.forensic?.reportSha256)],
                  ['Report size', fmtBytes(file.size)],
                  ['Ledger sequence', el('code', String(result.ledgerSeq ?? '—'))],
                  ['Entry hash', hash(result.entryHash)],
                ]),
                result.basisNote ? notice(result.basisNote, 'info') : null,
              ]);
              await load();
            } catch (error) {
              mount(statusSlot, denial(error, { heading: 'Report not filed' }));
            }
          });
        },
      },
      [
        field('Report document', fileInput, 'Hashed and signed here, on your machine, before it is sent.'),
        field(
          'Opinion',
          opinionSelect,
          'AUTHENTIC, MANIPULATED or INCONCLUSIVE. This is the only authenticity vocabulary in the system, and only a notified laboratory can produce it.'
        ),
        field('Examination summary', summaryInput),
        el('div.row', [fileBtn]),
      ]
    );

    return section(
      'File the forensic report',
      'Your opinion is expert evidence under BSA s.39. It is a different kind of claim from machine review prioritisation and is recorded, displayed and reasoned about separately.',
      [form, statusSlot]
    );
  }

  const filter = select({ onChange: (e) => load(e.target.value || undefined) }, [
    { value: '', label: 'All referrals' },
    { value: 'OPEN', label: 'Open' },
    { value: 'ACCEPTED', label: 'Accepted' },
    { value: 'REPORTED', label: 'Reported' },
  ]);

  append(root, [
    el('h2.page-title', 'Referrals to your laboratory'),
    el(
      'p.page-lede',
      'Visibility here is derived per exhibit from a live referral row, not from a role. Another laboratory’s examiner is refused with NO_OPEN_REFERRAL_TO_YOUR_LAB — a statement about the absence of a referral, which is the fact that actually matters.'
    ),
    labSlot,
    el('div.grid.grid--2', [
      section('Queue', null, [el('div.row', [field('Show', filter)]), listSlot]),
      el('div', detailSlot),
    ]),
  ]);

  load();
}

// -------------------------------------------------------------------- boot ----

boot({
  title: 'Forensic science laboratory',
  subtitle: 'Referrals, examination and expert opinion',
  roles: ['FSL_EXAMINER'],
  tabs: [{ id: 'referrals', label: 'Referrals', render: renderReferrals }],
});
