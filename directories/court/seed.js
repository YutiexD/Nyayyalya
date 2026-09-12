#!/usr/bin/env node
/**
 * Seed for the court directory (db `dir_court`).
 *
 * Idempotent: every document is upserted on its natural key (court code, judge
 * code, roster order + judge + court, CNR, staff code, CNR + advocate + party
 * side, legal-aid court order ref) — all unique-indexed. The one exception is the
 * demo case's vakalatnama register, which is emptied so each run starts with nobody
 * on record (see VAKALATNAMAS below).
 *
 *   node directories/court/seed.js
 */
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../common/config.js';
import { createLogger } from '../common/logger.js';
import { withMongo } from '../common/bootstrap.js';
import {
  Court,
  Judge,
  Roster,
  CaseListing,
  RegistryStaff,
  Vakalatnama,
  LegalAidAssignment,
  models,
} from './models/index.js';

const config = loadConfig({
  service: 'directory-court-seed',
  portVar: 'DIRECTORY_COURT_PORT',
  portDefault: 6002,
  dbVar: 'MONGO_DB_DIR_COURT',
  dbDefault: 'dir_court',
});

const D = (iso) => new Date(`${iso}T00:00:00.000Z`);

const upsert = (Model, key, doc) =>
  Model.findOneAndUpdate(
    key,
    { $set: { ...key, ...doc } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

const DEMO_CNR = 'UPGB010012342026';

const COURTS = [
  {
    code: 'UP-GZB-SESS-02',
    name: 'Sessions Court No. 2, Ghaziabad',
    courtType: 'SESSIONS',
    // POCSO designation — this is what the jurisdiction router matches against
    // once FIR 0123/2026 comes back as sensitivityClass POCSO. The same court is
    // also the district's designated Special Court under the SC/ST (Prevention of
    // Atrocities) Act, which is where FIR 0125/2026 is routed.
    designations: ['POCSO', 'SC_ST'],
    districtCode: 'UP-GZB',
    stateCode: 'UP',
  },
  {
    // A second court so "the roster picked this one" is a real answer, not the
    // only possible answer.
    code: 'UP-GZB-CJM-01',
    name: 'Court of the Chief Judicial Magistrate, Ghaziabad',
    courtType: 'MAGISTRATE',
    designations: [],
    districtCode: 'UP-GZB',
    stateCode: 'UP',
  },
];

const JUDGES = [
  {
    judgeCode: 'UP-JUD-2291',
    name: 'Sh. A. K. Verma',
    designation: 'Additional Sessions Judge',
    serviceStatus: 'ACTIVE',
    phone: '+91981002291',
  },
  {
    // The Magistrate bench. FIR 0124/2026 (maximum 3 years, ordinary) is triable
    // by a Magistrate, so its chargesheet lands in CJM-01 and this judge's cause list.
    judgeCode: 'UP-JUD-1180',
    name: 'Smt. R. Chauhan',
    designation: 'Chief Judicial Magistrate',
    serviceStatus: 'ACTIVE',
    phone: '+91981001180',
  },
];

const ROSTER = [
  {
    rosterOrderRef: 'PDJ/GZB/ROSTER/2026-27',
    judgeCode: 'UP-JUD-2291',
    courtCode: 'UP-GZB-SESS-02',
    caseCategories: ['SESSIONS_TRIAL', 'POCSO'],
    validFrom: D('2026-04-01'),
    validTo: null,
  },
  {
    // A lapsed roster order for the same judge. It proves the validity window is
    // actually applied: the lookup must return Sessions Court No. 2, not this.
    rosterOrderRef: 'PDJ/GZB/ROSTER/2025-26',
    judgeCode: 'UP-JUD-2291',
    courtCode: 'UP-GZB-CJM-01',
    caseCategories: ['MAGISTRATE_TRIAL'],
    validFrom: D('2025-04-01'),
    validTo: D('2026-03-31'),
  },
  {
    rosterOrderRef: 'PDJ/GZB/ROSTER/2026-27',
    judgeCode: 'UP-JUD-1180',
    courtCode: 'UP-GZB-CJM-01',
    caseCategories: ['MAGISTRATE_TRIAL'],
    validFrom: D('2026-04-01'),
    validTo: null,
  },
];

const LISTINGS = [
  {
    cnrNumber: DEMO_CNR,
    firNumber: '0123/2026',
    stationCode: 'UP-GZB-KVN',
    courtCode: 'UP-GZB-SESS-02',
    caseCategory: 'SESSIONS_TRIAL',
    listedOn: D('2026-04-22'),
    stage: 'COMMITTED',
  },
];

/**
 * Registry staff. Evidence rooms only.
 *
 * There are no registrars here any more. Ruling on a vakalatnama and on disclosure is
 * the presiding judge's act, verified against the roster; what a registry account is
 * still needed for is receiving and keeping the physical articles produced in court,
 * which is a real job that a judge does not do.
 */
const REGISTRY_STAFF = [
  {
    // The Sessions Court's evidence room.
    staffCode: 'UP-GZB-EVC-01',
    name: 'Sh. Deepak Rana',
    courtCode: 'UP-GZB-SESS-02',
    role: 'EVIDENCE_CUSTODIAN',
    serviceStatus: 'ACTIVE',
    phone: '+919810030011',
  },
  {
    // The Magistrate's evidence room, for the second demo case.
    staffCode: 'UP-GZB-EVC-02',
    name: 'Sh. Anil Tyagi',
    courtCode: 'UP-GZB-CJM-01',
    role: 'EVIDENCE_CUSTODIAN',
    serviceStatus: 'ACTIVE',
    phone: '+919810030002',
  },
];

/**
 * Deliberately empty.
 *
 * No advocate starts on record. An advocate comes on record the way the product says
 * they do: they file a vakalatnama through Lexx, the presiding judge accepts it, and
 * the acceptance is written HERE, into the court register, by the court's own act
 * (POST /directory/vakalatnama). The demo seed drives exactly that sequence for
 * UP/1234/2015; a row seeded here would be an advocate on record by fiat.
 */
const VAKALATNAMAS = [];

const LEGAL_AID = [
  {
    // BNSS s.341 route, so /directory/legal-aid returns something real.
    cnrNumber: DEMO_CNR,
    advocateEnrolmentNo: 'UP/7777/2018',
    courtOrderRef: 'SC/GZB/341/2026/44',
    dlsaRef: 'DLSA/GZB/2026/112',
    assignedOn: D('2026-05-11'),
    status: 'ACTIVE',
  },
];

/**
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {boolean} [opts.manageConnection]
 */
export async function seedCourt(opts = {}) {
  const logger = opts.logger ?? createLogger(config);
  const run = async () => {
    const courtBy = new Map();
    for (const c of COURTS) {
      const doc = await upsert(Court, { code: c.code }, c);
      courtBy.set(c.code, doc._id);
    }

    const judgeBy = new Map();
    for (const j of JUDGES) {
      const doc = await upsert(Judge, { judgeCode: j.judgeCode }, j);
      judgeBy.set(j.judgeCode, doc._id);
    }

    for (const r of ROSTER) {
      await upsert(
        Roster,
        {
          rosterOrderRef: r.rosterOrderRef,
          judgeId: judgeBy.get(r.judgeCode),
          courtId: courtBy.get(r.courtCode),
        },
        {
          caseCategories: r.caseCategories,
          validFrom: r.validFrom,
          validTo: r.validTo,
        }
      );
    }

    for (const l of LISTINGS) {
      await upsert(
        CaseListing,
        { cnrNumber: l.cnrNumber },
        {
          firNumber: l.firNumber,
          stationCode: l.stationCode,
          courtId: courtBy.get(l.courtCode),
          caseCategory: l.caseCategory,
          listedOn: l.listedOn,
          stage: l.stage,
        }
      );
    }

    for (const s of REGISTRY_STAFF) {
      await upsert(
        RegistryStaff,
        { staffCode: s.staffCode },
        {
          name: s.name,
          courtId: courtBy.get(s.courtCode),
          role: s.role,
          serviceStatus: s.serviceStatus,
          phone: s.phone,
        }
      );
    }

    // Registrars from an earlier version of this directory. The role no longer exists
    // in the product, and an upsert-only seed would leave the old rows behind — so a
    // stale staff code would still verify and Lexx would refuse it at activation with
    // a confusing "unknown role" instead of "no such identity".
    await RegistryStaff.deleteMany({ staffCode: { $nin: REGISTRY_STAFF.map((s) => s.staffCode) } });

    // Registrations made during a rehearsal — a chargesheet filed on FIR 0124/2026 or
    // 0125/2026 is registered HERE by the simulated registry act — are removed, so
    // each seed starts with only the seeded listing before any court. `npm run reset`
    // does not touch the directories, so without this a second run would find those
    // cases already listed, under CNRs that no longer match anything in Lexx.
    const seededCnrs = LISTINGS.map((l) => l.cnrNumber);
    const rehearsal = await CaseListing.find({ cnrNumber: { $nin: seededCnrs } }).select('cnrNumber').lean();
    await CaseListing.deleteMany({ cnrNumber: { $nin: seededCnrs } });

    // The same for the vakalatnama register. Appearances accepted during a rehearsal
    // are written here by the court's own act, and without this they would outlive
    // `npm run reset` — leaving an advocate on record for the next run who never filed
    // anything in it.
    await Vakalatnama.deleteMany({
      cnrNumber: { $in: [DEMO_CNR, ...rehearsal.map((l) => l.cnrNumber)] },
    });

    for (const v of VAKALATNAMAS) {
      await upsert(
        Vakalatnama,
        {
          cnrNumber: v.cnrNumber,
          advocateEnrolmentNo: v.advocateEnrolmentNo,
          appearingFor: v.appearingFor,
        },
        {
          partyName: v.partyName,
          filedOn: v.filedOn,
          acceptedBy: v.acceptedBy,
          acceptedOn: v.acceptedOn,
          status: v.status,
        }
      );
    }

    for (const a of LEGAL_AID) {
      await upsert(
        LegalAidAssignment,
        { courtOrderRef: a.courtOrderRef },
        {
          cnrNumber: a.cnrNumber,
          advocateEnrolmentNo: a.advocateEnrolmentNo,
          dlsaRef: a.dlsaRef,
          assignedOn: a.assignedOn,
          status: a.status,
        }
      );
    }

    const counts = {
      courts: await Court.countDocuments(),
      judges: await Judge.countDocuments(),
      roster: await Roster.countDocuments(),
      case_listings: await CaseListing.countDocuments(),
      registry_staff: await RegistryStaff.countDocuments(),
      vakalatnamas: await Vakalatnama.countDocuments(),
      legal_aid_assignments: await LegalAidAssignment.countDocuments(),
    };
    logger.info?.(counts, 'dir_court seeded');
    return counts;
  };

  if (opts.manageConnection === false) return run();
  return withMongo({ config, logger, models }, run);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedCourt()
    .then((counts) => {
      console.log('[seed:court]', JSON.stringify(counts));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed:court] failed:', err.message);
      process.exit(1);
    });
}
