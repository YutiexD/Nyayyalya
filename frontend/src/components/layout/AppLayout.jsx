/**
 * The application shell: header, session identity, theme control, and the outlet.
 *
 * The header carries the signed-in user's SCOPE, not just their name. That is a
 * product decision, not decoration: this system's central claim is that access
 * follows the authority directory rather than anything Lexx decides, and showing
 * "Station UP-GZB-KVN · District UP-GZB" beside the role makes that claim visible on
 * every screen instead of asserted in a slide.
 *
 * The chrome floats — frosted, with a hairline of the accent gradient beneath it — so
 * content scrolls under it rather than the page feeling like two stacked boxes.
 */
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { Moon, Sun, LogOut, AlertTriangle } from 'lucide-react';

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

import { BrandMark } from '@/components/common/Premium';
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
          className="rounded-full"
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
            'inline-flex h-8 items-center rounded-full px-3.5 text-sm font-medium transition-colors duration-200 ease-out',
            isActive
              ? 'bg-secondary text-foreground shadow-elev-1'
              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
          )}
        >
          {children}
        </span>
      )}
    </NavLink>
  );
}

function ScopeLine({ scope }) {
  const bits = [];
  if (scope?.stationCode) bits.push(`Station ${scope.stationCode}`);
  if (scope?.districtCode) bits.push(`District ${scope.districtCode}`);
  if (scope?.courtId) bits.push(`Court ${scope.courtId}`);
  if (scope?.labId) bits.push(`Lab ${scope.labId}`);
  if (!bits.length) return null;
  return <p className="text-[11px] text-muted-foreground">{bits.join(' · ')}</p>;
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
        <header className="surface-glass sticky top-0 z-40">
          <div className="container flex h-16 items-center gap-6">
            <Link to={home ?? '/'} className="flex shrink-0 items-center gap-2.5">
              <BrandMark size="sm" />
              <span className="text-[17px] font-semibold tracking-tight">LEXX</span>
            </Link>

            <nav className="hidden items-center gap-1 md:flex">
              {home && <NavItem to={home}>Workspace</NavItem>}
              <NavItem to="/verify">Public verifier</NavItem>
            </nav>

            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
              {session ? (
                <>
                  <Separator orientation="vertical" className="mx-1 h-7" />
                  <div className="hidden text-right sm:block">
                    <p className="text-sm font-medium leading-tight">
                      {session.name ?? session.authorityId}
                    </p>
                    <div className="mt-0.5 flex items-center justify-end gap-1.5">
                      <Badge
                        variant="secondary"
                        className="h-5 rounded-full px-2 text-[10.5px] font-medium"
                      >
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
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Sign out"
                        onClick={onSignOut}
                        className="rounded-full"
                      >
                        <LogOut className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Sign out</TooltipContent>
                  </Tooltip>
                </>
              ) : (
                pathname !== '/login' && (
                  <Button asChild size="sm" className="rounded-full px-4">
                    <Link to="/login">Sign in</Link>
                  </Button>
                )
              )}
            </div>
          </div>
          {/* The hairline: the accent, at low opacity, so the header has an edge the eye
              registers without a border the eye reads. */}
          <div aria-hidden className="h-px w-full bg-accent-gradient opacity-30" />
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

        <main className="flex-1">
          <Outlet />
        </main>

        <footer className="border-t border-border/60 py-6">
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
