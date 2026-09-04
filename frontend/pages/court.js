/**
 * Court view — judge and registry.
 *
 *   Cause list  — the cases listed in the court this session is rostered to. The
 *                 roster comes from the court directory at sign-in; Lexx never
 *                 assigns a judge to a case and cannot.
 *   Timeline    — the case's ledger, entry hash and all. Nothing is ever deleted, so
 *                 this is the whole history rather than a current state.
 *   Orders      — the judicial write path. It replaces every delete endpoint in the
 *                 system: a record does not disappear, an order is entered and the
 *                 status changes.
 *   Disclosure  — the registry rules on the exclusions the investigating officer
 *                 requested, then serves the pack, minting one watermark per
 *                 recipient so a leaked copy points back to who it was served on.
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
  table,
  kv,
  hash,
  notice,
  denial,
  showError,
  spinner,
  fmtDate,
  humanise,
  withBusy,
} from '../lib/ui.js';

const store = { cases: [], selectedCaseId: null };

async function loadCases() {
  const { cases } = await api.cases.list({ limit: 100 });
  store.cases = cases ?? [];
  return store.cases;
}

// ============================================================ 1. CAUSE LIST ====

function renderCases(root) {
  const listSlot = el('div');
  const detailSlot = el('div');

  async function load() {
    mount(listSlot, spinner('Loading the cause list…'));
    try {
      await loadCases();
      mount(
        listSlot,
        table(
          [
            { header: 'CNR', cell: (c) => el('code', c.cnrNumber ?? 'not committed') },
            { header: 'FIR', cell: (c) => el('code', c.firNumber) },
            { header: 'Title', cell: (c) => c.title ?? '—' },
            { header: 'Stage', cell: (c) => el('span.pill', humanise(c.stage)) },
            { header: 'Court', cell: (c) => c.courtName ?? c.courtId ?? '—' },
            {
              header: '',
              cell: (c) =>
                el(
                  'button.btn.btn--secondary.btn--small',
                  { type: 'button', onClick: () => openCase(c) },
                  'Open'
                ),
            },
          ],
          store.cases,
          { empty: 'No case is listed in your court.' }
        )
      );
    } catch (error) {
      showError(listSlot, error);
    }
  }

  async function openCase(c) {
    store.selectedCaseId = String(c._id);
    mount(detailSlot, spinner('Reading the ledger…'));
    try {
      const timeline = await api.cases.timeline(c._id);
      mount(detailSlot, [
        section(`Case — FIR ${c.firNumber}`, null, [
          kv([
            ['CNR', el('code', c.cnrNumber ?? 'not committed')],
            ['Court', c.courtName ?? c.courtId ?? '—'],
            ['Stage', el('span.pill', humanise(c.stage))],
            ['Sections', (c.bnsSections ?? []).join(', ') || '—'],
            ['Maximum punishment', c.maxPunishmentYears ? `${c.maxPunishmentYears} years` : '—'],
            ['Sensitivity', el('span.pill', humanise(c.sensitivityClass))],
            ['Disclosure due', fmtDate(c.clocks?.disclosureDueOn)],
            ['Disclosure served', fmtDate(c.clocks?.disclosureServedOn)],
          ]),
          c.jurisdictionComputed?.reasons?.length
            ? el('div', { style: 'margin-top:12px' }, [
                el('div.verdict__label', 'Jurisdiction reasoning on record'),
                el('ol.reasons', c.jurisdictionComputed.reasons.map((r) => el('li', String(r)))),
              ])
            : null,
        ]),
        section(
          'Ledger timeline',
          'Every entry carries the hash of the one before it. Nothing here can be edited or removed — the ledger has no update or delete code path.',
          el(
            'ul.timeline',
            (timeline.events ?? []).map((e) =>
              el(
                `li.timeline__item${e.eventType === 'INTEGRITY_EXCEPTION' ? '.timeline__item--exception' : ''}`,
                [
                  el('div.timeline__head', [
                    el('span.timeline__type', humanise(e.eventType)),
                    el('span.timeline__meta', `${fmtDate(e.occurredAt)} · ${e.actorRole ?? '—'} · seq ${e.seq}`),
                  ]),
                  e.payload?.exhibitCode
                    ? el('div.timeline__meta', `Exhibit ${e.payload.exhibitCode}`)
                    : null,
                  e.payload?.orderType ? el('div.timeline__meta', `Order: ${e.payload.orderType}`) : null,
                  el('div.timeline__hash', `entry ${e.entryHash ?? '—'}`),
                  e.anchorBatchId
                    ? el('div.timeline__meta', `Anchored in batch ${e.anchorBatchId}`)
                    : el('div.timeline__meta', 'Not yet anchored'),
                ]
              )
            )
          )
        ),
      ]);
    } catch (error) {
      showError(detailSlot, error);
    }
  }

  append(root, [
    el('h2.page-title', 'Cause list'),
    el(
      'p.page-lede',
      'You see the cases listed in the court your roster entry puts you in today. That roster is read from the court directory at sign-in and Lexx cannot write to it.'
    ),
    el('div.grid.grid--2', [section('Cases in your court', null, listSlot), el('div', detailSlot)]),
  ]);

  load();
}

// ================================================================ 2. ORDERS ====

function renderOrders(root) {
  const pickerSlot = el('div');
  const resultSlot = el('div');

  const caseSelect = el('select.input');
  const orderTypeInput = input({ placeholder: 'COMMITTAL / EXHIBIT_MARKED / DISCLOSURE_DIRECTION' });
  const textInput = el('textarea.input', { required: true, placeholder: 'The order, in the words it is to be recorded in.' });
  const effectiveInput = el('input.input', { type: 'datetime-local' });
  const recordBtn = el('button.btn', { type: 'submit' }, 'Record the order');

  async function load() {
    mount(pickerSlot, spinner('Loading cases…'));
    try {
      await loadCases();
      mount(caseSelect, store.cases.map((c) =>
        el('option', { value: String(c._id) }, `${c.cnrNumber ?? c.firNumber} — ${c.title ?? ''}`)
      ));
      mount(pickerSlot, field('Case', caseSelect));
    } catch (error) {
      showError(pickerSlot, error);
    }
  }

  const form = el(
    'form',
    {
      onSubmit: async (e) => {
        e.preventDefault();
        const caseId = caseSelect.value;
        if (!caseId) return;
        await withBusy(recordBtn, 'Recording…', async () => {
          try {
            const payload = {
              orderType: orderTypeInput.value.trim(),
              text: textInput.value.trim(),
            };
            if (effectiveInput.value) payload.effectiveOn = new Date(effectiveInput.value).toISOString();
            const result = await api.cases.recordOrder(caseId, payload);
            mount(resultSlot, [
              notice('Order recorded in the ledger.', 'ok'),
              kv([
                ['Ledger sequence', el('code', String(result.ledgerSeq))],
                ['Entry hash', hash(result.entryHash)],
              ]),
            ]);
            form.reset();
          } catch (error) {
            mount(resultSlot, denial(error, { heading: 'Order not recorded' }));
          }
        });
      },
    },
    [
      pickerSlot,
      field('Order type', orderTypeInput),
      field('Order', textInput),
      field(
        'Effective on',
        effectiveInput,
        'Recorded as the court’s asserted date. The ledger’s own sequence and timestamps are the server’s, and a client-asserted time is never chain input.'
      ),
      el('div.row', [recordBtn]),
    ]
  );

  append(root, [
    el('h2.page-title', 'Record an order'),
    el(
      'p.page-lede',
      'There is no delete endpoint anywhere in this system. Where another design would remove a record, this one records an order and changes a status — signed by whoever ordered it.'
    ),
    section('Judicial order', null, [form, resultSlot]),
  ]);

  load();
}

// ============================================================ 3. DISCLOSURE ====

function renderDisclosure(root) {
  const approveSlot = el('div');
  const serveSlot = el('div');

  const packIdInput = input({ placeholder: '24-character pack id from the investigating officer' });
  const variantInput = input({ placeholder: 'DEFENCE_V1' });
  const exclusionIdsInput = input({ placeholder: 'exhibit ids to withhold, comma separated' });
  const maskInput = el('input', { type: 'checkbox', id: 'mask-victim' });
  const approveBtn = el('button.btn', { type: 'button' }, 'Approve the pack');

  approveBtn.addEventListener('click', (ev) =>
    withBusy(ev.currentTarget, 'Approving…', async () => {
      const packId = packIdInput.value.trim();
      if (!packId) return;
      try {
        const payload = {
          approvedExclusions: exclusionIdsInput.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        };
        if (variantInput.value.trim()) payload.redactionVariant = variantInput.value.trim();
        payload.maskVictimIdentity = maskInput.checked;

        const result = await api.disclosure.approve(packId, payload);
        mount(approveSlot, [
          notice(
            result.servable
              ? 'Pack approved and ready to serve.'
              : 'Pack approved, but exclusions are still pending a ruling — it cannot be served until every one is decided.',
            result.servable ? 'ok' : 'warn'
          ),
          kv([
            ['Pack', el('code', result.pack.packId)],
            ['Status', el('span.pill', result.pack.status)],
            ['Exhibits', String(result.pack.exhibitCount ?? 0)],
            ['Redaction variant', el('code', result.pack.redactionVariant ?? '—')],
            ['Victim identity masked', result.pack.maskVictimIdentity ? 'Yes' : 'No'],
          ]),
          (result.pendingExclusions ?? []).length
            ? el('div', [
                el('div.verdict__label', 'Pending exclusions'),
                el(
                  'ul',
                  (result.pendingExclusions ?? []).map((x) =>
                    el('li', [el('code', String(x.itemId ?? x)), x.reason ? ` — ${x.reason}` : ''])
                  )
                ),
              ])
            : null,
          (result.pack.excludedItems ?? []).length
            ? el('div', [
                el('div.verdict__label', 'Exclusions on record'),
                el(
                  'ul',
                  result.pack.excludedItems.map((x) =>
                    el('li', [
                      el('code', x.itemId),
                      ` — ${x.reason}`,
                      el(`span.pill.pill--${x.approved ? 'ok' : 'warn'}`, x.approved ? 'APPROVED' : 'PENDING'),
                    ])
                  )
                ),
              ])
            : null,
        ]);
      } catch (error) {
        mount(approveSlot, denial(error, { heading: 'Pack not approved' }));
      }
    })
  );

  const serveBtn = el('button.btn', { type: 'button' }, 'Serve the pack');
  const recipientsInput = input({ placeholder: 'optional: recipient user ids, comma separated' });

  serveBtn.addEventListener('click', (ev) =>
    withBusy(ev.currentTarget, 'Serving…', async () => {
      const packId = packIdInput.value.trim();
      if (!packId) return;
      try {
        const recipients = recipientsInput.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const result = await api.disclosure.serve(
          packId,
          recipients.length ? { recipientUserIds: recipients } : {}
        );
        mount(serveSlot, [
          notice('Pack served. The fourteen-day clock stops when each recipient acknowledges.', 'ok'),
          table(
            [
              { header: 'Recipient', cell: (r) => el('code', r.authorityId ?? r.userId) },
              { header: 'Watermark identity', cell: (r) => r.watermarkLabel ?? '—' },
              { header: 'Token', cell: (r) => el('code', r.watermarkToken ?? '—') },
            ],
            result.servedNow ?? [],
            { empty: 'No recipient was served — check that a live grant exists for this case.' }
          ),
          notice(
            'Each recipient gets their own watermark token. A copy that leaks therefore points back to the person it was served on.',
            'info'
          ),
        ]);
      } catch (error) {
        mount(serveSlot, denial(error, { heading: 'Pack not served' }));
      }
    })
  );

  append(root, [
    el('h2.page-title', 'Disclosure'),
    el(
      'p.page-lede',
      'The investigating officer proposes a set and states a reason for anything withheld. The registry rules on those reasons, then serves — and only then does defence counsel see anything at all.'
    ),
    section('Pack', null, [
      field('Pack id', packIdInput, 'The officer’s disclosure tab prints this id when the set is prepared.'),
    ]),
    el('div.grid.grid--2', [
      section('Approve', 'Rule on each requested exclusion and fix the redaction variant.', [
        field('Redaction variant', variantInput),
        field('Approve these exclusions', exclusionIdsInput),
        el('label.row', [maskInput, el('span', 'Mask victim identity')]),
        el('div.row', { style: 'margin-top:10px' }, [approveBtn]),
        approveSlot,
      ]),
      section('Serve', 'Mints one watermark per recipient and stops the clock.', [
        field('Recipients', recipientsInput, 'Leave blank to serve every advocate with a live grant on the case.'),
        el('div.row', [serveBtn]),
        serveSlot,
      ]),
    ]),
  ]);
}

// -------------------------------------------------------------------- boot ----

boot({
  title: 'Court',
  subtitle: 'Cause list, ledger, orders and disclosure',
  roles: ['JUDGE', 'REGISTRAR', 'EVIDENCE_CUSTODIAN'],
  tabs: [
    { id: 'cases', label: 'Cause list', render: renderCases },
    { id: 'orders', label: 'Orders', render: renderOrders },
    { id: 'disclosure', label: 'Disclosure', render: renderDisclosure },
  ],
});
