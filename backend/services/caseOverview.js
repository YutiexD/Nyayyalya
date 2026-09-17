/**
 * The per-case picture every dashboard needs: each exhibit with its forensic status,
 * its physical article and its certificate, plus what is waiting to be done on the
 * case and by whom.
 *
 * One builder, used by the case overview (police, SHO, court) and the laboratory's
 * grouped queue, so an exhibit reads the same wherever it appears. Nothing here makes
 * an access decision about the records — callers pass evidence and custody already
 * intersected with the resolver's scope — and nothing here produces an AI judgement.
 *
 * The AI analysis is attached for a laboratory (FSL) viewer only, in the view shape
 * from `ai/visibility.js`. Every other viewer receives no `aiAnalysis` key, no
 * AI-derived pending action, and cards in a neutral order (newest first).
 */
import { CustodyItem } from '../models/CustodyItem.js';
import { Certificate } from '../models/Certificate.js';
import {
  AI_ANALYSIS_STATUS,
  AUTHORITY,
  CERTIFICATE_STATUS,
  TRIAGE_PRIORITY_RANK,
  TRIAGE_PRIORITY_ORDER,
  WRITABLE_CASE_STAGES,
} from '../models/enums.js';
import { seesTriage } from './accessResolver.js';
import { seesAiAnalysis, aiAnalysisView } from './ai/visibility.js';
import { certificateSummary } from './certificateState.js';
import { labelFor } from './evidenceLabel.js';

const UNRANKED = TRIAGE_PRIORITY_ORDER.length;

/**
 * The certificate as an exhibit card carries it. Certificates are issued and signed by
 * the system on upload, so there is no signing state to report — only that it exists,
 * when it was issued, and how it last verified.
 */
const certificateView = (cert) => {
  const s = certificateSummary(cert);
  return s
    ? {
        certificateId: s.certificateId,
        status: s.status,
        // ISSUED | PENDING_ISSUE for every certificate issued by the system.
        state: s.state,
        issuedAt: s.issuedAt,
        lastVerification: s.lastVerification,
      }
    : null;
};

/** Priority rank for sorting. Exhibits without a completed analysis sort last. FSL only. */
export const priorityRank = (card) =>
  card.aiAnalysis?.status === AI_ANALYSIS_STATUS.COMPLETED
    ? TRIAGE_PRIORITY_RANK[card.aiAnalysis.triagePriority] ?? UNRANKED
    : UNRANKED;

/** The laboratory's order: AI-recommended priority, then newest first. */
export const sortByPriority = (cards) =>
  [...cards].sort(
    (a, b) => priorityRank(a) - priorityRank(b) || new Date(b.createdAt) - new Date(a.createdAt)
  );

/** Everyone else's order: newest first, then exhibit code. Nothing AI-derived. */
export const sortNeutral = (cards) =>
  [...cards].sort(
    (a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt) || String(a.exhibitCode).localeCompare(String(b.exhibitCode))
  );

/** The order a given viewer is entitled to. */
export const sortForViewer = (cards, user) => (seesAiAnalysis(user) ? sortByPriority(cards) : sortNeutral(cards));

const custodyView = (item) =>
  item
    ? {
        itemId: String(item._id),
        itemCode: item.itemCode,
        description: item.description,
        status: item.status,
        location: item.currentLocation,
        custodian: item.custodian ?? null,
        sealNumber: item.sealNumber,
        sealIntact: item.sealIntact !== false,
        frozen: Boolean(item.frozen),
        lastMovedAt: item.lastMovedAt ?? item.createdAt ?? null,
      }
    : null;

/**
 * Exhibit cards for a set of evidence documents (already scope-filtered).
 *
 * @param {object[]} evidence  lean Evidence documents, `encryption` excluded
 * @param {object} user        session context
 */
export async function evidenceCards(evidence, user) {
  if (!evidence.length) return [];
  const ids = evidence.map((e) => e._id);
  const party = !seesTriage(user);
  const ai = seesAiAnalysis(user);

  const [items, certs] = await Promise.all([
    party
      ? []
      : CustodyItem.find({ evidenceId: { $in: ids } })
          .select('_id evidenceId itemCode description status currentLocation custodian sealNumber sealIntact frozen lastMovedAt createdAt')
          .lean(),
    Certificate.find({ evidenceId: { $in: ids }, status: CERTIFICATE_STATUS.ACTIVE }).lean(),
  ]);
  const itemBy = new Map(items.map((i) => [String(i.evidenceId), i]));
  const certBy = new Map(certs.map((c) => [String(c.evidenceId), c]));

  return evidence.map((e) => {
    const card = {
      _id: String(e._id),
      exhibitCode: e.exhibitCode,
      caseId: String(e.caseId),
      title: e.title,
      kind: e.kind,
      mimeType: e.mimeType,
      sizeBytes: e.sizeBytes,
      sourceType: e.sourceDevice?.sourceType ?? null,
      createdAt: e.createdAt,
      sha256: e.sha256Server,
      forensic: {
        status: e.forensic?.status ?? null,
        opinion: e.forensic?.opinion ?? null,
        labName: e.forensic?.labName ?? null,
        examinerName: e.forensic?.examinerName ?? null,
        examinationSummary: e.forensic?.examinationSummary ?? null,
        reportedAt: e.forensic?.reportedAt ?? null,
        basis: e.forensic?.basis ?? null,
      },
      certificate: certificateView(certBy.get(String(e._id))),
      // The permanent QR label. Anyone who may read the exhibit may print it.
      label: labelFor(e),
    };
    // The analysis is the laboratory's alone. The key is absent for everyone else.
    if (ai) card.aiAnalysis = aiAnalysisView(e.aiAnalysis);
    if (!party) card.physicalCustody = custodyView(itemBy.get(String(e._id)));
    return card;
  });
}

/**
 * What is waiting on the case, and who it is waiting on.
 *
 * Every entry is a fact about the record — a frozen article, a certificate awaiting a
 * signature, the next act the state machine allows — never an approval step invented
 * for a role. `actor` is the authority that can act on it. Entries derived from the
 * AI analysis are produced only when the viewer is a laboratory.
 */
export function pendingActionsFor({ caseDoc, cards = [], custody = [], workflow, pendingFilings = 0, user = null }) {
  const out = [];
  const add = (actor, code, message, target = null, severity = 'normal') =>
    out.push({ actor, code, message, target, severity });
  const ai = seesAiAnalysis(user);

  for (const c of cards) {
    const analysis = ai ? c.aiAnalysis : null;
    if (analysis?.status === AI_ANALYSIS_STATUS.FAILED) {
      add(AUTHORITY.FSL, 'AI_ANALYSIS_FAILED', `The AI analysis failed for ${c.exhibitCode} — retry it`, c.exhibitCode, 'high');
    }
    if (analysis?.status === AI_ANALYSIS_STATUS.COMPLETED && analysis.fslReviewRecommended && !c.forensic?.opinion) {
      add(
        AUTHORITY.FSL,
        'FSL_REVIEW_RECOMMENDED',
        `The AI analysis recommends forensic review of ${c.exhibitCode} (${analysis.triagePriority})`,
        c.exhibitCode,
        analysis.triagePriority === 'CRITICAL' || analysis.triagePriority === 'HIGH' ? 'high' : 'normal'
      );
    }
    // Certificates are issued and signed by the system on upload: no signature is ever awaited.
  }

  // Physical custody is a backend record only; it raises no to-do for anyone.
  void custody;

  if (workflow?.nextPoliceAction && WRITABLE_CASE_STAGES.includes(caseDoc.stage)) {
    add(AUTHORITY.POLICE, workflow.nextPoliceAction.action, 'File the chargesheet when the investigation is complete', null, 'info');
  }
  if (workflow?.nextCourtAction) {
    add(AUTHORITY.COURT, workflow.nextCourtAction.action, `Next judicial step: ${workflow.nextCourtAction.label}`, null, 'high');
  }
  if (caseDoc.courtId && pendingFilings > 0) {
    add(AUTHORITY.COURT, 'VAKALATNAMA_PENDING', `${pendingFilings} vakalatnama${pendingFilings === 1 ? '' : 's'} waiting for the court to rule`, null, 'high');
  }
  // Nothing to "share": counsel on record read the case file the moment they are on record.

  return out;
}

export default { evidenceCards, pendingActionsFor, sortByPriority, sortNeutral, sortForViewer, priorityRank };
