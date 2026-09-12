/**
 * Every server read and write, as hooks.
 *
 * One file rather than one per feature, because the invalidation relationships cross
 * features constantly: uploading an exhibit changes the case timeline, the ledger, the
 * triage queue and the anchor tail; serving a disclosure pack changes the pack list,
 * the case clocks and the advocate's own view. Those edges are only correct if they
 * are visible together.
 *
 * Reads are queries; anything that mutates is a mutation that names what it
 * invalidates. Nothing in the app calls `api.*` directly — that way a new screen
 * cannot accidentally read server state into a component and hold it stale.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk } from '@/lib/queryClient';

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
    // Filing binds the case to a court and closes it to investigative writes, so the
    // case, its timeline, the ledger and every list that shows a stage are all stale.
    onSuccess: (_data, caseId) => {
      qc.invalidateQueries({ queryKey: ['cases'] });
      qc.invalidateQueries({ queryKey: qk.case(caseId) });
      qc.invalidateQueries({ queryKey: qk.caseTimeline(caseId) });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

/**
 * The court closing the case.
 *
 * Closing changes what every screen may do with the case — it becomes readable and
 * nothing more — so the case, its lists, its timeline and the ledger are all stale.
 */
export function useCloseCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, reason }) => api.cases.close(caseId, reason),
    onSuccess: (_d, { caseId }) => {
      qc.invalidateQueries({ queryKey: ['cases'] });
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

export const useExhibit = (id, options) =>
  useQuery({ queryKey: qk.exhibit(id), queryFn: () => api.evidence.get(id), enabled: Boolean(id), ...options });

export const useTriageQueue = (query, options) =>
  useQuery({ queryKey: qk.triage(query), queryFn: () => api.evidence.triageQueue(query), ...options });

/**
 * Verify is a MUTATION, not a query, even though it reads.
 *
 * It writes a VERIFY row to the audit log every time it runs, so it must happen when
 * the user asks and never on a refetch, a window focus, or a cache revalidation. A
 * query would put unexplained verification events in the one log that has to mean
 * something.
 */
export function useVerifyExhibit() {
  return useMutation({ mutationFn: (id) => api.evidence.verify(id) });
}

export function useUploadEvidence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form) => api.evidence.upload(form),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: ['triage'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
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
      // The exhibit's own forensic status and the queue's status column both move to
      // "Referred". Without these the station kept showing "Not referred" and invited
      // a second referral that the server refuses as a duplicate.
      qc.invalidateQueries({ queryKey: qk.exhibit(evidenceId) });
      qc.invalidateQueries({ queryKey: ['triage'] });
    },
  });
}

// ---------------------------------------------------------------- custody ----

export const useCustodyItems = (query, options) =>
  useQuery({ queryKey: qk.custodyItems(query), queryFn: () => api.custody.items(query), ...options });

export const useCustodyGaps = (query, options) =>
  useQuery({ queryKey: qk.custodyGaps(query), queryFn: () => api.custody.gaps(query), ...options });

export const useCustodyChain = (id, options) =>
  useQuery({
    queryKey: qk.custodyChain(id),
    queryFn: () => api.custody.chain(id),
    enabled: Boolean(id),
    ...options,
  });

export function useCreateCustodyItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => api.custody.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custody'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export function useScanCustodyLabel() {
  return useMutation({ mutationFn: (qrToken) => api.custody.scan(qrToken) });
}

export const useCustodyRecipients = (id, options) =>
  useQuery({
    queryKey: qk.custodyRecipients(id),
    queryFn: () => api.custody.recipients(id),
    enabled: Boolean(id),
    ...options,
  });

export function useInitiateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.custody.initiateTransfer(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custody'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export function useAcceptTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.custody.acceptTransfer(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custody'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

/** An SHO's recorded decision lifting a seal-exception freeze. */
export function useLiftFreeze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.custody.liftFreeze(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custody'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

/**
 * Counsel reaching for a case by its CNR, or an exhibit by its code. Mutations, not
 * queries: each is an attempt the server audits — allowed or refused — so it happens
 * when the advocate asks and never on a background refetch.
 */
export function useOpenCaseByCnr() {
  return useMutation({ mutationFn: (cnr) => api.cases.byCnr(cnr) });
}

export function useOpenExhibitByCode() {
  return useMutation({ mutationFn: (code) => api.evidence.byCode(code) });
}

// ------------------------------------------------------------------- FSL ----

/**
 * The examiner's review queue — the screen the automatic review priority exists for.
 * `state` is PENDING (the default, and the work), REVIEWED, or ALL.
 */
export const useLabQueue = (query, options) =>
  useQuery({ queryKey: qk.labQueue(query), queryFn: () => api.fsl.queue(query), ...options });

/**
 * A laboratory recording its opinion on an exhibit.
 *
 * It changes the exhibit, the queue it came from, the case summaries that count
 * opinions, the certificates whose Part B it becomes, and the ledger. All of them.
 */
export function useRecordVerdict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ evidenceId, form }) => api.evidence.recordVerdict(evidenceId, form),
    onSuccess: (_d, { evidenceId }) => {
      qc.invalidateQueries({ queryKey: ['fsl'] });
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: qk.exhibit(evidenceId) });
      qc.invalidateQueries({ queryKey: ['triage'] });
      qc.invalidateQueries({ queryKey: ['cases'] });
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
      qc.invalidateQueries({ queryKey: ['fsl', 'referrals'] });
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
      qc.invalidateQueries({ queryKey: ['fsl', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: ['exhibit'] });
      qc.invalidateQueries({ queryKey: ['triage'] });
      // Certificates now report that a report has landed which their Part B lacks.
      qc.invalidateQueries({ queryKey: ['certificate'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

// ------------------------------------------------------------ disclosure ----

export const usePacksForCase = (caseId, status, options) =>
  useQuery({
    queryKey: qk.packsForCase(caseId, status),
    queryFn: () => api.disclosure.packsForCase(caseId, status),
    enabled: Boolean(caseId),
    ...options,
  });

export const useMyPack = (caseId, options) =>
  useQuery({
    queryKey: qk.myPack(caseId),
    queryFn: () => api.disclosure.myPack(caseId),
    enabled: Boolean(caseId),
    ...options,
  });

/**
 * The court sharing the case file: composed, ruled on and served in one act.
 *
 * It puts material in front of counsel for the first time, so it invalidates the
 * disclosure views, the case (its clocks move), the case lists, and the ledger.
 */
export function useShareCaseFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, payload }) => api.disclosure.share(caseId, payload),
    onSuccess: (_d, { caseId }) => {
      qc.invalidateQueries({ queryKey: ['disclosure'] });
      qc.invalidateQueries({ queryKey: ['cases'] });
      qc.invalidateQueries({ queryKey: qk.case(caseId) });
      qc.invalidateQueries({ queryKey: qk.caseTimeline(caseId) });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export function usePreparePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, payload }) => api.disclosure.prepare(caseId, payload),
    onSuccess: (_d, { caseId }) => {
      qc.invalidateQueries({ queryKey: ['disclosure'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
      // The case record now reports the pack, which the officer's screen reads.
      qc.invalidateQueries({ queryKey: qk.case(caseId) });
    },
  });
}

export function useSyncRepresentation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId) => api.disclosure.syncRepresentation(caseId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['disclosure'] });
      // The on-record list and the serve recipients read the representation query.
      qc.invalidateQueries({ queryKey: ['vakalatnama'] });
    },
  });
}

export function useApprovePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ packId, payload }) => api.disclosure.approve(packId, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['disclosure'] }),
  });
}

export function useServePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ packId, payload }) => api.disclosure.serve(packId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['disclosure'] });
      qc.invalidateQueries({ queryKey: ['cases'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export function useAcknowledgePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (packId) => api.disclosure.acknowledge(packId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['disclosure'] }),
  });
}

/** A lookup the court runs on demand — never on a refetch, since each one is audited. */
export function useTraceWatermark() {
  return useMutation({ mutationFn: (token) => api.disclosure.trace(token) });
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
 * Accepting puts an advocate on record, which changes who a pack can be served on,
 * who can read the case, and the ledger — so all of those are stale afterwards.
 */
export function useRuleOnFiling() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, note }) =>
      decision === 'ACCEPT' ? api.vakalatnama.accept(id) : api.vakalatnama.reject(id, note),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vakalatnama'] });
      qc.invalidateQueries({ queryKey: ['disclosure'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
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
 * The certificates for one exhibit, or — for an examiner, whose read on the exhibit
 * ends when they report — for one referral.
 */
export const useCertificatesFor = ({ evidenceId, referralId }, options) =>
  useQuery({
    queryKey: referralId ? qk.certificatesForReferral(referralId) : qk.certificatesForEvidence(evidenceId),
    queryFn: () =>
      referralId ? api.fsl.certificates(referralId) : api.certificates.forEvidence(evidenceId),
    enabled: Boolean(evidenceId || referralId),
    ...options,
  });

export function useGenerateCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (evidenceId) => api.certificates.generate(evidenceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['certificate'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export function useSignPartA() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.certificates.signPartA(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['certificate'] }),
  });
}

export function useSignPartB() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.certificates.signPartB(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['certificate'] }),
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

/**
 * Chain verification is a mutation for the same reason exhibit verification is: it is
 * an act the user performs, not a value that gets refreshed underneath them.
 */
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
