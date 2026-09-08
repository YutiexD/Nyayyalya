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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evidence'] });
      qc.invalidateQueries({ queryKey: ['fsl', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
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

export function useInitiateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.custody.initiateTransfer(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custody'] }),
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

// ------------------------------------------------------------------- FSL ----

export const useReferrals = (query, options) =>
  useQuery({ queryKey: qk.referrals(query), queryFn: () => api.fsl.referrals(query), ...options });

export function useAcceptReferral() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.fsl.accept(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fsl', 'referrals'] }),
  });
}

export function useFileReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, form }) => api.fsl.report(id, form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fsl', 'referrals'] });
      qc.invalidateQueries({ queryKey: ['evidence'] });
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

export function usePreparePack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, payload }) => api.disclosure.prepare(caseId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['disclosure'] });
      qc.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
}

export function useSyncRepresentation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId) => api.disclosure.syncRepresentation(caseId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['disclosure'] }),
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

// ---------------------------------------------------------- certificates ----

export const useCertificate = (id, options) =>
  useQuery({
    queryKey: qk.certificate(id),
    queryFn: () => api.certificates.get(id),
    enabled: Boolean(id),
    ...options,
  });

export function useGenerateCertificate() {
  return useMutation({ mutationFn: (evidenceId) => api.certificates.generate(evidenceId) });
}

export function useSignPartA() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.certificates.signPartA(id, payload),
    onSuccess: (_d, { id }) => qc.invalidateQueries({ queryKey: qk.certificate(id) }),
  });
}

export function useSignPartB() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }) => api.certificates.signPartB(id, payload),
    onSuccess: (_d, { id }) => qc.invalidateQueries({ queryKey: qk.certificate(id) }),
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
