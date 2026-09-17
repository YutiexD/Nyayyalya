/**
 * Sign-in.
 *
 *   1 IDENTIFY      — the authority directory confirms the identifier is active; role
 *                     and jurisdiction come back read-only.
 *   2 VERIFY PHONE  — a one-time code to the number the DIRECTORY holds.
 *   3 SIGN IN       — password plus code. Activation also generates the device signing
 *                     key and registers its public half.
 *   4 REGISTER      — shown only when sign-in succeeded but this browser holds a signing
 *                     key the server has never seen, so uploads would otherwise fail
 *                     later with SIGNATURE_INVALID.
 */
import { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate, useLocation } from 'react-router-dom';
import { KeyRound, ShieldCheck, Smartphone, CheckCircle2 } from 'lucide-react';

import { BrandMark } from '@/components/common/Premium';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';

import { api, ApiError, setSession, clearSession, HOME_FOR_ROLE } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { getOrCreateKeyPair, exportPublicJwk, publicKeyFingerprint } from '@/lib/crypto';
import { sessionEstablished, deviceKeyMismatchDetected } from '@/features/auth/authSlice';
import { Denial } from '@/components/common/Verdicts';
import { KeyValue, Hash } from '@/components/common/Primitives';
import { cn, humanise } from '@/lib/utils';

const MIN_PASSWORD = 12;
const STEPS = ['Identify', 'Verify phone', 'Sign in'];

function Stepper({ step }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'active' : 'todo';
        return (
          <li key={label} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              className={cn(
                'h-1 rounded-full',
                state === 'todo' ? 'bg-muted' : state === 'active' ? 'bg-primary' : 'bg-primary/40'
              )}
            />
            <span
              className={cn(
                'truncate text-label',
                state === 'active' ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}
            >
              {label}
            </span>
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
    // A new identity starts from an empty cache: nothing read under a previous
    // session (one that expired rather than signed out) may render under this one.
    queryClient.clear();
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
    <section className="page-container flex min-h-[calc(100vh-10rem)] flex-col items-center justify-center py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark />
          <p className="text-meta text-muted-foreground">LEXX · Digital evidence register</p>
        </div>

        <Card className="w-full">
          <CardHeader className="space-y-4">
            <Stepper step={Math.min(step, 3)} />
            <div className="space-y-1">
              <CardTitle className="text-xl">
                {step === 1 && 'Sign in'}
                {step === 2 && 'Verify your phone'}
                {step === 3 && (activating ? 'Activate your account' : 'Sign in')}
                {step === 4 && 'Register this device'}
              </CardTitle>
              <CardDescription>
                {step === 1 && 'Enter your authority identifier.'}
                {step === 2 && 'A code is sent to the number on your directory record.'}
                {step === 3 && (activating ? 'Set a password to activate.' : 'Enter the code and your password.')}
                {step === 4 && 'This browser’s signing key is not the one on record.'}
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-5">
            {justRegistered && (
              <Alert className="border-ok/40 bg-ok-muted">
                <CheckCircle2 className="size-4" />
                <AlertTitle>Device registered</AlertTitle>
                <AlertDescription>Sign in again to continue.</AlertDescription>
              </Alert>
            )}

            {identity && step > 1 && (
              <div className="rounded-md border bg-muted/40 px-3 py-2.5">
                <p className="text-sm font-medium">{identity.name ?? authorityId}</p>
                <p className="text-label text-muted-foreground">
                  {humanise(identity.role)}
                  {identity.scope?.stationCode ? ` · Station ${identity.scope.stationCode}` : ''}
                  {identity.scope?.districtCode ? ` · District ${identity.scope.districtCode}` : ''}
                  {identity.authority ? ` · ${humanise(identity.authority)} directory` : ''}
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
                  <p className="text-label text-muted-foreground">
                    PIS number, judge code, Bar Council enrolment or FSL examiner code.
                  </p>
                </div>
                <Button type="submit" disabled={busy || !authorityId.trim()} className="w-full">
                  <ShieldCheck className="size-4" />
                  {busy ? 'Checking…' : 'Continue'}
                </Button>
              </form>
            )}

            {/* ---------------------------------------------------------- step 2 */}
            {step === 2 && (
              <form onSubmit={onSendCode} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Send code to <span className="font-mono text-foreground">{identity?.maskedPhone ?? '•••••••••'}</span>
                </p>
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy}>
                    <Smartphone className="size-4" />
                    {busy ? 'Sending…' : 'Send code'}
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
                    Change identifier
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
                    <AlertTitle className="font-mono text-lg tracking-[0.3em]">{otpSent.demoOtp}</AlertTitle>
                    <AlertDescription className="text-xs">Demo code (development only).</AlertDescription>
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
                    <p className="text-label text-muted-foreground">At least {MIN_PASSWORD} characters.</p>
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
                      ? 'Activate account'
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
                  <AlertDescription className="text-xs">
                    Registering replaces the key on record and signs out other sessions.
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
                </div>

                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={onSendDeviceCode} disabled={busy}>
                    Send code
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
    </section>
  );
}
