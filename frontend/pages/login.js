/**
 * Sign-in: three steps against three real endpoints.
 *
 *   1. POST /api/auth/verify-identity — does this person exist, and are they ACTIVE,
 *      in their authority directory? Nothing is created. A fake identifier is refused
 *      here, and the refusal is logged server-side (demo beat 1).
 *   2. POST /api/auth/request-otp — a code to the phone ON RECORD IN THE DIRECTORY.
 *      Never to a number typed into this form.
 *   3. POST /api/auth/activate  (first time — this is where the browser keypair is
 *      generated and the public half registered)
 *      or POST /api/auth/login  (thereafter — which re-checks the directory live).
 *
 * The role shown at step one comes from the directory response. It is displayed, not
 * chosen: there is no role selector on this page and there never will be.
 */
import { api, ApiError, setSession, clearSession, HOME_FOR_ROLE } from '../lib/api.js';
import { getOrCreateKeyPair, exportPublicJwk, publicKeyFingerprint } from '../lib/crypto.js';
import { el, mount, clear, append, denial, field, input, humanise } from '../lib/ui.js';

const root = document.getElementById('app');

const state = {
  step: 1,
  authorityId: '',
  identity: null,
  otpSent: null,
  busy: false,
};

const MIN_PASSWORD = 12;

/**
 * Move to another step, replacing whatever step-scoped state came with the old one.
 *
 * A plain synchronous function on purpose: every caller is inside an async submit
 * handler, and assigning `state.*` directly after an await trips require-atomic-updates
 * even though a browser event handler cannot actually interleave. Going through one
 * function also means a transition is a single readable call instead of five
 * assignments a reader has to collect.
 */
function goToStep(step, patch = {}) {
  Object.assign(state, { step }, patch);
  render();
}

// A signed-in tab that lands here has signed out or expired; do not keep a half state.
clearSession();

// ---------------------------------------------------------------- chrome ----

function stepper() {
  const labels = ['Identify', 'Verify phone', state.identity?.accountExists ? 'Sign in' : 'Activate'];
  return el(
    'div.auth-steps',
    labels.map((label, i) => {
      const n = i + 1;
      const cls = n < state.step ? 'auth-steps__step--done' : n === state.step ? 'auth-steps__step--active' : '';
      return el(`div.auth-steps__step${cls ? `.${cls}` : ''}`, `${n}. ${label}`);
    })
  );
}

const heading = (title, lede) => el('div', [el('h2.page-title', title), el('p.page-lede', lede)]);

const errorBox = () => el('div', { id: 'error-slot' });

const showError = (error) => {
  const slot = document.getElementById('error-slot');
  if (!slot) return;
  mount(
    slot,
    denial(error, {
      heading: error?.status === 403 ? 'Identity not verified' : 'Sign-in refused',
    })
  );
};

const clearError = () => {
  const slot = document.getElementById('error-slot');
  if (slot) clear(slot);
};

/**
 * Guard every submit: one in flight at a time, errors rendered in one place.
 * The busy flag and the button's own state are set through `setBusy` so the
 * mutations stay in one place either side of the await.
 */
function setBusy(button, busy, label) {
  state.busy = busy;
  button.disabled = busy;
  button.textContent = label;
}

async function submit(button, label, action) {
  if (state.busy) return;
  const original = button.textContent;
  setBusy(button, true, label);
  clearError();
  try {
    await action();
  } catch (error) {
    showError(error instanceof ApiError ? error : new ApiError(0, 'CLIENT_ERROR', error.message));
  } finally {
    setBusy(button, false, original);
  }
}

// ------------------------------------------------------------- step one ----

function renderIdentity() {
  const idInput = input({
    id: 'authorityId',
    name: 'authorityId',
    autocomplete: 'username',
    placeholder: 'UP-GZB-4471',
    value: state.authorityId,
    required: true,
    spellcheck: 'false',
    autocapitalize: 'characters',
  });

  const go = el('button.btn', { type: 'submit' }, 'Check the directory');

  const form = el(
    'form',
    {
      onSubmit: (e) => {
        e.preventDefault();
        const value = idInput.value.trim();
        if (!value) return;
        submit(go, 'Checking…', async () => {
          const identity = await api.auth.verifyIdentity(value);
          state.authorityId = value;
          state.identity = identity;
          state.step = 2;
          render();
        });
      },
    },
    [
      field(
        'Authority identifier',
        idInput,
        'Your PIS number, judge code, registry staff code, Bar Council enrolment number or FSL examiner code.'
      ),
      el('div.row', [go]),
    ]
  );

  return [
    heading('Sign in', 'Lexx checks your authority directory before it does anything else.'),
    form,
    errorBox(),
    el(
      'p.field__hint',
      'Try an identifier that does not exist — UP-GZB-9999 — to see what happens when a directory has no record of you.'
    ),
  ];
}

// ------------------------------------------------------------- step two ----

function identityCard() {
  const i = state.identity;
  const scope = i.scope ?? {};
  const scopeBits = [
    scope.stationCode && `Station ${scope.stationCode}`,
    scope.districtCode && `District ${scope.districtCode}`,
    scope.stateCode && `State ${scope.stateCode}`,
    scope.courtId && `Court ${scope.courtId}`,
    scope.labId && `Laboratory ${scope.labId}`,
  ].filter(Boolean);

  return el('div.notice.notice--ok', [
    el('div', [el('strong', i.name ?? state.authorityId), ' — verified in the ', el('strong', humanise(i.authority)), ' directory']),
    el('div.field__hint', [
      'Role from the directory: ',
      el('code', i.role ?? '—'),
      scopeBits.length ? ` · ${scopeBits.join(' · ')}` : '',
    ]),
  ]);
}

/** Move to step three with the challenge the server just issued. */
function advanceToFinal(otpSent) {
  state.otpSent = otpSent;
  state.step = 3;
  render();
}

function renderOtp() {
  const purpose = state.identity.accountExists ? 'LOGIN' : 'ACTIVATION';

  const send = el('button.btn', { type: 'submit' }, 'Send the code');

  const form = el(
    'form',
    {
      onSubmit: (e) => {
        e.preventDefault();
        submit(send, 'Sending…', async () => {
          const result = await api.auth.requestOtp(state.authorityId, purpose);
          advanceToFinal(result);
        });
      },
    },
    [el('div.row', [send])]
  );

  return [
    // Shown here because registering a device drops you back to THIS step, not the
    // password step — rotating a signing key revokes every session, including the one
    // that just did the rotating.
    registeredNotice(),
    heading(
      'Verify the number on record',
      'The code goes to the phone number your authority directory holds — not to a number entered here.'
    ),
    stepper(),
    identityCard(),
    el(
      'p.field__hint',
      `Code destination: ${state.identity.maskedPhone ?? 'no number on record'}${
        state.identity.accountExists ? '' : ' · first sign-in, so this activates the account'
      }`
    ),
    form,
    errorBox(),
    el('div.row', [
      el(
        'button.btn.btn--secondary.btn--small',
        {
          type: 'button',
          onClick: () => {
            state.step = 1;
            state.identity = null;
            render();
          },
        },
        'Use a different identifier'
      ),
    ]),
  ];
}

// ----------------------------------------------------------- step three ----

/** Confirms the re-key after step 4, so the second sign-in is not unexplained. */
function registeredNotice() {
  if (!state.justRegistered) return null;
  return el('div.notice.notice--ok', [
    el('strong', 'This device is registered. '),
    'Its signing key is now the one on record for your account. Sign in again to continue — rotating a signing key ends every existing session, including the one you just used.',
  ]);
}

function otpNotice() {
  if (!state.otpSent) return null;
  const bits = [
    el('div', [
      'Code sent to ',
      el('strong', state.otpSent.maskedPhone ?? state.identity.maskedPhone ?? '—'),
      state.otpSent.expiresInSec ? ` · valid for ${Math.round(state.otpSent.expiresInSec / 60)} minutes` : '',
    ]),
  ];

  if (state.otpSent.demoOtp) {
    bits.push(
      el('div', { style: 'margin-top:8px' }, [
        el('div.demo-otp', String(state.otpSent.demoOtp)),
        el(
          'div.field__hint',
          'DEVELOPMENT ONLY — this deployment echoes the one-time code back to the browser so the demo does not depend on an SMS gateway. The server refuses to do this when NODE_ENV is production.'
        ),
      ])
    );
    return el('div.notice.notice--dev', bits);
  }
  return el('div.notice', bits);
}

function renderFinal() {
  const activating = !state.identity.accountExists;

  const otpInput = input({
    id: 'otp',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    placeholder: '000000',
    maxlength: '8',
    required: true,
    value: state.otpSent?.demoOtp ?? '',
  });

  const passwordInput = el('input.input', {
    type: 'password',
    id: 'password',
    autocomplete: activating ? 'new-password' : 'current-password',
    required: true,
    minlength: activating ? String(MIN_PASSWORD) : '1',
  });

  const confirmInput = activating
    ? el('input.input', { type: 'password', id: 'confirm', autocomplete: 'new-password', required: true })
    : null;

  const go = el('button.btn', { type: 'submit' }, activating ? 'Activate this account' : 'Sign in');
  const keyStatus = el('p.field__hint', '');

  const form = el(
    'form',
    {
      onSubmit: (e) => {
        e.preventDefault();
        const otp = otpInput.value.trim();
        const password = passwordInput.value;

        if (activating) {
          if (password.length < MIN_PASSWORD) {
            showError(
              new ApiError(0, 'PASSWORD_TOO_SHORT', `Choose a password of at least ${MIN_PASSWORD} characters.`)
            );
            return;
          }
          if (confirmInput.value !== password) {
            showError(new ApiError(0, 'PASSWORD_MISMATCH', 'The two passwords do not match.'));
            return;
          }
        }

        submit(go, activating ? 'Generating key…' : 'Signing in…', async () => {
          let session;
          if (activating) {
            // The keypair is created HERE, in the browser, non-extractable, and the
            // public half is the only thing that travels.
            keyStatus.textContent = 'Generating an ECDSA P-256 keypair in this browser…';
            const keyPair = await getOrCreateKeyPair();
            const publicKeyJwk = await exportPublicJwk(keyPair.publicKey);
            keyStatus.textContent = 'Key generated. The private half stays in this browser and cannot be exported.';
            session = await api.auth.activate({
              authorityId: state.authorityId,
              otp,
              password,
              publicKeyJwk,
            });
          } else {
            session = await api.auth.login({ authorityId: state.authorityId, password, otp });

            // A returning officer on a fresh machine gets a device key here — but a
            // key this browser generated is NOT the key the server has on record, and
            // the server verifies uploads against the registered one.
            //
            // Previously this called getOrCreateKeyPair() and moved on, which meant a
            // silently unusable session: sign-in succeeded, the dashboard loaded, and
            // then every single upload was refused with SIGNATURE_INVALID and no
            // explanation of why. On any machine that did not perform the activation
            // — a fresh browser, a cleared profile, an account created by the seed —
            // that was the whole evidence-upload workflow, dead, with the failure
            // surfacing three screens away from its cause.
            const keyPair = await getOrCreateKeyPair();
            const localFingerprint = await publicKeyFingerprint(keyPair.publicKey);

            if (localFingerprint !== session.user?.publicKeyFingerprint) {
              // Hold the session so rotate-key can authenticate, then make the user
              // deal with it now, on this screen, where the cause is obvious.
              setSession(session);
              goToStep(4, { deviceKey: { session, keyPair, localFingerprint } });
              return;
            }
          }

          setSession(session);
          const params = new URLSearchParams(location.search);
          const next = params.get('next');
          const home = HOME_FOR_ROLE[session.user?.role] ?? 'officer.html';
          location.replace(next && /^[a-z]+\.html$/.test(next) ? next : home);
        });
      },
    },
    [
      field('One-time code', otpInput),
      field(
        'Password',
        passwordInput,
        activating ? `At least ${MIN_PASSWORD} characters. You are setting it now.` : null
      ),
      confirmInput ? field('Confirm password', confirmInput) : null,
      el('div.row', [go]),
      keyStatus,
    ]
  );

  return [
    registeredNotice(),
    heading(
      activating ? 'Activate your account' : 'Sign in',
      activating
        ? 'Your role and jurisdiction are taken from the directory record above. Nothing on this form can change them.'
        : 'Lexx re-checks your directory record on every sign-in, so a transfer, suspension or roster change takes effect immediately.'
    ),
    stepper(),
    identityCard(),
    otpNotice(),
    form,
    errorBox(),
  ];
}


// ------------------------------------------------- 4. register this device ----

/**
 * Shown only when sign-in succeeded but this browser holds a signing key the server
 * has never seen.
 *
 * The account is fine and the password was right; what is missing is the link between
 * THIS device and the account. Uploads are signed in the browser and verified against
 * the registered public key, so until that link exists the officer can read everything
 * and upload nothing. Saying so here — rather than letting them discover it as an
 * unexplained SIGNATURE_INVALID at the upload form — is the whole point of this step.
 *
 * Registering is a re-key, so it costs a fresh one-time code: proving the password was
 * not enough to move an account's signing identity to a new machine.
 */
function renderDeviceKey() {
  const otpInput = input({
    id: 'device-otp',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    placeholder: '000000',
    maxlength: '8',
    required: true,
    value: state.deviceOtpSent?.demoOtp ?? '',
  });

  const go = el('button.btn', { type: 'submit' }, 'Register this device');
  const sendBtn = el('button.btn.btn--ghost', { type: 'button' }, 'Send a code');
  const status = el('p.field__hint', '');

  sendBtn.addEventListener('click', (ev) =>
    submit(ev.currentTarget, 'Sending…', async () => {
      const sent = await api.auth.requestOtp(state.authorityId, 'LOGIN');
      goToStep(4, { deviceOtpSent: sent });
    })
  );

  const form = el(
    'form',
    {
      onSubmit: (e) => {
        e.preventDefault();
        const otp = otpInput.value.trim();
        if (!otp) {
          showError(new ApiError(0, 'OTP_REQUIRED', 'Enter the one-time code first.'));
          return;
        }
        submit(go, 'Registering…', async () => {
          const publicKeyJwk = await exportPublicJwk(state.deviceKey.keyPair.publicKey);
          await api.auth.rotateKey({ otp, publicKeyJwk });

          // Rotating revokes every session, including this one, by design: a key
          // change must not leave older sessions alive. So sign in again, cleanly.
          clearSession();
          goToStep(2, {
            otpSent: null,
            deviceKey: null,
            deviceOtpSent: null,
            justRegistered: true,
          });
        });
      },
    },
    [
      field('One-time code', otpInput, 'Sent to the number your authority directory holds.'),
      el('div.row', [sendBtn, go]),
      status,
    ]
  );

  return [
    heading(
      'Register this device',
      'You are signed in, but the signing key in this browser is not the one on record for your account.'
    ),
    stepper(),
    identityCard(),
    el('div.notice.notice--warn', [
      el('strong', 'Uploads from this browser would be refused. '),
      'Every exhibit is signed here, in this browser, and the server verifies that signature against the public key registered to your account. ',
      'This browser holds a different key — because it generated a fresh one, which is what happens on a new machine, a cleared browser profile, or an account that was activated somewhere else. ',
      'Registering replaces the key on record with this one and signs you out of every other session.',
    ]),
    el('div.kv', [
      el('div.kv__k', 'Key on record'),
      el('div.kv__v', el('code', (state.deviceKey?.session?.user?.publicKeyFingerprint ?? '—').slice(0, 32))),
      el('div.kv__k', 'Key in this browser'),
      el('div.kv__v', el('code', (state.deviceKey?.localFingerprint ?? '—').slice(0, 32))),
    ]),
    form,
    errorBox(),
  ];
}

// ---------------------------------------------------------------- render ----

function render() {
  const views = { 1: renderIdentity, 2: renderOtp, 3: renderFinal, 4: renderDeviceKey };
  clear(root);
  append(root, views[state.step]());
  const first = root.querySelector('input:not([type=hidden])');
  if (first) first.focus();
}

render();
