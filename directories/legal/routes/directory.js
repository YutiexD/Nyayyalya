/**
 * Legal & FSL directory endpoints (§3.3).
 *
 *   GET /directory/advocate/:enrolmentNo        verify an advocate (Bar Council)
 *   GET /directory/lab/:labCode                 lab + s.79A notification reference
 *   GET /directory/examiner/:examinerCode       examiner + their lab
 *   GET /directory/legal-aid-panel?district=    DLSA panel for a district
 *
 * `UP/1234/2015` contains slashes, so /advocate accepts either the percent-encoded
 * single segment (`UP%2F1234%2F2015`) or the three-segment form; both normalise to
 * the same enrolment number.
 *
 * Real status values are always returned: `status`, and `copValidTill` with a
 * derived `copValid`. Lexx re-checks these on every login, so a lapsed certificate
 * of practice must be visible, not hidden behind a 404.
 */
import { Router } from 'express';
import { route } from '../../common/app.js';
import { NotFound } from '../../common/errors.js';
import {
  PATTERNS,
  identifier,
  optionalEnumValue,
  boundedInt,
  joinSegments,
} from '../../common/validate.js';
import { Advocate, FslLab, FslExaminer, ADVOCATE_STATUSES } from '../models/index.js';

const labView = (l) =>
  l && {
    labCode: l.labCode,
    name: l.name,
    section79ANotificationRef: l.section79ANotificationRef,
    disciplines: l.disciplines ?? [],
    stateCode: l.stateCode,
  };

const advocateView = (a, now) => ({
  enrolmentNo: a.enrolmentNo,
  name: a.name,
  barCouncil: a.barCouncil,
  enrolmentDate: a.enrolmentDate,
  copValidTill: a.copValidTill,
  // Derived for convenience only. `copValidTill` is the fact; Lexx may recompute.
  copValid: a.copValidTill >= now,
  status: a.status,
  isLegalAidPanel: a.isLegalAidPanel,
  districtCode: a.districtCode,
  districtName: a.districtName,
  phone: a.phone,
});

export function directoryRouter() {
  const router = Router();

  // --------------------------------------------------------------- advocate ----
  const advocateHandler = route(async (req, res) => {
    const raw = req.params.b
      ? joinSegments(req.params, ['enrolmentNo', 'b', 'c'])
      : req.params.enrolmentNo;
    const enrolmentNo = identifier(raw, 'enrolmentNo', PATTERNS.ENROLMENT_NO);

    const advocate = await Advocate.findOne({ enrolmentNo }).lean();
    if (!advocate) throw NotFound('ADVOCATE_NOT_FOUND', 'No advocate with that enrolment number.');
    res.json(advocateView(advocate, new Date()));
  });

  router.get('/advocate/:enrolmentNo/:b/:c', advocateHandler);
  router.get('/advocate/:enrolmentNo', advocateHandler);

  // -------------------------------------------------------------------- lab ----
  router.get(
    '/lab/:labCode',
    route(async (req, res) => {
      const labCode = identifier(req.params.labCode, 'labCode', PATTERNS.DASHED_CODE);
      const lab = await FslLab.findOne({ labCode }).lean();
      if (!lab) throw NotFound('LAB_NOT_FOUND', 'No forensic science laboratory with that code.');
      res.json(labView(lab));
    })
  );

  // --------------------------------------------------------------- examiner ----
  router.get(
    '/examiner/:examinerCode',
    route(async (req, res) => {
      const examinerCode = identifier(
        req.params.examinerCode,
        'examinerCode',
        PATTERNS.DASHED_CODE
      );
      const examiner = await FslExaminer.findOne({ examinerCode }).lean();
      if (!examiner) throw NotFound('EXAMINER_NOT_FOUND', 'No FSL examiner with that code.');

      // The lab is returned inline because it is what becomes the examiner's Lexx
      // scope (scope.labId) and the s.79A reference on their reports.
      const lab = await FslLab.findById(examiner.labId).lean();
      res.json({
        examinerCode: examiner.examinerCode,
        name: examiner.name,
        disciplines: examiner.disciplines ?? [],
        status: examiner.status,
        phone: examiner.phone,
        lab: labView(lab),
      });
    })
  );

  // -------------------------------------------------------- legal aid panel ----
  router.get(
    '/legal-aid-panel',
    route(async (req, res) => {
      const district = identifier(req.query.district, 'district', PATTERNS.DISTRICT_CODE);
      const status = optionalEnumValue(req.query.status, 'status', ADVOCATE_STATUSES);
      const limit = boundedInt(req.query.limit, 'limit', { def: 100, max: 200 });

      const filter = { isLegalAidPanel: true, districtCode: district };
      if (status) filter.status = status;

      const advocates = await Advocate.find(filter).sort({ name: 1 }).limit(limit).lean();
      const now = new Date();
      res.json({
        district,
        count: advocates.length,
        advocates: advocates.map((a) => advocateView(a, now)),
      });
    })
  );

  return router;
}
