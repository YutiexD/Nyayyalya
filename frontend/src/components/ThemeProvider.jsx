/**
 * Applies the Redux theme to the document, and keeps it in step with the OS.
 *
 * Rendered once, near the root. Everything else in the app reads colour from CSS
 * variables, so this single class toggle is the entire dark-mode implementation —
 * no component has a `dark:` colour variant to keep in sync.
 */
import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { selectTheme, themeSet } from '@/features/ui/uiSlice';
import { sessionCleared } from '@/features/auth/authSlice';
import { onSessionEnded } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';

export function ThemeProvider({ children }) {
  const theme = useSelector(selectTheme);
  const dispatch = useDispatch();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    // Follow the OS only while the user has expressed no preference of their own.
    // Once they choose, their choice wins until they change it.
    let hasExplicitChoice = false;
    try {
      hasExplicitChoice = Boolean(localStorage.getItem('lexx.theme'));
    } catch {
      /* private mode: treat as no explicit choice */
    }
    if (hasExplicitChoice) return undefined;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => dispatch(themeSet(e.matches ? 'dark' : 'light'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dispatch]);

  // Keep Redux in step with the token layer. When a refresh fails the API clears the
  // session in sessionStorage; if the store is not told, the route guard still sees a
  // signed-in user and renders a workspace where every panel is an expired-token
  // error. Listening here — once, above the router — turns that into a redirect to
  // sign in, which is what actually happened.
  //
  // The query cache goes with it. It is keyed by endpoint, not by user, so without this
  // the next person to sign in on the same tab — an advocate after an officer — was
  // shown the previous user's case list from cache until the refetch landed.
  useEffect(
    () =>
      onSessionEnded(() => {
        queryClient.clear();
        dispatch(sessionCleared());
      }),
    [dispatch]
  );

  return children;
}
