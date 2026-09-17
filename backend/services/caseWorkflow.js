/**
 * The case state machine.
 *
 * Every stage change a case can undergo is defined here, once: which act causes it,
 * which authority performs it, which stages it may be performed from, and what else
 * must be true. Controllers ask this module whether a transition is valid and then
 * perform it; the client asks it (through `GET /api/cases/:id/workflow`) what can
 * happen next. Neither invents a stage.
 *
 *   UNDER_INVESTIGATION ──FILE_CHARGESHEET (police)──▶ CHARGESHEET_FILED
 *   CHARGESHEET_FILED ──TAKE_COGNIZANCE (court)──────▶ COGNIZANCE_TAKEN
 *   COGNIZANCE_TAKEN ──COMMIT_FOR_TRIAL (court)──────▶ COMMITTED        [Sessions-triable]
 *   COGNIZANCE_TAKEN ──BEGIN_TRIAL (court)───────────▶ TRIAL            [Magistrate-triable]
 *   COMMITTED ──BEGIN_TRIAL (court)──────────────────▶ TRIAL
 *   COGNIZANCE_TAKEN ──DIRECT_FURTHER_INVESTIGATION──▶ FURTHER_INVESTIGATION ─FILE_CHARGESHEET─▶ …
 *   COGNIZANCE_TAKEN | COMMITTED | TRIAL ──CLOSE_CASE─▶ CLOSED
 *
 * Whether committal applies is not a choice anyone makes on screen: it is the
 * jurisdiction router's answer for the case's own FIR facts (offence punishable with
 * seven years or more, or a special-court designation).
 */
import { AUTHORITY, CASE_ACTION, CASE_STAGE, CLOSED_CASE_STAGES, WRITABLE_CASE_STAGES } from '../models/enums.js';
import { computeJurisdiction } from './jurisdiction.js';

export const STAGE_LABEL = Object.freeze({
  [CASE_STAGE.UNDER_INVESTIGATION]: 'Under investigation',
  [CASE_STAGE.FURTHER_INVESTIGATION]: 'Further investigation',
  [CASE_STAGE.CHARGESHEET_FILED]: 'Chargesheet filed',
  [CASE_STAGE.COGNIZANCE_TAKEN]: 'Cognizance taken',
  [CASE_STAGE.COMMITTED]: 'Committed for trial',
  [CASE_STAGE.TRIAL]: 'Trial',
  [CASE_STAGE.CLOSED]: 'Closed',
  [CASE_STAGE.DISPOSED]: 'Disposed',
});

/** Sessions-triable or special-court cases need committal before trial. */
export function requiresCommittal(caseDoc) {
  return computeJurisdiction({
    bnsSections: caseDoc.bnsSections ?? [],
    maxPunishmentYears: caseDoc.maxPunishmentYears ?? 0,
    sensitivityClass: caseDoc.sensitivityClass,
    isVictimProtected: caseDoc.isVictimProtected,
    districtCode: caseDoc.districtCode,
  }).requiresCommittal;
}

/**
 * The transitions. `from` may depend on the case (trial starts from COMMITTED only
 * where committal applies). `applies` says whether the act exists for this case at
 * all, which is different from whether it is available at this stage.
 */
const DEFINITIONS = Object.freeze({
  [CASE_ACTION.FILE_CHARGESHEET]: {
    authority: AUTHORITY.POLICE,
    label: 'File the chargesheet',
    description:
      'The investigation is complete. Filing registers the case with the court the jurisdiction router selects and fixes the investigative record.',
    from: () => WRITABLE_CASE_STAGES,
    to: CASE_STAGE.CHARGESHEET_FILED,
  },
  [CASE_ACTION.TAKE_COGNIZANCE]: {
    authority: AUTHORITY.COURT,
    label: 'Take cognizance',
    description:
      'The court receives the chargesheet, reviews the case file and evidence, and takes cognizance of the offence (BNSS s.210).',
    from: () => [CASE_STAGE.CHARGESHEET_FILED],
    to: CASE_STAGE.COGNIZANCE_TAKEN,
    requiresCourtListing: true,
  },
  [CASE_ACTION.COMMIT_FOR_TRIAL]: {
    authority: AUTHORITY.COURT,
    label: 'Commit to the Court of Session',
    description:
      'The offence is triable by a Court of Session, so the case is committed for trial after cognizance (BNSS s.232).',
    from: () => [CASE_STAGE.COGNIZANCE_TAKEN],
    to: CASE_STAGE.COMMITTED,
    applies: (c) => requiresCommittal(c),
    notApplicable: 'This offence is triable by a Magistrate, so no committal is required.',
    requiresCourtListing: true,
  },
  [CASE_ACTION.BEGIN_TRIAL]: {
    authority: AUTHORITY.COURT,
    label: 'Frame charges and begin trial',
    description: 'Charges are framed and the trial begins.',
    from: (c) => (requiresCommittal(c) ? [CASE_STAGE.COMMITTED] : [CASE_STAGE.COGNIZANCE_TAKEN]),
    to: CASE_STAGE.TRIAL,
    requiresCourtListing: true,
  },
  [CASE_ACTION.DIRECT_FURTHER_INVESTIGATION]: {
    authority: AUTHORITY.COURT,
    label: 'Direct further investigation',
    description:
      'The court sends the case back to the police for further investigation. The police file re-opens and a fresh chargesheet returns it to the court.',
    from: () => [CASE_STAGE.COGNIZANCE_TAKEN],
    to: CASE_STAGE.FURTHER_INVESTIGATION,
    requiresNote: true,
    requiresCourtListing: true,
  },
  [CASE_ACTION.CLOSE_CASE]: {
    authority: AUTHORITY.COURT,
    label: 'Close the case',
    description:
      'Judgment, discharge or withdrawal. The case is closed; every exhibit, certificate and ledger entry stays readable and nothing further can be recorded.',
    from: () => [CASE_STAGE.COGNIZANCE_TAKEN, CASE_STAGE.COMMITTED, CASE_STAGE.TRIAL],
    to: CASE_STAGE.CLOSED,
    requiresNote: true,
    requiresCourtListing: true,
  },
});

/** The acts the court is prompted to take next, in the order they happen. */
const COURT_PROGRESSION = [
  CASE_ACTION.TAKE_COGNIZANCE,
  CASE_ACTION.COMMIT_FOR_TRIAL,
  CASE_ACTION.BEGIN_TRIAL,
  CASE_ACTION.CLOSE_CASE,
];

/**
 * Evaluate one act against one case.
 *
 * @returns {{ ok: boolean, action: string, to: string|null, code: string|null, message: string|null,
 *             requiresNote: boolean, authority: string|null, label: string|null, description: string|null }}
 */
export function evaluateTransition(caseDoc, action) {
  const def = DEFINITIONS[action];
  if (!def) {
    return { ok: false, action, to: null, code: 'UNKNOWN_CASE_ACTION', message: 'No such case action', requiresNote: false, authority: null, label: null, description: null };
  }
  const base = {
    action,
    to: def.to,
    requiresNote: Boolean(def.requiresNote),
    authority: def.authority,
    label: def.label,
    description: def.description,
  };

  if (CLOSED_CASE_STAGES.includes(caseDoc.stage)) {
    return { ...base, ok: false, code: 'CASE_IS_CLOSED', message: 'The case is closed; nothing further can be recorded.' };
  }
  if (def.applies && !def.applies(caseDoc)) {
    return { ...base, ok: false, code: 'TRANSITION_NOT_APPLICABLE', message: def.notApplicable };
  }
  const from = def.from(caseDoc);
  if (!from.includes(caseDoc.stage)) {
    return {
      ...base,
      ok: false,
      code: 'INVALID_TRANSITION',
      message: `“${def.label}” is only possible from ${from.map((s) => STAGE_LABEL[s]).join(' or ')}; this case is at ${STAGE_LABEL[caseDoc.stage] ?? caseDoc.stage}.`,
    };
  }
  if (def.requiresCourtListing && (!caseDoc.courtId || !caseDoc.cnrNumber)) {
    return { ...base, ok: false, code: 'CASE_NOT_LISTED', message: 'This case is not listed before a court.' };
  }
  return { ...base, ok: true, code: null, message: null };
}

/**
 * The whole workflow picture for a case: the lifecycle strip, every act with whether
 * it is available now, and the next act each authority is expected to take.
 */
export function workflowFor(caseDoc) {
  const committal = requiresCommittal(caseDoc);
  const actions = Object.keys(DEFINITIONS).map((a) => evaluateTransition(caseDoc, a));
  const available = (authority) => actions.filter((x) => x.ok && x.authority === authority);

  const nextCourtAction =
    COURT_PROGRESSION.map((a) => actions.find((x) => x.action === a)).find((x) => x?.ok) ?? null;
  const nextPoliceAction = available(AUTHORITY.POLICE)[0] ?? null;

  // The strip. FURTHER_INVESTIGATION is drawn on the investigation step, and COMMITTED
  // is marked not-applicable for a Magistrate-triable case rather than left looking
  // like a step that was skipped.
  const order = [
    CASE_STAGE.UNDER_INVESTIGATION,
    CASE_STAGE.CHARGESHEET_FILED,
    CASE_STAGE.COGNIZANCE_TAKEN,
    CASE_STAGE.COMMITTED,
    CASE_STAGE.TRIAL,
    CASE_STAGE.CLOSED,
  ];
  const stageForStrip =
    caseDoc.stage === CASE_STAGE.FURTHER_INVESTIGATION
      ? CASE_STAGE.UNDER_INVESTIGATION
      : caseDoc.stage === CASE_STAGE.DISPOSED
        ? CASE_STAGE.CLOSED
        : caseDoc.stage;
  const current = order.indexOf(stageForStrip);
  const lifecycle = order.map((stage, i) => ({
    stage,
    label: STAGE_LABEL[stage],
    state:
      stage === CASE_STAGE.COMMITTED && !committal
        ? 'not_applicable'
        : i < current
          ? 'done'
          : i === current
            ? 'current'
            : 'upcoming',
  }));

  return {
    stage: caseDoc.stage,
    stageLabel: STAGE_LABEL[caseDoc.stage] ?? caseDoc.stage,
    requiresCommittal: committal,
    lifecycle,
    actions,
    nextCourtAction,
    nextPoliceAction,
    waitingOn: CLOSED_CASE_STAGES.includes(caseDoc.stage)
      ? null
      : nextPoliceAction
        ? AUTHORITY.POLICE
        : nextCourtAction
          ? AUTHORITY.COURT
          : null,
  };
}

export default { evaluateTransition, workflowFor, requiresCommittal, STAGE_LABEL };
