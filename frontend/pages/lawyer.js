/**
 * Advocate's view (beat 8).
 *
 * An advocate sees the disclosure set that has been SERVED ON THEM, and nothing
 * else. Two separate refusals live behind that sentence, and both are shown in full:
 *
 *   NOT_ON_RECORD_FOR_THIS_CASE   — you are not on record. A vakalatnama accepted by
 *                                   the registrar, or a legal aid order, is what puts
 *                                   an advocate on record; Lexx reads that, it does
 *                                   not decide it.
 *   NO_DISCLOSURE_PACK_SERVED     — you are on record, but nothing has been served.
 *   EXHIBIT_NOT_IN_DISCLOSURE_SET — the exhibit exists and is outside your set.
 *
 * A denial that the user cannot understand is a bug, so every one of these is
 * rendered as the reason code AND a plain-English sentence. Rendering it invisibly,
 * or as a generic "something went wrong", would hide the exact boundary this system
 * exists to enforce.
 */
import { api } from '../lib/api.js';
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
  forensicOpinion,
  fmtDate,
  fmtBytes,
  humanise,
  withBusy,
} from '../lib/ui.js';

const store = { cases: [], selectedCaseId: null };

/**
 * The watermark, shown as prominently as it is printed.
 *
 * Every page served to this advocate carries their identity and a per-recipient
 * token. Saying so on screen is part of the deterrent: a leaked copy is traceable
 * back to the recipient it was served on.
 */
const watermarkPanel = (watermark, pack) =>
  el('div.watermark', [
    el('div.watermark__kicker', 'Served copy — watermarked to you'),
    el('div.watermark__label', watermark?.label ?? '—'),
    el('div.watermark__token', `token ${watermark?.token ?? '—'}`),
    el(
      'p.field__hint',
      `Redaction variant ${pack?.redactionVariant ?? '—'}${
        pack?.maskVictimIdentity ? ' · victim identity masked by order' : ''
      }. Every document rendered from this pack carries this identity and token.`
    ),
  ]);

function renderPack(root) {
  const pickerSlot = el('div');
  const packSlot = el('div');

  async function loadCases() {
    mount(pickerSlot, spinner('Loading the cases you are on record for…'));
    try {
      const { cases } = await api.cases.list({ limit: 100 });
      store.cases = cases ?? [];

      if (!store.cases.length) {
        mount(
          pickerSlot,
          notice(
            'No case is open to you. An advocate appears here only once the registrar has accepted a vakalatnama, or a legal aid order has been made, in a case Lexx holds.',
            'warn'
          )
        );
        return;
      }

      const control = select(
        {
          onChange: (e) => {
            store.selectedCaseId = e.target.value;
            loadPack();
          },
        },
        store.cases.map((c) => ({
          value: String(c._id),
          label: `${c.cnrNumber ?? c.firNumber} — ${c.title ?? ''}`,
        }))
      );
      store.selectedCaseId = String(store.cases[0]._id);
      control.value = store.selectedCaseId;
      mount(pickerSlot, field('Case', control));
      loadPack();
    } catch (error) {
      showError(pickerSlot, error);
    }
  }

  async function loadPack() {
    if (!store.selectedCaseId) return;
    mount(packSlot, spinner('Requesting your disclosure pack…'));
    try {
      const pack = await api.disclosure.myPack(store.selectedCaseId);
      mount(packSlot, packView(pack));
    } catch (error) {
      // The refusal IS the content here. Render it large, with the code and the
      // sentence, not as a toast that disappears.
      mount(packSlot, [
        denial(error, { heading: 'Disclosure refused' }),
        el('div', { style: 'height:12px' }),
        notice(
          'This refusal has been written to the audit log with your identity, the case, the reason code and the time. Supervisory users can see it in their own feed.',
          'info'
        ),
      ]);
    }
  }

  function packView(pack) {
    const ackSlot = el('div');
    const ackBtn = el(
      'button.btn',
      {
        type: 'button',
        disabled: Boolean(pack.acknowledgedAt),
        onClick: (ev) =>
          withBusy(ev.currentTarget, 'Acknowledging…', async () => {
            try {
              await api.disclosure.acknowledge(pack.packId);
              mount(ackSlot, notice('Receipt acknowledged. The fourteen-day clock is stopped.', 'ok'));
              loadPack();
            } catch (error) {
              mount(ackSlot, denial(error, { heading: 'Acknowledgement refused' }));
            }
          }),
      },
      pack.acknowledgedAt ? `Acknowledged ${fmtDate(pack.acknowledgedAt)}` : 'Acknowledge receipt'
    );

    return el('div.stack', [
      watermarkPanel(pack.watermark, pack),
      section('Pack', null, [
        kv([
          ['CNR', el('code', pack.cnrNumber ?? 'not committed')],
          ['FIR', el('code', pack.firNumber ?? '—')],
          ['Status', el('span.pill.pill--ok', pack.status)],
          ['Served on', fmtDate(pack.servedOn)],
          ['Due on', fmtDate(pack.dueOn)],
          ['Exhibits in your set', String(pack.exhibitCount ?? 0)],
        ]),
        el('div.row', { style: 'margin-top:12px' }, [ackBtn]),
        ackSlot,
      ]),
      section(
        'Exhibits served on you',
        'These are the only exhibits accessible to you in this case. Any other exhibit is refused with EXHIBIT_NOT_IN_DISCLOSURE_SET, and the attempt is logged.',
        el(
          'div.stack',
          (pack.exhibits ?? []).length
            ? pack.exhibits.map((e) =>
                el('div.panel', [
                  el('div.panel__head', [
                    el('h2.panel__title', `${e.exhibitCode} — ${e.title ?? ''}`),
                    el('p.panel__note', [
                      el('span.pill', humanise(e.kind)),
                      ' ',
                      el('span.pill', e.mimeType ?? '—'),
                      ' ',
                      el('span.pill', fmtBytes(e.sizeBytes)),
                      ' ',
                      el('span.pill', humanise(e.courtStatus)),
                    ]),
                  ]),
                  el('div.panel__body.stack', [
                    e.description ? el('p', e.description) : null,
                    kv([
                      ['Recorded digest', hash(e.sha256Server)],
                      ['Captured at', fmtDate(e.capturedAt)],
                    ]),
                    // Only the laboratory's opinion is shown to the defence. Machine
                    // review priority is investigative triage, not disclosable
                    // material, and it is deliberately absent from this view.
                    forensicOpinion(e.forensic),
                  ]),
                ])
              )
            : [el('p.empty', 'The served pack contains no exhibits.')]
        )
      ),
      (pack.withheld ?? []).length
        ? section(
            'Material withheld',
            'You are told that material was withheld and on what ground. Naming the item would disclose the very thing the registrar ruled should be withheld.',
            table(
              [{ header: 'Ground for withholding', cell: (w) => w.reason ?? '—' }],
              pack.withheld,
              { empty: 'Nothing withheld.' }
            )
          )
        : null,
    ]);
  }

  append(root, [
    el('h2.page-title', 'Disclosure served on you'),
    el(
      'p.page-lede',
      'Access here follows the court record: a vakalatnama accepted by the registrar, or a legal aid order. Lexx reads that record and can neither create nor extend it.'
    ),
    pickerSlot,
    packSlot,
  ]);

  loadCases();
}

// -------------------------------------------------- direct exhibit request ----

/**
 * A deliberate affordance: try to open an exhibit by id.
 *
 * For an advocate whose disclosure set does not contain it, this is the
 * EXHIBIT_NOT_IN_DISCLOSURE_SET refusal, in full, on screen — the moment the
 * confidentiality boundary stops being a claim and becomes visible.
 */
function renderDirect(root) {
  const idInput = input({ placeholder: '24-character exhibit id' });
  const resultSlot = el('div');
  const goBtn = el('button.btn', { type: 'submit' }, 'Request this exhibit');

  const form = el(
    'form',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        const id = idInput.value.trim();
        if (!id) return;
        await withBusy(goBtn, 'Requesting…', async () => {
          mount(resultSlot, spinner('Asking the access resolver…'));
          try {
            const { evidence } = await api.evidence.get(id);
            mount(resultSlot, [
              notice('This exhibit is inside the set served on you.', 'ok'),
              kv([
                ['Exhibit', el('code', evidence.exhibitCode)],
                ['Title', evidence.title ?? '—'],
                ['Digest', hash(evidence.sha256Server)],
              ]),
            ]);
          } catch (error) {
            mount(resultSlot, [
              denial(error, { heading: 'Exhibit refused' }),
              el('div', { style: 'height:12px' }),
              notice(
                'The refusal names the reason and nothing about the exhibit. That is the design: a reason code may say why you are not entitled, never anything about the record you were reaching for.',
                'info'
              ),
            ]);
          }
        });
      },
    },
    [field('Exhibit id', idInput), el('div.row', [goBtn])]
  );

  append(root, [
    el('h2.page-title', 'Request an exhibit directly'),
    el(
      'p.page-lede',
      'Every request runs through the access resolver, whether it arrives from a list you were shown or from an identifier you typed in. There is no path around it.'
    ),
    section('Direct request', null, [form, resultSlot]),
  ]);
}

// -------------------------------------------------------------------- boot ----

boot({
  title: 'Advocate',
  subtitle: 'Disclosure set and case access',
  roles: ['DEFENCE_COUNSEL', 'VICTIM_COUNSEL', 'LEGAL_AID_COUNSEL', 'PUBLIC_PROSECUTOR'],
  tabs: [
    { id: 'pack', label: 'My disclosure pack', render: renderPack },
    { id: 'direct', label: 'Request an exhibit', render: renderDirect },
  ],
});
