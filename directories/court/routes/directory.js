/**
 * Court directory endpoints (§3.2).
 *
 *   GET  /directory/judge/:judgeCode            verify judge
 *   GET  /directory/judge/:judgeCode/court      ROSTER LOOKUP → which court today
 *   GET  /directory/courts?districtCode=        the courts of a district
 *   GET  /directory/court/:code                 court details + designations
 *   GET  /directory/listing/by-fir/:firNumber   CNR + court for a case
 *   POST /directory/listing                     SIMULATED chargesheet registration (demo only)
 *   GET  /directory/vakalatnama?enrolmentNo=    cases this advocate is on record for
 *   GET  /directory/legal-aid?enrolmentNo=      legal aid assignments
 *   POST /directory/vakalatnama                 SIMULATED court filing (demo only)
 *   GET  /directory/registry-staff/:staffCode   verify registry user
 *
 * POST /directory/vakalatnama is the single write endpoint in all three
 * directories. It is an act of the court, not of Lexx: Lexx relays the presiding
 * judge's acceptance to it and nothing else, and the read-only guard blocks every
 * other method.
 */
import { Router } from 'express';
import { route } from '../../common/app.js';
import { NotFound, Conflict, DirectoryError } from '../../common/errors.js';
import {
  PATTERNS,
  identifier,
  optionalEnumValue,
  boundedInt,
  freeText,
  enumValue,
  objectBody,
  joinSegments,
} from '../../common/validate.js';
import {
  Court,
  Judge,
  Roster,
  CaseListing,
  RegistryStaff,
  Vakalatnama,
  LegalAidAssignment,
  APPEARING_FOR,
  VAKALATNAMA_STATUSES,
  LEGAL_AID_STATUSES,
} from '../models/index.js';

const courtView = (c) =>
  c && {
    code: c.code,
    name: c.name,
    courtType: c.courtType,
    designations: c.designations ?? [],
    districtCode: c.districtCode,
    stateCode: c.stateCode,
  };

const judgeView = (j) => ({
  judgeCode: j.judgeCode,
  name: j.name,
  designation: j.designation,
  serviceStatus: j.serviceStatus,
  phone: j.phone,
});

/** Attach the court of each CNR to a list of records, in one extra query. */
async function withCourts(records) {
  const cnrs = [...new Set(records.map((r) => r.cnrNumber))];
  const listings = await CaseListing.find({ cnrNumber: { $in: cnrs } }).lean();
  const courts = await Court.find({
    _id: { $in: [...new Set(listings.map((l) => String(l.courtId)))] },
  }).lean();
  const courtById = new Map(courts.map((c) => [String(c._id), c]));
  const listingByCnr = new Map(listings.map((l) => [l.cnrNumber, l]));
  return { listingByCnr, courtById };
}

export function directoryRouter(config = {}) {
  const router = Router();

  // ------------------------------------------------------------------ judge ----
  router.get(
    '/judge/:judgeCode',
    route(async (req, res) => {
      const judgeCode = identifier(req.params.judgeCode, 'judgeCode', PATTERNS.DASHED_CODE);
      const judge = await Judge.findOne({ judgeCode }).lean();
      if (!judge) throw NotFound('JUDGE_NOT_FOUND', 'No judge with that code.');
      res.json(judgeView(judge));
    })
  );

  /**
   * THE roster lookup. A judge has no court of their own: the court is whichever
   * roster row is in force right now — validFrom <= now AND (validTo is null OR
   * validTo >= now). Lexx puts the result in the JWT scope and can never set it
   * itself. When no roster row is in force the answer is a 404, and the judge gets
   * no court scope at all.
   */
  router.get(
    '/judge/:judgeCode/court',
    route(async (req, res) => {
      const judgeCode = identifier(req.params.judgeCode, 'judgeCode', PATTERNS.DASHED_CODE);
      const judge = await Judge.findOne({ judgeCode }).lean();
      if (!judge) throw NotFound('JUDGE_NOT_FOUND', 'No judge with that code.');

      const now = new Date();
      const roster = await Roster.findOne({
        judgeId: judge._id,
        validFrom: { $lte: now },
        $or: [{ validTo: null }, { validTo: { $gte: now } }],
      })
        .sort({ validFrom: -1 })
        .lean();

      if (!roster) {
        throw NotFound(
          'NO_CURRENT_ROSTER',
          'No roster order places this judge in a court as of now.'
        );
      }

      const court = await Court.findById(roster.courtId).lean();
      if (!court) {
        throw NotFound('COURT_NOT_FOUND', 'The roster order references an unknown court.');
      }

      res.json({
        judge: {
          judgeCode: judge.judgeCode,
          name: judge.name,
          designation: judge.designation,
          serviceStatus: judge.serviceStatus,
        },
        court: courtView(court),
        roster: {
          caseCategories: roster.caseCategories ?? [],
          validFrom: roster.validFrom,
          validTo: roster.validTo ?? null,
          rosterOrderRef: roster.rosterOrderRef,
        },
        asOf: now,
      });
    })
  );

  // ------------------------------------------------------------------ court ----

  /**
   * The courts of one district. The jurisdiction router picks from this list; it
   * used to ask for `/court/:code` with a DISTRICT code, which never matched a court,
   * so every case was told "no court in this district holds the required designation".
   */
  router.get(
    '/courts',
    route(async (req, res) => {
      const districtCode = identifier(req.query.districtCode, 'districtCode', PATTERNS.DASHED_CODE);
      const courts = await Court.find({ districtCode }).sort({ code: 1 }).lean();
      res.json({ districtCode, count: courts.length, courts: courts.map(courtView) });
    })
  );

  router.get(
    '/court/:code',
    route(async (req, res) => {
      const code = identifier(req.params.code, 'code', PATTERNS.DASHED_CODE);
      const court = await Court.findOne({ code }).lean();
      if (!court) throw NotFound('COURT_NOT_FOUND', 'No court with that code.');
      res.json(courtView(court));
    })
  );

  // ---------------------------------------------------------------- listing ----
  const listingHandler = route(async (req, res) => {
    const raw = req.params.year
      ? joinSegments(req.params, ['firNumber', 'year'])
      : req.params.firNumber;
    const firNumber = identifier(raw, 'firNumber', PATTERNS.FIR_NUMBER);

    const listing = await CaseListing.findOne({ firNumber }).sort({ listedOn: -1 }).lean();
    if (!listing) throw NotFound('LISTING_NOT_FOUND', 'That FIR is not listed before any court.');

    const court = await Court.findById(listing.courtId).lean();
    res.json({
      cnrNumber: listing.cnrNumber,
      firNumber: listing.firNumber,
      stationCode: listing.stationCode,
      caseCategory: listing.caseCategory,
      listedOn: listing.listedOn,
      stage: listing.stage,
      court: courtView(court),
    });
  });

  router.get('/listing/by-fir/:firNumber/:year', listingHandler);
  router.get('/listing/by-fir/:firNumber', listingHandler);

  /**
   * SIMULATED REGISTRY REGISTRATION — a chargesheet being registered by the court.
   *
   * When a police report is filed before a court, the court's registry registers the
   * case and allots it a CNR. eCourts owns that act. This stands in for it, under the
   * same three labels as the vakalatnama simulator below: refused unless simulated
   * filings are enabled, `simulated: true` on every response, and exactly one caller
   * in Lexx (`POST /api/cases/:id/file-chargesheet`, once the jurisdiction router has
   * picked the court from THIS directory's own list).
   *
   * Idempotent on the FIR: a case already registered answers with its existing
   * listing and CNR rather than a second one, because one FIR is one case before the
   * court however many times the filing is retried.
   */
  router.post(
    '/listing',
    route(async (req, res) => {
      if (!config.allowSimulatedFilings) {
        throw new DirectoryError(
          403,
          'SIMULATED_FILING_DISABLED',
          'This endpoint simulates a court registry registering a chargesheet and is disabled in this environment. In a real deployment the registration is made in eCourts, not here.'
        );
      }

      const body = objectBody(req.body);
      const firNumber = identifier(body.firNumber, 'firNumber', PATTERNS.FIR_NUMBER);
      const stationCode = identifier(body.stationCode, 'stationCode', PATTERNS.DASHED_CODE);
      const courtCode = identifier(body.courtCode, 'courtCode', PATTERNS.DASHED_CODE);
      const caseCategory = freeText(body.caseCategory, 'caseCategory', { max: 60 });

      const court = await Court.findOne({ code: courtCode }).lean();
      if (!court) throw NotFound('COURT_NOT_FOUND', 'No court with that code.');

      const view = (listing, created) => ({
        simulated: true,
        notice:
          'Simulated registry registration. This stands in for a chargesheet registered in eCourts; it is not a filing of record.',
        created,
        cnrNumber: listing.cnrNumber,
        firNumber: listing.firNumber,
        stationCode: listing.stationCode,
        caseCategory: listing.caseCategory,
        listedOn: listing.listedOn,
        stage: listing.stage,
        court: courtView(court),
      });

      const existing = await CaseListing.findOne({ firNumber }).lean();
      if (existing) {
        const existingCourt = await Court.findById(existing.courtId).lean();
        return res.status(200).json({ ...view(existing, false), court: courtView(existingCourt) });
      }

      // CNR: state (2) + establishment (4) + serial (6) + year (4). The serial is the
      // next free one in this register, checked rather than assumed.
      const year = new Date().getUTCFullYear();
      const establishment = `${court.stateCode}GB01`.slice(0, 6);
      let serial = (await CaseListing.countDocuments()) + 1235;
      let cnrNumber;
      for (;;) {
        cnrNumber = `${establishment}${String(serial).padStart(6, '0')}${year}`;
        if (!(await CaseListing.exists({ cnrNumber }))) break;
        serial += 1;
      }

      const created = await CaseListing.create({
        cnrNumber,
        firNumber,
        stationCode,
        courtId: court._id,
        caseCategory,
        listedOn: new Date(),
        stage: 'FILED',
      });

      res.status(201).json(view(created.toObject(), true));
    })
  );

  // ----------------------------------------------------------- vakalatnamas ----
  router.get(
    '/vakalatnama',
    route(async (req, res) => {
      // `?enrolmentNo[$ne]=x` arrives as an object here and is rejected with 400
      // before any filter is built. Only a validated string ever reaches Mongo.
      const enrolmentNo = identifier(
        req.query.enrolmentNo,
        'enrolmentNo',
        PATTERNS.ENROLMENT_NO
      );
      const status = optionalEnumValue(req.query.status, 'status', VAKALATNAMA_STATUSES);
      const limit = boundedInt(req.query.limit, 'limit', { def: 50, max: 200 });

      const filter = { advocateEnrolmentNo: enrolmentNo };
      if (status) filter.status = status;

      const records = await Vakalatnama.find(filter).sort({ filedOn: -1 }).limit(limit).lean();
      const { listingByCnr, courtById } = await withCourts(records);

      res.json({
        enrolmentNo,
        count: records.length,
        vakalatnamas: records.map((v) => {
          const listing = listingByCnr.get(v.cnrNumber);
          return {
            cnrNumber: v.cnrNumber,
            appearingFor: v.appearingFor,
            partyName: v.partyName,
            filedOn: v.filedOn,
            acceptedBy: v.acceptedBy,
            acceptedOn: v.acceptedOn,
            status: v.status,
            firNumber: listing?.firNumber ?? null,
            stage: listing?.stage ?? null,
            court: listing ? courtView(courtById.get(String(listing.courtId))) : null,
          };
        }),
      });
    })
  );

  /**
   * SIMULATED REGISTRY FILING — not a real vakalatnama.
   *
   * The one write endpoint in the three directories. In the real world eCourts owns
   * this act: the court accepts a vakalatnama and the advocate is on record. Here it
   * exists so the demo can show that happening, because the grant it produces is what
   * later unlocks disclosure for that advocate inside Lexx.
   *
   * It is therefore an AUTHORITY SIMULATOR, and is labelled as one three ways, because
   * a reviewer who mistook it for a Lexx feature would badly misread the trust model:
   *
   *   1. It is refused outright unless `config.allowSimulatedFilings` is set — off by
   *      default under NODE_ENV=production. With a real dataset behind it and no
   *      authentication in front of it, this would put any advocate on record for any
   *      listed case.
   *   2. Every response carries `simulated: true` and a `notice`.
   *   3. Lexx calls it from exactly one place: when the PRESIDING JUDGE accepts a
   *      vakalatnama that an advocate filed through Lexx, the acceptance is relayed
   *      here — with the judge's own code, which this endpoint verifies against its
   *      own judges AND against the roster order placing them in the court this case
   *      is listed before — BEFORE Lexx grants anything. The court register records
   *      the appearance; Lexx then mirrors it. In a real deployment this relay is the
   *      eCourts e-filing interface, not this simulator.
   */
  router.post(
    '/vakalatnama',
    route(async (req, res) => {
      if (!config.allowSimulatedFilings) {
        throw new DirectoryError(
          403,
          'SIMULATED_FILING_DISABLED',
          'This endpoint simulates a court recording a vakalatnama and is disabled in this environment. In a real deployment the filing is made in eCourts, not here.'
        );
      }

      const body = objectBody(req.body);

      const cnrNumber = identifier(body.cnrNumber, 'cnrNumber', PATTERNS.CNR_NUMBER);
      const advocateEnrolmentNo = identifier(
        body.advocateEnrolmentNo,
        'advocateEnrolmentNo',
        PATTERNS.ENROLMENT_NO
      );
      const appearingFor = enumValue(body.appearingFor, 'appearingFor', APPEARING_FOR);
      const partyName = freeText(body.partyName, 'partyName', { max: 120 });
      const acceptedBy = identifier(body.acceptedBy, 'acceptedBy', PATTERNS.DASHED_CODE);

      // The case must actually be listed, and the judge taking the advocate on record
      // must be the judge the ROSTER puts in that court today. Neither fact comes
      // from the request body.
      const listing = await CaseListing.findOne({ cnrNumber }).lean();
      if (!listing) {
        throw NotFound('LISTING_NOT_FOUND', 'No case is listed under that CNR number.');
      }

      const judge = await Judge.findOne({ judgeCode: acceptedBy }).lean();
      if (!judge || judge.serviceStatus !== 'ACTIVE') {
        throw NotFound('JUDGE_NOT_FOUND', 'No serving judge with that code.');
      }

      // Same validity window as the roster lookup above: a judge who has rotated out
      // of this court cannot take an advocate on record in it, and the register is
      // where that is decided rather than anywhere in Lexx.
      const now = new Date();
      const roster = await Roster.findOne({
        judgeId: judge._id,
        courtId: listing.courtId,
        validFrom: { $lte: now },
        $or: [{ validTo: null }, { validTo: { $gte: now } }],
      }).lean();
      if (!roster) {
        throw Conflict(
          'JUDGE_OUT_OF_COURT_SCOPE',
          'No roster order in force places that judge in the court this case is listed before.'
        );
      }

      const existing = await Vakalatnama.findOne({
        cnrNumber,
        advocateEnrolmentNo,
        appearingFor,
      }).lean();
      if (existing) {
        throw Conflict(
          'VAKALATNAMA_ALREADY_ON_RECORD',
          'That advocate is already on record for this party in this case.'
        );
      }

      const created = await Vakalatnama.create({
        cnrNumber,
        advocateEnrolmentNo,
        appearingFor,
        partyName,
        filedOn: now,
        acceptedBy: judge.judgeCode,
        acceptedOn: now,
        status: 'ACCEPTED',
      });

      res.status(201).json({
        simulated: true,
        notice:
          'Simulated court filing. This stands in for a vakalatnama accepted in eCourts; it is not a filing of record.',
        cnrNumber: created.cnrNumber,
        advocateEnrolmentNo: created.advocateEnrolmentNo,
        appearingFor: created.appearingFor,
        partyName: created.partyName,
        filedOn: created.filedOn,
        acceptedBy: created.acceptedBy,
        acceptedOn: created.acceptedOn,
        status: created.status,
      });
    })
  );

  // ------------------------------------------------------------- legal aid ----
  router.get(
    '/legal-aid',
    route(async (req, res) => {
      const enrolmentNo = identifier(
        req.query.enrolmentNo,
        'enrolmentNo',
        PATTERNS.ENROLMENT_NO
      );
      const status = optionalEnumValue(req.query.status, 'status', LEGAL_AID_STATUSES);
      const limit = boundedInt(req.query.limit, 'limit', { def: 50, max: 200 });

      const filter = { advocateEnrolmentNo: enrolmentNo };
      if (status) filter.status = status;

      const records = await LegalAidAssignment.find(filter)
        .sort({ assignedOn: -1 })
        .limit(limit)
        .lean();
      const { listingByCnr, courtById } = await withCourts(records);

      res.json({
        enrolmentNo,
        count: records.length,
        assignments: records.map((a) => {
          const listing = listingByCnr.get(a.cnrNumber);
          return {
            cnrNumber: a.cnrNumber,
            courtOrderRef: a.courtOrderRef,
            dlsaRef: a.dlsaRef,
            assignedOn: a.assignedOn,
            status: a.status,
            firNumber: listing?.firNumber ?? null,
            court: listing ? courtView(courtById.get(String(listing.courtId))) : null,
          };
        }),
      });
    })
  );

  // -------------------------------------------------------- registry staff ----
  router.get(
    '/registry-staff/:staffCode',
    route(async (req, res) => {
      const staffCode = identifier(req.params.staffCode, 'staffCode', PATTERNS.DASHED_CODE);
      const staff = await RegistryStaff.findOne({ staffCode }).lean();
      if (!staff) throw NotFound('REGISTRY_STAFF_NOT_FOUND', 'No registry staff with that code.');
      const court = await Court.findById(staff.courtId).lean();
      res.json({
        staffCode: staff.staffCode,
        name: staff.name,
        role: staff.role,
        serviceStatus: staff.serviceStatus,
        phone: staff.phone,
        court: courtView(court),
      });
    })
  );

  return router;
}
