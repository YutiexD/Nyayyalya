/**
 * Police directory endpoints (§3.1).
 *
 *   GET /directory/officer/:pisId            verify an officer exists, and its real status
 *   GET /directory/officer/:pisId/posting    current posting → station, role, validity
 *   GET /directory/station/:code             station + district + state hierarchy
 *   GET /directory/fir/:firNumber            FIR details, IO, sections, sensitivity
 *   GET /directory/firs?stationId=&ioOfficerId=   list for the officer's dashboard
 *
 * Every handler validates its inputs before it touches the database, and every
 * response is an explicit projection — Mongo documents are never returned raw.
 *
 * Note on status: an officer who exists but is SUSPENDED is returned with 200 and
 * `serviceStatus: "SUSPENDED"`. That is deliberate. Lexx's login flow re-checks
 * the live status on every login, so the directory's job is to report the truth,
 * not to make the access decision. Only a genuinely absent record is a 404.
 */
import { Router } from 'express';
import { route } from '../../common/app.js';
import { NotFound } from '../../common/errors.js';
import {
  PATTERNS,
  identifier,
  optionalIdentifier,
  boundedInt,
  joinSegments,
} from '../../common/validate.js';
import { Officer, Station, Posting, Fir } from '../models/index.js';

const stationView = (s) =>
  s && {
    code: s.code,
    name: s.name,
    districtCode: s.districtCode,
    districtName: s.districtName,
    rangeCode: s.rangeCode,
    stateCode: s.stateCode,
    jurisdictionPolygon: s.jurisdictionPolygon ?? null,
  };

const officerView = (o) => ({
  pisId: o.pisId,
  name: o.name,
  rank: o.rank,
  serviceStatus: o.serviceStatus,
  phone: o.phone,
  aadhaarLast4: o.aadhaarLast4,
  currentPostingId: o.currentPostingId ? String(o.currentPostingId) : null,
});

const isWithin = (p, now) =>
  p.validFrom <= now && (p.validTo === null || p.validTo === undefined || p.validTo >= now);

export function directoryRouter() {
  const router = Router();

  // ---------------------------------------------------------------- officer ----
  router.get(
    '/officer/:pisId',
    route(async (req, res) => {
      const pisId = identifier(req.params.pisId, 'pisId', PATTERNS.DASHED_CODE);
      const officer = await Officer.findOne({ pisId }).lean();
      if (!officer) throw NotFound('OFFICER_NOT_FOUND', 'No officer with that PIS identifier.');
      res.json(officerView(officer));
    })
  );

  /**
   * Current posting. "Current" = validFrom <= now and (validTo is null or >= now).
   *
   * When an officer has postings but none is current (a transfer that has already
   * taken effect) the most recent one is still returned, with `isCurrent: false`
   * and its real validTo, because the login flow has to be able to tell "posting
   * expired" apart from "officer has no posting record at all". Lexx makes the
   * decision; the directory supplies the facts.
   */
  router.get(
    '/officer/:pisId/posting',
    route(async (req, res) => {
      const pisId = identifier(req.params.pisId, 'pisId', PATTERNS.DASHED_CODE);
      const officer = await Officer.findOne({ pisId }).lean();
      if (!officer) throw NotFound('OFFICER_NOT_FOUND', 'No officer with that PIS identifier.');

      const now = new Date();
      const postings = await Posting.find({ officerId: officer._id })
        .sort({ validFrom: -1 })
        .limit(20)
        .lean();
      if (postings.length === 0) {
        throw NotFound('POSTING_NOT_FOUND', 'No posting order on record for that officer.');
      }

      const posting = postings.find((p) => isWithin(p, now)) ?? postings[0];
      const station = await Station.findById(posting.stationId).lean();

      res.json({
        officer: {
          pisId: officer.pisId,
          name: officer.name,
          rank: officer.rank,
          serviceStatus: officer.serviceStatus,
          phone: officer.phone,
        },
        posting: {
          id: String(posting._id),
          role: posting.role,
          orderNumber: posting.orderNumber,
          validFrom: posting.validFrom,
          validTo: posting.validTo ?? null,
          isCurrent: isWithin(posting, now),
        },
        station: stationView(station),
        asOf: now,
      });
    })
  );

  // ---------------------------------------------------------------- station ----
  router.get(
    '/station/:code',
    route(async (req, res) => {
      const code = identifier(req.params.code, 'code', PATTERNS.DASHED_CODE);
      const station = await Station.findOne({ code }).lean();
      if (!station) throw NotFound('STATION_NOT_FOUND', 'No station with that code.');
      res.json(stationView(station));
    })
  );

  // -------------------------------------------------------------------- FIR ----
  const firHandler = route(async (req, res) => {
    // "0123/2026" arrives either percent-encoded in one segment or split in two.
    const raw = req.params.year
      ? joinSegments(req.params, ['firNumber', 'year'])
      : req.params.firNumber;
    const firNumber = identifier(raw, 'firNumber', PATTERNS.FIR_NUMBER);

    const fir = await Fir.findOne({ firNumber }).lean();
    if (!fir) throw NotFound('FIR_NOT_FOUND', 'No FIR with that number.');

    const [station, io] = await Promise.all([
      Station.findById(fir.stationId).lean(),
      Officer.findById(fir.ioOfficerId).lean(),
    ]);

    res.json({
      firNumber: fir.firNumber,
      firDate: fir.firDate,
      station: stationView(station),
      districtCode: fir.districtCode,
      stateCode: fir.stateCode,
      bnsSections: fir.bnsSections,
      maxPunishmentYears: fir.maxPunishmentYears,
      complainantName: fir.complainantName,
      accusedNames: fir.accusedNames,
      isVictimProtected: fir.isVictimProtected,
      sensitivityClass: fir.sensitivityClass,
      io: io && {
        pisId: io.pisId,
        name: io.name,
        rank: io.rank,
        serviceStatus: io.serviceStatus,
      },
    });
  });

  // Registered before /fir/:firNumber so the two-segment form wins when present.
  router.get('/fir/:firNumber/:year', firHandler);
  router.get('/fir/:firNumber', firHandler);

  // ------------------------------------------------------------------- FIRs ----
  /**
   * §3.1 specifies stationId and ioOfficerId (ObjectIds). The friendlier
   * stationCode / ioPisId aliases are accepted too, because that is what a caller
   * actually holds after a /officer or /station lookup.
   */
  router.get(
    '/firs',
    route(async (req, res) => {
      const stationId = optionalIdentifier(req.query.stationId, 'stationId', PATTERNS.OBJECT_ID, {
        upper: false,
      });
      const ioOfficerId = optionalIdentifier(
        req.query.ioOfficerId,
        'ioOfficerId',
        PATTERNS.OBJECT_ID,
        { upper: false }
      );
      const stationCode = optionalIdentifier(
        req.query.stationCode,
        'stationCode',
        PATTERNS.DASHED_CODE
      );
      const ioPisId = optionalIdentifier(req.query.ioPisId, 'ioPisId', PATTERNS.DASHED_CODE);
      const limit = boundedInt(req.query.limit, 'limit', { def: 50, max: 200 });

      // Only validated scalars are ever placed in this filter.
      const filter = {};
      if (stationId) filter.stationId = stationId;
      if (ioOfficerId) filter.ioOfficerId = ioOfficerId;

      if (stationCode) {
        const station = await Station.findOne({ code: stationCode }).select('_id').lean();
        if (!station) return res.json({ count: 0, firs: [] });
        filter.stationId = station._id;
      }
      if (ioPisId) {
        const officer = await Officer.findOne({ pisId: ioPisId }).select('_id').lean();
        if (!officer) return res.json({ count: 0, firs: [] });
        filter.ioOfficerId = officer._id;
      }

      const firs = await Fir.find(filter).sort({ firDate: -1 }).limit(limit).lean();

      const stationIds = [...new Set(firs.map((f) => String(f.stationId)))];
      const officerIds = [...new Set(firs.map((f) => String(f.ioOfficerId)))];
      const [stations, officers] = await Promise.all([
        Station.find({ _id: { $in: stationIds } })
          .select('code')
          .lean(),
        Officer.find({ _id: { $in: officerIds } })
          .select('pisId name')
          .lean(),
      ]);
      const stationBy = new Map(stations.map((s) => [String(s._id), s]));
      const officerBy = new Map(officers.map((o) => [String(o._id), o]));

      res.json({
        count: firs.length,
        firs: firs.map((f) => ({
          firNumber: f.firNumber,
          firDate: f.firDate,
          stationCode: stationBy.get(String(f.stationId))?.code ?? null,
          districtCode: f.districtCode,
          stateCode: f.stateCode,
          bnsSections: f.bnsSections,
          maxPunishmentYears: f.maxPunishmentYears,
          sensitivityClass: f.sensitivityClass,
          isVictimProtected: f.isVictimProtected,
          complainantName: f.complainantName,
          ioPisId: officerBy.get(String(f.ioOfficerId))?.pisId ?? null,
          ioName: officerBy.get(String(f.ioOfficerId))?.name ?? null,
        })),
      });
    })
  );

  return router;
}
