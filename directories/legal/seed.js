#!/usr/bin/env node
/**
 * Seed for the legal & FSL directory (db `dir_legal`).
 *
 * Idempotent: upserted on enrolmentNo / labCode / examinerCode, all unique-indexed.
 *
 *   node directories/legal/seed.js
 */
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../common/config.js';
import { createLogger } from '../common/logger.js';
import { withMongo } from '../common/bootstrap.js';
import { Advocate, FslLab, FslExaminer, models } from './models/index.js';

const config = loadConfig({
  service: 'directory-legal-seed',
  portVar: 'DIRECTORY_LEGAL_PORT',
  portDefault: 6003,
  dbVar: 'MONGO_DB_DIR_LEGAL',
  dbDefault: 'dir_legal',
});

const D = (iso) => new Date(`${iso}T00:00:00.000Z`);

const upsert = (Model, key, doc) =>
  Model.findOneAndUpdate(
    key,
    { $set: { ...key, ...doc } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

const BCI_UP = 'Bar Council of Uttar Pradesh';

const ADVOCATES = [
  {
    // On record for the demo case (vakalatnama ACCEPTED in dir_court).
    enrolmentNo: 'UP/1234/2015',
    name: 'Adv. Priya Sharma',
    barCouncil: BCI_UP,
    enrolmentDate: D('2015-08-11'),
    copValidTill: D('2029-12-31'),
    status: 'ACTIVE',
    isLegalAidPanel: true,
    districtCode: 'UP-GZB',
    districtName: 'Ghaziabad',
    phone: '+919810012345',
  },
  {
    // THE DENIAL DEMO. Fully valid — ACTIVE, COP in date — and on no case at all.
    // The refusal must come from "not on record", never from "not a real lawyer".
    enrolmentNo: 'UP/9876/2019',
    name: 'Adv. Nitin Bhardwaj',
    barCouncil: BCI_UP,
    enrolmentDate: D('2019-02-27'),
    copValidTill: D('2029-12-31'),
    status: 'ACTIVE',
    isLegalAidPanel: false,
    districtCode: 'UP-GZB',
    districtName: 'Ghaziabad',
    phone: '+919810098765',
  },
  {
    // Legal aid counsel assigned under BNSS s.341 in dir_court.
    enrolmentNo: 'UP/7777/2018',
    name: 'Adv. Meena Gupta',
    barCouncil: BCI_UP,
    enrolmentDate: D('2018-06-19'),
    copValidTill: D('2028-12-31'),
    status: 'ACTIVE',
    isLegalAidPanel: true,
    districtCode: 'UP-GZB',
    districtName: 'Ghaziabad',
    phone: '+919810077770',
  },
  // --- negative fixture ------------------------------------------------------
  {
    // Certificate of practice LAPSED. Exists, is ACTIVE on the roll, and must
    // still be denied a Lexx login on copValidTill alone.
    enrolmentNo: 'UP/5555/2011',
    name: 'Adv. Rajeev Malhotra',
    barCouncil: BCI_UP,
    enrolmentDate: D('2011-03-30'),
    copValidTill: D('2024-12-31'),
    status: 'ACTIVE',
    isLegalAidPanel: false,
    districtCode: 'UP-GZB',
    districtName: 'Ghaziabad',
    phone: '+919810055550',
  },
];

const LABS = [
  {
    labCode: 'UP-FSL-LKO',
    name: 'State FSL, Lucknow',
    section79ANotificationRef: 'MeitY/79A/2019/17',
    disciplines: ['MOBILE_FORENSICS', 'MEDIA_FORENSICS', 'COMPUTER_FORENSICS'],
    stateCode: 'UP',
  },
];

const EXAMINERS = [
  {
    examinerCode: 'FSL-LKO-0091',
    name: 'Dr. S. Nair',
    labCode: 'UP-FSL-LKO',
    disciplines: ['MEDIA_FORENSICS'],
    status: 'ACTIVE',
    phone: '+919810000091',
  },
];

/**
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {boolean} [opts.manageConnection]
 */
export async function seedLegal(opts = {}) {
  const logger = opts.logger ?? createLogger(config);
  const run = async () => {
    for (const a of ADVOCATES) {
      await upsert(Advocate, { enrolmentNo: a.enrolmentNo }, a);
    }

    const labBy = new Map();
    for (const l of LABS) {
      const doc = await upsert(FslLab, { labCode: l.labCode }, l);
      labBy.set(l.labCode, doc._id);
    }

    for (const e of EXAMINERS) {
      await upsert(
        FslExaminer,
        { examinerCode: e.examinerCode },
        {
          name: e.name,
          labId: labBy.get(e.labCode),
          disciplines: e.disciplines,
          status: e.status,
          phone: e.phone,
        }
      );
    }

    const counts = {
      advocates: await Advocate.countDocuments(),
      fsl_labs: await FslLab.countDocuments(),
      fsl_examiners: await FslExaminer.countDocuments(),
    };
    logger.info?.(counts, 'dir_legal seeded');
    return counts;
  };

  if (opts.manageConnection === false) return run();
  return withMongo({ config, logger, models }, run);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedLegal()
    .then((counts) => {
      console.log('[seed:legal]', JSON.stringify(counts));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed:legal] failed:', err.message);
      process.exit(1);
    });
}
