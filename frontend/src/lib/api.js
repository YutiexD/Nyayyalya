/**
 * The API client.
 *
 * # Token handling
 *
 * The access token lives in a module variable first and in `sessionStorage` second.
 * Not `localStorage`: a token in localStorage outlives the tab, survives the browser
 * being closed, and is readable by any script on the origin forever. sessionStorage
 * is per tab — so one browser can hold an officer, an examiner and a court session
 * side by side — and survives reloads. The session itself has no time limit: the
 * 15-minute access token is renewed silently from a refresh token that never expires,
 * so a signed-in tab stays signed in until someone signs out or closes the tab. Tokens are never logged, never put in a
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

/**
 * Anyone who needs to know the session ended.
 *
 * The token layer is deliberately framework-free — it is imported by the crypto and
 * verifier code as well as by React — so instead of reaching into the store it
 * announces, and the store listens. Without this the two disagree after an expiry:
 * `clearSession()` empties sessionStorage while Redux still holds a session object, so
 * the route guard sees a signed-in user and renders a dashboard in which every panel
 * is a TOKEN_EXPIRED error card. The user is then stuck on a page with no way out
 * except to find the sign-out button.
 */
const sessionEndedListeners = new Set();

export function onSessionEnded(listener) {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

export function clearSession() {
  accessToken = null;
  writeStore(ACCESS_KEY, null);
  writeStore(REFRESH_KEY, null);
  writeStore(SESSION_KEY, null);
  for (const listener of sessionEndedListeners) {
    try {
      listener();
    } catch {
      /* a bad listener must not stop the session from being cleared */
    }
  }
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
 * Every refusal shows its code AND one of these sentences. Anything unmapped falls
 * back to the server's own safe message.
 */
export const REASON_TEXT = Object.freeze({
  // --- authorization ---
  NOT_ASSIGNED_IO: 'You are not the investigating officer recorded for this case.',
  OUT_OF_JURISDICTION: 'This case belongs to a station outside your posting.',
  CASE_STAGE_CLOSED_TO_WRITES: 'This case has moved past investigation, so it is closed to new entries.',
  CASE_IS_CLOSED: 'The court has closed this case. It stays readable, but nothing further can be recorded.',
  READ_ONLY_ROLE: 'Your role may read this record but may not change it.',
  CASE_NOT_LISTED_IN_YOUR_COURT: 'This case is not before a court in your district yet.',
  NO_OPEN_REFERRAL_TO_YOUR_LAB: 'This exhibit is outside your laboratory.',
  NOT_ON_RECORD_FOR_THIS_CASE:
    'You are not on record for this case. Access starts when the court accepts your vakalatnama.',
  GRANT_REVOKED: 'Your access to this case has been revoked.',
  GRANT_NOT_YET_VALID: 'Your access to this case has not started yet.',
  GRANT_EXPIRED: 'Your access to this case has expired.',
  RESOURCE_NOT_FOUND: 'No such record, or none you are entitled to see.',
  NO_MATCHING_POLICY: 'Your role has no access to this record.',
  USER_NOT_ACTIVE: 'This account is not active.',
  AUDIT_NOT_PERMITTED: 'Your role cannot read the audit feed.',
  AUDIT_UNAVAILABLE: 'The audit trail cannot be written right now, so this action is refused. Try again shortly.',
  SEARCH_UNAVAILABLE: 'Search is unavailable. Nothing was searched, so this is not a "no results" answer.',

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
  HASH_FAILED: 'The file could not be read in this browser, so nothing was uploaded.',
  SIGNING_FAILED: 'This browser could not sign the file, so nothing was uploaded.',
  HASH_MISMATCH: 'The file that arrived does not match the fingerprint taken in your browser. The upload was refused.',
  SIGNATURE_INVALID: 'The signature does not match the key registered to this account. The upload was refused.',
  NO_REGISTERED_KEY: 'No signing key is registered for this account on this device.',
  MIME_TYPE_NOT_ALLOWED: 'That file type is not accepted as evidence.',
  MIME_TYPE_MISMATCH: 'The file contents do not match the type it claims to be.',
  PAYLOAD_TOO_LARGE: 'That file is larger than this deployment accepts.',
  VALIDATION_FAILED: 'The request was not in the form the server accepts.',
  ROUTE_NOT_FOUND: 'That endpoint is not available on this server.',

  // --- representation (vakalatnama) ---
  CNR_NOT_FOUND: 'No case before a court carries that CNR number.',
  VAKALATNAMA_ALREADY_FILED: 'A filing for this appearance is already before the court.',
  VAKALATNAMA_ALREADY_ON_RECORD: 'You are already on record for this party in this case.',
  VAKALATNAMA_WITHDRAWN: 'This filing has been withdrawn.',
  LEGAL_AID_ASSIGNMENT_CLOSED: 'This legal aid assignment is closed.',
  ALREADY_ON_RECORD: 'You are already on record for this party in this case.',
  DOCUMENT_MUST_BE_PDF: 'The vakalatnama must be a PDF.',
  DOCUMENT_HASH_MISMATCH: 'The document that arrived does not match the fingerprint taken in your browser.',
  COURT_REGISTER_REFUSED: 'The court register did not record this appearance. The filing is still pending.',
  VAKALATNAMA_NOT_PENDING: 'This filing has already been ruled on.',
  ADVOCATE_NOT_ACTIVE: 'The filing advocate no longer holds an active account.',

  // --- forensic laboratory ---
  REFERRAL_NOT_ACCEPTED: 'Accept the referral before filing a report, or a report is already filed.',
  REFERRAL_NOT_OPEN: 'Only an open referral can be accepted.',
  REPORT_MUST_BE_PDF: 'A forensic report must be a PDF.',
  VERDICT_HASH_MISMATCH: 'The verdict that arrived does not match what was signed. Record it again.',
  REPORT_HASH_MISMATCH: 'The report that arrived does not match the fingerprint taken in your browser.',
  DUPLICATE_LIVE_REFERRAL: 'This exhibit is already referred to that laboratory.',
  LAB_NOT_FOUND: 'No such laboratory.',
  DISCIPLINE_NOT_OFFERED: 'That laboratory does not run this discipline.',
  VERDICT_ALREADY_RECORDED: 'An FSL verdict is already recorded for this exhibit.',

  // --- certificates ---
  CERTIFICATE_NOT_FOUND: 'No certificate matches this link.',
  LABEL_NOT_FOUND: 'No exhibit matches this label.',
  CERTIFICATE_DOCUMENT_UNAVAILABLE: 'The certificate PDF is not available right now.',
  CERTIFICATE_PDF_CORRUPT: 'The stored certificate PDF failed its integrity check.',
  CERTIFICATE_VERIFICATION_FAILED: 'The certificate did not verify.',
  CERTIFICATE_SUPERSEDED: 'This certificate has been replaced by a newer one.',
  EVIDENCE_HAS_NO_HASH: 'This exhibit has no recorded fingerprint, so no certificate can be issued for it.',

  // --- AI analysis ---
  AI_ANALYSIS_NOT_RETRYABLE: 'Only a failed analysis can be retried.',
  AI_ANALYSIS_FAILED: 'The AI analysis did not complete.',
  AI_NOT_CONFIGURED: 'AI analysis is not configured on this server.',
  AI_INVALID_API_KEY: 'AI analysis is misconfigured on this server. Tell an operator.',
  AI_PERMISSION_DENIED: 'AI analysis is misconfigured on this server. Tell an operator.',
  AI_MODEL_NOT_FOUND: 'AI analysis is misconfigured on this server. Tell an operator.',
  AI_UNAVAILABLE: 'The AI analysis service is unavailable. Retry later.',
  AI_TIMEOUT: 'The AI analysis timed out. Retry later.',
  AI_RATE_LIMITED: 'The AI analysis service is busy. Retry in a few minutes.',
  AI_UNSUPPORTED_FORMAT: 'This file type cannot be analysed.',
  AI_FILE_TOO_LARGE: 'This file is too large to analyse.',
  AI_PAYLOAD_TOO_LARGE: 'This file is too large to analyse.',
  AI_RESPONSE_BLOCKED: 'The AI analysis declined to assess this file.',
  AI_EMPTY_RESPONSE: 'The AI analysis returned no result. Retry.',
  AI_INVALID_JSON: 'The AI analysis returned an unusable result. Retry.',
  AI_PARTIAL_RESPONSE: 'The AI analysis returned an incomplete result. Retry.',
  AI_RESPONSE_SCHEMA_INVALID: 'The AI analysis returned an unusable result. Retry.',
  AI_RESPONSE_INCOHERENT: 'The AI analysis returned an inconsistent result. Retry.',
  AI_INVALID_REQUEST: 'The analysis request was rejected. Retry.',

  // --- judicial workflow ---
  INVALID_TRANSITION: 'That judicial step is not available at the stage this case is in.',
  TRANSITION_NOT_APPLICABLE: 'That step does not apply to this case.',
  NOTE_REQUIRED: 'Record the reason for this order.',
  NO_COURT_LISTING: 'The court directory has no listing for this FIR yet.',
  NO_COURT_FOR_JURISDICTION: 'No court in this district can take this case. Escalate to the District Judge.',
  COURT_REGISTRATION_REFUSED: 'The court registry did not register this chargesheet.',
  SIMULATED_FILING_DISABLED: 'The court registry simulator is switched off in this environment.',
  CLOSURE_DOCUMENT_NOT_PDF: 'The closing document must be a PDF.',
  CLOSURE_DOCUMENT_TOO_LARGE: 'The closing document is larger than 20 MB.',
  CLOSURE_DOCUMENT_KIND_REQUIRED: 'Say whether the document is a final judgment, a declaration or an order.',
  CLOSURE_DOCUMENT_HASH_MISMATCH:
    'The document that arrived does not match the fingerprint taken in your browser. The case was not closed.',
  CLOSURE_DOCUMENT_NOT_FOUND: 'No closing document was filed with this case.',
  CLOSURE_DOCUMENT_UNAVAILABLE: 'The closing document is not available right now.',
  CLOSURE_DOCUMENT_CORRUPT: 'The stored closing document failed its integrity check.',
  CLOSURE_NOT_SIGNED: 'This browser could not sign the document, so the case was not closed.',

  // --- cases ---
  FIR_NOT_FOUND: 'The police directory holds no FIR with that number.',
  CASE_ALREADY_EXISTS: 'A case has already been opened from this FIR.',
  INVALID_STAGE: 'That step is not available at the stage this case is in.',
  CONCURRENT_UPDATE: 'Someone else changed this record at the same moment. Refresh and try again.',
  CASE_NOT_LISTED: 'This case is not listed before a court yet.',
  EVIDENCE_NOT_IN_CASE: 'That exhibit does not belong to this case.',
  EVIDENCE_NOT_FOUND: 'No such exhibit.',

  // --- evidence and downloads ---
  FILE_REQUIRED: 'Choose a file first.',
  CASE_NOT_FOUND: 'No such case.',
  CASE_MISMATCH: 'The case on the form does not match the case being written to.',
  STREAM_TOKEN_INVALID: 'That download link has expired or was already used. Open the file again.',
  STREAM_TOKEN_REQUIRED: 'A download link is required.',
  STREAM_TOKEN_WRONG_USER: 'That download link was issued to someone else.',
  STREAM_TOKEN_WRONG_RESOURCE: 'That download link is for a different item.',
  OBJECT_NOT_FOUND: 'The stored file is missing. The register still holds its fingerprint and history.',

  // --- session ---
  TOKEN_EXPIRED: 'Your session has expired. Sign in again.',
  TOKEN_INVALID: 'Your session is not valid. Sign in again.',
  REFRESH_INVALID: 'Your session has ended. Sign in again.',
  REFRESH_REUSED: 'Your session was ended for security reasons. Sign in again.',
  REFRESH_EXPIRED: 'Your session has expired. Sign in again.',
  SESSION_USER_MISSING: 'Your session is not valid. Sign in again.',
  INVALID_IDENTIFIER: 'That identifier is not in a form this system accepts.',
  MALFORMED_JSON: 'The request could not be read.',
  LIMIT_FILE_SIZE: 'That file is larger than this deployment accepts.',
  LIMIT_UNEXPECTED_FILE: 'The file was attached under the wrong field.',
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
export async function refreshSession() {
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
      .catch((err) => {
        // Only the server saying "this session is over" ends it. A network blip, an API
        // restart, a rate limit or a briefly unreachable directory must not sign anyone
        // out — the next request simply tries again.
        const ended = err instanceof ApiError && (err.status === 401 || err.status === 403);
        if (ended) clearSession();
        return false;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

const ANSWERS_NOT_EXPIRY = new Set([
  'BAD_CREDENTIALS',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_ATTEMPTS_EXCEEDED',
]);

export async function request(path, options = {}) {
  try {
    return await send(path, options);
  } catch (err) {
    // A 401 that is an ANSWER about what was submitted — a wrong password, a wrong or
    // expired one-time code — is not an expired session. Refreshing and replaying one
    // of those spent a second OTP attempt on every wrong code at "Register this device".
    const expired =
      err instanceof ApiError &&
      err.status === 401 &&
      options.auth !== false &&
      !ANSWERS_NOT_EXPIRY.has(err.code);

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
  const attempt = async () => {
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
  };

  try {
    return await attempt();
  } catch (err) {
    // Binary downloads go through the same one-shot refresh as every other request.
    // They did not, which made the certificate PDF the single action in the product
    // that hard-failed once the 15-minute access token expired — on a screen the user
    // had been sitting on, reading, for exactly that long.
    if (err instanceof ApiError && err.status === 401 && (await refreshSession())) {
      return attempt();
    }
    throw err;
  }
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
    /**
     * Register THIS browser's signing key against the account.
     *
     * Needed whenever the key held here is not the one the server has on record —
     * a new machine, a cleared browser, or a demo account activated elsewhere.
     * Until it is called, every upload from this browser is refused with
     * SIGNATURE_INVALID, because the server verifies against the registered key.
     */
    rotateKey: (payload) => post('/api/auth/rotate-key', payload),
  },

  cases: {
    list: (query) => get('/api/cases', query),
    get: (id) => get(`/api/cases/${id}`),
    /** By CNR — the number an advocate has. Audited either way, like any case read. */
    byCnr: (cnr) => get(`/api/cases/by-cnr/${encodeURIComponent(cnr)}`),
    fromFir: (firNumber) => post('/api/cases/from-fir', { firNumber }),
    timeline: (id) => get(`/api/cases/${id}/timeline`),
    computeJurisdiction: (id) => post(`/api/cases/${id}/compute-jurisdiction`, {}),
    fileChargesheet: (id) => post(`/api/cases/${id}/file-chargesheet`, {}),
    /** Where the case stands and every act that can move it now (server state machine). */
    workflow: (id) => get(`/api/cases/${id}/workflow`),
    /** The case grouped for a dashboard: exhibits, pending actions, activity. */
    overview: (id) => get(`/api/cases/${id}/overview`),
    /** A judicial act — TAKE_COGNIZANCE, COMMIT_FOR_TRIAL, BEGIN_TRIAL, DIRECT_FURTHER_INVESTIGATION, CLOSE_CASE. */
    transition: (id, action, note) => post(`/api/cases/${id}/transition`, { action, ...(note ? { note } : {}) }),
    /**
     * CLOSE_CASE with a signed document. Multipart: `action`, `note`, `document` (PDF),
     * `documentKind`, `documentSha256`, `documentSignature`.
     */
    transitionWithDocument: (id, form) => postForm(`/api/cases/${id}/transition`, form),
    /** The judgment / declaration / order filed when the case was closed. Audited download. */
    closureDocumentBlob: (id) => fetchBlob(`/api/cases/${id}/closure-document`),
    recordOrder: (id, payload) => post(`/api/cases/${id}/record-order`, payload),
    /** The court's final act. Nothing is deleted; the case becomes read-only. */
    close: (id, reason) => post(`/api/cases/${id}/close`, { reason }),
  },

  evidence: {
    list: (query) => get('/api/evidence', query),
    get: (id) => get(`/api/evidence/${id}`),
    /** By register code (EX-…). Audited either way, like any exhibit read. */
    byCode: (code) => get(`/api/evidence/by-code/${encodeURIComponent(code)}`),
    /**
     * Multipart: `file, caseId, title, sha256Client, signature` and optional
     * `description`. Responds `{ evidence, receipt, certificate }`; the s.63
     * certificate is issued by the server as part of the upload.
     */
    upload: (form) => postForm('/api/evidence/upload', form),
    verify: (id) => post(`/api/evidence/${id}/verify`, {}),
    /** `{ evidenceId, exhibitCode, lifecycle }` — each step with who, when and the proof. */
    lifecycle: (id) => get(`/api/evidence/${id}/lifecycle`),
    triageQueue: (query) => get('/api/evidence/queue/triage', query),
    /** Re-queue a failed AI analysis. FSL only. */
    retryAiAnalysis: (id) => post(`/api/evidence/${id}/ai-analysis/retry`, {}),
    referFsl: (id, payload) => post(`/api/evidence/${id}/refer-fsl`, payload),
    /**
     * A laboratory's verdict on an exhibit, in one step. Multipart: the report document
     * is optional, the browser signature over `verdictSha256` is not.
     */
    recordVerdict: (id, form) => postForm(`/api/evidence/${id}/forensic-verdict`, form),
    streamToken: (id) => post(`/api/evidence/${id}/stream-token`, {}),
    streamUrl: (id, token) => `/api/evidence/${id}/stream?token=${encodeURIComponent(token)}`,
    /**
     * The exhibit's decrypted bytes: mint a single-use, user-bound token, then spend it
     * on an authenticated fetch. Both halves are audited as a DOWNLOAD.
     */
    fileBlob: async (id) => {
      const { token } = await post(`/api/evidence/${id}/stream-token`, {});
      return fetchBlob(`/api/evidence/${id}/stream?token=${encodeURIComponent(token)}`);
    },
  },

  fsl: {
    /** The examiner's review queue. `state` is PENDING (default), REVIEWED or ALL. */
    queue: (query) => get('/api/fsl/queue', query),
    /** The laboratory's work grouped by case, exhibits ordered by review priority. */
    cases: (query) => get('/api/fsl/cases', query),
    referrals: (query) => get('/api/fsl/referrals', query),
    accept: (id) => post(`/api/fsl/referrals/${id}/accept`, {}),
    report: (id, form) => postForm(`/api/fsl/referrals/${id}/report`, form),
  },

  vakalatnama: {
    /** Multipart: `document` (the signed PDF) + cnrNumber, appearingFor, partyName, hash, signature. */
    file: (form) => postForm('/api/vakalatnama', form),
    mine: () => get('/api/vakalatnama/mine'),
    forCase: (caseId) => get(`/api/vakalatnama/case/${caseId}`),
    documentBlob: (id) => fetchBlob(`/api/vakalatnama/${id}/document`),
    /** Puts the advocate on record; the response carries `access: 'CASE_AND_EXHIBITS_READ_ONLY'`. */
    accept: (id) => post(`/api/vakalatnama/${id}/accept`, {}),
    reject: (id, note) => post(`/api/vakalatnama/${id}/reject`, { note }),
  },

  disclosure: {
    /**
     * The case and every exhibit in it, for counsel on record (and anyone else who may
     * read the case). Nothing is shared by hand: acceptance of the vakalatnama is the grant.
     */
    caseFile: (caseId) => get(`/api/disclosure/case-file/${caseId}`),
    /** Court: mirror accepted appearances from the court register into access grants. */
    syncRepresentation: (caseId) => post(`/api/disclosure/${caseId}/sync-representation`, {}),
  },

  certificates: {
    get: (id) => get(`/api/certificates/${id}`),
    /** `{ evidenceId, exhibitCode, active, certificates, total }` — never more visible than the exhibit. */
    forEvidence: (evidenceId) => get('/api/certificates', { evidenceId }),
    /** An authenticated, audited DOWNLOAD, so it is fetched as a blob rather than linked. */
    pdfBlob: (id) => fetchBlob(`/api/certificates/${id}/pdf`),
    /** One-click verification: `{ result: 'VERIFIED'|'FAILED', verifiedAt, checks }`. Audited. */
    verify: (id) => post(`/api/certificates/${id}/verify`, {}),
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

  /**
   * PUBLIC. No session, no Authorization header — that is the point.
   *
   * `copySha256` is the digest of a PDF the caller holds, hashed in the browser. Only
   * the digest leaves the machine.
   */
  publicVerifyCertificate: (token, copySha256) =>
    request(`/public/verify/${encodeURIComponent(token)}`, {
      auth: false,
      query: copySha256 ? { copy: copySha256 } : undefined,
    }),
  /** The exhibit behind a printed QR label: same result shape as the certificate check. */
  publicEvidenceByLabel: (labelToken) =>
    request(`/public/evidence/${encodeURIComponent(labelToken)}`, { auth: false }),
  publicLatestAnchor: () => request('/api/anchors/latest', { auth: false }),
  publicRecentAnchors: (limit = 8) => request('/api/anchors/recent', { auth: false, query: { limit } }),
  /** An officer's upload receipt, checked against the register and the anchored root. */
  publicVerifyReceipt: (seq, entryHash) =>
    request(`/api/anchors/entry/${encodeURIComponent(seq)}/${encodeURIComponent(entryHash)}`, {
      auth: false,
    }),
};

// ------------------------------------------------------------ role routing ----

/**
 * Which view each directory-derived role lands on after sign-in.
 *
 * Routes now, not filenames: the client is a single-page app, so navigation goes
 * through the router rather than `location.replace`. Keeping this map here — beside
 * the session it describes — means the router, the guard and the sign-in redirect all
 * read the same table.
 */
export const HOME_FOR_ROLE = Object.freeze({
  IO: '/officer',
  SHO: '/station',
  DISTRICT_SP: '/station',
  COURT: '/court',
  FSL_EXAMINER: '/lab',
  DEFENCE_COUNSEL: '/counsel',
  VICTIM_COUNSEL: '/counsel',
  LEGAL_AID_COUNSEL: '/counsel',
  PUBLIC_PROSECUTOR: '/counsel',
});

/** What each role is called on screen. The enum name is never shown to a user. */
export const ROLE_LABEL = Object.freeze({
  IO: 'Investigating Officer',
  SHO: 'Station House Officer',
  DISTRICT_SP: 'District SP',
  COURT: 'Court',
  FSL_EXAMINER: 'Forensic Examiner',
  DEFENCE_COUNSEL: 'Defence Counsel',
  VICTIM_COUNSEL: 'Victim Counsel',
  LEGAL_AID_COUNSEL: 'Legal Aid Counsel',
  PUBLIC_PROSECUTOR: 'Public Prosecutor',
});

/** Every role that may reach a given route, derived from the map above. */
export const ROLES_FOR_ROUTE = Object.freeze(
  Object.entries(HOME_FOR_ROLE).reduce((acc, [role, route]) => {
    (acc[route] ??= []).push(role);
    return acc;
  }, {})
);

/**
 * End the session.
 *
 * The server call is best-effort: the refresh token is revoked there, but the local
 * session is cleared either way. A logout that fails silently and leaves a token in
 * the tab would be worse than one that fails loudly.
 */
export async function signOut() {
  try {
    await api.auth.logout();
  } catch {
    /* the local session is cleared regardless */
  }
  clearSession();
}
