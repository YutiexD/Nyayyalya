#!/usr/bin/env node
/**
 * Seed for the police directory (db `dir_police`).
 *
 * Idempotent: every document is upserted on its natural key (pisId, station code,
 * posting order number, FIR number), all of which carry unique indexes. Running
 * this twice produces the same collection counts as running it once.
 *
 *   node directories/police/seed.js          # standalone
 *   import { seedPolice } from './seed.js'   # from seed/seed-all.js
 *
 * Dates are fixed, not relative to now, so the demo state is reproducible: the
 * live postings are open-ended (validTo null) and the expired one is anchored in
 * the past, which stays true whenever this is run.
 */
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../common/config.js';
import { createLogger } from '../common/logger.js';
import { withMongo } from '../common/bootstrap.js';
import { Officer, Station, Posting, Fir, models } from './models/index.js';

const config = loadConfig({
  service: 'directory-police-seed',
  portVar: 'DIRECTORY_POLICE_PORT',
  portDefault: 6001,
  dbVar: 'MONGO_DB_DIR_POLICE',
  dbDefault: 'dir_police',
});

const D = (iso) => new Date(`${iso}T00:00:00.000Z`);

const upsert = (Model, key, doc) =>
  Model.findOneAndUpdate(
    key,
    { $set: { ...key, ...doc } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

// ------------------------------------------------------------------ stations --
const STATIONS = [
  {
    code: 'UP-GZB-KVN',
    name: 'Kavi Nagar Police Station',
    districtCode: 'UP-GZB',
    districtName: 'Ghaziabad',
    rangeCode: 'UP-MRT',
    stateCode: 'UP',
    jurisdictionPolygon: null,
  },
  {
    // The District SP is not posted to a police station; the SP's office is
    // modelled as a station record so the posting has somewhere to point.
    code: 'UP-GZB-SPO',
    name: 'Office of the Superintendent of Police, Ghaziabad',
    districtCode: 'UP-GZB',
    districtName: 'Ghaziabad',
    rangeCode: 'UP-MRT',
    stateCode: 'UP',
    jurisdictionPolygon: null,
  },
];

// ------------------------------------------------------------------ officers --
const OFFICERS = [
  {
    pisId: 'UP-GZB-4471',
    name: 'SI Rakesh Kumar',
    rank: 'SUB_INSPECTOR',
    serviceStatus: 'ACTIVE',
    phone: '+919810004471',
    aadhaarLast4: '4471',
  },
  {
    pisId: 'UP-GZB-4402',
    name: 'Insp. Vinod Chauhan',
    rank: 'INSPECTOR',
    serviceStatus: 'ACTIVE',
    phone: '+919810004402',
    aadhaarLast4: '4402',
  },
  {
    pisId: 'UP-GZB-4455',
    name: 'HC Suresh Yadav',
    rank: 'HEAD_CONSTABLE',
    serviceStatus: 'ACTIVE',
    phone: '+919810004455',
    aadhaarLast4: '4455',
  },
  {
    pisId: 'UP-GZB-9001',
    name: 'Smt. Anjali Rathi, IPS',
    rank: 'SP',
    serviceStatus: 'ACTIVE',
    phone: '+919810009001',
    aadhaarLast4: '9001',
  },
  // --- negative fixtures -----------------------------------------------------
  {
    // Exists, is found, is NOT ACTIVE. Login must be denied on serviceStatus.
    pisId: 'UP-GZB-4499',
    name: 'SI Mahesh Tomar',
    rank: 'SUB_INSPECTOR',
    serviceStatus: 'SUSPENDED',
    phone: '+919810004499',
    aadhaarLast4: '4499',
  },
  {
    // ACTIVE officer whose posting lapsed. Login must be denied on posting validity,
    // which is the "transferred officer loses access by itself" case.
    pisId: 'UP-GZB-4488',
    name: 'SI Deepak Sharma',
    rank: 'SUB_INSPECTOR',
    serviceStatus: 'ACTIVE',
    phone: '+919810004488',
    aadhaarLast4: '4488',
  },
];

// ------------------------------------------------------------------ postings --
const POSTINGS = [
  {
    orderNumber: 'GZB/POST/2026/1187',
    pisId: 'UP-GZB-4471',
    stationCode: 'UP-GZB-KVN',
    role: 'IO',
    validFrom: D('2025-04-01'),
    validTo: null,
  },
  {
    orderNumber: 'GZB/POST/2026/1102',
    pisId: 'UP-GZB-4402',
    stationCode: 'UP-GZB-KVN',
    role: 'SHO',
    validFrom: D('2025-07-01'),
    validTo: null,
  },
  {
    orderNumber: 'GZB/POST/2026/1155',
    pisId: 'UP-GZB-4455',
    stationCode: 'UP-GZB-KVN',
    role: 'MALKHANA_CUSTODIAN',
    validFrom: D('2024-11-01'),
    validTo: null,
  },
  {
    orderNumber: 'GZB/POST/2026/9001',
    pisId: 'UP-GZB-9001',
    stationCode: 'UP-GZB-SPO',
    role: 'DISTRICT_SP',
    validFrom: D('2025-01-15'),
    validTo: null,
  },
  {
    orderNumber: 'GZB/POST/2025/0899',
    pisId: 'UP-GZB-4499',
    stationCode: 'UP-GZB-KVN',
    role: 'IO',
    validFrom: D('2024-02-01'),
    validTo: null,
  },
  {
    // EXPIRED — transferred out on 31 Mar 2026.
    orderNumber: 'GZB/POST/2024/0771',
    pisId: 'UP-GZB-4488',
    stationCode: 'UP-GZB-KVN',
    role: 'IO',
    validFrom: D('2023-05-01'),
    validTo: D('2026-03-31'),
  },
];

// ---------------------------------------------------------------------- firs --
const FIRS = [
  {
    firNumber: '0123/2026',
    firDate: D('2026-01-19'),
    stationCode: 'UP-GZB-KVN',
    districtCode: 'UP-GZB',
    stateCode: 'UP',
    // Max punishment 20 years → Sessions. POCSO → SPECIAL with a POCSO designation.
    // Together these are what the jurisdiction router reads.
    bnsSections: ['65(2)', '3(5)'],
    maxPunishmentYears: 20,
    complainantName: 'Smt. Kamla Devi',
    accusedNames: ['Ramesh Singh'],
    ioPisId: 'UP-GZB-4471',
    isVictimProtected: true,
    sensitivityClass: 'POCSO',
  },
];

/**
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {boolean} [opts.manageConnection] false when the caller already connected
 *                                          to dir_police and will disconnect itself
 */
export async function seedPolice(opts = {}) {
  const logger = opts.logger ?? createLogger(config);
  const run = async () => {
    const stationBy = new Map();
    for (const s of STATIONS) {
      const doc = await upsert(Station, { code: s.code }, s);
      stationBy.set(s.code, doc._id);
    }

    const officerBy = new Map();
    for (const o of OFFICERS) {
      const doc = await upsert(Officer, { pisId: o.pisId }, o);
      officerBy.set(o.pisId, doc._id);
    }

    for (const p of POSTINGS) {
      const doc = await upsert(
        Posting,
        { orderNumber: p.orderNumber },
        {
          officerId: officerBy.get(p.pisId),
          stationId: stationBy.get(p.stationCode),
          role: p.role,
          validFrom: p.validFrom,
          validTo: p.validTo,
        }
      );
      // The officer's pointer to their posting is set by the posting order, in a
      // second pass, exactly as a real personnel system would.
      await Officer.updateOne({ _id: officerBy.get(p.pisId) }, { $set: { currentPostingId: doc._id } });
    }

    for (const f of FIRS) {
      await upsert(
        Fir,
        { firNumber: f.firNumber },
        {
          firDate: f.firDate,
          stationId: stationBy.get(f.stationCode),
          districtCode: f.districtCode,
          stateCode: f.stateCode,
          bnsSections: f.bnsSections,
          maxPunishmentYears: f.maxPunishmentYears,
          complainantName: f.complainantName,
          accusedNames: f.accusedNames,
          ioOfficerId: officerBy.get(f.ioPisId),
          isVictimProtected: f.isVictimProtected,
          sensitivityClass: f.sensitivityClass,
        }
      );
    }

    const counts = {
      stations: await Station.countDocuments(),
      officers: await Officer.countDocuments(),
      postings: await Posting.countDocuments(),
      firs: await Fir.countDocuments(),
    };
    logger.info?.(counts, 'dir_police seeded');
    return counts;
  };

  if (opts.manageConnection === false) return run();
  return withMongo({ config, logger, models }, run);
}

// Executed directly: `node directories/police/seed.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPolice()
    .then((counts) => {
      console.log('[seed:police]', JSON.stringify(counts));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed:police] failed:', err.message);
      process.exit(1);
    });
}
