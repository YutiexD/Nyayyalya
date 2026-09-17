/**
 * TanStack Query configuration.
 *
 * The defaults here are chosen for a records system, which has a different tolerance
 * for staleness than a social feed: an exhibit list that is thirty seconds out of
 * date is fine, an exhibit list that silently retries a 403 four times is not.
 */
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';

/**
 * Never retry a refusal.
 *
 * A 401/403/404 from this API is a decision, not a blip: the resolver evaluated the
 * request and said no. Retrying it produces more identical denials in the audit log
 * and can trip the rate limiter. Only genuine transport and server faults are retried.
 */
function retry(failureCount, error) {
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) return false;
    // 503 SEARCH_UNAVAILABLE / AUDIT_UNAVAILABLE are real conditions the operator
    // must see, not transient ones to paper over.
    if (error.status === 503) return false;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry,
      // Changes arrive over the live stream (hooks/useRealtime.js), which invalidates
      // what they touch. Focus and reconnect refetches are the backstop for anything a
      // dropped stream missed; staleTime keeps a quick tab switch from re-hitting the API.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // A refetch that replaces a rendered table with a spinner reads as a bug.
      placeholderData: (prev) => prev,
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Query keys in one place.
 *
 * Invalidation is only as reliable as the keys agree, and a mutation in one feature
 * routinely has to invalidate a list owned by another — uploading an exhibit changes
 * the case, its timeline, the ledger, the lab queue and the certificate register.
 */
export const qk = {
  session: ['session'],
  cases: (query) => ['cases', query ?? {}],
  case: (id) => ['case', id],
  caseTimeline: (id) => ['case', id, 'timeline'],
  caseOverview: (id) => ['case', id, 'overview'],
  caseWorkflow: (id) => ['case', id, 'workflow'],
  caseFile: (caseId) => ['case-file', caseId],
  evidence: (query) => ['evidence', query ?? {}],
  exhibit: (id) => ['exhibit', id],
  verify: (id) => ['exhibit', id, 'verify'],
  exhibitLifecycle: (id) => ['exhibit', id, 'lifecycle'],
  triage: (query) => ['triage', query ?? {}],
  ledger: (caseId) => ['ledger', caseId],
  chainVerify: ['ledger', 'verify-chain'],
  anchorLatest: ['anchor', 'latest'],
  anchorRecent: ['anchor', 'recent'],
  referrals: (query) => ['fsl', 'referrals', query ?? {}],
  labQueue: (query) => ['fsl', 'queue', query ?? {}],
  fslCases: (query) => ['fsl', 'cases', query ?? {}],
  certificate: (id) => ['certificate', id],
  certificatesForEvidence: (evidenceId) => ['certificate', 'for-evidence', evidenceId],
  vakalatnamaMine: ['vakalatnama', 'mine'],
  vakalatnamaForCase: (caseId) => ['vakalatnama', 'case', caseId],
  audit: (query) => ['audit', query ?? {}],
  auditSecurity: ['audit', 'security'],
  search: (q) => ['search', q],
  health: ['health', 'readyz'],
};
