/**
 * The application shell.
 *
 * A resizable navbar that smoothly shrinks to a floating pill on scroll,
 * frosted glass, four compact items (brand, verifier, theme, identity).
 * Workspace and scan navigation are available through the brand-mark
 * home link and the workspace screen itself.
 */
import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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

import {
  Navbar,
  NavBody,
  NavSpacer,
  MobileNav,
  MobileNavHeader,
  MobileNavToggle,
  MobileNavMenu,
} from '@/components/ui/resizable-navbar';
import { BrandMark } from '@/components/common/Premium';
import { Facts } from '@/components/common/Shell';
import { selectSession, sessionCleared, selectDeviceKeyMismatch } from '@/features/auth/authSlice';
import { selectTheme, themeToggled } from '@/features/ui/uiSlice';
import { signOut, HOME_FOR_ROLE, ROLE_LABEL } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useSmoothScroll } from '@/hooks/useSmoothScroll';

function ThemeToggle() {
  const theme = useSelector(selectTheme);
  const dispatch = useDispatch();
  const ref = useRef(null);
  const next = theme === 'dark' ? 'light' : 'dark';

  const toggle = useCallback(async () => {
    if (!document.startViewTransition) {
      dispatch(themeToggled());
      return;
    }

    await document.startViewTransition(() => {
      flushSync(() => {
        const root = document.documentElement;
        root.classList.toggle('dark', next === 'dark');
        root.style.colorScheme = next;
        dispatch(themeToggled());
      });
    }).ready;

    document.documentElement.animate(
      [
        { opacity: 0, transform: 'scale(0.8) rotate(5deg)' },
        { opacity: 1, transform: 'scale(1) rotate(0deg)' },
      ],
      {
        duration: 480,
        easing: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        pseudoElement: '::view-transition-new(root)',
      },
    );
  }, [dispatch, next]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={`Switch to ${next} theme`}
          onClick={toggle}
          className="grid size-8 place-items-center rounded-full text-muted-foreground transition-all duration-200 hover:scale-110 hover:bg-secondary/70 hover:text-foreground active:scale-95"
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8} className="rounded-full px-3 py-1">
        {next === 'dark' ? 'Dark mode' : 'Light mode'}
      </TooltipContent>
    </Tooltip>
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
          className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground transition-all hover:scale-105 active:scale-95"
        >
          {initials}
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
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Read from your authority directory when you signed in. Nyayyalya cannot set or widen
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
  useSmoothScroll();
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
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex min-h-screen flex-col bg-background">
        {/* ─── resizable navbar ─── */}
        <Navbar>
          {/* Desktop */}
          <NavBody>
            {/* 1 — Brand mark + Nyayyalya */}
            <Link
              to="/"
              className="relative z-20 flex items-center gap-2 rounded-full py-1 pl-1.5 pr-3 transition-colors hover:bg-secondary/60"
            >
              <BrandMark size="sm" />
              <span className="text-sm font-semibold tracking-[-0.01em]">Nyayyalya</span>
            </Link>

            {/* Spacer: fills gap at full-width, disappears in the collapsed pill */}
            <NavSpacer />

            {/* Right side items */}
            <div className="flex items-center gap-1">
              <span className="mx-0.5 h-5 w-px bg-border/50" aria-hidden />

              {/* 2 — Public verifier (icon only) */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <NavLink to="/verify">
                    {({ isActive }) => (
                      <span
                        className={cn(
                          'grid size-8 place-items-center rounded-full transition-all duration-200 hover:scale-110 active:scale-95',
                          isActive
                            ? 'bg-secondary text-foreground'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                        )}
                      >
                        <ShieldCheck className="size-4" />
                      </span>
                    )}
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={8} className="rounded-full px-3 py-1">
                  Public verifier
                </TooltipContent>
              </Tooltip>

              {/* 3 — Theme toggle */}
              <ThemeToggle />

              <span className="mx-0.5 h-5 w-px bg-border/50" aria-hidden />

              {/* 4 — Sign in / Identity */}
              {session ? (
                <Identity session={session} onSignOut={onSignOut} />
              ) : (
                pathname !== '/login' && (
                  <Button asChild size="sm" className="h-8 rounded-full px-4 text-xs">
                    <Link to="/login">Sign in</Link>
                  </Button>
                )
              )}
            </div>
          </NavBody>

          {/* Mobile */}
          <MobileNav>
            <MobileNavHeader>
              <Link to="/" className="flex items-center gap-2">
                <BrandMark size="sm" />
                <span className="text-sm font-semibold tracking-[-0.01em]">Nyayyalya</span>
              </Link>
              <MobileNavToggle
                isOpen={isMobileMenuOpen}
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              />
            </MobileNavHeader>
            <MobileNavMenu isOpen={isMobileMenuOpen} onClose={() => setIsMobileMenuOpen(false)}>
              <NavLink to="/verify" onClick={() => setIsMobileMenuOpen(false)} className="flex items-center gap-2 text-muted-foreground">
                <ShieldCheck className="size-4" />
                <span>Public verifier</span>
              </NavLink>
              <div className="flex items-center gap-2">
                <ThemeToggle />
                <span className="text-sm text-muted-foreground">Toggle theme</span>
              </div>
              {!session && pathname !== '/login' && (
                <Button asChild size="sm" className="w-full">
                  <Link to="/login" onClick={() => setIsMobileMenuOpen(false)}>Sign in</Link>
                </Button>
              )}
              {session && (
                <Button variant="outline" size="sm" className="w-full" onClick={() => { onSignOut(); setIsMobileMenuOpen(false); }}>
                  <LogOut className="size-3.5" />
                  Sign out
                </Button>
              )}
            </MobileNavMenu>
          </MobileNav>
        </Navbar>

        {keyMismatch && (
          <div className="container max-w-7xl pt-24">
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

        <main className="flex-1 pt-20">
          <Outlet />
        </main>

        <footer className="bg-[#1E3932] text-white border-t-0 py-8">
          <div className="container flex max-w-7xl flex-col gap-1 text-[12px] text-white/70 sm:flex-row sm:items-center sm:justify-between">
            <p>
              Nyayyalya — evidence register for the criminal justice chain. Ledger roots anchored to
              Monad Testnet; no evidence, personal data or case identifiers are ever published.
            </p>
            <p className="shrink-0">Prototype. Directory services are simulated.</p>
          </div>
        </footer>
      </div>
    </TooltipProvider>
  );
}
