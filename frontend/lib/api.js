/**
 * The API client.
 *
 * # Token handling
 *
 * The access token lives in a module variable first and in `sessionStorage` second.
 * Not `localStorage`: a token in localStorage outlives the tab, survives the browser
 * being closed, and is readable by any script on the origin forever. sessionStorage
 * is cleared when the tab closes, which is the right lifetime for a 15-minute
 * credential on a shared station machine. Tokens are never logged, never put in a
 * URL, and never rendered.
 *
 * # Errors
 *
 * Every failure becomes an `ApiError` carrying the server's stable `code` (which is
 * the resolver's denial reason on a 403) plus its safe message and details. Pages
 * render the code AND a plain-English explanation — a denial the user cannot
 * understand is a bug, not a security feature.
 */

const ACCESS_KEY = 'lexx.access';
const REFRESH_KEY = 'lexx.refresh';
const SESSION_KEY = 'lexx.session';

let accessToken = null;
let refreshInFlight = null;

// ---------------------------------------------------------------- session ----

const readStore = (key) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStore = (key, value) => {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* private mode: the session simply does not survive a reload */
  }
};

export function getAccessToken() {
  if (accessToken) return accessToken;
  accessToken = readStore(ACCESS_KEY);
  return accessToken;
}

export function getSession() {
  const raw = readStore(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Store a `{accessToken, refreshToken, user}` response. */
export function setSession({ accessToken: access, refreshToken, user }) {
  accessToken = access ?? null;
  writeStore(ACCESS_KEY, access ?? null);
  if (refreshToken !== undefined) writeStore(REFRESH_KEY, refreshToken ?? null);
  if (user !== undefined) writeStore(SESSION_KEY, user ? JSON.stringify(user) : null);
}

export function clearSession() {
  accessToken = null;
  writeStore(ACCESS_KEY, null);
  writeStore(REFRESH_KEY, null);
  writeStore(SESSION_KEY, null);
}

// ----------------------------------------------------------------- errors ----

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
    this.details = details ?? null;
  }
}

/**
 * Plain-English readings of the codes a user can actually hit.
 *
 * Every denial in this system shows its reason code AND one of these sentences. The
 * codes come from `backend/models/enums.js` DENY_REASON and from the controllers'
 * typed errors; anything unmapped falls back to the server's own safe message.
 */
export const REASON_TEXT = Object.freeze({
  // --- authorization: the resolver's vocabulary ---
  NOT_ASSIGNED_IO: 'You are not the investigating officer recorded for this case.',
  OUT_OF_JURISDICTION: 'This case belongs to a station outside your posting.',
  CASE_STAGE_CLOSED_TO_WRITES:
    'This case has moved past investigation, so it is closed to new entries.',
  CUSTODIAN_SCOPE: 'A malkhana custodian may act only on custody items at their own station.',
  READ_ONLY_ROLE: 'Your role may read this record but may not change it.',
  CASE_NOT_LISTED_IN_YOUR_COURT: 'This case is not listed in the court you are rostered to today.',
  OUT_OF_COURT_SCOPE: 'This record belongs to a different court.',
  NO_OPEN_REFERRAL_TO_YOUR_LAB:
    'This exhibit has not been referred to your laboratory, so it is not yours to examine.',
  NOT_ON_RECORD_FOR_THIS_CASE:
    'You are not on record for this case. A vakalatnama accepted by the registrar, or a legal aid order, puts an advocate on record.',
  GRANT_REVOKED: 'Your authority to act on this case has been revoked.',
  GRANT_NOT_YET_VALID: 'Your authority to act on this case has not started yet.',
  GRANT_EXPIRED: 'Your authority to act on this case has expired.',
  NO_DISCLOSURE_PACK_SERVED:
    'No disclosure pack has been served on you in this case yet. Until the registrar serves one, there is nothing to disclose to you.',
  EXHIBIT_NOT_IN_DISCLOSURE_SET:
    'This exhibit is not part of the disclosure set served on you. Material outside the served set is not accessible, and this attempt has been logged.',
  NOT_CURRENT_HOLDER: 'Only the officer currently holding this item can move it.',
  CUSTODY_FROZEN: 'Custody of this item is frozen after a seal exception. A supervisor must act.',
  IO_CANNOT_HOLD_OWN_CASE_EVIDENCE:
    'The investigating officer cannot be the store keeper for evidence in their own case.',
  RESOURCE_NOT_FOUND: 'No such record, or none you are entitled to see.',
  NO_MATCHING_POLICY: 'No access policy covers this combination of role and record.',
  USER_NOT_ACTIVE: 'This account is not active in Lexx.',
  AUDIT_NOT_PERMITTED: 'Your role cannot read the audit feed.',
  AUDIT_UNAVAILABLE:
    'This action is refused because the audit trail cannot currently be written. Serving disclosure and filing a forensic report are not permitted to happen unrecorded. Tell an operator, and try again once /readyz reports the audit writer healthy.',
  SEARCH_UNAVAILABLE:
    'Search is temporarily unavailable. This is NOT a statement that no records matched — nothing was searched. Do not treat this as an absence of evidence.',

  // --- identity and session ---
  IDENTITY_NOT_VERIFIED:
    'This identity is not present, or not active, in its authority directory. Lexx cannot create an account that the directory does not vouch for.',
  IDENTITY_NOT_IN_DIRECTORY: 'No such identifier exists in the authority directory.',
  IDENTITY_NOT_ACTIVE: 'The directory holds this identity but does not show it as active.',
  DIRECTORY_REVERIFICATION_FAILED:
    'Your authority record no longer permits access. A transfer, suspension or roster change removes access at the next sign-in.',
  DIRECTORY_UNAVAILABLE:
    'The authority directory is unreachable, so access cannot be verified. Lexx fails closed rather than guessing.',
  SELF_REGISTRATION_DISABLED: 'Accounts are provisioned by your authority directory.',
  ACCOUNT_EXISTS: 'This account is already activated. Sign in instead.',
  ACCOUNT_NOT_ACTIVATED: 'This account has not been activated yet.',
  ACCOUNT_LOCKED: 'Too many failed attempts. Try again later.',
  BAD_CREDENTIALS: 'Sign-in failed. Check the identifier, password and code.',
  NOT_AUTHENTICATED: 'Your session has ended. Sign in again.',
  SESSION_STALE: 'Your role changed in the authority directory. Sign in again.',
  OTP_INVALID: 'That code is not valid.',
  OTP_EXPIRED: 'That code has expired. Request a new one.',
  OTP_ATTEMPTS_EXCEEDED: 'Too many attempts on that code. Request a new one.',
  RATE_LIMITED: 'Too many attempts from this machine. Wait and try again.',

  // --- integrity ---
  HASH_MISMATCH:
    'The bytes that arrived do not hash to what your browser computed. The upload was refused and the exception was written to the ledger.',
  SIGNATURE_INVALID:
    'The signature does not verify against the key registered to this account. The upload was refused and the exception was written to the ledger.',
  NO_REGISTERED_KEY: 'No signing key is registered for this account on this device.',
  MIME_TYPE_NOT_ALLOWED: 'That file type is not accepted as evidence.',
  MIME_TYPE_MISMATCH: 'The file contents do not match the type it claims to be.',
  CERTIFICATE_PART_A_INCOMPLETE:
    'Part A cannot be completed from the record, so no certificate was generated. Record the missing particulars and try again.',
  PAYLOAD_TOO_LARGE: 'That file is larger than this deployment accepts.',
  VALIDATION_FAILED: 'The request was not in the form the server accepts.',
  ROUTE_NOT_FOUND: 'That endpoint is not available on this server.',
});

export const explain = (code, fallback) =>
  REASON_TEXT[code] ?? fallback ?? 'The server refused this request.';

// --------------------------------------------------------------- requests ----

function buildUrl(path, query) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function readBody(response) {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

async function send(path, { method = 'GET', json, form, query, auth = true } = {}) {
  const headers = {};
  let body;

  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    // Never set Content-Type for FormData — the browser must add the boundary.
    body = form;
  }

  if (auth) {
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(buildUrl(path, query), { method, headers, body });
  const payload = await readBody(response);

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return payload;
}

/**
 * One transparent refresh attempt on an expired access token. A second failure ends
 * the session rather than looping — an unauthenticated client retrying forever is
 * how a rate limiter gets tripped during a demo.
 */
async function refreshSession() {
  const refreshToken = readStore(REFRESH_KEY);
  if (!refreshToken) return false;

  if (!refreshInFlight) {
    refreshInFlight = send('/api/auth/refresh', {
      method: 'POST',
      json: { refreshToken },
      auth: false,
    })
      .then((result) => {
        setSession(result);
        return true;
      })
      .catch(() => {
        clearSession();
        return false;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export async function request(path, options = {}) {
  try {
    return await send(path, options);
  } catch (err) {
    const expired =
      err instanceof ApiError &&
      err.status === 401 &&
      options.auth !== false &&
      err.code !== 'BAD_CREDENTIALS';

    if (expired && (await refreshSession())) return send(path, options);
    throw err;
  }
}

/**
 * Fetch a binary body (a PDF, a decrypted exhibit) with the session token attached.
 * A `<a href>` cannot carry an Authorization header, and these endpoints are audited
 * downloads rather than public URLs, so the bytes come back through here instead.
 */
export async function fetchBlob(path) {
  const token = getAccessToken();
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const payload = await readBody(response);
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return response.blob();
}

const get = (path, query) => request(path, { method: 'GET', query });
const post = (path, json) => request(path, { method: 'POST', json });
const postForm = (path, form) => request(path, { method: 'POST', form });

// ------------------------------------------------------------- endpoints ----

/**
 * Every server endpoint this client touches, in one place, so drift against
 * `backend/routes/*.js` shows up as one diff rather than twenty.
 */
export const api = {
  auth: {
    verifyIdentity: (authorityId) =>
      request('/api/auth/verify-identity', {
        method: 'POST',
        json: { authorityId },
        auth: false,
      }),
    requestOtp: (authorityId, purpose) =>
      request('/api/auth/request-otp', { method: 'POST', json: { authorityId, purpose }, auth: false }),
    activate: (payload) =>
      request('/api/auth/activate', { method: 'POST', json: payload, auth: false }),
    login: (payload) => request('/api/auth/login', { method: 'POST', json: payload, auth: false }),
    me: () => get('/api/auth/me'),
    logout: () => post('/api/auth/logout', {}),
  },

  cases: {
    list: (query) => get('/api/cases', query),
    get: (id) => get(`/api/cases/${id}`),
    fromFir: (firNumber) => post('/api/cases/from-fir', { firNumber }),
    timeline: (id) => get(`/api/cases/${id}/timeline`),
    computeJurisdiction: (id) => post(`/api/cases/${id}/compute-jurisdiction`, {}),
    fileChargesheet: (id) => post(`/api/cases/${id}/file-chargesheet`, {}),
    recordOrder: (id, payload) => post(`/api/cases/${id}/record-order`, payload),
  },

  evidence: {
    list: (query) => get('/api/evidence', query),
    get: (id) => get(`/api/evidence/${id}`),
    upload: (form) => postForm('/api/evidence/upload', form),
    verify: (id) => post(`/api/evidence/${id}/verify`, {}),
    triageQueue: () => get('/api/evidence/queue/triage'),
    referFsl: (id, payload) => post(`/api/evidence/${id}/refer-fsl`, payload),
    streamToken: (id) => post(`/api/evidence/${id}/stream-token`, {}),
    streamUrl: (id, token) => `/api/evidence/${id}/stream?token=${encodeURIComponent(token)}`,
  },

  custody: {
    create: (payload) => post('/api/custody/items', payload),
    scan: (qrToken) => get(`/api/custody/scan/${encodeURIComponent(qrToken)}`),
    chain: (id) => get(`/api/custody/items/${id}/chain`),
    gaps: (query) => get('/api/custody/gaps', query),
    initiateTransfer: (id, payload) => post(`/api/custody/items/${id}/initiate-transfer`, payload),
    acceptTransfer: (id, payload) => post(`/api/custody/items/${id}/accept-transfer`, payload),
  },

  fsl: {
    referrals: (query) => get('/api/fsl/referrals', query),
    accept: (id) => post(`/api/fsl/referrals/${id}/accept`, {}),
    report: (id, form) => postForm(`/api/fsl/referrals/${id}/report`, form),
  },

  disclosure: {
    prepare: (caseId, payload) => post(`/api/disclosure/${caseId}/prepare`, payload),
    /** Court-side discovery: the packs on a case that the registry has to act on. */
    packsForCase: (caseId, status) =>
      get(`/api/disclosure/case/${caseId}/packs${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    syncRepresentation: (caseId) => post(`/api/disclosure/${caseId}/sync-representation`, {}),
    approve: (packId, payload) => post(`/api/disclosure/${packId}/approve`, payload),
    serve: (packId, payload) => post(`/api/disclosure/${packId}/serve`, payload ?? {}),
    myPack: (caseId) => get(`/api/disclosure/my-pack/${caseId}`),
    acknowledge: (packId) => post(`/api/disclosure/${packId}/acknowledge`, {}),
  },

  certificates: {
    generate: (evidenceId) => post('/api/certificates/generate', { evidenceId }),
    get: (id) => get(`/api/certificates/${id}`),
    /**
     * The PDF is an authenticated, audited DOWNLOAD, so it cannot be reached with a
     * plain `<a href>` — a link carries no Authorization header. It is fetched with
     * the session token and handed to the user as a blob instead.
     */
    pdfBlob: (id) => fetchBlob(`/api/certificates/${id}/pdf`),
  },

  ledger: {
    forCase: (caseId) => get(`/api/ledger/case/${caseId}`),
    verifyChain: (query) => get('/api/ledger/verify-chain', query),
  },

  audit: {
    list: (query) => get('/api/audit', query),
    security: (query) => get('/api/audit/security', query),
  },

  search: (query) => get('/api/search', query),

  /** PUBLIC. No session, no Authorization header — that is the point of both. */
  publicVerifyCertificate: (token) =>
    request(`/public/verify/${encodeURIComponent(token)}`, { auth: false }),
  publicLatestAnchor: () => request('/api/anchors/latest', { auth: false }),
};

// ------------------------------------------------------------ role routing ----

/** Which view each directory-derived role lands on after sign-in. */
export const HOME_FOR_ROLE = Object.freeze({
  IO: 'officer.html',
  SHO: 'sho.html',
  MALKHANA_CUSTODIAN: 'sho.html',
  DISTRICT_SP: 'sho.html',
  JUDGE: 'court.html',
  REGISTRAR: 'court.html',
  EVIDENCE_CUSTODIAN: 'court.html',
  FSL_EXAMINER: 'fsl.html',
  DEFENCE_COUNSEL: 'lawyer.html',
  VICTIM_COUNSEL: 'lawyer.html',
  LEGAL_AID_COUNSEL: 'lawyer.html',
  PUBLIC_PROSECUTOR: 'lawyer.html',
});

/**
 * Page guard. Returns the session or sends the browser to sign in.
 *
 * This is convenience, not security: the server authorises every request on its own
 * and would refuse a hand-edited session object. It exists so a stale tab shows a
 * sign-in page instead of a wall of 401s.
 */
export function requireSession(allowedRoles) {
  const session = getSession();
  if (!session || !getAccessToken()) {
    location.replace(`login.html?next=${encodeURIComponent(location.pathname.split('/').pop())}`);
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    const home = HOME_FOR_ROLE[session.role];
    if (home) location.replace(home);
    return null;
  }
  return session;
}

export async function signOut() {
  try {
    await api.auth.logout();
  } catch {
    /* the local session is cleared either way */
  }
  clearSession();
  location.replace('login.html');
}
