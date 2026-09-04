/**
 * The jurisdiction router.
 *
 * A pure function, no ML, ~40 lines of actual logic — and it punches far above its
 * weight, because it shows the reasoning rather than just the answer. The `reasons`
 * array is rendered on screen: a reviewer can check the law against the output.
 *
 * Every input comes from the FIR record in the police directory. Nothing here is
 * client-supplied, so a caller cannot steer which court a case lands in (ADR-014).
 */
import { COURT_TYPE, SENSITIVITY_CLASS } from '../models/enums.js';

/** The threshold at which an offence becomes Sessions-triable. */
const SESSIONS_THRESHOLD_YEARS = 7;

/**
 * @param {object} fir
 * @param {string[]} fir.bnsSections
 * @param {number} fir.maxPunishmentYears
 * @param {string} fir.sensitivityClass
 * @param {boolean} fir.isVictimProtected
 * @param {string} fir.districtCode
 * @returns {{courtType:string, requiredDesignation:string|null, requiresCommittal:boolean, reasons:string[], districtCode:string}}
 */
export function computeJurisdiction({
  bnsSections = [],
  maxPunishmentYears = 0,
  sensitivityClass = SENSITIVITY_CLASS.ORDINARY,
  isVictimProtected = false,
  districtCode = null,
} = {}) {
  const reasons = [];
  let courtType = COURT_TYPE.MAGISTRATE;
  let requiredDesignation = null;

  // The spec's `victimIsMinor` input does not exist on an FIR record; it is derived
  // from the classification the police directory already carries. (ADR-014)
  const victimIsMinor = sensitivityClass === SENSITIVITY_CLASS.POCSO || isVictimProtected;

  if (maxPunishmentYears >= SESSIONS_THRESHOLD_YEARS) {
    courtType = COURT_TYPE.SESSIONS;
    reasons.push(
      `Maximum punishment ${maxPunishmentYears} years — triable by a Court of Session`
    );
  } else {
    reasons.push(
      `Maximum punishment ${maxPunishmentYears} years — triable by a Magistrate`
    );
  }

  // Special-court designations override the ordinary Sessions/Magistrate split.
  if (sensitivityClass === SENSITIVITY_CLASS.POCSO || victimIsMinor) {
    courtType = COURT_TYPE.SPECIAL;
    requiredDesignation = 'POCSO';
    reasons.push('Victim is a minor — POCSO designated court required');
  }
  if (sensitivityClass === SENSITIVITY_CLASS.NDPS) {
    courtType = COURT_TYPE.SPECIAL;
    requiredDesignation = 'NDPS';
    reasons.push('NDPS Act — Special Court required');
  }
  if (sensitivityClass === SENSITIVITY_CLASS.SC_ST) {
    courtType = COURT_TYPE.SPECIAL;
    requiredDesignation = 'SC_ST';
    reasons.push('SC/ST (Prevention of Atrocities) Act — Special Court required');
  }

  const requiresCommittal = courtType === COURT_TYPE.SESSIONS || courtType === COURT_TYPE.SPECIAL;
  if (requiresCommittal) {
    reasons.push('Committal by a Magistrate required before trial');
  }

  if (bnsSections.length) {
    reasons.push(`BNS sections invoked: ${bnsSections.join(', ')}`);
  }

  return { courtType, requiredDesignation, requiresCommittal, reasons, districtCode };
}

/**
 * Forensic visit obligation under BNSS s.176(3): offences punishable by 7 years or
 * more require forensic examination of the scene.
 */
export const forensicVisitRequired = (maxPunishmentYears) =>
  Number(maxPunishmentYears) >= SESSIONS_THRESHOLD_YEARS;

/**
 * Pick the correct court from the directory's list for this district.
 * Returns null when no court matches, which the caller surfaces rather than
 * silently falling back to "any court in the district".
 */
export function selectCourt(courts, { courtType, requiredDesignation }) {
  if (!Array.isArray(courts) || courts.length === 0) return null;

  if (requiredDesignation) {
    const designated = courts.find((c) => (c.designations ?? []).includes(requiredDesignation));
    if (designated) return designated;
    // A required designation that no local court holds is a real-world escalation,
    // not something to paper over by returning an ordinary court.
    return null;
  }
  return courts.find((c) => c.courtType === courtType) ?? null;
}

export default { computeJurisdiction, forensicVisitRequired, selectCourt };
