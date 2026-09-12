/**
 * Client-only interface state: theme, and the case the user is working on.
 *
 * The working case is here rather than in a URL param because several role views are
 * tabbed workspaces over one case — switching tabs should not lose it, and switching
 * cases should update every tab at once.
 */
import { createSlice } from '@reduxjs/toolkit';
import { sessionCleared, sessionEstablished } from '@/features/auth/authSlice';

const THEME_KEY = 'lexx.theme';

/** Explicit choice first, then the OS preference. Never guess and never persist a guess. */
function initialTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* private mode: fall through to the OS preference */
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

const uiSlice = createSlice({
  name: 'ui',
  initialState: {
    theme: initialTheme(),
    workingCaseId: null,
  },
  reducers: {
    themeSet(state, action) {
      state.theme = action.payload === 'dark' ? 'dark' : 'light';
      try {
        localStorage.setItem(THEME_KEY, state.theme);
      } catch {
        /* the choice simply does not survive a reload */
      }
    },
    themeToggled(state) {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, state.theme);
      } catch {
        /* as above */
      }
    },
    workingCaseSet(state, action) {
      state.workingCaseId = action.payload ?? null;
    },
  },
  // The working case belongs to the person who chose it. A new session — or the end of
  // one — drops it, so the next user in the same tab never lands on a case id picked by
  // someone else (typically one they cannot read, which rendered every tab as a denial).
  extraReducers: (builder) => {
    builder.addCase(sessionEstablished, (state) => {
      state.workingCaseId = null;
    });
    builder.addCase(sessionCleared, (state) => {
      state.workingCaseId = null;
    });
  },
});

export const { themeSet, themeToggled, workingCaseSet } = uiSlice.actions;

export const selectTheme = (state) => state.ui.theme;
export const selectWorkingCaseId = (state) => state.ui.workingCaseId;

export default uiSlice.reducer;
