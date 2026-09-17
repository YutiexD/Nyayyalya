/**
 * Idempotent data migrations, run at API boot before indexes are built.
 *
 * Each step brings records written by an earlier version into line with the current
 * rules, so existing cases recover rather than only new ones working. Nothing is
 * deleted: a duplicate is marked and linked, never removed.
 *
 *   1. Court roles       JUDGE / EVIDENCE_CUSTODIAN / REGISTRAR  →  COURT
 *   2. Certificates      status on every record; duplicate ACTIVE certificates for one
 *                        exhibit resolved to one (the most complete), the rest marked
 *                        SUPERSEDED and linked to it — required before the partial
 *                        unique index can be built
 *   3. Evidence          the old hardcoded heuristic triage is removed from the
 *                        record, and every exhibit without an AI analysis is queued
 *                        for one (PENDING); the retired online-source check's stored
 *                        results are removed (aiAnalysis.onlineSource); every exhibit
 *                        without a permanent QR label token gets one (labelToken)
 *   4. Custody           the retired handshake field removed; duplicate seal
 *                        registrations flagged; location made consistent with status
 *   5. Stale indexes     indexes on fields that no longer exist are dropped
 *   6. Watermarks        per-recipient watermark fields removed from disclosure packs and
 *                        stream tokens, and the watermark index dropped. Packs no longer
 *                        gate counsel's access, so nothing else about them needs to change.
 *   7. Certificates      every exhibit gets one system-signed s.63 certificate; legacy
 *                        user-signed certificates are SUPERSEDED by it
 *
 * Raw collection operations are used deliberately: the schemas no longer declare the
 * legacy fields being cleaned up, and `strict: 'throw'` would refuse to touch them.
 */
import mongoose from 'mongoose';
import {
  AI_ANALYSIS_STATUS,
  AI_DISCLAIMER,
  AI_PROVIDER,
  CASE_STAGE,
  CERTIFICATE_STATUS,
  CUSTODY_LOCATION_FOR_STATUS,
  LEGACY_COURT_ROLES,
  ROLE,
} from '../models/enums.js';
import { issueMissingSystemCertificates } from './certificateIssuer.js';
import { randomBase64Url } from '../config/crypto.js';

async function collectionExists(db, name) {
  return (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
}

async function dropIndexIfPresent(collection, name) {
  try {
    const indexes = await collection.indexes();
    if (indexes.some((i) => i.name === name)) {
      await collection.dropIndex(name);
      return true;
    }
  } catch {
    /* absent collection or index: nothing to drop */
  }
  return false;
}

/** How complete a certificate is, for choosing which duplicate stays active. */
const completeness = (c) =>
  (c.signatures?.length ?? 0) * 10 + (c.partBComplete ? 5 : 0) + new Date(c.generatedAt ?? c.createdAt ?? 0).getTime() / 1e15;

export async function runMigrations(logger = console) {
  const db = mongoose.connection.db;
  const report = {};
  const now = new Date();

  // ---- 1. court roles ---------------------------------------------------------
  if (await collectionExists(db, 'users')) {
    const r = await db
      .collection('users')
      .updateMany({ role: { $in: LEGACY_COURT_ROLES } }, { $set: { role: ROLE.COURT } });
    report.courtRolesUnified = r.modifiedCount;
  }

  // ---- 2. certificates --------------------------------------------------------
  if (await collectionExists(db, 'certificates')) {
    const certs = db.collection('certificates');
    report.certificateStatusBackfilled = (
      await certs.updateMany({ status: { $exists: false } }, { $set: { status: CERTIFICATE_STATUS.ACTIVE } })
    ).modifiedCount;
    await certs.updateMany({ templateVersion: { $exists: false } }, { $set: { templateVersion: 'v1.0' } });

    const groups = await certs
      .aggregate([
        { $match: { status: CERTIFICATE_STATUS.ACTIVE } },
        { $group: { _id: '$evidenceId', ids: { $push: '$_id' }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray();

    let superseded = 0;
    for (const g of groups) {
      const docs = await certs.find({ _id: { $in: g.ids } }).toArray();
      docs.sort((a, b) => completeness(b) - completeness(a));
      const [keeper, ...rest] = docs;
      const r = await certs.updateMany(
        { _id: { $in: rest.map((d) => d._id) } },
        {
          $set: {
            status: CERTIFICATE_STATUS.SUPERSEDED,
            supersededById: keeper._id,
            supersededAt: now,
            supersededReason: 'DUPLICATE_ISSUED_BEFORE_ONE_CERTIFICATE_RULE',
          },
        }
      );
      superseded += r.modifiedCount;
    }
    report.duplicateCertificatesSuperseded = superseded;
  }

  // ---- 3. evidence: Gemini replaces the heuristic --------------------------------
  if (await collectionExists(db, 'evidence')) {
    const evidence = db.collection('evidence');
    report.heuristicTriageRemoved = (
      await evidence.updateMany({ triage: { $exists: true } }, { $unset: { triage: '' } })
    ).modifiedCount;
    report.evidenceQueuedForGemini = (
      await evidence.updateMany(
        { $or: [{ aiAnalysis: { $exists: false } }, { aiAnalysis: null }] },
        {
          $set: {
            aiAnalysis: {
              status: AI_ANALYSIS_STATUS.PENDING,
              provider: AI_PROVIDER.GEMINI,
              model: null,
              requestedAt: now,
              startedAt: null,
              completedAt: null,
              attempts: 0,
              deepfakeAssessment: null,
              deepfakeScore: null,
              analysisDescription: null,
              detectedIndicators: [],
              triagePriority: null,
              priorityReason: null,
              fslReviewRecommended: null,
              fslReviewReason: null,
              evidenceSummary: null,
              error: null,
              disclaimer: AI_DISCLAIMER,
            },
          },
        }
      )
    ).modifiedCount;
    await dropIndexIfPresent(evidence, 'triage.priority_1');
    await dropIndexIfPresent(evidence, 'caseId_1_triage.priority_1');

    // ---- 3b. the online-source check is gone: its stored results go with it ----
    report.aiOnlineSourceRemoved = (
      await evidence.updateMany(
        { 'aiAnalysis.onlineSource': { $exists: true } },
        { $unset: { 'aiAnalysis.onlineSource': '' } }
      )
    ).modifiedCount;

    // ---- 3c. every exhibit gets its permanent QR label token ----
    // Before the unique (sparse) index on labelToken is built. Each token is written
    // only where none exists, so a repeat run — or a concurrent boot — changes nothing.
    const unlabelled = await evidence
      .find({ $or: [{ labelToken: { $exists: false } }, { labelToken: null }] })
      .project({ _id: 1 })
      .toArray();
    let labelled = 0;
    for (const e of unlabelled) {
      const r = await evidence.updateOne(
        { _id: e._id, $or: [{ labelToken: { $exists: false } }, { labelToken: null }] },
        { $set: { labelToken: randomBase64Url(32) } }
      );
      labelled += r.modifiedCount;
    }
    report.evidenceLabelTokensBackfilled = labelled;
  }

  // ---- 4. custody --------------------------------------------------------------
  if (await collectionExists(db, 'custody_items')) {
    const items = db.collection('custody_items');
    await items.updateMany({ pendingTransfer: { $exists: true } }, { $unset: { pendingTransfer: '' } });
    await items.updateMany({ duplicateLegacy: { $exists: false } }, { $set: { duplicateLegacy: false } });
    await dropIndexIfPresent(items, 'pendingTransfer.expiresAt_1');

    const dupes = await items
      .aggregate([
        { $match: { duplicateLegacy: false } },
        { $group: { _id: { caseId: '$caseId', sealNumber: '$sealNumber' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray();
    let flagged = 0;
    for (const d of dupes) {
      const docs = await items.find({ _id: { $in: d.ids } }).sort({ createdAt: 1 }).toArray();
      const r = await items.updateMany(
        { _id: { $in: docs.slice(1).map((x) => x._id) } },
        { $set: { duplicateLegacy: true } }
      );
      flagged += r.modifiedCount;
    }
    report.duplicateSealRegistrationsFlagged = flagged;

    let relocated = 0;
    for (const [status, location] of Object.entries(CUSTODY_LOCATION_FOR_STATUS)) {
      const r = await items.updateMany({ status, currentLocation: { $ne: location } }, [
        {
          $set: {
            currentLocationDetail: {
              $ifNull: ['$currentLocationDetail', { $concat: ['Recorded at registration as ', '$currentLocation'] }],
            },
            currentLocation: location,
          },
        },
      ]);
      relocated += r.modifiedCount;
    }
    report.custodyLocationsMadeConsistent = relocated;
    await items.updateMany({ lastMovedAt: { $exists: false } }, [{ $set: { lastMovedAt: '$updatedAt' } }]);
  }

  // ---- 5. cases that cannot recover on their own ----------------------------------
  if (await collectionExists(db, 'cases')) {
    const stranded = await db
      .collection('cases')
      .find({ stage: CASE_STAGE.CHARGESHEET_FILED, $or: [{ courtId: null }, { cnrNumber: null }] })
      .project({ firNumber: 1 })
      .toArray();
    if (stranded.length) {
      logger.warn?.(
        { firNumbers: stranded.map((c) => c.firNumber) },
        'cases marked CHARGESHEET_FILED with no court binding — re-file the chargesheet to bind them'
      );
    }
    report.casesMissingCourtBinding = stranded.length;
  }

  // ---- 6. watermarks removed -------------------------------------------------------
  // The ledger is deliberately NOT touched: its entries are hash-chained, and removing
  // a field from an old payload would break the chain. New entries carry no watermark.
  report.watermarkFieldsRemovedFromPacks = 0;
  report.watermarkFieldsRemovedFromStreamTokens = 0;
  report.watermarkIndexesDropped = 0;
  if (await collectionExists(db, 'disclosure_packs')) {
    const packs = db.collection('disclosure_packs');
    report.watermarkFieldsRemovedFromPacks = (
      await packs.updateMany(
        {
          $or: [
            { 'servedTo.watermarkToken': { $exists: true } },
            { 'servedTo.watermarkLabel': { $exists: true } },
          ],
        },
        { $unset: { 'servedTo.$[].watermarkToken': '', 'servedTo.$[].watermarkLabel': '' } }
      )
    ).modifiedCount;
    if (await dropIndexIfPresent(packs, 'servedTo.watermarkToken_1')) report.watermarkIndexesDropped += 1;
  }
  if (await collectionExists(db, 'stream_tokens')) {
    report.watermarkFieldsRemovedFromStreamTokens = (
      await db
        .collection('stream_tokens')
        .updateMany({ watermarkLabel: { $exists: true } }, { $unset: { watermarkLabel: '' } })
    ).modifiedCount;
  }

  // ---- 7. system-signed s.63 certificates -------------------------------------------
  // Every exhibit without an ACTIVE, issued v3.0 certificate gets one; a legacy ACTIVE
  // certificate is superseded (REPLACED_BY_SYSTEM_CERTIFICATE), never deleted. Exhibits
  // already issued are excluded up front, so a repeat run does nothing.
  if (await collectionExists(db, 'evidence')) {
    try {
      Object.assign(report, await issueMissingSystemCertificates(logger));
    } catch (err) {
      logger.error?.({ err: err.message }, 'system certificate migration could not run; it will retry at next boot');
      report.systemCertificateFailures = (report.systemCertificateFailures ?? 0) + 1;
    }
  }

  logger.info?.(report, 'data migrations applied');
  return report;
}

export default { runMigrations };
