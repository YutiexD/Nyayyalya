/**
 * The application shell.
 *
 * A compact top bar: brand, a short role-aware navigation, the theme toggle, the
 * signed-in identity (name and role) and a visible sign-out. The authority scope is one
 * click away behind the identity button, which is the right depth for something a user
 * reads once at sign-in and then trusts. Content below is centred at max 1280px.
 */
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { AlertTriangle, LogOut, Moon, ShieldCheck, Sun } from 'lucide-react';

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
import { useRealtimeStatus, useRealtimeSync } from '@/hooks/useRealtime';
import { signOut, HOME_FOR_ROLE, ROLE_LABEL } from '@/lib/api';
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
          size="icon-sm"
          aria-label={`Switch to ${next} theme`}
          onClick={() => dispatch(themeToggled())}
          className="text-muted-foreground"
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Switch to {next} theme</TooltipContent>
    </Tooltip>
  );
}

/** A dot: green while changes stream in live, muted while the stream reconnects. */
function LiveIndicator() {
  const { status } = useRealtimeStatus();
  if (status === 'idle') return null;
  const live = status === 'live';
  const text = live ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  const hint = live ? 'Live · changes appear as they happen' : `${text} Changes still refresh periodically.`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          aria-label={text}
          className="grid size-8 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="relative flex size-2">
            {live && <span aria-hidden className="absolute inline-flex size-full animate-ping rounded-full bg-ok/40 [animation-duration:2.5s]" />}
            <span
              aria-hidden
              className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-ok' : 'bg-muted-foreground/40')}
            />
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function NavItem({ to, children }) {
  return (
    <NavLink to={to}>
      {({ isActive }) => (
        <span
          className={cn(
            'inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium transition-colors',
            isActive
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
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

function Identity({ session }) {
  const name = session.name ?? session.authorityId;
  const role = ROLE_LABEL[session.role] ?? session.role;
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
          className="flex items-center gap-2.5 rounded-md py-1 pl-1 pr-2 transition-colors hover:bg-muted/70"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
            {initials}
          </span>
          <span className="hidden text-left sm:block">
            <span className="block max-w-[14rem] truncate text-[13px] font-medium leading-tight">{name}</span>
            <span className="block text-xs leading-tight text-muted-foreground">{role}</span>
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 space-y-3.5">
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">{name}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="neutral" size="sm">
              {role}
            </Badge>
            <code className="font-mono text-xs text-muted-foreground">{session.authorityId}</code>
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <p className="label-xs">Authority scope</p>
          <Facts dense rows={scopeRows(session.scope)} />
        </div>
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
  useRealtimeSync(Boolean(session), session?.authorityId);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex min-h-screen flex-col bg-background">
        <header className="surface-glass sticky top-0 z-40 border-b">
          <div className="page-container flex h-14 items-center gap-6">
            <Link to={home ?? '/'} className="flex shrink-0 items-center gap-2.5">
              <BrandMark size="sm" />
              <span className="text-[15px] font-semibold tracking-tight">LEXX</span>
            </Link>

            <nav className="hidden items-center gap-1 md:flex">
              {home && <NavItem to={home}>Workspace</NavItem>}
              <NavItem to="/verify">
                <ShieldCheck className="mr-1.5 size-3.5" />
                Verify certificate
              </NavItem>
            </nav>

            <div className="ml-auto flex items-center gap-1">
              {session && <LiveIndicator />}
              <ThemeToggle />
              {session ? (
                <>
                  <Separator orientation="vertical" className="mx-1.5 h-6" />
                  <Identity session={session} />
                  <Button variant="ghost" size="sm" onClick={onSignOut} className="text-muted-foreground">
                    <LogOut />
                    <span className="hidden sm:inline">Sign out</span>
                  </Button>
                </>
              ) : (
                pathname !== '/login' && (
                  <Button asChild size="sm" className="ml-1">
                    <Link to="/login">Sign in</Link>
                  </Button>
                )
              )}
            </div>
          </div>
        </header>

        {keyMismatch && (
          <div className="page-container pt-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>This device is not registered</AlertTitle>
              <AlertDescription>Sign out and sign in again to register it.</AlertDescription>
            </Alert>
          </div>
        )}

        <main className="flex-1">
          <Outlet />
        </main>

        <footer className="border-t py-4">
          <div className="page-container flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>LEXX · Digital evidence register</p>
            <p className="shrink-0">Prototype · directory services simulated</p>
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}
