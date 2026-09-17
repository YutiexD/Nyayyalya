/**
 * Keeping every screen current without a reload.
 *
 * `useRealtimeSync` is mounted once, in the app shell, for a signed-in user. Each change
 * frame from the server invalidates the queries it touches; TanStack then refetches the
 * ones on screen and marks the rest stale. Bursts (an upload writes several ledger
 * events) are coalesced into one pass.
 *
 * Fallbacks, because a stream is a best effort:
 *   - after a reconnect every active query is refetched, since frames may have been missed;
 *   - while the stream has been down for more than 20 s, the case, evidence and
 *     laboratory views on screen are refetched every 20 s until it comes back;
 *   - window focus and network reconnect refetch stale queries (queryClient defaults).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  getRealtimeState, onRealtimeChange, onRealtimeReady, startRealtime, stopRealtime,
  subscribeRealtimeStatus,
} from '@/lib/realtime';

const DEBOUNCE_MS = 250;
const MAX_WAIT_MS = 1_000;
const POLL_AFTER_DOWN_MS = 20_000;
const POLL_EVERY_MS = 20_000;

/** Never refetched by a change: identity, public anchoring, health. */
const NEVER = new Set(['session', 'anchor', 'health']);
/** What the polling fallback refreshes. */
const POLLED = new Set(['cases', 'case', 'case-file', 'evidence', 'exhibit', 'fsl']);

const EVERYTHING = [
  'cases', 'case', 'case-file', 'evidence', 'exhibit', 'certificate', 'fsl', 'triage',
  'vakalatnama', 'ledger', 'audit', 'search',
];

/** Which query families each kind of ledger event can change. Unknown types touch all. */
const RULES = [
  [/^AI_/, ['cases', 'case', 'evidence', 'exhibit', 'fsl', 'triage']],
  [
    /^(EVIDENCE|CERTIFICATE|FORENSIC|FSL|REFERRAL|CUSTODY)/,
    ['cases', 'case', 'case-file', 'evidence', 'exhibit', 'certificate', 'fsl', 'triage', 'ledger', 'audit', 'search'],
  ],
  [
    /^CASE_/,
    ['cases', 'case', 'case-file', 'evidence', 'exhibit', 'fsl', 'triage', 'vakalatnama', 'ledger', 'audit', 'search'],
  ],
  [
    /^(VAKALATNAMA|ACCESS|GRANT|REPRESENTATION)/,
    ['vakalatnama', 'cases', 'case', 'case-file', 'evidence', 'exhibit', 'certificate', 'ledger', 'audit'],
  ],
];

/** Families whose second key segment is a case id / an evidence id. */
const BY_CASE = new Set(['case', 'case-file', 'ledger']);
const BY_EVIDENCE = new Set(['exhibit']);

/** A verification result is an audited act, never something to refetch. */
const isVerifyKey = (key) => key?.[2] === 'verify' || (key?.[0] === 'ledger' && key?.[1] === 'verify-chain');

/**
 * Invalidate everything a batch of changes can have touched.
 * @param {import('@tanstack/react-query').QueryClient} qc
 * @param {{ type: string|null, caseId: string|null, evidenceId: string|null }[]} changes
 */
export function invalidateForChanges(qc, changes) {
  /** head -> { all: boolean, ids: Set<string> } */
  const plan = new Map();
  const mark = (head, id) => {
    const entry = plan.get(head) ?? { all: false, ids: new Set() };
    if (id) entry.ids.add(String(id));
    else entry.all = true;
    plan.set(head, entry);
  };

  for (const change of changes) {
    const type = change.type ?? '';
    const heads = RULES.find(([re]) => re.test(type))?.[1] ?? EVERYTHING;
    // A case-level event (stage, closure) changes every exhibit's lifecycle in the case.
    const caseLevel = /^CASE_/.test(type) || !change.evidenceId;
    for (const head of heads) {
      if (BY_CASE.has(head)) mark(head, change.caseId);
      else if (BY_EVIDENCE.has(head)) mark(head, caseLevel ? null : change.evidenceId);
      else mark(head, null);
    }
  }
  if (!plan.size) return;

  qc.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (isVerifyKey(key)) return false;
      const entry = plan.get(key?.[0]);
      if (!entry) return false;
      return entry.all || entry.ids.has(String(key?.[1]));
    },
  });
}

const isLiveQuery = (query) => !NEVER.has(query.queryKey?.[0]) && !isVerifyKey(query.queryKey);
const isPolledQuery = (query) => POLLED.has(query.queryKey?.[0]) && !isVerifyKey(query.queryKey);

/**
 * @param {boolean} enabled   true while a user is signed in
 * @param {string} [identity] restarts the stream when a different user signs in
 */
export function useRealtimeSync(enabled, identity) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return undefined;

    let pending = [];
    let timer = null;
    let firstPendingAt = 0;
    const flush = () => {
      timer = null;
      const batch = pending;
      pending = [];
      invalidateForChanges(qc, batch);
    };

    const offChange = onRealtimeChange((change) => {
      if (!pending.length) firstPendingAt = Date.now();
      pending.push(change);
      clearTimeout(timer);
      const waited = Date.now() - firstPendingAt;
      timer = setTimeout(flush, waited >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS);
    });

    const offReady = onRealtimeReady(({ reconnected }) => {
      if (reconnected) qc.invalidateQueries({ predicate: isLiveQuery });
    });

    let lastPoll = 0;
    const poll = setInterval(() => {
      const { status, downSince } = getRealtimeState();
      if (status === 'live' || !downSince || document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - downSince < POLL_AFTER_DOWN_MS || now - lastPoll < POLL_EVERY_MS) return;
      lastPoll = now;
      qc.invalidateQueries({ predicate: isPolledQuery });
    }, 5_000);

    startRealtime();

    return () => {
      offChange();
      offReady();
      clearInterval(poll);
      clearTimeout(timer);
      stopRealtime();
    };
  }, [enabled, identity, qc]);
}

/** `{ status: 'idle'|'connecting'|'live'|'reconnecting', downSince }`. */
export function useRealtimeStatus() {
  return useSyncExternalStore(subscribeRealtimeStatus, getRealtimeState, getRealtimeState);
}
