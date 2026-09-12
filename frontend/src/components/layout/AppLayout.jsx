/**
 * The application shell.
 *
 * ## What changed, and why
 *
 * The header used to carry the user's name, their role badge, their authority id and
 * their full jurisdictional scope — "Station UP-GZB-KVN · District UP-GZB" — on every
 * screen, permanently. The reasoning was sound (this system's central claim is that
 * access follows the authority directory, so showing the scope makes that claim
 * visible rather than asserted) but the execution put four lines of identity metadata
 * in the top-right corner of every screen, competing with the work.
 *
 * The claim is still made, in the same words, one click away: the identity button
 * opens a panel with the role, the authority id and the full scope. That is the right
 * depth for something a user reads once at sign-in and then trusts — and it gives the
 * header back to navigation, which is what a header is for.
 *
 * Navigation is role-aware and deliberately short. Most roles see two items.
 */
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { AlertTriangle, LogOut, Moon, ScanLine, ShieldCheck, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

import { BrandMark } from '@/components/common/Premium';
import { Facts } from '@/components/common/Shell';
import { selectSession, sessionCleared, selectDeviceKeyMismatch } from '@/features/auth/authSlice';
import { selectTheme, themeToggled } from '@/features/ui/uiSlice';
import { signOut, HOME_FOR_ROLE, ROLE_LABEL, SCAN_ROLES } from '@/lib/api';
import { cn } from '@/lib/utils';

function ThemeToggle() {
  const theme = useSelector(selectTheme);
  const dispatch = useDispatch();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Switch to ${next} theme`}
          onClick={() => dispatch(themeToggled())}
          className="size-8 rounded-full"
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Switch to {next} theme</TooltipContent>
    </Tooltip>
  );
}

function NavItem({ to, children }) {
  return (
    <NavLink to={to}>
      {({ isActive }) => (
        <span
          className={cn(
            'inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-medium transition-colors',
            isActive
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
          )}
        >
          {children}
        </span>
      )}
    </NavLink>
  );
}

/** The scope line, in the one place it belongs: behind the identity button. */
function scopeRows(scope) {
  return [
    scope?.stationCode && ['Station', <code key="s" className="font-mono text-xs">{scope.stationCode}</code>],
    scope?.districtCode && ['District', <code key="d" className="font-mono text-xs">{scope.districtCode}</code>],
    scope?.courtId && ['Court', <code key="c" className="font-mono text-xs">{scope.courtId}</code>],
    scope?.labId && ['Laboratory', <code key="l" className="font-mono text-xs">{scope.labId}</code>],
    scope?.stateCode && ['State', <code key="t" className="font-mono text-xs">{scope.stateCode}</code>],
  ].filter(Boolean);
}

function Identity({ session, onSignOut }) {
  const name = session.name ?? session.authorityId;
  const initials = name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(-2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 transition-colors hover:bg-secondary/70"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-semibold">
            {initials}
          </span>
          <span className="hidden text-left sm:block">
            <span className="block text-[13px] font-medium leading-tight">{name}</span>
            <span className="block text-[11px] leading-tight text-muted-foreground">
              {ROLE_LABEL[session.role] ?? session.role}
            </span>
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 space-y-3.5">
        <div className="space-y-1">
          <p className="text-sm font-semibold">{name}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="rounded-full px-2 py-0 text-[11px] font-medium">
              {ROLE_LABEL[session.role] ?? session.role}
            </Badge>
            <code className="font-mono text-[11px] text-muted-foreground">
              {session.authorityId}
            </code>
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <p className="label-xs">Authority scope</p>
          <Facts dense rows={scopeRows(session.scope)} />
          {/* The product's central claim, made where somebody has asked to see it. */}
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Read from your authority directory when you signed in. Lexx cannot set or widen
            it, and a transfer or roster change removes access at your next sign-in.
          </p>
        </div>

        <Separator />

        <Button variant="outline" size="sm" className="w-full" onClick={onSignOut}>
          <LogOut className="size-3.5" />
          Sign out
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function AppLayout() {
  const session = useSelector(selectSession);
  const keyMismatch = useSelector(selectDeviceKeyMismatch);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const onSignOut = async () => {
    await signOut();
    dispatch(sessionCleared());
    navigate('/login', { replace: true });
  };

  const home = session ? HOME_FOR_ROLE[session.role] : null;
  const canScan = session && SCAN_ROLES.includes(session.role);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex min-h-screen flex-col bg-background">
        <header className="surface-glass sticky top-0 z-40 border-b">
          <div className="container flex h-14 max-w-7xl items-center gap-5">
            <Link to={home ?? '/'} className="flex shrink-0 items-center gap-2.5">
              <BrandMark size="sm" />
              <span className="text-[15px] font-semibold tracking-tight">LEXX</span>
            </Link>

            <nav className="hidden items-center gap-0.5 md:flex">
              {home && <NavItem to={home}>Workspace</NavItem>}
              {canScan && (
                <NavItem to="/scan">
                  <ScanLine className="mr-1.5 size-3.5" />
                  Scan a label
                </NavItem>
              )}
              <NavItem to="/verify">
                <ShieldCheck className="mr-1.5 size-3.5" />
                Public verifier
              </NavItem>
            </nav>

            <div className="ml-auto flex items-center gap-1.5">
              <ThemeToggle />
              {session ? (
                <Identity session={session} onSignOut={onSignOut} />
              ) : (
                pathname !== '/login' && (
                  <Button asChild size="sm" className="rounded-full px-4">
                    <Link to="/login">Sign in</Link>
                  </Button>
                )
              )}
            </div>
          </div>
        </header>

        {keyMismatch && (
          <div className="container max-w-7xl pt-4">
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>This browser&rsquo;s signing key is not registered</AlertTitle>
              <AlertDescription>
                Uploads will be refused until you register this device. Sign out and sign in
                again to complete registration.
              </AlertDescription>
            </Alert>
          </div>
        )}

        <main className="flex-1">
          <Outlet />
        </main>

        <footer className="border-t py-5">
          <div className="container flex max-w-7xl flex-col gap-1 text-[12px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>
              LEXX — evidence register for the criminal justice chain. Ledger roots anchored to
              Monad Testnet; no evidence, personal data or case identifiers are ever published.
            </p>
            <p className="shrink-0">Prototype. Directory services are simulated.</p>
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}
