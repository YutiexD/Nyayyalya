/**
 * Every server read and write, as hooks.
 *
 * One file rather than one per feature, because invalidation crosses features: an
 * upload changes the case, its timeline, the ledger, the lab queue and the certificate
 * register. Reads are queries; anything that mutates is a mutation that names what it
 * invalidates. Nothing in the app calls `api.*` for server state directly.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk } from '@/lib/queryClient';

/** Statuses in which an AI analysis has not come back yet. */
const ANALYSIS_IN_FLIGHT = new Set(['PENDING', 'PROCESSING']);

/**
 * Poll while any exhibit in a response is still being analysed, and stop the moment
 * none is. Only laboratory responses carry `aiAnalysis`, so other roles never poll.
 */
const pollWhileAnalysing = (collect) => (query) => {
  const exhibits = collect(query.state.data) ?? [];
  return exhibits.some((e) => ANALYSIS_IN_FLIGHT.has(e?.aiAnalysis?.status)) ? 4000 : false;
};

/** Everything that shows a case, its evidence or its progress. */
const invalidateCaseViews = (qc) => {
  qc.invalidateQueries({ queryKey: ['cases'] });
  qc.invalidateQueries({ queryKey: ['case'] });
  qc.invalidateQueries({ queryKey: ['case-file'] });
  qc.invalidateQueries({ queryKey: ['fsl'] });
};

// ------------------------------------------------------------------ cases ----

export const useCases = (query, options) =>
  useQuery({ queryKey: qk.cases(query), queryFn: () => api.cases.list(query), ...options });

export const useCase = (id, options) =>
  useQuery({ queryKey: qk.case(id), queryFn: () => api.cases.get(id), enabled: Boolean(id), ...options });

export const useCaseTimeline = (id, options) =>
  useQuery({
    queryKey: qk.caseTimeline(id),
    queryFn: () => api.cases.timeline(id),
    enabled: Boolean(id),
    ...options,
  });

/** The case grouped for a dashboard. Polls while an AI analysis is still running. */
export const useCaseOverview = (id, options) =>
  useQuery({
    queryKey: qk.caseOverview(id),
    queryFn: () => api.cases.overview(id),
    enabled: Boolean(id),
    refetchInterval: pollWhileAnalysing((d) => d?.evidence),
    ...options,
  });

export const useCaseWorkflow = (id, options) =>
  useQuery({
    queryKey: qk.caseWorkflow(id),
    queryFn: () => api.cases.workflow(id),
    enabled: Boolean(id),
    ...options,
  });

/**
 * The case file: `{ caseId, cnrNumber, firNumber, title, stage, courtId, onRecord,
 * clocks, exhibitCount, exhibits }`. Counsel on record read it automatically.
 */
export const useCaseFile = (caseId, options) =>
  useQuery({
    queryKey: qk.caseFile(caseId),
    queryFn: () => api.disclosure.caseFile(caseId),
    enabled: Boolean(caseId),
    ...options,
  });

/**
 * A judicial act on a case. The server's state machine decides whether it is valid;
 * the client names the act, never the stage.
 */
export function useTransitionCase() {
  const qc = useQueryClient();
  return useMutation({
    // `form` (multipart) is used when closing with a signed judgment or declaration.
    mutationFn: ({ caseId, action, note, form }) =>
      form ? api.cases.transitionWithDocument(caseId, form) : api.cases.transition(caseId, action, note),
    onSuccess: () => {
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: ['ledger'] });
      // Every exhibit's lifecycle carries the case stage.
      qc.invalidateQueries({ queryKey: ['exhibit'] });
    },
  });
}

export function useCreateCaseFromFir() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (firNumber) => api.cases.fromFir(firNumber),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cases'] }),
  });
}

export function useComputeJurisdiction() {
  return useMutation({ mutationFn: (caseId) => api.cases.computeJurisdiction(caseId) });
}

export function useFileChargesheet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId) => api.cases.fileChargesheet(caseId),
    // Filing binds the case to a court and closes it to investigative writes.
    onSuccess: (_data, caseId) => {
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: qk.case(caseId) });
      qc.invalidateQueries({ queryKey: qk.caseTimeline(caseId) });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

/** The court closing the case: it becomes readable and nothing more. */
export function useCloseCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, reason }) => api.cases.close(caseId, reason),
    onSuccess: (_d, { caseId }) => {
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: qk.case(caseId) });
      qc.invalidateQueries({ queryKey: qk.caseTimeline(caseId) });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export function useRecordOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, payload }) => api.cases.recordOrder(caseId, payload),
    onSuccess: (_d, { caseId }) => {
      qc.invalidateQueries({ queryKey: qk.case(caseId) });
      qc.invalidateQueries({ queryKey: qk.caseTimeline(caseId) });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

// --------------------------------------------------------------- evidence ----

export const useEvidence = (query, options) =>
  useQuery({ queryKey: qk.evidence(query), queryFn: () => api.evidence.list(query), ...options });

/** One exhibit. Polls while its AI analysis is pending or processing (FSL responses only). */
export const useExhibit = (id, options) =>
  useQuery({
    queryKey: qk.exhibit(id),
    queryFn: () => api.evidence.get(id),
    enabled: Boolean(id),
    refetchInterval: pollWhileAnalysing((d) => (d?.evidence ? [d.evidence] : [])),
    ...options,
  });

/** Re-queue a failed AI analysis. FSL only. */
/** One exhibit's lifecycle: every step with its description, actor and proofs. */
export const useEvidenceLifecycle = (evidenceId, options) =>
  useQuery({
    queryKey: qk.exhibitLifecycle(evidenceId),
    queryFn: () => api.evidence.lifecycle(evidenceId),
    enabled: Boolean(evidenceId),
    ...options,
  });

export function useRetryAiAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (evidenceId) => api.evidence.retryAiAnalysis(evidenceId),
    onSuccess: (_d, evidenceId) => {
      qc.invalidateQueries({ queryKey: qk.exhibit(evidenceId) });
      qc.invalidateQueries({ queryKey: ['evidence'] });
      invalidateCaseViews(qc);
    },
  });
}

export const useTriageQueue = (query, options) =>
  useQuery({ queryKey: qk.triage(query), queryFn: () => api.evidence.triageQueue(query), ...options });

/**
 * Verify is a MUTATION, not a query, even though it reads: every run is written to the
 * audit log, so it must happen when the user asks and never on a refetch.
 */
export function useVerifyExhibit() {
  return useMutation({ mutationFn: (id) => api.evidence.verify(id) });
}

/** Upload evidence. The server issues the s.63 certificate as part of the same request. */
export function useUploadEvidence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form) => api.evidence.upload(form),
    onSuccess: (data) => {
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: ['triage'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
      qc.invalidateQueries({ queryKey: ['certificate'] });
      const caseId = data?.evidence?.caseId;
      if (caseId) qc.invalidateQueries({ queryKey: qk.caseTimeline(caseId) });
    },
  });
}

export function useReferToFsl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ evidenceId, payload }) => api.evidence.referFsl(evidenceId, payload),
    onSuccess: (_d, { evidenceId }) => {
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: ['fsl', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
      qc.invalidateQueries({ queryKey: qk.exhibit(evidenceId) });
      qc.invalidateQueries({ queryKey: ['triage'] });
      invalidateCaseViews(qc);
    },
  });
}

/**
 * Counsel reaching for a case by its CNR, or an exhibit by its code. Mutations, not
 * queries: each is an audited attempt, so it happens only when asked.
 */
export function useOpenCaseByCnr() {
  return useMutation({ mutationFn: (cnr) => api.cases.byCnr(cnr) });
}

export function useOpenExhibitByCode() {
  return useMutation({ mutationFn: (code) => api.evidence.byCode(code) });
}

// ------------------------------------------------------------------- FSL ----

/** The examiner's review queue. `state` is PENDING (the default), REVIEWED, or ALL. */
export const useLabQueue = (query, options) =>
  useQuery({ queryKey: qk.labQueue(query), queryFn: () => api.fsl.queue(query), ...options });

/**
 * The laboratory's work grouped by case: `{ cases: [{ case, summary, highestPriority,
 * evidence }], counts }`. Polls while any analysis is running.
 */
export const useFslCases = (query, options) =>
  useQuery({
    queryKey: qk.fslCases(query),
    queryFn: () => api.fsl.cases(query),
    refetchInterval: pollWhileAnalysing((d) => (d?.cases ?? []).flatMap((g) => g.evidence ?? [])),
    ...options,
  });

/** A laboratory recording its verdict on an exhibit. */
export function useRecordVerdict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ evidenceId, form }) => api.evidence.recordVerdict(evidenceId, form),
    // Settled, not success: a 409 VERDICT_ALREADY_RECORDED means the screen is stale.
    onSettled: (_d, _e, { evidenceId }) => {
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: qk.exhibit(evidenceId) });
      qc.invalidateQueries({ queryKey: ['triage'] });
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: ['certificate'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export const useReferrals = (query, options) =>
  useQuery({ queryKey: qk.referrals(query), queryFn: () => api.fsl.referrals(query), ...options });

export function useAcceptReferral() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.fsl.accept(id),
    onSuccess: () => {
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: ['exhibit'] });
      qc.invalidateQueries({ queryKey: ['triage'] });
    },
  });
}

export function useFileReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, form }) => api.fsl.report(id, form),
    onSuccess: () => {
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: ['exhibit'] });
      qc.invalidateQueries({ queryKey: ['triage'] });
      qc.invalidateQueries({ queryKey: ['certificate'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

// ------------------------------------------------------------ vakalatnama ----

export const useMyFilings = (options) =>
  useQuery({ queryKey: qk.vakalatnamaMine, queryFn: () => api.vakalatnama.mine(), ...options });

export const useRepresentation = (caseId, options) =>
  useQuery({
    queryKey: qk.vakalatnamaForCase(caseId),
    queryFn: () => api.vakalatnama.forCase(caseId),
    enabled: Boolean(caseId),
    ...options,
  });

export function useFileVakalatnama() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form) => api.vakalatnama.file(form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vakalatnama'] }),
  });
}

/**
 * The court ruling on a filing. Accepting puts the advocate on record, which gives them
 * the case and every exhibit automatically — so cases, evidence, the case file and
 * certificates are all stale afterwards.
 */
export function useRuleOnFiling() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, note }) =>
      decision === 'ACCEPT' ? api.vakalatnama.accept(id) : api.vakalatnama.reject(id, note),
    onSuccess: () => {
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: ['vakalatnama'] });
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: ['certificate'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export function useSyncRepresentation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId) => api.disclosure.syncRepresentation(caseId),
    onSuccess: () => {
      invalidateCaseViews(qc);
      qc.invalidateQueries({ queryKey: ['vakalatnama'] });
    },
  });
}

// ---------------------------------------------------------- certificates ----

export const useCertificate = (id, options) =>
  useQuery({
    queryKey: qk.certificate(id),
    queryFn: () => api.certificates.get(id),
    enabled: Boolean(id),
    ...options,
  });

/**
 * The certificate register for one exhibit: `{ evidenceId, exhibitCode, active,
 * certificates, total }`. `active` is the one current certificate, or null.
 */
export const useCertificateFor = (evidenceId, options) =>
  useQuery({
    queryKey: qk.certificatesForEvidence(evidenceId),
    queryFn: () => api.certificates.forEvidence(evidenceId),
    enabled: Boolean(evidenceId),
    ...options,
  });

/**
 * One-click certificate verification. A mutation, because every run is audited. On
 * success the certificate's `lastVerification` has moved, so the register is refetched.
 */
export function useVerifyCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.certificates.verify(id),
    // A verification updates the certificate's last result, which the lab list, case
    // overviews and exhibit views all show.
    onSuccess: () =>
      qc.invalidateQueries({
        predicate: (q) => {
          const head = String(q.queryKey?.[0] ?? '');
          return /^(certificate|fsl|case|evidence|exhibit)/i.test(head);
        },
      }),
  });
}

// ---------------------------------------------------- ledger, anchor, audit ----

export const useLedger = (caseId, options) =>
  useQuery({
    queryKey: qk.ledger(caseId),
    queryFn: () => api.ledger.forCase(caseId),
    enabled: Boolean(caseId),
    ...options,
  });

export const useLatestAnchor = (options) =>
  useQuery({ queryKey: qk.anchorLatest, queryFn: () => api.publicLatestAnchor(), ...options });

export const useRecentAnchors = (options) =>
  useQuery({ queryKey: qk.anchorRecent, queryFn: () => api.publicRecentAnchors(), ...options });

export const useAudit = (query, options) =>
  useQuery({ queryKey: qk.audit(query), queryFn: () => api.audit.list(query), ...options });

export const useSecurityFeed = (options) =>
  useQuery({ queryKey: qk.auditSecurity, queryFn: () => api.audit.security(), ...options });

/** Chain verification is an act the user performs, so it is a mutation. */
export function useVerifyChain() {
  return useMutation({ mutationFn: () => api.ledger.verifyChain() });
}

// ----------------------------------------------------------------- search ----

export const useSearch = (q, options) =>
  useQuery({
    queryKey: qk.search(q),
    queryFn: () => api.search({ q }),
    // Two characters is the server's own minimum; querying below it just earns a 400.
    enabled: Boolean(q && q.trim().length >= 2),
    ...options,
  });
