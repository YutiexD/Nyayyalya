/**
 * Lifecycle details: what happened at each milestone, who did it, and the material a
 * reader needs to check it for themselves.
 *
 * ONE builder, used by every surface that shows a lifecycle:
 *
 *   - the public exhibit page and certificate verifier  (variant 'public')
 *   - GET /api/evidence/:id/lifecycle                   (variant 'authenticated')
 *   - workflow.lifecycle on the case overview/workflow  (variant 'authenticated')
 *
 * Every entry is read from the record — the hash-chained ledger first, then the
 * exhibit, its certificate, the case and the users named in them — never from
 * anything a client asserted. Each entry is:
 *
 *   { key, label, state, at, description, actor: { name, roleLabel, authorityId } | null,
 *     proofs: [{ label, value, kind: 'hash'|'key'|'ledger'|'anchor'|'text', href? }] }
 *
 * The public variant carries no free-text note, no forensic opinion, no AI data, no
 * exhibit description and no examiner identity. The authenticated variant adds the
 * court's recorded notes, and still never the AI analysis or the opinion itself.
 *
 * Cost: one ledger query, one user query and one anchor-batch query per call.
 */
import env from '../config/env.js';
import { Ledger } from '../models/Ledger.js';
import { User } from '../models/User.js';
import { AnchorBatch } from '../models/AnchorBatch.js';
import {
  ANCHOR_STATUS,
  CASE_ACTION,
  CASE_STAGE,
  CLOSURE_DOCUMENT_KIND_LABEL,
  FORENSIC_STATUS,
  LEDGER_EVENT,
  ROLE_LABEL,
} from '../models/enums.js';
import { SYSTEM_SIGNER_LABEL, authorityPublicKey } from './systemSigner.js';

export const LIFECYCLE_VARIANT = Object.freeze({
  PUBLIC: 'public',
  AUTHENTICATED: 'authenticated',
});

const CASE_EVENTS = [LEDGER_EVENT.CASE_CREATED, LEDGER_EVENT.CASE_STAGE_CHANGED, LEDGER_EVENT.CASE_CLOSED];
const EXHIBIT_EVENTS = [
  LEDGER_EVENT.EVIDENCE_UPLOADED,
  LEDGER_EVENT.CERTIFICATE_GENERATED,
  LEDGER_EVENT.FSL_REPORT_FILED,
];
const ENTRY_FIELDS =
  'seq eventType subjectId actorUserId actorRole actorPubKeyFingerprint payload entryHash anchorBatchId occurredAt';

const idStr = (v) => (v == null ? null : String(v));
const uniq = (xs) => [...new Set(xs.filter(Boolean).map(String))];
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// ------------------------------------------------------------------ loading ----

/**
 * Everything the builders read, in three queries.
 *
 * @param {object} args
 * @param {any}    args.caseId
 * @param {any[]}  [args.subjectIds]  exhibit / certificate ids whose own entries are wanted
 * @param {any[]}  [args.userIds]     users named outside the ledger (uploader, examiner…)
 */
export async function loadLifecycleRecords({ caseId, subjectIds = [], userIds = [] }) {
  if (!caseId) return { entries: [], users: new Map(), batches: new Map() };

  const subjects = subjectIds.filter(Boolean);
  const or = [{ eventType: { $in: CASE_EVENTS } }];
  if (subjects.length) or.push({ subjectId: { $in: subjects }, eventType: { $in: EXHIBIT_EVENTS } });

  const entries = await Ledger.find({ caseId, $or: or }).sort({ seq: 1 }).select(ENTRY_FIELDS).limit(1000).lean();

  const [users, batches] = await Promise.all([
    (async () => {
      const ids = uniq([...userIds, ...entries.map((e) => e.actorUserId)]);
      if (!ids.length) return [];
      return User.find({ _id: { $in: ids } }).select('_id name role authorityId').lean();
    })(),
    (async () => {
      const ids = uniq(entries.map((e) => e.anchorBatchId));
      if (!ids.length) return [];
      return AnchorBatch.find({ batchId: { $in: ids } }).select('batchId status txHash anchoredAt').lean();
    })(),
  ]);

  return {
    entries,
    users: new Map(users.map((u) => [String(u._id), u])),
    batches: new Map(batches.map((b) => [b.batchId, b])),
  };
}

// ------------------------------------------------------------------ pieces ----

const actorOf = (user, fallback = {}) => {
  if (!user && !fallback.name && !fallback.role) return null;
  const role = user?.role ?? fallback.role ?? null;
  return {
    name: user?.name ?? fallback.name ?? null,
    roleLabel: ROLE_LABEL[role] ?? fallback.roleLabel ?? role ?? null,
    authorityId: user?.authorityId ?? fallback.authorityId ?? null,
  };
};

/** "Asha Rao (Investigating Officer, UP-GZB-4471)" — degrades gracefully. */
const who = (actor, fallback = 'an unidentified user') => {
  if (!actor?.name) return actor?.roleLabel ? `the ${actor.roleLabel}` : fallback;
  const tail = [actor.roleLabel, actor.authorityId].filter(Boolean).join(', ');
  return tail ? `${actor.name} (${tail})` : actor.name;
};

const quoted = (text) => {
  const t = String(text ?? '').trim();
  return t ? `“${t}”` : null;
};

const hashProof = (label, value) => (value ? { label, value, kind: 'hash' } : null);
const keyProof = (label, value) => (value ? { label, value, kind: 'key' } : null);
const textProof = (label, value) => (value ? { label, value, kind: 'text' } : null);

const explorerHref = (txHash) => `${String(env.ANCHOR_EXPLORER_BASE).replace(/\/$/, '')}/tx/${txHash}`;

/** Where one ledger entry stands on its way to the chain. */
export function anchorProof(entry, batches) {
  if (!entry) return null;
  if (!entry.anchorBatchId) return { label: 'Anchoring', value: 'Awaiting anchoring', kind: 'anchor' };
  const batch = batches.get(entry.anchorBatchId);
  const id = entry.anchorBatchId;
  if (!batch) return { label: 'Anchoring', value: `Batch ${id} (batch record unavailable)`, kind: 'anchor' };
  if (batch.txHash && batch.status === ANCHOR_STATUS.CONFIRMED) {
    return { label: 'Anchoring', value: `Anchored in batch ${id} — tx ${batch.txHash}`, kind: 'anchor', href: explorerHref(batch.txHash) };
  }
  if (batch.txHash && batch.status === ANCHOR_STATUS.SUBMITTED) {
    return {
      label: 'Anchoring',
      value: `Submitted in batch ${id} — tx ${batch.txHash} (awaiting confirmation)`,
      kind: 'anchor',
      href: explorerHref(batch.txHash),
    };
  }
  if (batch.status === ANCHOR_STATUS.DRY_RUN) {
    return { label: 'Anchoring', value: `Recorded locally (dry run) in batch ${id}`, kind: 'anchor' };
  }
  if (batch.status === ANCHOR_STATUS.FAILED) {
    return { label: 'Anchoring', value: `Anchoring of batch ${id} failed; it will be retried`, kind: 'anchor' };
  }
  return { label: 'Anchoring', value: `Queued in batch ${id}`, kind: 'anchor' };
}

/** The ledger entry and its anchoring, as a pair of proofs. */
const entryProofs = (entry, batches) =>
  entry ? [{ label: `Ledger entry #${entry.seq}`, value: entry.entryHash, kind: 'ledger' }, anchorProof(entry, batches)] : [];

const compact = (proofs) => proofs.filter(Boolean);

const lastOf = (entries, pred) => {
  for (let i = entries.length - 1; i >= 0; i -= 1) if (pred(entries[i])) return entries[i];
  return null;
};

const stageAct = (action) => (e) =>
  e.eventType === LEDGER_EVENT.CASE_STAGE_CHANGED && e.payload?.action === action;

// ------------------------------------------------------- case milestones ----

/**
 * Details for the case-level milestones, shared by the case strip and the exhibit
 * lifecycle. Returns null when the milestone has not happened.
 */
function caseMilestone(key, { caseDoc, variant, records }) {
  const { entries, users, batches } = records;
  const authenticated = variant === LIFECYCLE_VARIANT.AUTHENTICATED;
  const actorFor = (entry) => (entry ? actorOf(users.get(idStr(entry.actorUserId)), { role: entry.actorRole }) : null);

  switch (key) {
    case CASE_STAGE.UNDER_INVESTIGATION: {
      const created = lastOf(entries, (e) => e.eventType === LEDGER_EVENT.CASE_CREATED);
      const actor = actorFor(created);
      const station = caseDoc?.stationName ?? caseDoc?.stationCode ?? null;
      const parts = [
        `Case opened from FIR ${caseDoc?.firNumber ?? '—'}${station ? ` of ${station}` : ''} by ${who(actor, 'the police')}.`,
      ];
      const directions = entries.filter(stageAct(CASE_ACTION.DIRECT_FURTHER_INVESTIGATION));
      const proofs = [...entryProofs(created, batches)];
      for (const d of directions) {
        const judge = actorOf(users.get(idStr(d.actorUserId)), { role: d.actorRole });
        const note = authenticated ? quoted(d.payload?.note) : null;
        parts.push(
          `Further investigation directed by ${judge?.name ?? 'the Court'} (Court) on ${isoDate(d.occurredAt)}${note ? `: ${note}` : '.'}`
        );
        proofs.push(...entryProofs(d, batches));
      }
      return { description: parts.join(' '), actor, proofs: compact(proofs), at: created?.occurredAt ?? caseDoc?.createdAt ?? null };
    }

    case CASE_STAGE.CHARGESHEET_FILED: {
      const filed = lastOf(entries, stageAct(CASE_ACTION.FILE_CHARGESHEET));
      if (!filed && !caseDoc?.chargesheetFiledOn) return null;
      const actor = actorFor(filed);
      const court = filed?.payload?.courtName ?? caseDoc?.courtName ?? null;
      const cnr = filed?.payload?.cnrNumber ?? caseDoc?.cnrNumber ?? null;
      return {
        description: `Filed by ${who(actor, 'the investigating officer')}${court ? ` before ${court}` : ''}${cnr ? `; CNR ${cnr} allotted` : ''}.`,
        actor,
        proofs: compact(entryProofs(filed, batches)),
        at: filed?.occurredAt ?? caseDoc?.chargesheetFiledOn ?? null,
      };
    }

    case CASE_STAGE.COGNIZANCE_TAKEN:
    case CASE_STAGE.COMMITTED:
    case CASE_STAGE.TRIAL: {
      const action = {
        [CASE_STAGE.COGNIZANCE_TAKEN]: CASE_ACTION.TAKE_COGNIZANCE,
        [CASE_STAGE.COMMITTED]: CASE_ACTION.COMMIT_FOR_TRIAL,
        [CASE_STAGE.TRIAL]: CASE_ACTION.BEGIN_TRIAL,
      }[key];
      const entry = lastOf(entries, stageAct(action));
      const dateField = { [CASE_STAGE.COGNIZANCE_TAKEN]: 'cognizanceTakenOn', [CASE_STAGE.COMMITTED]: 'committedOn', [CASE_STAGE.TRIAL]: 'trialStartedOn' }[key];
      if (!entry && !caseDoc?.[dateField]) return null;
      const actor = actorFor(entry);
      const note = authenticated ? quoted(entry?.payload?.note) : null;
      return {
        description: `Recorded by ${actor?.name ?? 'the Court'} (Court).${note ? ` The court’s note: ${note}.` : ''}`,
        actor,
        proofs: compact(entryProofs(entry, batches)),
        at: entry?.occurredAt ?? caseDoc?.[dateField] ?? null,
      };
    }

    case CASE_STAGE.CLOSED: {
      const entry = lastOf(entries, (e) => e.eventType === LEDGER_EVENT.CASE_CLOSED);
      if (!entry && !caseDoc?.closedOn) return null;
      const closure = caseDoc?.closure ?? null;
      const actor = actorFor(entry) ?? actorOf(null, { name: closure?.signedBy?.name, role: closure?.signedBy?.role, authorityId: closure?.signedBy?.authorityId });
      const hasDocument = Boolean(closure?.sha256);
      const kindLabel = CLOSURE_DOCUMENT_KIND_LABEL[closure?.kind] ?? 'Closing document';
      const note = authenticated ? quoted(closure?.note ?? entry?.payload?.reason) : null;
      const parts = [`Closed by ${actor?.name ?? 'the Court'}.`];
      if (hasDocument) parts.push(`${kindLabel} attached (signed with the judge’s device key).`);
      if (note) parts.push(`Reason recorded: ${note}.`);
      return {
        description: parts.join(' '),
        actor,
        proofs: compact([
          hasDocument ? hashProof(`${kindLabel} SHA-256`, closure.sha256) : null,
          hasDocument ? keyProof('Signer key fingerprint', closure.signerKeyFingerprint) : null,
          ...entryProofs(entry, batches),
        ]),
        at: entry?.occurredAt ?? caseDoc?.closedOn ?? null,
      };
    }

    default:
      return null;
  }
}

/** What an upcoming (or never-reached) case milestone is waiting for. */
function pendingCaseDescription(key, state, { caseDoc, records }) {
  const closed = state === 'not_applicable';
  const sentBack =
    caseDoc?.stage === CASE_STAGE.FURTHER_INVESTIGATION ||
    records.entries.some(stageAct(CASE_ACTION.DIRECT_FURTHER_INVESTIGATION));
  switch (key) {
    case CASE_STAGE.UNDER_INVESTIGATION:
      return 'Awaiting the opening of the case from the FIR.';
    case CASE_STAGE.CHARGESHEET_FILED:
      if (closed) return 'Not applicable — the case closed without a chargesheet.';
      return sentBack && caseDoc?.stage === CASE_STAGE.FURTHER_INVESTIGATION
        ? 'Awaiting a fresh chargesheet after the court directed further investigation.'
        : 'Awaiting the chargesheet from the investigating officer.';
    case CASE_STAGE.COGNIZANCE_TAKEN:
      return closed ? 'Not applicable — the case closed before cognizance.' : 'Awaiting the court’s cognizance of the offence.';
    case CASE_STAGE.COMMITTED:
      return closed
        ? 'Not applicable — this case is triable by a Magistrate, or closed without committal.'
        : 'Awaiting committal to the Court of Session.';
    case CASE_STAGE.TRIAL:
      return closed ? 'Not applicable — the case closed before trial.' : 'Awaiting the framing of charges and the start of trial.';
    case CASE_STAGE.CLOSED:
      return 'Awaiting the court’s final disposal of the case.';
    default:
      return 'Awaiting this step.';
  }
}

/** A Magistrate-triable case never has a committal. Said plainly. */
const notApplicableCommittal = 'Not applicable — this case is triable by a Magistrate, so no committal is required.';

// ------------------------------------------------------------ case strip ----

/**
 * The case strip (`workflow.lifecycle`), with details. Keeps each item's `stage`,
 * `label` and `state` exactly as workflowFor produced them and adds `key`, `at`,
 * `description`, `actor` and `proofs`.
 */
export async function describeCaseLifecycle({ caseDoc, lifecycle, variant = LIFECYCLE_VARIANT.AUTHENTICATED, records }) {
  const recs =
    records ??
    (await loadLifecycleRecords({ caseId: caseDoc?._id, userIds: [caseDoc?.closure?.signedBy?.userId] }));

  return lifecycle.map((item) => {
    const key = item.stage;
    // On the strip a "current" stage is one the case has reached: its act happened.
    const reached = item.state === 'done' || item.state === 'current';
    const detail = reached ? caseMilestone(key, { caseDoc, variant, records: recs }) : null;
    if (detail) {
      return { ...item, key, at: detail.at, description: detail.description, actor: detail.actor, proofs: detail.proofs };
    }
    const committalNa = key === CASE_STAGE.COMMITTED && item.state === 'not_applicable' && caseDoc?.stage !== CASE_STAGE.CLOSED;
    return {
      ...item,
      key,
      at: null,
      description: committalNa ? notApplicableCommittal : pendingCaseDescription(key, item.state, { caseDoc, records: recs }),
      actor: null,
      proofs: [],
    };
  });
}

// --------------------------------------------------------- exhibit strip ----

const EVIDENCE_TO_CASE_KEY = Object.freeze({
  CHARGESHEET_FILED: CASE_STAGE.CHARGESHEET_FILED,
  COGNIZANCE_TAKEN: CASE_STAGE.COGNIZANCE_TAKEN,
  COMMITTED: CASE_STAGE.COMMITTED,
  TRIAL: CASE_STAGE.TRIAL,
  CLOSED: CASE_STAGE.CLOSED,
});

function uploadedDetail({ evidence, records }) {
  const { entries, users, batches } = records;
  const entry =
    lastOf(entries, (e) => e.eventType === LEDGER_EVENT.EVIDENCE_UPLOADED && idStr(e.subjectId) === idStr(evidence._id)) ??
    (Number.isInteger(evidence.ledgerSeq) ? entries.find((e) => e.seq === evidence.ledgerSeq) ?? null : null);
  const uploader = users.get(idStr(evidence.uploadedByUserId)) ?? users.get(idStr(entry?.actorUserId));
  const actor = actorOf(uploader, { role: entry?.actorRole });
  const verified = evidence.hashMatchedOnIngest !== false && evidence.signatureValidOnIngest !== false;
  return {
    description: `Uploaded by ${who(actor)}.${
      verified
        ? ' The file’s SHA-256 was computed in the officer’s browser, matched by the server, and signed with the officer’s registered device key.'
        : ''
    }`,
    actor,
    proofs: compact([
      hashProof('Evidence SHA-256', evidence.sha256Server),
      keyProof('Uploader key fingerprint', evidence.signerPubKeyFingerprint ?? entry?.actorPubKeyFingerprint),
      ...entryProofs(entry, batches),
    ]),
  };
}

function certificateDetail({ certificate, records }) {
  const { entries, batches } = records;
  const entry = certificate
    ? entries.find((e) => Number.isInteger(certificate.issuanceLedgerSeq) && e.seq === certificate.issuanceLedgerSeq) ??
      lastOf(entries, (e) => e.eventType === LEDGER_EVENT.CERTIFICATE_GENERATED && idStr(e.subjectId) === idStr(certificate._id))
    : null;
  const onBehalfOf = certificate?.issuedOnBehalfOf?.name ?? null;
  const last = certificate?.lastVerification;
  const fingerprint = certificate?.systemSignature?.keyFingerprint ?? entry?.payload?.authorityKeyFingerprint ?? authorityPublicKey().fingerprint;
  return {
    description: `Issued and signed automatically by the ${SYSTEM_SIGNER_LABEL}${onBehalfOf ? ` on behalf of ${onBehalfOf}` : ''}.`,
    actor: { name: SYSTEM_SIGNER_LABEL, roleLabel: 'Certificate Authority', authorityId: null },
    proofs: compact([
      hashProof('Certificate PDF SHA-256', certificate?.pdfSha256),
      keyProof('Authority key fingerprint', fingerprint),
      ...entryProofs(entry, batches),
      last?.result
        ? textProof(
            'Last verification',
            `${last.result} on ${new Date(last.at).toISOString()}${last.byRole ? ` by ${ROLE_LABEL[last.byRole] ?? last.byRole}` : ''}`
          )
        : null,
    ]),
  };
}

function forensicDetail({ evidence, variant, records }) {
  const { entries, users, batches } = records;
  const f = evidence.forensic ?? {};
  const entry = lastOf(entries, (e) => e.eventType === LEDGER_EVENT.FSL_REPORT_FILED && idStr(e.subjectId) === idStr(evidence._id));
  const lab = f.labName ?? entry?.payload?.labName ?? 'a forensic laboratory';
  const authenticated = variant === LIFECYCLE_VARIANT.AUTHENTICATED;

  let actor;
  let description;
  if (authenticated) {
    const examiner = users.get(idStr(f.examinerUserId)) ?? users.get(idStr(entry?.actorUserId));
    actor = actorOf(examiner, { name: f.examinerName, role: entry?.actorRole ?? 'FSL_EXAMINER' });
    description = `Examined at ${lab} by ${actor?.name ?? 'a forensic examiner'}. Verdict recorded${
      f.reportSha256 ? ' with a signed report document' : ''
    }.`;
  } else {
    // The public learn THAT an examination was reported, where and when — not by whom
    // and not what it concluded.
    actor = { name: null, roleLabel: ROLE_LABEL.FSL_EXAMINER, authorityId: null };
    description = `Examined at ${lab} by a forensic examiner.`;
  }

  return {
    description,
    actor,
    proofs: compact([
      hashProof('Report SHA-256', f.reportSha256 ?? entry?.payload?.reportSha256),
      f.reportSignature || entry?.actorPubKeyFingerprint ? keyProof('Examiner key fingerprint', entry?.actorPubKeyFingerprint) : null,
      ...entryProofs(entry, batches),
      authenticated && f.basis
        ? textProof('Basis', f.basis === 'DIRECT_REVIEW' ? 'Direct review from the laboratory queue' : 'Formal referral')
        : null,
    ]),
  };
}

function pendingEvidenceDescription(key, state, { evidence, caseDoc, records }) {
  const closed = state === 'not_applicable';
  switch (key) {
    case 'CERTIFICATE_ISSUED':
      return closed ? 'No section 63 certificate was issued.' : `Awaiting issue of the section 63 certificate by the ${SYSTEM_SIGNER_LABEL}.`;
    case 'FORENSIC_EXAMINATION': {
      if (closed) return 'Not applicable — no forensic examination was reported before the case closed.';
      const f = evidence?.forensic ?? {};
      if (f.status === FORENSIC_STATUS.REFERRED || f.status === FORENSIC_STATUS.UNDER_EXAMINATION) {
        return `Referred to ${f.labName ?? 'a forensic laboratory'}; awaiting the laboratory’s report.`;
      }
      return 'Awaiting forensic examination.';
    }
    default: {
      const caseKey = EVIDENCE_TO_CASE_KEY[key];
      if (caseKey === CASE_STAGE.COMMITTED && state === 'not_applicable' && !['CLOSED', 'DISPOSED'].includes(caseDoc?.stage)) {
        return notApplicableCommittal;
      }
      return caseKey ? pendingCaseDescription(caseKey, state, { caseDoc, records }) : 'Awaiting this step.';
    }
  }
}

/**
 * The exhibit lifecycle (from `lifecycleFor`), with details.
 *
 * @param {object}   args
 * @param {object[]} args.lifecycle          `lifecycleFor` output
 * @param {object}   args.evidence           lean Evidence
 * @param {object}   [args.caseDoc]          lean Case
 * @param {object}   [args.activeCertificate]
 * @param {string}   [args.variant]
 */
export async function describeEvidenceLifecycle({
  lifecycle,
  evidence,
  caseDoc = null,
  activeCertificate = null,
  variant = LIFECYCLE_VARIANT.PUBLIC,
}) {
  const records = await loadLifecycleRecords({
    caseId: evidence?.caseId ?? caseDoc?._id,
    subjectIds: [evidence?._id, activeCertificate?._id],
    userIds: [evidence?.uploadedByUserId, evidence?.forensic?.examinerUserId, caseDoc?.closure?.signedBy?.userId],
  });
  const ctx = { evidence, caseDoc, certificate: activeCertificate, variant, records };

  return lifecycle.map((m) => {
    let detail = null;
    if (m.state === 'done') {
      if (m.key === 'UPLOADED') detail = uploadedDetail(ctx);
      else if (m.key === 'CERTIFICATE_ISSUED') detail = certificateDetail(ctx);
      else if (m.key === 'FORENSIC_EXAMINATION') detail = forensicDetail(ctx);
      else if (EVIDENCE_TO_CASE_KEY[m.key]) detail = caseMilestone(EVIDENCE_TO_CASE_KEY[m.key], { caseDoc, variant, records });
    }
    if (detail) {
      return { ...m, description: detail.description, actor: detail.actor ?? null, proofs: detail.proofs ?? [] };
    }
    return {
      ...m,
      description: pendingEvidenceDescription(m.key, m.state, ctx),
      actor: null,
      proofs: [],
    };
  });
}

// ------------------------------------------------------------ closure view ----

/**
 * How a case's closure reads to a client. Never the stored subdocument: no vault key,
 * no signature bytes, no pinned key material. Counsel may read it.
 */
export function closureView(closure) {
  if (!closure) return null;
  const signedBy = closure.signedBy ?? null;
  return {
    kind: closure.kind ?? null,
    kindLabel: CLOSURE_DOCUMENT_KIND_LABEL[closure.kind] ?? null,
    fileName: closure.fileName ?? null,
    sizeBytes: closure.sizeBytes ?? null,
    sha256: closure.sha256 ?? null,
    signedBy: signedBy
      ? {
          name: signedBy.name ?? null,
          roleLabel: ROLE_LABEL[signedBy.role] ?? signedBy.role ?? null,
          authorityId: signedBy.authorityId ?? null,
        }
      : null,
    signerKeyFingerprint: closure.signerKeyFingerprint ?? null,
    uploadedAt: closure.uploadedAt ?? null,
    note: closure.note ?? null,
    hasDocument: Boolean(closure.sha256),
  };
}

export default {
  describeCaseLifecycle,
  describeEvidenceLifecycle,
  loadLifecycleRecords,
  anchorProof,
  closureView,
  LIFECYCLE_VARIANT,
};
