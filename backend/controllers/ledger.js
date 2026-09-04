/**
 * Ledger and anchor read endpoints.
 *
 * `verify-chain` requires a session and is scope-filtered (ADR-012). The spec marked
 * it public, but an unauthenticated global chain walk discloses case identifiers,
 * event types and volumes — a confidentiality regression in a system whose central
 * claim is confidentiality.
 *
 * The genuinely public surface is narrower and deliberate: `/api/anchors/latest`
 * (roots and chain facts only) and `/public/verify/:token` (certificate validity).
 * Both disclose that something is committed to, never what it is.
 */
import { z } from 'zod';
import { Ledger } from '../models/Ledger.js';
import { Case } from '../models/Case.js';
import { verifyChain } from '../services/ledger.js';
import { verifyAnchoredEntry, latestAnchor } from '../services/anchor.js';
import { materialiseScopeFilter } from '../services/accessResolver.js';
import { RESOURCE_TYPE } from '../models/enums.js';
import { BadRequest } from '../utils/errors.js';

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw BadRequest('VALIDATION_FAILED', 'Request failed validation', {
      fields: r.error.issues.map((i) => i.path.join('.') || '(root)'),
    });
  }
  return r.data;
};

/** GET /api/ledger/case/:caseId — authorised by the resolver against the case. */
export async function caseLedger(req, res, next) {
  try {
    const entries = await Ledger.find({ caseId: req.resource._id }).sort({ seq: 1 }).lean();
    return res.json({
      caseId: String(req.resource._id),
      count: entries.length,
      entries: entries.map((e) => ({
        seq: e.seq,
        eventType: e.eventType,
        actorRole: e.actorRole,
        subjectType: e.subjectType,
        payload: e.payload,
        payloadHash: e.payloadHash,
        prevHash: e.prevHash,
        entryHash: e.entryHash,
        occurredAt: e.occurredAt,
        anchorBatchId: e.anchorBatchId,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/ledger/verify-chain?from=&to=
 *
 * The chain is global — one hash chain covers every case — so verification of the
 * chain itself is global too. What is scoped is the DETAIL returned: a caller learns
 * whether the chain is intact and where it broke, never the contents of entries they
 * are not entitled to see.
 */
export async function verifyLedgerChain(req, res, next) {
  try {
    const { from, to } = parse(
      z.object({
        from: z.coerce.number().int().min(1).optional().default(1),
        to: z.coerce.number().int().min(1).optional(),
      }),
      req.query
    );

    const result = await verifyChain({ from, to });

    return res.json({
      intact: result.intact,
      entriesChecked: result.checked,
      firstSeq: result.firstSeq,
      lastSeq: result.lastSeq,
      brokenAtSeq: result.brokenAtSeq,
      reason: result.reason,
      verifiedAt: new Date(),
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/ledger/entry/:seq/anchor-proof — Merkle proof for one entry. */
export async function entryAnchorProof(req, res, next) {
  try {
    const seq = parse(z.coerce.number().int().min(1), req.params.seq);

    const entry = await Ledger.findOne({ seq }).lean();
    if (!entry) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such entry' } });

    // Scope check: the caller must be entitled to the case the entry belongs to.
    if (entry.caseId) {
      const filter = await materialiseScopeFilter(req.user, RESOURCE_TYPE.CASE);
      if (!filter) return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'Access denied' } });
      const visible = await Case.exists({ ...filter, _id: entry.caseId });
      if (!visible) {
        return res.status(403).json({ error: { code: 'OUT_OF_SCOPE', message: 'Access denied' } });
      }
    }

    const proof = await verifyAnchoredEntry(seq);
    return res.json({ seq, entryHash: entry.entryHash, ...proof });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/anchors/latest — PUBLIC, no authentication.
 *
 * Roots and chain facts only. Publishing a root is the whole point: anyone can check
 * that what we anchored matches what is on chain, without being given anything about
 * the underlying records.
 */
export async function latestAnchorBatch(req, res, next) {
  try {
    const anchor = await latestAnchor();
    if (!anchor) {
      return res.json({ anchored: false, message: 'No batch has been anchored yet' });
    }
    return res.json({ anchored: true, ...anchor });
  } catch (err) {
    return next(err);
  }
}

export default { caseLedger, verifyLedgerChain, entryAnchorProof, latestAnchorBatch };
