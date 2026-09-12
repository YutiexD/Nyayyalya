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
 * request and said no. Retrying it produces three more identical denials in the audit
 * log — which is the one log that has to mean something — and can trip the rate
 * limiter mid-demo. Only genuine transport and server faults are worth another go.
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
      // Long enough that tab switching does not re-hit the API, short enough that a
      // second operator's change shows up without a manual reload.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
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
 * the case timeline, the ledger, the triage queue and the anchor tail. Keeping the
 * keys in a single table means those relationships are visible instead of guessed.
 */
export const qk = {
  session: ['session'],
  cases: (query) => ['cases', query ?? {}],
  case: (id) => ['case', id],
  caseTimeline: (id) => ['case', id, 'timeline'],
  evidence: (query) => ['evidence', query ?? {}],
  exhibit: (id) => ['exhibit', id],
  verify: (id) => ['exhibit', id, 'verify'],
  triage: (query) => ['triage', query ?? {}],
  custodyItems: (query) => ['custody', 'items', query ?? {}],
  custodyGaps: (query) => ['custody', 'gaps', query ?? {}],
  custodyChain: (id) => ['custody', 'chain', id],
  ledger: (caseId) => ['ledger', caseId],
  chainVerify: ['ledger', 'verify-chain'],
  anchorLatest: ['anchor', 'latest'],
  referrals: (query) => ['fsl', 'referrals', query ?? {}],
  labQueue: (query) => ['fsl', 'queue', query ?? {}],
  packsForCase: (caseId, status) => ['disclosure', 'packs', caseId, status ?? 'all'],
  myPack: (caseId) => ['disclosure', 'my-pack', caseId],
  certificate: (id) => ['certificate', id],
  certificatesForEvidence: (evidenceId) => ['certificate', 'for-evidence', evidenceId],
  certificatesForReferral: (referralId) => ['certificate', 'for-referral', referralId],
  custodyRecipients: (id) => ['custody', 'recipients', id],
  vakalatnamaMine: ['vakalatnama', 'mine'],
  vakalatnamaForCase: (caseId) => ['vakalatnama', 'case', caseId],
  anchorRecent: ['anchor', 'recent'],
  audit: (query) => ['audit', query ?? {}],
  auditSecurity: ['audit', 'security'],
  search: (q) => ['search', q],
  health: ['health', 'readyz'],
};
