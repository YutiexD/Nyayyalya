/**
 * Redux Toolkit store.
 *
 * # What lives here, and what deliberately does not
 *
 * Redux holds CLIENT state: who is signed in, which theme is active, which case the
 * user is currently working on. TanStack Query holds SERVER state: cases, exhibits,
 * ledger entries, referrals — anything the API owns.
 *
 * Keeping those apart is the single decision that keeps this app simple. Server data
 * put into Redux has to be manually invalidated, refetched, deduplicated and
 * garbage-collected, and every one of those is a bug waiting to happen in a system
 * where a stale exhibit list is a correctness problem rather than a cosmetic one.
 * Query already does all four.
 *
 * So the rule: if the server is the authority on it, it is a query, not a slice.
 */
import { configureStore } from '@reduxjs/toolkit';
import authReducer from '@/features/auth/authSlice';
import uiReducer from '@/features/ui/uiSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    ui: uiReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      // Everything in the store is JSON-serialisable by construction: the session is
      // what the server sent, and UI state is primitives. Leaving the check on means
      // an accidental Date or File in a slice fails loudly in development.
      serializableCheck: true,
    }),
});
