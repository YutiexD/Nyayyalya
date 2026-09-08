/**
 * Sign-in.
 *
 * Four steps, and the fourth is the one worth explaining.
 *
 *   1 IDENTIFY      — the directory is asked whether this identifier exists and is
 *                     active. Lexx holds no identities of its own, so this is the
 *                     only place a person can enter the system, and the role and
 *                     jurisdiction that come back are read-only facts.
 *   2 VERIFY PHONE  — a one-time code to the number the DIRECTORY holds, not to any
 *                     number typed on this screen.
 *   3 SIGN IN       — password plus code. Activation additionally generates the
 *                     device signing key and registers its public half.
 *   4 REGISTER      — shown only when sign-in succeeded but this browser holds a
 *                     signing key the server has never seen.
 *
 * Step 4 exists because the alternative is silent failure. Every exhibit is signed in
 * the browser and verified server-side against the registered public key; a browser
 * that generated its own key — a new machine, a cleared profile, an account activated
 * elsewhere — produces a session that loads perfectly and then refuses every upload
 * with SIGNATURE_INVALID, three screens away from the cause.
 */
import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate, useLocation } from 'react-router-dom';
import { KeyRound, ShieldCheck, Smartphone, CheckCircle2 } from 'lucide-react';

import { BorderBeam } from '@/components/ui/border-beam';
import { Backdrop, Eyebrow, ACCENT_HEX } from '@/components/common/Premium';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';

import { api, ApiError, setSession, clearSession, HOME_FOR_ROLE } from '@/lib/api';
import { getOrCreateKeyPair, exportPublicJwk, publicKeyFingerprint } from '@/lib/crypto';
import { sessionEstablished, deviceKeyMismatchDetected } from '@/features/auth/authSlice';
import { Denial } from '@/components/common/Verdicts';
import { KeyValue, Hash } from '@/components/common/Primitives';
import { useReveal } from '@/hooks/useGsap';
import { humanise } from '@/lib/utils';

const MIN_PASSWORD = 12;
const STEPS = ['Identify', 'Verify phone', 'Sign in'];

function Stepper({ step }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'active' : 'todo';
        return (
          <li
            key={label}
            className={
              state === 'active'
                ? 'font-semibold text-foreground'
                : state === 'done'
                  ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                  : 'text-muted-foreground/60'
            }
          >
            <span className="tabular-nums">{n}.</span> {label}
          </li>
        );
      })}
    </ol>
  );
}

export default function LoginPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const scope = useReveal('.will-reveal', { deps: [] });

  const [step, setStep] = useState(1);
  const [authorityId, setAuthorityId] = useState('');
  const [identity, setIdentity] = useState(null);
  const [otpSent, setOtpSent] = useState(null);
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Step 4 state: the mismatch we detected and the key we would register.
  const [deviceKey, setDeviceKey] = useState(null);
  const [deviceOtp, setDeviceOtp] = useState('');
  const [deviceOtpSent, setDeviceOtpSent] = useState(null);
  const [justRegistered, setJustRegistered] = useState(false);

  const activating = identity ? !identity.accountExists : false;

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'REQUEST_FAILED', err.message));
    } finally {
      setBusy(false);
    }
  };

  const onIdentify = (e) => {
    e.preventDefault();
    run(async () => {
      const result = await api.auth.verifyIdentity(authorityId.trim());
      setIdentity(result.identity ?? result);
      setStep(2);
    });
  };

  const onSendCode = (e) => {
    e.preventDefault();
    run(async () => {
      const sent = await api.auth.requestOtp(
        authorityId.trim(),
        identity?.accountExists ? 'LOGIN' : 'ACTIVATION'
      );
      setOtpSent(sent);
      setOtp(sent.demoOtp ?? '');
      setStep(3);
    });
  };

  const finish = (session) => {
    setSession(session);
    dispatch(sessionEstablished(session.user));
    const next = location.state?.from;
    navigate(next || HOME_FOR_ROLE[session.user?.role] || '/', { replace: true });
  };

  const onSubmitFinal = (e) => {
    e.preventDefault();
    run(async () => {
      if (activating) {
        if (password.length < MIN_PASSWORD) {
          throw new ApiError(0, 'PASSWORD_TOO_SHORT', `Choose at least ${MIN_PASSWORD} characters.`);
        }
        if (password !== confirm) {
          throw new ApiError(0, 'PASSWORD_MISMATCH', 'The two passwords do not match.');
        }
        // The keypair is created HERE, in this browser, non-extractable. Only the
        // public half travels.
        const keyPair = await getOrCreateKeyPair();
        const publicKeyJwk = await exportPublicJwk(keyPair.publicKey);
        const session = await api.auth.activate({
          authorityId: authorityId.trim(),
          otp: otp.trim(),
          password,
          publicKeyJwk,
        });
        finish(session);
        return;
      }

      const session = await api.auth.login({
        authorityId: authorityId.trim(),
        password,
        otp: otp.trim(),
      });

      const keyPair = await getOrCreateKeyPair();
      const localFingerprint = await publicKeyFingerprint(keyPair.publicKey);

      if (localFingerprint !== session.user?.publicKeyFingerprint) {
        // Hold the session so rotate-key can authenticate, then deal with it here,
        // where the cause is on screen — not at the upload form.
        setSession(session);
        setDeviceKey({ session, keyPair, localFingerprint });
        setStep(4);
        return;
      }
      finish(session);
    });
  };

  const onSendDeviceCode = () => {
    run(async () => {
      const sent = await api.auth.requestOtp(authorityId.trim(), 'LOGIN');
      setDeviceOtpSent(sent);
      setDeviceOtp(sent.demoOtp ?? '');
    });
  };

  const onRegisterDevice = (e) => {
    e.preventDefault();
    run(async () => {
      if (!deviceOtp.trim()) throw new ApiError(0, 'OTP_REQUIRED', 'Enter the one-time code first.');
      const publicKeyJwk = await exportPublicJwk(deviceKey.keyPair.publicKey);
      await api.auth.rotateKey({ otp: deviceOtp.trim(), publicKeyJwk });

      // Rotating revokes every session, including this one, by design: a key change
      // must not leave older sessions alive. So sign in again, cleanly.
      clearSession();
      dispatch(deviceKeyMismatchDetected(false));
      setDeviceKey(null);
      setDeviceOtpSent(null);
      setOtpSent(null);
      setOtp('');
      setPassword('');
      setJustRegistered(true);
      setStep(2);
    });
  };

  return (
    <section className="relative overflow-hidden">
    <Backdrop />
    {/* The reveal scope is the whole grid, not the copy column: the sign-in card is a
        reveal target too, and a target outside the scope is never revealed. */}
    <div ref={scope} className="container relative grid min-h-[calc(100vh-10rem)] items-center gap-10 py-12 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
      {/* The standing explanation. It is the same on every step, because it is the
          architectural claim the whole product rests on. */}
      <div className="space-y-6">
        <div className="space-y-4">
          <div className="will-reveal">
            <Eyebrow>Digital evidence register</Eyebrow>
          </div>
          <h1 className="text-balance text-display-sm will-reveal sm:text-display">
            Evidence that can be checked,
            <br />
            <span className="text-gradient">not merely trusted.</span>
          </h1>
        </div>
        <div className="space-y-4 border-l-2 border-border pl-5 text-sm leading-relaxed text-muted-foreground">
          <p className="will-reveal">
            Lexx holds no identities of its own. Officers exist in the police directory, judges
            and registrars in the court directory, advocates and examiners in the Bar Council and
            FSL directory. We verify against them and can create none of them.
          </p>
          <p className="will-reveal">
            There is no self-registration. An account exists only where the authority directory
            already shows an active person, and your role and jurisdiction are read from that
            record — never from anything you type here.
          </p>
          <p className="will-reveal">
            Your signing key is generated in this browser and never leaves it. Every exhibit you
            upload is hashed and signed here, before a byte reaches the server.
          </p>
        </div>
      </div>

      <div className="will-reveal w-full">
      <Card className="surface relative w-full overflow-hidden shadow-elev-3">
        {/* One beam, on the one card that is the task. */}
        <BorderBeam size={160} duration={10} colorFrom={ACCENT_HEX.from} colorTo={ACCENT_HEX.to} />
        <CardHeader className="space-y-3">
          <Stepper step={Math.min(step, 3)} />
          <div>
            <CardTitle className="text-xl">
              {step === 1 && 'Sign in'}
              {step === 2 && 'Verify the number on record'}
              {step === 3 && (activating ? 'Activate your account' : 'Sign in')}
              {step === 4 && 'Register this device'}
            </CardTitle>
            <CardDescription>
              {step === 1 && 'Lexx checks your authority directory before it does anything else.'}
              {step === 2 &&
                'The code goes to the phone number your authority directory holds — not to a number entered here.'}
              {step === 3 &&
                (activating
                  ? 'Your role and jurisdiction are taken from the directory record. Nothing on this form can change them.'
                  : 'Lexx re-checks your directory record on every sign-in, so a transfer, suspension or roster change takes effect immediately.')}
              {step === 4 &&
                'You are signed in, but the signing key in this browser is not the one on record for your account.'}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {justRegistered && (
            <Alert className="border-ok/40 bg-ok-muted">
              <CheckCircle2 className="size-4" />
              <AlertTitle>This device is registered</AlertTitle>
              <AlertDescription>
                Its signing key is now the one on record. Sign in again to continue — rotating a
                signing key ends every existing session, including the one you just used.
              </AlertDescription>
            </Alert>
          )}

          {identity && step > 1 && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium">
                {identity.name ?? authorityId} — verified in the {humanise(identity.authority)}{' '}
                directory
              </p>
              <p className="text-xs text-muted-foreground">
                Role from the directory: {humanise(identity.role)}
                {identity.scope?.stationCode ? ` · Station ${identity.scope.stationCode}` : ''}
                {identity.scope?.districtCode ? ` · District ${identity.scope.districtCode}` : ''}
              </p>
            </div>
          )}

          {/* ---------------------------------------------------------- step 1 */}
          {step === 1 && (
            <form onSubmit={onIdentify} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="authorityId">Authority identifier</Label>
                <Input
                  id="authorityId"
                  value={authorityId}
                  onChange={(e) => setAuthorityId(e.target.value)}
                  placeholder="UP-GZB-4471"
                  autoComplete="username"
                  required
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Your PIS number, judge code, registry staff code, Bar Council enrolment number
                  or FSL examiner code.
                </p>
              </div>
              <Button type="submit" disabled={busy || !authorityId.trim()} className="w-full">
                <ShieldCheck className="size-4" />
                {busy ? 'Checking the directory…' : 'Check the directory'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Try an identifier that does not exist — <code className="font-mono">UP-GZB-9999</code>{' '}
                — to see what happens when a directory has no record of you.
              </p>
            </form>
          )}

          {/* ---------------------------------------------------------- step 2 */}
          {step === 2 && (
            <form onSubmit={onSendCode} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Code destination:{' '}
                <span className="font-mono">{identity?.maskedPhone ?? '•••••••••'}</span>
              </p>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  <Smartphone className="size-4" />
                  {busy ? 'Sending…' : 'Send the code'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setStep(1);
                    setIdentity(null);
                    setJustRegistered(false);
                  }}
                >
                  Use a different identifier
                </Button>
              </div>
            </form>
          )}

          {/* ---------------------------------------------------------- step 3 */}
          {step === 3 && (
            <form onSubmit={onSubmitFinal} className="space-y-4">
              {otpSent?.demoOtp && (
                <Alert className="border-warn/40 bg-warn-muted">
                  <KeyRound className="size-4" />
                  <AlertTitle className="font-mono text-lg tracking-[0.3em]">
                    {otpSent.demoOtp}
                  </AlertTitle>
                  <AlertDescription className="text-xs">
                    DEVELOPMENT ONLY — this deployment echoes the one-time code back to the
                    browser so the demo does not depend on an SMS gateway. The server refuses to
                    do this when NODE_ENV is production.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="otp">One-time code</Label>
                <Input
                  id="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  placeholder="000000"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={activating ? 'new-password' : 'current-password'}
                  minLength={activating ? MIN_PASSWORD : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                {activating && (
                  <p className="text-xs text-muted-foreground">
                    At least {MIN_PASSWORD} characters. You are setting it now.
                  </p>
                )}
              </div>

              {activating && (
                <div className="space-y-2">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </div>
              )}

              <Button type="submit" disabled={busy} className="w-full">
                {busy
                  ? activating
                    ? 'Generating key…'
                    : 'Signing in…'
                  : activating
                    ? 'Activate this account'
                    : 'Sign in'}
              </Button>
            </form>
          )}

          {/* ---------------------------------------------------------- step 4 */}
          {step === 4 && deviceKey && (
            <form onSubmit={onRegisterDevice} className="space-y-4">
              <Alert variant="destructive">
                <KeyRound className="size-4" />
                <AlertTitle>Uploads from this browser would be refused</AlertTitle>
                <AlertDescription className="space-y-2 text-xs leading-relaxed">
                  <p>
                    Every exhibit is signed here, in this browser, and the server verifies that
                    signature against the public key registered to your account. This browser
                    holds a different key — which is what happens on a new machine, a cleared
                    browser profile, or an account activated somewhere else.
                  </p>
                  <p>
                    Registering replaces the key on record with this one and signs you out of
                    every other session.
                  </p>
                </AlertDescription>
              </Alert>

              <KeyValue
                rows={[
                  ['Key on record', <Hash key="a" value={deviceKey.session.user?.publicKeyFingerprint} />],
                  ['Key in this browser', <Hash key="b" value={deviceKey.localFingerprint} />],
                ]}
              />

              <Separator />

              {deviceOtpSent?.demoOtp && (
                <p className="font-mono text-lg tracking-[0.3em]">{deviceOtpSent.demoOtp}</p>
              )}

              <div className="space-y-2">
                <Label htmlFor="device-otp">One-time code</Label>
                <Input
                  id="device-otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  placeholder="000000"
                  value={deviceOtp}
                  onChange={(e) => setDeviceOtp(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Sent to the number your authority directory holds. Moving a signing key to a new
                  machine costs a fresh code — the password alone is not enough.
                </p>
              </div>

              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={onSendDeviceCode} disabled={busy}>
                  Send a code
                </Button>
                <Button type="submit" disabled={busy || !deviceOtp.trim()}>
                  {busy ? 'Registering…' : 'Register this device'}
                </Button>
              </div>
            </form>
          )}

          {error && <Denial error={error} heading="Sign-in refused" />}
        </CardContent>
      </Card>
      </div>
    </div>
    </section>
  );
}
