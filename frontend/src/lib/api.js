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
  CASE_IS_CLOSED:
    'The court has closed this case. It stays readable in full — nothing has been removed — but nothing further can be recorded against it.',
  CUSTODIAN_SCOPE: 'Custody items can only be acted on at the station that holds them.',
  READ_ONLY_ROLE: 'Your role may read this record but may not change it.',
  CASE_NOT_LISTED_IN_YOUR_COURT: 'This case is not listed in the court you are rostered to today.',
  OUT_OF_COURT_SCOPE: 'This record belongs to a different court.',
  NO_OPEN_REFERRAL_TO_YOUR_LAB:
    'This exhibit is outside your laboratory: it has not been referred to you, and it is not registered in the state your laboratory serves.',
  NOT_ON_RECORD_FOR_THIS_CASE:
    'You are not on record for this case. A vakalatnama accepted by the court, or a legal aid order, puts an advocate on record.',
  GRANT_REVOKED: 'Your authority to act on this case has been revoked.',
  GRANT_NOT_YET_VALID: 'Your authority to act on this case has not started yet.',
  GRANT_EXPIRED: 'Your authority to act on this case has expired.',
  NO_DISCLOSURE_PACK_SERVED:
    'The court has not shared the case file with you yet. Until it does, there is nothing here to read.',
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
  CERTIFICATE_NOT_FOUND:
    'No certificate on the register matches that token. An unknown token and a malformed one answer identically here, so the shape of the token space cannot be probed from outside.',
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

  // --- representation (vakalatnama) ---
  CNR_NOT_FOUND:
    'No case before a court carries that CNR number in Lexx. A vakalatnama can only be filed in a case that has been committed to a court.',
  VAKALATNAMA_ALREADY_FILED:
    'A filing for this appearance is already before the court. Wait for it to be ruled on.',
  ALREADY_ON_RECORD: 'You are already on record for this party in this case.',
  DOCUMENT_MUST_BE_PDF: 'The vakalatnama must be filed as a PDF.',
  DOCUMENT_HASH_MISMATCH:
    'The document that arrived does not hash to what your browser computed, so the filing was refused.',
  COURT_REGISTER_REFUSED:
    'The court register did not record this appearance, so nothing changed in Lexx. The filing is still pending.',
  VAKALATNAMA_NOT_PENDING: 'This filing has already been ruled on.',
  ADVOCATE_NOT_ACTIVE: 'The filing advocate no longer holds an active account.',

  // --- forensic laboratory ---
  REFERRAL_NOT_ACCEPTED:
    'The referral must be accepted before a report can be filed — or a report has already been filed on it.',
  REFERRAL_NOT_OPEN: 'Only an open referral can be accepted.',
  REPORT_MUST_BE_PDF: 'A forensic report must be filed as a PDF.',
  VERDICT_HASH_MISMATCH:
    'The digest signed on this device is not the digest of the verdict that arrived, so the verdict was refused. Try recording it again.',
  REPORT_HASH_MISMATCH: 'The report that arrived does not hash to what your browser computed.',
  DUPLICATE_LIVE_REFERRAL: 'This exhibit is already referred to that laboratory and the referral is still live.',
  LAB_NOT_FOUND: 'No such laboratory in the FSL directory.',
  DISCIPLINE_NOT_OFFERED: 'That laboratory does not run this discipline.',

  // --- certificates ---
  NOT_THE_DEPONENT: 'Part A names a different deponent. Only the person whose statement it is can sign it.',
  ALREADY_SIGNED: 'That part of the certificate is already signed.',
  PART_B_NOT_FILED: 'Part B is blank until a laboratory files its report, so there is nothing to sign.',
  NOT_THE_REPORTING_EXAMINER: 'Part B may only be signed by the examiner who filed the report.',

  // --- custody ---
  INVALID_OR_FORGED_TAG: 'That label does not carry a valid Lexx signature. It is not a label this system printed.',
  TRANSFER_TOKEN_INVALID: 'That handover code is not valid for this item.',
  TRANSFER_TOKEN_EXPIRED: 'That handover code has expired. The holder must start the handover again.',
  TRANSFER_WRONG_RECIPIENT: 'This handover was addressed to someone else.',
  TRANSFER_ALREADY_PENDING: 'A handover of this item is already waiting to be accepted.',
  ILLEGAL_CUSTODY_TRANSITION:
    'That is not a lawful next step for this article. Every movement routes through the station store.',
  RECIPIENT_NOT_AVAILABLE: 'That person cannot take custody.',

  // --- disclosure ---
  PACK_ALREADY_SERVED:
    'The court has already shared this case file. Changing what is in it needs a fresh order; serving a newly appointed advocate uses the file that was shared.',
  PACK_NOT_APPROVED: 'The pack must be approved before it can be served.',
  UNAPPROVED_EXCLUSIONS:
    'Every withholding request must be ruled on — approved or refused — before the pack can be served.',
  UNKNOWN_EXCLUSION: 'An approval named an exhibit that was never requested for exclusion on this pack.',
  ALREADY_SERVED: 'Everyone named has already been served this pack.',
  NO_RECIPIENTS_ON_RECORD:
    'No advocate is on record for this case yet. An advocate comes on record when the court accepts their vakalatnama.',
  RECIPIENT_NOT_ON_RECORD: 'A named recipient is not on record for this case.',
  WATERMARK_NOT_FOUND: 'No served copy carries that watermark token.',
  NO_COURT_LISTING: 'The court directory has no listing for this FIR yet, so the chargesheet cannot bind it to a court.',
  NO_COURT_FOR_JURISDICTION:
    'No court in this district holds the designation this case requires, so there is no court to file the chargesheet in. Escalate to the District Judge.',
  COURT_REGISTRATION_REFUSED: 'The court registry did not register this chargesheet.',
  SIMULATED_FILING_DISABLED:
    'The court registry simulator is switched off in this environment, so it cannot register a filing.',

  // --- cases ---
  FIR_NOT_FOUND: 'The police directory holds no FIR with that number.',
  CASE_ALREADY_EXISTS: 'A case has already been opened from this FIR.',
  INVALID_STAGE: 'That step is not available at the stage this case is in.',
  CONCURRENT_UPDATE: 'Someone else changed this record at the same moment. Refresh and try again.',

  // --- disclosure ---
  DISCLOSURE_PACK_LOCKED:
    'The court has already ruled on this pack, so it can no longer be re-prepared. A revised set needs a fresh order.',
  EXCLUDED_ITEM_NOT_IN_CASE: 'An exhibit you asked to withhold does not belong to this case.',
  RECIPIENT_NOT_ACTIVE: 'A recipient on record no longer holds an active account.',
  CASE_NOT_LISTED: 'This case is not listed before a court yet.',
  CONFLICTING_RULING: 'An exclusion cannot be both approved and refused.',
  EXCLUSION_ALREADY_RULED: 'The court has already ruled the other way on this exclusion.',

  // --- custody ---
  CUSTODY_NOT_FROZEN: 'This item is not frozen.',

  // --- evidence and downloads ---
  FILE_REQUIRED: 'Choose a file first.',
  CASE_NOT_FOUND: 'No such case.',
  CASE_MISMATCH: 'The case on the form does not match the case being written to.',
  STREAM_TOKEN_INVALID: 'That download link has expired or was already used. Open the file again.',
  STREAM_TOKEN_REQUIRED: 'A download link is required.',
  STREAM_TOKEN_WRONG_USER: 'That download link was issued to someone else.',
  STREAM_TOKEN_WRONG_RESOURCE: 'That download link is for a different item.',
  OBJECT_NOT_FOUND: 'The stored file is missing. The register still holds its hash and history.',

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
    recordOrder: (id, payload) => post(`/api/cases/${id}/record-order`, payload),
    /**
     * The court's final act. Nothing is deleted: the stage moves to CLOSED, the
     * ledger records who closed it and why, and every exhibit, opinion, certificate
     * and custody record stays exactly where it is.
     */
    close: (id, reason) => post(`/api/cases/${id}/close`, { reason }),
  },

  evidence: {
    list: (query) => get('/api/evidence', query),
    get: (id) => get(`/api/evidence/${id}`),
    /** By register code (EX-…). Audited either way, like any exhibit read. */
    byCode: (code) => get(`/api/evidence/by-code/${encodeURIComponent(code)}`),
    upload: (form) => postForm('/api/evidence/upload', form),
    verify: (id) => post(`/api/evidence/${id}/verify`, {}),
    triageQueue: (query) => get('/api/evidence/queue/triage', query),
    referFsl: (id, payload) => post(`/api/evidence/${id}/refer-fsl`, payload),
    /**
     * A laboratory's verdict on an exhibit, in one step.
     *
     * Multipart, because a report document may travel with it — but the document is
     * optional and the signature is not. `verdictSignature` is made in the browser
     * over `verdictSha256`, which is the digest of a statement the server recomputes
     * from the fields it receives: the opinion cannot be swapped after signing.
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

  custody: {
    create: (payload) => post('/api/custody/items', payload),
    /** The custody register: what this user's scope actually contains. */
    items: (query) => get('/api/custody/items', query),
    scan: (qrToken) => get(`/api/custody/scan/${encodeURIComponent(qrToken)}`),
    chain: (id) => get(`/api/custody/items/${id}/chain`),
    gaps: (query) => get('/api/custody/gaps', query),
    initiateTransfer: (id, payload) => post(`/api/custody/items/${id}/initiate-transfer`, payload),
    acceptTransfer: (id, payload) => post(`/api/custody/items/${id}/accept-transfer`, payload),
    /** SHO only: lift a seal-exception freeze with a recorded decision. */
    liftFreeze: (id, payload) => post(`/api/custody/items/${id}/lift-freeze`, payload),
    /** Named people this item could lawfully be handed to next. */
    recipients: (id) => get(`/api/custody/items/${id}/recipients`),
  },

  fsl: {
    /**
     * The examiner's review queue: every exhibit their laboratory may need to look
     * at, ordered by the review priority computed at ingest. `state` is PENDING
     * (the default, and the work), REVIEWED, or ALL.
     */
    queue: (query) => get('/api/fsl/queue', query),
    referrals: (query) => get('/api/fsl/referrals', query),
    accept: (id) => post(`/api/fsl/referrals/${id}/accept`, {}),
    report: (id, form) => postForm(`/api/fsl/referrals/${id}/report`, form),
    /** Certificates for the referred exhibit — where the examiner signs Part B. */
    certificates: (id) => get(`/api/fsl/referrals/${id}/certificates`),
  },

  vakalatnama: {
    /** Multipart: `document` (the signed PDF) + cnrNumber, appearingFor, partyName, hash, signature. */
    file: (form) => postForm('/api/vakalatnama', form),
    mine: () => get('/api/vakalatnama/mine'),
    forCase: (caseId) => get(`/api/vakalatnama/case/${caseId}`),
    documentBlob: (id) => fetchBlob(`/api/vakalatnama/${id}/document`),
    accept: (id) => post(`/api/vakalatnama/${id}/accept`, {}),
    reject: (id, note) => post(`/api/vakalatnama/${id}/reject`, { note }),
  },

  disclosure: {
    /**
     * THE disclosure route: the court gives the advocates on record the case file.
     * Composes the set, rules on anything withheld and serves it, in one act.
     */
    share: (caseId, payload) => post(`/api/disclosure/${caseId}/share`, payload ?? {}),
    prepare: (caseId, payload) => post(`/api/disclosure/${caseId}/prepare`, payload),
    /** Court-side discovery: the packs on a case that the registry has to act on. */
    packsForCase: (caseId, status) =>
      get(`/api/disclosure/case/${caseId}/packs${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    syncRepresentation: (caseId) => post(`/api/disclosure/${caseId}/sync-representation`, {}),
    approve: (packId, payload) => post(`/api/disclosure/${packId}/approve`, payload),
    serve: (packId, payload) => post(`/api/disclosure/${packId}/serve`, payload ?? {}),
    myPack: (caseId) => get(`/api/disclosure/my-pack/${caseId}`),
    acknowledge: (packId) => post(`/api/disclosure/${packId}/acknowledge`, {}),
    /** Court-only: whose served copy does this watermark token belong to? */
    trace: (token) => get(`/api/disclosure/trace/${encodeURIComponent(token)}`),
  },

  certificates: {
    generate: (evidenceId) => post('/api/certificates/generate', { evidenceId }),
    get: (id) => get(`/api/certificates/${id}`),
    /** Every certificate for one exhibit — never more visible than the exhibit. */
    forEvidence: (evidenceId) => get('/api/certificates', { evidenceId }),
    /**
     * The PDF is an authenticated, audited DOWNLOAD, so it cannot be reached with a
     * plain `<a href>` — a link carries no Authorization header. It is fetched with
     * the session token and handed to the user as a blob instead.
     */
    pdfBlob: (id) => fetchBlob(`/api/certificates/${id}/pdf`),
    /**
     * Part A is signed by the deponent the certificate names; Part B by the examiner
     * who filed the report. Both signatures are produced in the browser over the
     * canonical body hash the GET returns — the private key never leaves the device.
     */
    signPartA: (id, payload) => post(`/api/certificates/${id}/sign-part-a`, payload),
    signPartB: (id, payload) => post(`/api/certificates/${id}/sign-part-b`, payload),
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
  /**
   * `copySha256` is the digest of a PDF the caller holds, hashed in the browser. Only
   * the digest leaves the machine; the register answers whether it is the current
   * document, an earlier version of it, or not this certificate at all.
   */
  publicVerifyCertificate: (token, copySha256) =>
    request(`/public/verify/${encodeURIComponent(token)}`, {
      auth: false,
      query: copySha256 ? { copy: copySha256 } : undefined,
    }),
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
  JUDGE: '/court',
  EVIDENCE_CUSTODIAN: '/court',
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
  JUDGE: 'Presiding Judge',
  EVIDENCE_CUSTODIAN: 'Court Evidence Room',
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
 * Who a scanned custody label can be opened by: everyone who can hold, receive or
 * supervise a physical article. Counsel see custody only through disclosure. The
 * server decides per item regardless — this only keeps the route out of reach of
 * roles for whom every scan would be a refusal.
 */
export const SCAN_ROLES = Object.freeze([
  'IO',
  'SHO',
  'DISTRICT_SP',
  'JUDGE',
  'EVIDENCE_CUSTODIAN',
  'FSL_EXAMINER',
]);

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
