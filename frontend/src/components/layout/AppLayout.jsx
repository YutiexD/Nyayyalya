/**
 * The application shell: header, session identity, theme control, and the outlet.
 *
 * The header carries the signed-in user's SCOPE, not just their name. That is a
 * product decision, not decoration: this system's central claim is that access
 * follows the authority directory rather than anything Lexx decides, and showing
 * "Station UP-GZB-KVN · District UP-GZB" beside the role makes that claim visible on
 * every screen instead of asserted in a slide.
 */
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { Moon, Sun, LogOut, ShieldCheck, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

import { selectSession, sessionCleared, selectDeviceKeyMismatch } from '@/features/auth/authSlice';
import { selectTheme, themeToggled } from '@/features/ui/uiSlice';
import { signOut, HOME_FOR_ROLE } from '@/lib/api';
import { humanise, cn } from '@/lib/utils';

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
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Switch to {next} theme</TooltipContent>
    </Tooltip>
  );
}

function ScopeLine({ scope }) {
  const bits = [];
  if (scope?.stationCode) bits.push(`Station ${scope.stationCode}`);
  if (scope?.districtCode) bits.push(`District ${scope.districtCode}`);
  if (scope?.courtId) bits.push(`Court ${scope.courtId}`);
  if (scope?.labId) bits.push(`Lab ${scope.labId}`);
  if (!bits.length) return null;
  return <p className="text-xs text-muted-foreground">{bits.join(' · ')}</p>;
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

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen flex-col bg-background">
        <header className="sticky top-0 z-40 border-b border-border/80 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="container flex h-16 items-center gap-6">
            <Link to={home ?? '/'} className="flex items-center gap-2.5 shrink-0">
              <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
                <ShieldCheck className="size-4" />
              </span>
              <span className="text-lg font-semibold tracking-tight">LEXX</span>
            </Link>

            <nav className="hidden items-center gap-1 md:flex">
              {home && (
                <NavLink to={home}>
                  {({ isActive }) => (
                    <Button variant={isActive ? 'secondary' : 'ghost'} size="sm">
                      Workspace
                    </Button>
                  )}
                </NavLink>
              )}
              <NavLink to="/verify">
                {({ isActive }) => (
                  <Button variant={isActive ? 'secondary' : 'ghost'} size="sm">
                    Public verifier
                  </Button>
                )}
              </NavLink>
            </nav>

            <div className="ml-auto flex items-center gap-3">
              <ThemeToggle />
              {session ? (
                <>
                  <Separator orientation="vertical" className="h-8" />
                  <div className="hidden text-right sm:block">
                    <p className="text-sm font-medium leading-tight">
                      {session.name ?? session.authorityId}
                    </p>
                    <div className="flex items-center justify-end gap-1.5">
                      <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-medium">
                        {humanise(session.role)}
                      </Badge>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {session.authorityId}
                      </span>
                    </div>
                    <ScopeLine scope={session.scope} />
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Sign out" onClick={onSignOut}>
                        <LogOut className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Sign out</TooltipContent>
                  </Tooltip>
                </>
              ) : (
                pathname !== '/login' && (
                  <Button asChild size="sm">
                    <Link to="/login">Sign in</Link>
                  </Button>
                )
              )}
            </div>
          </div>
        </header>

        {keyMismatch && (
          <div className="container pt-4">
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

        <main className={cn('flex-1')}>
          <Outlet />
        </main>

        <footer className="border-t border-border/80 py-6">
          <div className="container flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>
              LEXX 2.0 — evidence register for the criminal justice chain. Roots anchored to
              Monad Testnet; no evidence, personal data or case identifiers are ever published.
            </p>
            <p>Prototype. Directory services are simulated.</p>
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}
