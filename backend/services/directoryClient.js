/**
 * Clients for the three external authority directories.
 *
 * # The rule this file exists to enforce
 *
 * Lexx holds no identities. Officers live in the police directory, judges and
 * registry staff in the court directory, advocates and examiners in the legal/FSL
 * directory. Every role and every scope in a Lexx session is READ FROM HERE and
 * never from a request body.
 *
 * # Failing closed
 *
 * If a directory is unreachable we raise `DirectoryUnavailableError` and the caller
 * denies the operation. We never fall back to cached or assumed authority: the whole
 * point of re-verifying on every login is that a transferred officer or a suspended
 * advocate loses access, and a fallback would reinstate exactly the access we mean
 * to remove.
 */
import axios from 'axios';
import env from '../config/env.js';
import { AUTHORITY, ROLE } from '../models/enums.js';
import { DirectoryUnavailableError, BadRequest } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('directoryClient');

const DIRECTORIES = Object.freeze({
  POLICE: { name: 'police', baseURL: env.DIRECTORY_POLICE_URL },
  COURT: { name: 'court', baseURL: env.DIRECTORY_COURT_URL },
  LEGAL: { name: 'legal', baseURL: env.DIRECTORY_LEGAL_URL },
});

function makeClient({ name, baseURL }) {
  const instance = axios.create({
    baseURL,
    timeout: env.DIRECTORY_TIMEOUT_MS,
    // Directories are read-only sources of truth; we accept only JSON.
    headers: { Accept: 'application/json' },
    // 4xx is a meaningful answer ("no such officer"), not a transport failure.
    validateStatus: (s) => s < 500,
    maxRedirects: 0,
    maxContentLength: 2 * 1024 * 1024,
  });
  instance.__directoryName = name;
  return instance;
}

const clients = {
  POLICE: makeClient(DIRECTORIES.POLICE),
  COURT: makeClient(DIRECTORIES.COURT),
  LEGAL: makeClient(DIRECTORIES.LEGAL),
};

/**
 * GET with bounded retries.
 *
 * Retries only transport failures and 5xx — never a 404, which is a definitive
 * "this person does not exist" and must not be retried into a different answer.
 * Returns `null` for 404 so callers can distinguish "absent" from "unavailable".
 */
async function get(directoryKey, path, config = {}) {
  const client = clients[directoryKey];
  const attempts = env.DIRECTORY_RETRIES + 1;
  let lastError;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await client.get(path, config);
      if (res.status === 404) return null;
      if (res.status >= 400) {
        // A 4xx that is not 404 means we asked wrongly — retrying will not help.
        throw BadRequest(
          'DIRECTORY_REQUEST_REJECTED',
          `The ${client.__directoryName} directory rejected the lookup`,
          { status: res.status }
        );
      }
      return res.data;
    } catch (err) {
      if (err?.status === 400) throw err; // our own BadRequest — do not retry
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  }

  log.warn(
    { directory: client.__directoryName, path, err: lastError?.message },
    'directory lookup failed'
  );
  throw new DirectoryUnavailableError(client.__directoryName, lastError);
}

/** Path segments must never be able to escape their route. */
function seg(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw BadRequest('INVALID_IDENTIFIER', `${label} is not a valid identifier`);
  }
  // Identifiers in this domain are alphanumerics, dash, slash, dot and underscore
  // (e.g. "UP-GZB-4471", "UP/1234/2015", "0123/2026"). Anything else is rejected
  // before it can reach a URL or a query object.
  if (!/^[A-Za-z0-9/_.-]+$/.test(value)) {
    throw BadRequest('INVALID_IDENTIFIER', `${label} contains unsupported characters`);
  }
  if (value.includes('..')) {
    throw BadRequest('INVALID_IDENTIFIER', `${label} contains a path traversal sequence`);
  }
  return value.split('/').map(encodeURIComponent).join('/');
}

// ============================================================ POLICE ============

export const police = {
  /** Officer record, including serviceStatus. */
  getOfficer: (pisId) => get('POLICE', `/directory/officer/${seg(pisId, 'PIS id')}`),

  /** Current posting → station, role, validity window. This is what expires access. */
  getCurrentPosting: (pisId) =>
    get('POLICE', `/directory/officer/${seg(pisId, 'PIS id')}/posting`),

  getStation: (code) => get('POLICE', `/directory/station/${seg(code, 'station code')}`),

  getFir: (firNumber) => get('POLICE', `/directory/fir/${seg(firNumber, 'FIR number')}`),

  listFirs: ({ stationId, ioOfficerId } = {}) =>
    get('POLICE', '/directory/firs', { params: { stationId, ioOfficerId } }),
};

// ============================================================= COURT ===========

export const court = {
  getJudge: (judgeCode) => get('COURT', `/directory/judge/${seg(judgeCode, 'judge code')}`),

  /**
   * Roster lookup — which court this judge sits in TODAY.
   * Lexx never assigns a judge to a court; it reads the roster the court published.
   */
  getJudgeCourt: (judgeCode) =>
    get('COURT', `/directory/judge/${seg(judgeCode, 'judge code')}/court`),

  getCourt: (code) => get('COURT', `/directory/court/${seg(code, 'court code')}`),

  getListingByFir: (firNumber) =>
    get('COURT', `/directory/listing/by-fir/${seg(firNumber, 'FIR number')}`),

  /** Cases this advocate is on record for, by accepted vakalatnama. */
  getVakalatnamas: (enrolmentNo) =>
    get('COURT', '/directory/vakalatnama', { params: { enrolmentNo: seg(enrolmentNo, 'enrolment number') } }),

  getLegalAidAssignments: (enrolmentNo) =>
    get('COURT', '/directory/legal-aid', { params: { enrolmentNo: seg(enrolmentNo, 'enrolment number') } }),

  getRegistryStaff: (staffCode) =>
    get('COURT', `/directory/registry-staff/${seg(staffCode, 'staff code')}`),
};

// ======================================================== LEGAL / FSL ==========

export const legal = {
  /** Advocate record, including certificate-of-practice validity. */
  getAdvocate: (enrolmentNo) =>
    get('LEGAL', `/directory/advocate/${seg(enrolmentNo, 'enrolment number')}`),

  getLab: (labCode) => get('LEGAL', `/directory/lab/${seg(labCode, 'lab code')}`),

  getExaminer: (examinerCode) =>
    get('LEGAL', `/directory/examiner/${seg(examinerCode, 'examiner code')}`),

  getLegalAidPanel: (district) =>
    get('LEGAL', '/directory/legal-aid-panel', { params: { district } }),
};

// ==================================================== identity resolution =====

/** Map a directory posting role onto a Lexx role. Unknown postings are refused. */
const POSTING_ROLE_TO_LEXX = Object.freeze({
  IO: ROLE.IO,
  SHO: ROLE.SHO,
  MALKHANA_CUSTODIAN: ROLE.MALKHANA_CUSTODIAN,
  DISTRICT_SP: ROLE.DISTRICT_SP,
});

const REGISTRY_ROLE_TO_LEXX = Object.freeze({
  REGISTRAR: ROLE.REGISTRAR,
  EVIDENCE_CUSTODIAN: ROLE.EVIDENCE_CUSTODIAN,
});

/**
 * Resolve an authority id to a verified identity, role and scope.
 *
 * All five lookups run in parallel and we require EXACTLY ONE match. Guessing the
 * directory from the identifier's shape would be brittle, and — worse — an
 * identifier that matched in two directories would otherwise resolve to whichever
 * we happened to try first. Ambiguity is refused instead.
 *
 * @returns {Promise<null | {
 *   authority: string, role: string, name: string, scope: object,
 *   phone: string|null, active: boolean, inactiveReason: string|null, raw: object
 * }>} null when no directory knows this identifier.
 */
export async function resolveIdentity(authorityId) {
  if (typeof authorityId !== 'string' || !authorityId.trim()) {
    throw BadRequest('INVALID_IDENTIFIER', 'authorityId is required');
  }
  const id = authorityId.trim();

  const [officer, judge, registryStaff, advocate, examiner] = await Promise.all([
    probe(() => police.getOfficer(id)),
    probe(() => court.getJudge(id)),
    probe(() => court.getRegistryStaff(id)),
    probe(() => legal.getAdvocate(id)),
    probe(() => legal.getExaminer(id)),
  ]);

  const matches = [
    officer && 'OFFICER',
    judge && 'JUDGE',
    registryStaff && 'REGISTRY',
    advocate && 'ADVOCATE',
    examiner && 'EXAMINER',
  ].filter(Boolean);

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    // Two authorities claiming one identifier is a data-integrity problem in the
    // directories. Resolving it arbitrarily could hand someone the wrong authority.
    log.error({ authorityId: id, matches }, 'ambiguous identity across directories');
    throw BadRequest(
      'AMBIGUOUS_IDENTITY',
      'This identifier is claimed by more than one authority directory'
    );
  }

  if (officer) return resolveOfficer(id, officer);
  if (judge) return resolveJudge(id, judge);
  if (registryStaff) return resolveRegistryStaff(id, registryStaff);
  if (advocate) return resolveAdvocate(id, advocate);
  return resolveExaminer(id, examiner);
}

/**
 * Run one identity probe, distinguishing "this directory has no such person" from
 * "this directory is broken or down".
 *
 * Each directory validates identifiers against its OWN format — a PIS number like
 * `UP-GZB-4471` is not a well-formed Bar Council enrolment number, so the legal
 * directory answers 400. When we are probing all five in parallel, that 400 means
 * exactly "not mine", and must not abort the whole resolution.
 *
 * A directory being unreachable is different in kind: we cannot know whether the
 * person exists, so it propagates and the caller fails closed with a 503.
 */
async function probe(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) throw err;
    // 400 from a format check = this identifier does not belong to this directory.
    if (err?.status === 400) {
      log.debug({ code: err.code }, 'identifier not valid for this directory; treating as absent');
      return null;
    }
    throw err;
  }
}

async function resolveOfficer(authorityId, officer) {
  const inactive =
    officer.serviceStatus !== 'ACTIVE' ? `OFFICER_${officer.serviceStatus}` : null;

  const response = await police.getCurrentPosting(authorityId);
  if (!response) {
    return base(AUTHORITY.POLICE, null, officer.name, {}, officer.phone, false, 'NO_CURRENT_POSTING', { officer });
  }

  // The directory returns { officer, posting, station, asOf } and reports whether the
  // posting is current rather than deciding access. Lexx makes the decision.
  const posting = response.posting ?? response;
  const station = response.station ?? null;

  // Trust the directory's own `isCurrent` where it is given, but re-derive from the
  // validity window too — the decision to refuse access should not depend on an
  // upstream service having computed a boolean correctly.
  const now = new Date();
  const validFrom = posting.validFrom ? new Date(posting.validFrom) : null;
  const validTo = posting.validTo ? new Date(posting.validTo) : null;

  let postingProblem = null;
  if (validFrom && validFrom > now) postingProblem = 'POSTING_NOT_YET_VALID';
  else if (validTo && validTo < now) postingProblem = 'POSTING_EXPIRED';
  else if (posting.isCurrent === false) postingProblem = 'POSTING_NOT_CURRENT';

  const role = POSTING_ROLE_TO_LEXX[posting.role];
  if (!role) {
    return base(
      AUTHORITY.POLICE,
      null,
      officer.name,
      {},
      officer.phone,
      false,
      'UNSUPPORTED_POSTING_ROLE',
      { officer, posting }
    );
  }

  const resolvedStation =
    station ?? (posting.stationCode ? await police.getStation(posting.stationCode) : null);

  return base(
    AUTHORITY.POLICE,
    role,
    officer.name,
    {
      stationCode: resolvedStation?.code ?? posting.stationCode ?? null,
      districtCode: resolvedStation?.districtCode ?? null,
      stateCode: resolvedStation?.stateCode ?? null,
    },
    officer.phone,
    !inactive && !postingProblem,
    inactive ?? postingProblem,
    { officer, posting, station: resolvedStation }
  );
}

async function resolveJudge(authorityId, judge) {
  const inactive = judge.serviceStatus !== 'ACTIVE' ? `JUDGE_${judge.serviceStatus}` : null;

  // The roster decides which court, today. If the judge is not on any current
  // roster they have no court scope, and therefore no case access.
  const courtAssignment = await court.getJudgeCourt(authorityId);
  if (!courtAssignment) {
    return base(AUTHORITY.COURT, ROLE.JUDGE, judge.name, {}, judge.phone, false, 'NOT_ON_CURRENT_ROSTER', { judge });
  }

  const courtRecord = courtAssignment.court ?? courtAssignment;

  return base(
    AUTHORITY.COURT,
    ROLE.JUDGE,
    judge.name,
    {
      courtId: courtRecord.code ?? courtRecord.courtCode ?? null,
      districtCode: courtRecord.districtCode ?? null,
      stateCode: courtRecord.stateCode ?? null,
    },
    judge.phone,
    !inactive,
    inactive,
    { judge, court: courtRecord, roster: courtAssignment.roster ?? null }
  );
}

async function resolveRegistryStaff(authorityId, staff) {
  const inactive = staff.serviceStatus !== 'ACTIVE' ? `REGISTRY_${staff.serviceStatus}` : null;
  const role = REGISTRY_ROLE_TO_LEXX[staff.role];
  if (!role) {
    return base(AUTHORITY.COURT, null, staff.name, {}, staff.phone, false, 'UNSUPPORTED_REGISTRY_ROLE', { staff });
  }

  const courtRecord = staff.court ?? (staff.courtCode ? await court.getCourt(staff.courtCode) : null);

  return base(
    AUTHORITY.COURT,
    role,
    staff.name,
    {
      courtId: courtRecord?.code ?? staff.courtCode ?? null,
      districtCode: courtRecord?.districtCode ?? null,
      stateCode: courtRecord?.stateCode ?? null,
    },
    staff.phone,
    !inactive,
    inactive,
    { staff, court: courtRecord }
  );
}

async function resolveAdvocate(authorityId, advocate) {
  let problem = null;
  if (advocate.status !== 'ACTIVE') problem = `ADVOCATE_${advocate.status}`;
  else if (advocate.copValidTill && new Date(advocate.copValidTill) < new Date()) {
    // An expired certificate of practice means they may not appear. Spec §4.2.
    problem = 'CERTIFICATE_OF_PRACTICE_EXPIRED';
  }

  // Advocates get no jurisdictional scope. Their access is purely per-case, via an
  // accepted vakalatnama or a legal-aid order — see CaseAccessGrant.
  return base(
    AUTHORITY.LEGAL,
    ROLE.DEFENCE_COUNSEL,
    advocate.name,
    {},
    advocate.phone,
    !problem,
    problem,
    { advocate }
  );
}

async function resolveExaminer(authorityId, examiner) {
  const inactive = examiner.status !== 'ACTIVE' ? `EXAMINER_${examiner.status}` : null;
  const lab = examiner.lab ?? (examiner.labCode ? await legal.getLab(examiner.labCode) : null);

  return base(
    AUTHORITY.FSL,
    ROLE.FSL_EXAMINER,
    examiner.name,
    { labId: lab?.labCode ?? examiner.labCode ?? null, stateCode: lab?.stateCode ?? null },
    examiner.phone,
    !inactive,
    inactive,
    { examiner, lab }
  );
}

function base(authority, role, name, scope, phone, active, inactiveReason, raw) {
  return {
    authority,
    role,
    name: name ?? null,
    scope: {
      stationCode: scope.stationCode ?? null,
      districtCode: scope.districtCode ?? null,
      stateCode: scope.stateCode ?? null,
      courtId: scope.courtId ?? null,
      labId: scope.labId ?? null,
    },
    phone: phone ?? null,
    active: Boolean(active && role),
    inactiveReason: inactiveReason ?? null,
    raw,
  };
}

/** Health probe for /healthz. Never throws. */
export async function directoryHealth() {
  const check = async (key) => {
    const started = Date.now();
    try {
      const res = await clients[key].get('/healthz', { timeout: 1500 });
      return { ok: res.status === 200, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: Date.now() - started };
    }
  };
  const [policeH, courtH, legalH] = await Promise.all([check('POLICE'), check('COURT'), check('LEGAL')]);
  return { police: policeH, court: courtH, legal: legalH };
}

export default { police, court, legal, resolveIdentity, directoryHealth };
