#!/usr/bin/env node
/**
 * Seed for the court directory (db `dir_court`).
 *
 * Idempotent: every document is upserted on its natural key (court code, judge
 * code, roster order + judge + court, CNR, staff code, CNR + advocate + party
 * side, legal-aid court order ref) — all unique-indexed.
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
    // once FIR 0123/2026 comes back as sensitivityClass POCSO.
    designations: ['POCSO'],
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

const REGISTRY_STAFF = [
  {
    staffCode: 'UP-GZB-REG-01',
    name: 'Sh. Mohit Bansal',
    courtCode: 'UP-GZB-SESS-02',
    role: 'REGISTRAR',
    serviceStatus: 'ACTIVE',
    phone: '+919810030001',
  },
];

const VAKALATNAMAS = [
  {
    // Adv. Priya Sharma, on record for the accused. This is the record that
    // makes Lexx grant her access to the case — and its absence for UP/9876/2019
    // is the denial demo.
    cnrNumber: DEMO_CNR,
    advocateEnrolmentNo: 'UP/1234/2015',
    appearingFor: 'ACCUSED',
    partyName: 'Ramesh Singh',
    filedOn: D('2026-05-04'),
    acceptedByRegistrar: 'UP-GZB-REG-01',
    acceptedOn: D('2026-05-06'),
    status: 'ACCEPTED',
  },
];

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
          acceptedByRegistrar: v.acceptedByRegistrar,
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
