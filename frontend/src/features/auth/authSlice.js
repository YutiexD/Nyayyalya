/**
 * Session state.
 *
 * This slice is a MIRROR of what the server issued, never a source of truth. The
 * server re-checks the directory record on every request and would refuse a session
 * object edited in devtools; what this holds is enough to render the right chrome and
 * route to the right home without a round trip on every navigation.
 *
 * The tokens themselves stay in lib/api.js (module variable + sessionStorage) rather
 * than in Redux: Redux state ends up in devtools, in time-travel snapshots, and in
 * any future persistence layer, and a 15-minute bearer credential belongs in none of
 * those places.
 */
import { createSlice } from '@reduxjs/toolkit';
import { getSession } from '@/lib/api';

const initialState = {
  // Rehydrated from sessionStorage so a page reload does not bounce a signed-in user
  // to the login screen before the first query resolves.
  session: getSession(),
  // Set when the browser holds a signing key the server has not registered. Uploads
  // would be refused until it is resolved, so the chrome says so persistently.
  deviceKeyMismatch: false,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    sessionEstablished(state, action) {
      state.session = action.payload ?? null;
      state.deviceKeyMismatch = false;
    },
    sessionCleared(state) {
      state.session = null;
      state.deviceKeyMismatch = false;
    },
    deviceKeyMismatchDetected(state, action) {
      state.deviceKeyMismatch = Boolean(action.payload ?? true);
    },
  },
});

export const { sessionEstablished, sessionCleared, deviceKeyMismatchDetected } =
  authSlice.actions;

export const selectSession = (state) => state.auth.session;
export const selectRole = (state) => state.auth.session?.role ?? null;
export const selectIsAuthenticated = (state) => Boolean(state.auth.session);
export const selectDeviceKeyMismatch = (state) => state.auth.deviceKeyMismatch;

export default authSlice.reducer;
