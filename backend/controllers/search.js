/**
 * Search.
 *
 * The rule: ALWAYS intersect with the resolver's scope filter before querying, never
 * after. Filtering results post-hoc is how search becomes the back door around every
 * other access control — the database would still have read the rows, and any bug in
 * the filtering step exposes them.
 *
 * Every query is logged, including the ones that return nothing. Search terms are
 * themselves investigative signal: who looked for what, and when.
 */
import { z } from 'zod';
import { Case } from '../models/Case.js';
import { Evidence } from '../models/Evidence.js';
import { materialiseScopeFilter } from '../services/accessResolver.js';
import { writeAudit } from '../middleware/audit.js';
import { RESOURCE_TYPE, ACTION, DECISION } from '../models/enums.js';
import { BadRequest, ServiceUnavailable } from '../utils/errors.js';
import { loggerFor } from '../utils/logger.js';

const log = loggerFor('search');

const parse = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw BadRequest('VALIDATION_FAILED', 'Request failed validation', {
      fields: r.error.issues.map((i) => i.path.join('.') || '(root)'),
    });
  }
  return r.data;
};

/**
 * GET /api/search?q=&caseId=&limit=
 */
export async function search(req, res, next) {
  try {
    const q = parse(
      z.object({
        q: z.string().trim().min(2).max(200),
        caseId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional().default(25),
      }),
      req.query
    );

    // 1. What may this user see AT ALL?
    const caseFilter = await materialiseScopeFilter(req.user, RESOURCE_TYPE.CASE);

    await writeAudit(req, {
      action: ACTION.READ,
      resourceType: RESOURCE_TYPE.SEARCH,
      resourceLabel: q.q.slice(0, 120),
      caseId: q.caseId ?? null,
      decision: DECISION.ALLOW,
      reason: 'SEARCH_QUERY',
    });

    if (!caseFilter) return res.json({ query: q.q, cases: [], evidence: [], total: 0 });

    const visibleCaseIds = await Case.distinct('_id', caseFilter);
    if (visibleCaseIds.length === 0) {
      return res.json({ query: q.q, cases: [], evidence: [], total: 0 });
    }

    // 2. A requested caseId narrows the visible set; it can never widen it.
    const scopedCaseIds = q.caseId
      ? visibleCaseIds.filter((id) => String(id) === q.caseId)
      : visibleCaseIds;

    // 3. Now, and only now, run the text query — inside the scope, never outside it.
    //
    // These deliberately do NOT swallow errors. An earlier version caught each query
    // and returned `[]`, which made a dropped connection or a missing text index
    // indistinguishable from "nothing matched" — the worst possible failure mode for
    // a search over evidence, because an investigator would conclude a record does
    // not exist when the truth is that we failed to look. A failure is now reported
    // as a failure.
    let cases;
    let evidence;
    try {
      [cases, evidence] = await Promise.all([
        Case.find({ _id: { $in: scopedCaseIds }, $text: { $search: q.q } })
          .select('firNumber title stage stationCode districtCode createdAt')
          .limit(q.limit)
          .lean(),
        Evidence.find({ caseId: { $in: scopedCaseIds }, $text: { $search: q.q } })
          .select('exhibitCode title caseId mimeType triage.priority courtStatus createdAt')
          .limit(q.limit)
          .lean(),
      ]);
    } catch (err) {
      // Log the real database error for an operator; return a safe, typed code to the
      // caller so a client can tell "search is broken" from "search found nothing".
      log.error({ err: err.message, query: q.q.slice(0, 120) }, 'search query failed');
      throw ServiceUnavailable(
        'SEARCH_UNAVAILABLE',
        'Search is temporarily unavailable. This is not a statement that no records matched.'
      );
    }

    return res.json({
      query: q.q,
      cases,
      evidence,
      total: cases.length + evidence.length,
    });
  } catch (err) {
    return next(err);
  }
}

export default { search };
