/**
 * Merkle anchoring to MONAD TESTNET.
 *
 * # What goes on chain
 *
 * A batch id, a Merkle root, and the sequence range it covers. That is all.
 * No evidence, no file contents, no hashes of PII, no case identifiers, no names,
 * no AI triage. The root is a commitment to a set of ledger entry hashes and reveals
 * nothing about them.
 *
 * # Why this is more careful than the sketch
 *
 * The design sketch anchors and immediately records success. Three things go wrong
 * with that in practice, and each is handled explicitly here:
 *
 *  1. **A submitted transaction is not a confirmed transaction.** It can revert, be
 *     dropped, or be replaced. A batch is CONFIRMED only after its receipt has been
 *     read back and `status === 1`. Otherwise a reverted transaction would sit in the
 *     database looking like proof.
 *  2. **Retries must not double-anchor.** The batch row is created BEFORE submission,
 *     the `fromSeq`/`toSeq` range is uniquely indexed, and the contract itself reverts
 *     on a repeated `batchId`. Three independent guards, because a duplicate anchor
 *     means two conflicting "truths" for one range.
 *  3. **The chain can be unreachable.** An RPC outage marks the batch FAILED with a
 *     reason and leaves the ledger entries unstamped, so the next run retries them.
 *     It never marks them anchored.
 *
 * With no signing key configured the batcher runs in DRY_RUN: roots are computed and
 * stored so the pipeline is exercised and verifiable, but nothing is submitted. That
 * is an honest state with its own status value, not a silent no-op.
 */
import { ethers } from 'ethers';
import env, { anchorCanSubmit } from '../config/env.js';
import { AnchorBatch } from '../models/AnchorBatch.js';
import { Ledger } from '../models/Ledger.js';
import { getUnanchored, stampAnchorBatch } from './ledger.js';
import { merkleRoot, merkleProof, verifyProof } from './merkle.js';
import { ANCHOR_STATUS, ANCHOR_NETWORK, ANCHOR_CHAIN_ID } from '../models/enums.js';
import { loggerFor } from '../utils/logger.js';
import { Conflict } from '../utils/errors.js';

const log = loggerFor('anchor');

/** The only ABI fragments we use. Keeping this minimal keeps the coupling visible. */
export const LEXX_ANCHOR_ABI = [
  'function anchorBatch(bytes32 batchId, bytes32 merkleRoot, uint64 fromSeq, uint64 toSeq) external',
  'function isAnchored(bytes32 batchId) external view returns (bool)',
  'function getBatch(bytes32 batchId) external view returns (tuple(bytes32 merkleRoot, uint64 fromSeq, uint64 toSeq, uint64 anchoredAt, address anchoredBy))',
  'function verifyEntry(bytes32 batchId, bytes32 entryHash, bytes32[] calldata proof) external view returns (bool)',
  'event BatchAnchored(bytes32 indexed batchId, bytes32 merkleRoot, uint64 fromSeq, uint64 toSeq, uint256 timestamp, address indexed anchoredBy)',
];

let provider = null;
let contract = null;

/** Lazily build the chain connection. Never throws at import time. */
function getContract({ readOnly = false } = {}) {
  if (!env.ANCHOR_CONTRACT_ADDRESS) return null;

  if (!provider) {
    provider = new ethers.JsonRpcProvider(env.ANCHOR_RPC_URL, {
      chainId: env.ANCHOR_CHAIN_ID,
      name: ANCHOR_NETWORK,
    });
  }

  if (readOnly || !env.ANCHOR_PRIVATE_KEY) {
    return new ethers.Contract(env.ANCHOR_CONTRACT_ADDRESS, LEXX_ANCHOR_ABI, provider);
  }

  if (!contract) {
    // The key comes from configuration and is never logged; the logger redacts it by
    // path as well, so an accidental object dump cannot expose it.
    const wallet = new ethers.Wallet(env.ANCHOR_PRIVATE_KEY, provider);
    contract = new ethers.Contract(env.ANCHOR_CONTRACT_ADDRESS, LEXX_ANCHOR_ABI, wallet);
  }
  return contract;
}

/**
 * Deterministic 32-byte batch id: the sequence range it covers AND the root it commits.
 *
 * The range alone is not unique. A ledger that is reset — every demo rehearsal does
 * it — starts again at sequence 1, and its first batch would have asked the contract
 * to anchor an id the contract already holds under a different root. The contract
 * correctly refuses (and the batcher reports ON_CHAIN_ROOT_MISMATCH), so the new
 * ledger could never be anchored at all. Committing the root keeps the id stable for
 * a retry of the same batch — same entries, same root, same id — while two different
 * ledgers can no longer collide.
 */
export function computeBatchId(fromSeq, toSeq, merkleRootHex) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`lexx-batch:${ANCHOR_NETWORK}:${fromSeq}-${toSeq}:${String(merkleRootHex).toLowerCase()}`)
  );
}

/**
 * Run one batching cycle.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] max ledger entries in a batch
 * @param {boolean} [opts.force] batch even a single entry (default true)
 * @returns {Promise<{batched:boolean, batch?:object, reason?:string}>}
 */
export async function runAnchorCycle({ limit = env.ANCHOR_BATCH_MAX } = {}) {
  // Settle anything whose transaction went out but whose outcome we never read back.
  // Until that is known its entries are neither anchored nor free to re-batch, so a
  // new batch over them would put the same entries on chain twice.
  const reconciled = anchorCanSubmit ? await reconcileSubmittedBatches() : [];
  if (reconciled.some((r) => r.status === ANCHOR_STATUS.SUBMITTED)) {
    return { batched: false, reason: 'AWAITING_RECEIPT', reconciled, promoted: [] };
  }

  // History first. Roots computed while submission was off are still only local; now
  // that it is on, they go to the chain before anything newer does, so the on-chain
  // record has no hole where the dry-run period was.
  const promoted = anchorCanSubmit ? await promoteDryRunBatches() : [];

  const entries = await getUnanchored(limit);
  if (entries.length === 0) {
    return { batched: false, reason: 'NOTHING_TO_ANCHOR', promoted, reconciled };
  }

  const fromSeq = entries[0].seq;
  const toSeq = entries.at(-1).seq;
  const leafHashes = entries.map((e) => e.entryHash);
  const root = merkleRoot(leafHashes);
  const batchId = computeBatchId(fromSeq, toSeq, root);

  // Guard 1: this exact range must not already have a batch. The unique index on
  // (fromSeq, toSeq) turns a concurrent second batcher into a duplicate-key error
  // rather than a second anchor.
  let batch;
  try {
    batch = await AnchorBatch.create({
      batchId,
      fromSeq,
      toSeq,
      leafCount: entries.length,
      leafHashes,
      merkleRoot: root,
      network: ANCHOR_NETWORK,
      chainId: ANCHOR_CHAIN_ID,
      contractAddress: env.ANCHOR_CONTRACT_ADDRESS ?? null,
      status: ANCHOR_STATUS.PENDING,
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;

    // The range already has a batch. If it is one that definitively failed — nothing
    // sent, or sent and reverted — the same entries are retried under the same id.
    // Anything else (a concurrent batcher, a batch awaiting its receipt) is left alone.
    const existing = await AnchorBatch.findOne({ fromSeq, toSeq }).lean();
    const retryable =
      anchorCanSubmit &&
      existing?.status === ANCHOR_STATUS.FAILED &&
      existing.batchId === batchId &&
      (!existing.txHash ||
        existing.failureReason === 'TRANSACTION_REVERTED' ||
        existing.failureReason === 'TRANSACTION_DROPPED');
    if (!retryable) {
      log.warn({ fromSeq, toSeq, status: existing?.status }, 'batch for this range already exists; skipping');
      return { batched: false, reason: 'BATCH_ALREADY_EXISTS', promoted, reconciled };
    }
    log.info({ fromSeq, toSeq }, 'retrying a failed batch for this range');
    const result = await submitBatch(batchHandle({ ...existing, txHash: null, failureReason: null }), entries);
    return { ...result, promoted, reconciled };
  }

  // Dry run: the pipeline is fully exercised and the root is verifiable locally.
  if (!anchorCanSubmit) {
    batch.status = ANCHOR_STATUS.DRY_RUN;
    batch.anchoredAt = new Date();
    await batch.save();
    await stampAnchorBatch(entries.map((e) => e.seq), batchId);

    log.info(
      { batchId, fromSeq, toSeq, leaves: entries.length, root },
      'anchor DRY_RUN — root computed and stored, nothing submitted'
    );
    return { batched: true, batch: batch.toObject(), reason: 'DRY_RUN' };
  }

  const result = await submitBatch(batch, entries);
  return { ...result, promoted, reconciled };
}

/** The read-only chain connection, for receipts. */
function getProvider() {
  if (!getContract({ readOnly: true })) return null;
  return provider;
}

/**
 * Read a transaction's receipt and record what it says.
 *
 * `tx.wait()` is not the only way to learn an outcome, and on this RPC it is not a
 * reliable one: a malformed reply while waiting ("could not coalesce error") used to
 * mark a batch FAILED even when its transaction had been mined successfully — leaving
 * its entries unstamped, its range blocked, and a real anchor on chain that our own
 * record denied. The receipt is the fact; this reads it.
 *
 * @returns {Promise<'CONFIRMED'|'REVERTED'|'UNKNOWN'>}
 */
async function settleFromReceipt(batch, entries) {
  const p = getProvider();
  if (!p || !batch.txHash) return 'UNKNOWN';

  let receipt;
  try {
    receipt = await p.getTransactionReceipt(batch.txHash);
  } catch (err) {
    log.warn({ batchId: batch.batchId, err: err?.shortMessage ?? err?.message }, 'receipt lookup failed');
    return 'UNKNOWN';
  }
  if (!receipt) return 'UNKNOWN';

  if (receipt.status !== 1) {
    batch.status = ANCHOR_STATUS.FAILED;
    batch.failureReason = 'TRANSACTION_REVERTED';
    await batch.save();
    return 'REVERTED';
  }

  batch.status = ANCHOR_STATUS.CONFIRMED;
  batch.blockNumber = receipt.blockNumber;
  batch.gasUsed = receipt.gasUsed?.toString() ?? null;
  batch.failureReason = null;
  batch.anchoredAt = batch.anchoredAt ?? new Date();
  await batch.save();
  await stampAnchorBatch(entries.map((e) => e.seq), batch.batchId);
  log.info({ batchId: batch.batchId, txHash: batch.txHash, block: receipt.blockNumber }, 'anchor confirmed from receipt');
  return 'CONFIRMED';
}

/**
 * Batches whose transaction was sent but whose outcome is not recorded: SUBMITTED
 * ones, and FAILED ones that nonetheless carry a transaction hash (the pre-fix record
 * of an RPC error while waiting). Each is settled from its receipt.
 */
async function reconcileSubmittedBatches() {
  const rows = await AnchorBatch.find({
    txHash: { $ne: null },
    $or: [
      { status: ANCHOR_STATUS.SUBMITTED },
      {
        status: ANCHOR_STATUS.FAILED,
        failureReason: { $nin: ['TRANSACTION_REVERTED', 'TRANSACTION_DROPPED'] },
      },
    ],
  })
    .sort({ fromSeq: 1 })
    .limit(10)
    .lean();

  const outcomes = [];
  for (const row of rows) {
    const batch = batchHandle(row);
    const entries = await Ledger.find({ seq: { $gte: row.fromSeq, $lte: row.toSeq } }).sort({ seq: 1 }).lean();
    const outcome = await settleFromReceipt(batch, entries);

    if (outcome === 'UNKNOWN') {
      // No receipt. Recent: still waiting, and nothing new is batched over it. Long
      // gone: the transaction was dropped, and the range is released to be retried.
      const sentAt = new Date(row.lastAttemptAt ?? row.createdAt).getTime();
      if (Date.now() - sentAt > RECEIPT_GIVE_UP_MS) {
        batch.status = ANCHOR_STATUS.FAILED;
        batch.failureReason = 'TRANSACTION_DROPPED';
      } else {
        batch.status = ANCHOR_STATUS.SUBMITTED;
      }
      await batch.save();
    }
    outcomes.push({ batchId: row.batchId, fromSeq: row.fromSeq, toSeq: row.toSeq, outcome, status: batch.status });
  }
  return outcomes;
}

/** How long an unanswered transaction is waited for before its range is retried. */
const RECEIPT_GIVE_UP_MS = 30 * 60 * 1000;

/**
 * Submit batches that were sealed in DRY_RUN, oldest first.
 *
 * A DRY_RUN batch is a real, final batch: its range is fixed, its root is fixed, and
 * its entries are already stamped with its id, so the ordinary cycle will never
 * re-batch them. Without this, switching submission on would anchor only what came
 * after the switch and leave everything before it provable to nobody but us.
 *
 * On a failure the batch goes BACK to DRY_RUN (with the reason kept) so the next cycle
 * retries it — its entries are stamped, so leaving it FAILED would strand them
 * permanently. The one exception is the chain disagreeing about the root, which no
 * retry can fix and which an operator has to see.
 */
async function promoteDryRunBatches({ max = 5 } = {}) {
  const rows = await AnchorBatch.find({ status: ANCHOR_STATUS.DRY_RUN })
    .sort({ fromSeq: 1 })
    .limit(max)
    .lean();

  const outcomes = [];
  for (const batch of rows.map(batchHandle)) {
    const entries = await Ledger.find({ anchorBatchId: batch.batchId }).sort({ seq: 1 }).lean();
    const result = await submitBatch(batch, entries);
    outcomes.push({ batchId: batch.batchId, fromSeq: batch.fromSeq, toSeq: batch.toSeq, ...pickOutcome(result) });

    if (!result.batched) {
      // submitBatch records a root disagreement as ON_CHAIN_ROOT_MISMATCH and then its
      // catch re-records it under the error's code, ANCHOR_ROOT_MISMATCH.
      if (!/ROOT_MISMATCH/.test(batch.failureReason ?? '')) {
        batch.status = ANCHOR_STATUS.DRY_RUN;
        await batch.save();
      }
      // An RPC outage will fail every batch behind this one too. Stop, and let the
      // next cycle try again from the oldest.
      break;
    }
    log.info({ batchId: batch.batchId, fromSeq: batch.fromSeq, toSeq: batch.toSeq }, 'dry-run batch anchored on chain');
  }
  return outcomes;
}

const pickOutcome = (r) => ({ batched: r.batched, reason: r.reason ?? null, txHash: r.batch?.txHash ?? null });

/** The fields a batch may still change after creation. Everything else is immutable. */
const MUTABLE_BATCH_FIELDS = Object.freeze([
  'status', 'txHash', 'blockNumber', 'gasUsed', 'anchoredAt', 'failureReason', 'attempts',
  'lastAttemptAt', 'contractAddress',
]);

/**
 * A stored batch, shaped like the document `submitBatch` expects, without hydrating it.
 *
 * Hydrating an existing AnchorBatch through Mongoose fails: the schema's immutable
 * fields carry defaults, and under `strict: 'throw'` applying those defaults to a
 * document that is not new is refused. Rather than weaken either guard, promotion works
 * on the plain row and writes back only the fields a batch is allowed to change.
 */
function batchHandle(row) {
  const handle = { ...row, attempts: row.attempts ?? 0 };
  handle.contractAddress = handle.contractAddress ?? env.ANCHOR_CONTRACT_ADDRESS ?? null;
  handle.save = async () => {
    const $set = {};
    for (const key of MUTABLE_BATCH_FIELDS) $set[key] = handle[key] ?? null;
    $set.attempts = handle.attempts ?? 0;
    await AnchorBatch.updateOne({ _id: row._id }, { $set });
    return handle;
  };
  handle.toObject = () => {
    const { save: _save, toObject: _toObject, ...plain } = handle;
    return plain;
  };
  return handle;
}

/**
 * Submit a PENDING batch and confirm it before recording success.
 *
 * Note on the `batch` document being mutated across `await`s: ESLint's
 * `require-atomic-updates` flags this, and the concern is a fair one in general. It is
 * safe here because exactly one writer ever holds a given batch — the row is created
 * in `runAnchorCycle` immediately before this call, and the unique index on
 * `(fromSeq, toSeq)` means a second batcher racing for the same range fails at
 * creation rather than reaching this function. The warnings are left visible rather
 * than suppressed, so the next person to touch this reconsiders the invariant.
 */
async function submitBatch(batch, entries) {
  const c = getContract();
  if (!c) {
    batch.status = ANCHOR_STATUS.FAILED;
    batch.failureReason = 'NO_CONTRACT_CONFIGURED';
    await batch.save();
    return { batched: false, reason: 'NO_CONTRACT_CONFIGURED' };
  }

  batch.attempts += 1;
  batch.lastAttemptAt = new Date();
  await batch.save();

  try {
    // Guard 2: ask the chain first. A retry after a receipt we never saw must not
    // resubmit — the contract would revert, but burning gas to discover that is
    // avoidable, and the already-anchored state is the correct outcome anyway.
    if (await c.isAnchored(batch.batchId)) {
      log.warn({ batchId: batch.batchId }, 'batch already anchored on chain; reconciling');
      const onChain = await c.getBatch(batch.batchId);
      if (onChain.merkleRoot.toLowerCase() !== batch.merkleRoot.toLowerCase()) {
        // The chain disagrees with us about this batch id. Never overwrite; surface it.
        batch.status = ANCHOR_STATUS.FAILED;
        batch.failureReason = 'ON_CHAIN_ROOT_MISMATCH';
        await batch.save();
        throw Conflict('ANCHOR_ROOT_MISMATCH', 'On-chain root does not match the computed root');
      }
      batch.status = ANCHOR_STATUS.CONFIRMED;
      batch.anchoredAt = new Date(Number(onChain.anchoredAt) * 1000);
      await batch.save();
      await stampAnchorBatch(entries.map((e) => e.seq), batch.batchId);
      return { batched: true, batch: batch.toObject(), reason: 'ALREADY_ANCHORED' };
    }

    const tx = await c.anchorBatch(batch.batchId, batch.merkleRoot, batch.fromSeq, batch.toSeq);

    batch.txHash = tx.hash;
    batch.status = ANCHOR_STATUS.SUBMITTED;
    await batch.save();

    log.info({ batchId: batch.batchId, txHash: tx.hash }, 'anchor transaction submitted');

    // Guard 3: a receipt, and a successful one. Anything else is a failure.
    const receipt = await tx.wait(env.ANCHOR_CONFIRMATIONS);

    if (!receipt || receipt.status !== 1) {
      batch.status = ANCHOR_STATUS.FAILED;
      batch.failureReason = 'TRANSACTION_REVERTED';
      await batch.save();
      log.error({ batchId: batch.batchId, txHash: tx.hash }, 'anchor transaction reverted');
      return { batched: false, reason: 'TRANSACTION_REVERTED' };
    }

    batch.status = ANCHOR_STATUS.CONFIRMED;
    batch.blockNumber = receipt.blockNumber;
    batch.gasUsed = receipt.gasUsed?.toString() ?? null;
    batch.anchoredAt = new Date();
    await batch.save();

    // Entries are stamped only after confirmation, so a failed anchor leaves them
    // available for the next cycle rather than marked as anchored to nothing.
    await stampAnchorBatch(entries.map((e) => e.seq), batch.batchId);

    log.info(
      { batchId: batch.batchId, txHash: tx.hash, block: receipt.blockNumber, network: ANCHOR_NETWORK },
      'anchor confirmed'
    );

    return { batched: true, batch: batch.toObject() };
  } catch (err) {
    // Provider errors can be enormous and can echo request bodies; keep a short,
    // operator-facing summary and nothing else.
    const summary = String(err?.shortMessage ?? err?.code ?? err?.message ?? 'UNKNOWN').slice(0, 200);

    // Once the transaction has gone out, an error is NOT a failure — it is an
    // unanswered question. Ask the receipt; if it has no answer yet, the batch stays
    // SUBMITTED and the next cycle asks again.
    if (batch.txHash && batch.status === ANCHOR_STATUS.SUBMITTED) {
      const outcome = await settleFromReceipt(batch, entries);
      if (outcome === 'CONFIRMED') return { batched: true, batch: batch.toObject(), reason: 'CONFIRMED_FROM_RECEIPT' };
      if (outcome === 'UNKNOWN') {
        batch.failureReason = summary;
        await batch.save();
        log.warn({ batchId: batch.batchId, txHash: batch.txHash, err: summary }, 'anchor outcome unknown; will re-check the receipt');
        return { batched: false, reason: 'AWAITING_RECEIPT' };
      }
      return { batched: false, reason: 'TRANSACTION_REVERTED' };
    }

    batch.status = ANCHOR_STATUS.FAILED;
    batch.failureReason = summary;
    await batch.save();

    log.error({ batchId: batch.batchId, err: batch.failureReason }, 'anchor failed');
    return { batched: false, reason: batch.failureReason };
  }
}

/**
 * Independently verify that a ledger entry is committed to by an anchored root.
 *
 * Recomputes the root from the ledger AS IT STANDS NOW. If any entry in the batch has
 * been altered since anchoring, the recomputed root diverges from the published one —
 * which is the entire point of anchoring.
 */
export async function verifyAnchoredEntry(seq) {
  const entry = await Ledger.findOne({ seq }).lean();
  if (!entry) return { ok: false, reason: 'ENTRY_NOT_FOUND' };
  if (!entry.anchorBatchId) return { ok: false, reason: 'NOT_ANCHORED' };

  // Every failure below still names the batch. The entry WAS stamped into one, and a
  // caller that saw no batch id reported an integrity failure as "not batched yet".
  const batch = await AnchorBatch.findOne({ batchId: entry.anchorBatchId }).lean();
  if (!batch) return { ok: false, reason: 'BATCH_NOT_FOUND', batchId: entry.anchorBatchId };

  const entries = await Ledger.find({ anchorBatchId: batch.batchId }).sort({ seq: 1 }).lean();
  const hashes = entries.map((e) => e.entryHash);
  const recomputedRoot = merkleRoot(hashes);

  if (recomputedRoot.toLowerCase() !== batch.merkleRoot.toLowerCase()) {
    return {
      ok: false,
      reason: 'ROOT_MISMATCH',
      batchId: batch.batchId,
      publishedRoot: batch.merkleRoot,
      computedRoot: recomputedRoot,
      network: batch.network,
      chainId: batch.chainId,
      txHash: batch.txHash,
      explorerUrl: batch.txHash ? `${env.ANCHOR_EXPLORER_BASE}/tx/${batch.txHash}` : null,
    };
  }

  const index = entries.findIndex((e) => e.seq === seq);
  const proof = merkleProof(hashes, index);
  const includedLocally = verifyProof(entry.entryHash, proof, batch.merkleRoot);

  // Where a chain connection exists, ask the contract too — that is the difference
  // between "our arithmetic agrees with our database" and "a third party can check".
  let onChainVerified = null;
  const c = getContract({ readOnly: true });
  if (c && batch.status === ANCHOR_STATUS.CONFIRMED) {
    try {
      onChainVerified = await c.verifyEntry(batch.batchId, `0x${entry.entryHash}`, proof);
    } catch (err) {
      log.warn({ err: err.message }, 'on-chain verification unavailable');
      onChainVerified = null;
    }
  }

  return {
    ok: includedLocally,
    reason: includedLocally ? null : 'PROOF_INVALID',
    batchId: batch.batchId,
    publishedRoot: batch.merkleRoot,
    computedRoot: recomputedRoot,
    proof,
    onChainVerified,
    network: batch.network,
    chainId: batch.chainId,
    txHash: batch.txHash,
    explorerUrl: batch.txHash ? `${env.ANCHOR_EXPLORER_BASE}/tx/${batch.txHash}` : null,
  };
}

/** Latest confirmed (or dry-run) batch, for the public `/api/anchors/latest`. */
export async function latestAnchor() {
  const batch = await AnchorBatch.findOne({
    status: { $in: [ANCHOR_STATUS.CONFIRMED, ANCHOR_STATUS.DRY_RUN] },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!batch) return null;

  // Public surface: roots and chain facts only. Never leaf hashes, which would
  // disclose the shape and volume of the ledger.
  return {
    batchId: batch.batchId,
    merkleRoot: batch.merkleRoot,
    fromSeq: batch.fromSeq,
    toSeq: batch.toSeq,
    leafCount: batch.leafCount,
    network: batch.network,
    chainId: batch.chainId,
    contractAddress: batch.contractAddress,
    txHash: batch.txHash,
    blockNumber: batch.blockNumber,
    status: batch.status,
    anchoredAt: batch.anchoredAt,
    explorerUrl: batch.txHash ? `${env.ANCHOR_EXPLORER_BASE}/tx/${batch.txHash}` : null,
  };
}

/**
 * The most recent batches, newest first, for the public verifier's history.
 *
 * Same public projection as `latestAnchor` — roots and chain facts, never leaves —
 * plus FAILED and SUBMITTED batches, because a verifier who can only see successes
 * cannot tell a quiet pipeline from a broken one.
 */
export async function recentAnchors(limit = 10) {
  const batches = await AnchorBatch.find({})
    .sort({ fromSeq: -1 })
    .limit(Math.min(Math.max(Number(limit) || 10, 1), 50))
    .select('-leafHashes')
    .lean();

  return batches.map((b) => ({
    batchId: b.batchId,
    merkleRoot: b.merkleRoot,
    fromSeq: b.fromSeq,
    toSeq: b.toSeq,
    leafCount: b.leafCount,
    status: b.status,
    txHash: b.txHash,
    blockNumber: b.blockNumber,
    anchoredAt: b.anchoredAt,
    explorerUrl: b.txHash ? `${env.ANCHOR_EXPLORER_BASE}/tx/${b.txHash}` : null,
  }));
}

/** What the public verifier needs to know about the chain side, stated in one place. */
export function anchorConfig() {
  return {
    network: ANCHOR_NETWORK,
    chainId: ANCHOR_CHAIN_ID,
    submitting: anchorCanSubmit,
    contractAddress: env.ANCHOR_CONTRACT_ADDRESS ?? null,
    contractExplorerUrl: env.ANCHOR_CONTRACT_ADDRESS
      ? `${env.ANCHOR_EXPLORER_BASE}/address/${env.ANCHOR_CONTRACT_ADDRESS}`
      : null,
    intervalMs: env.ANCHOR_INTERVAL_MS,
  };
}

// ---------------------------------------------------------------- scheduler ----

let timer = null;

/** Start the periodic batcher. Idempotent — calling twice does not double-schedule. */
export function startAnchorScheduler() {
  if (timer) return timer;
  // ANCHOR_BATCHING_ENABLED, not ANCHOR_ENABLED. Batching computes and stores the
  // Merkle root; ANCHOR_ENABLED only decides whether it is also SUBMITTED. Gating the
  // scheduler on the submission flag meant that with no funded key — the default, and
  // the shipped configuration — nothing was ever batched at all, so the entire
  // anchoring feature was inert while the documentation described it running.
  if (!env.ANCHOR_BATCHING_ENABLED) {
    log.info('anchor scheduler disabled (ANCHOR_BATCHING_ENABLED=false)');
    return null;
  }

  log.info(
    { intervalMs: env.ANCHOR_INTERVAL_MS, network: ANCHOR_NETWORK, canSubmit: anchorCanSubmit },
    anchorCanSubmit
      ? 'anchor scheduler started — roots will be submitted on chain'
      : 'anchor scheduler started in DRY_RUN — roots computed and stored, nothing submitted'
  );

  // Run one cycle immediately rather than making the first root wait a full interval.
  // Five minutes of "No batch has been anchored yet" is the whole anchoring story
  // missing from the first five minutes of any demo or any fresh boot.
  runAnchorCycle().catch((err) => log.error({ err: err.message }, 'initial anchor cycle failed'));

  timer = setInterval(() => {
    runAnchorCycle().catch((err) => log.error({ err: err.message }, 'anchor cycle failed'));
  }, env.ANCHOR_INTERVAL_MS);

  timer.unref?.(); // never hold the process open on the scheduler alone
  return timer;
}

export function stopAnchorScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: drop the memoised provider/contract between suites. */
export const __resetChainConnection = () => {
  provider = null;
  contract = null;
};

export default {
  runAnchorCycle,
  verifyAnchoredEntry,
  latestAnchor,
  recentAnchors,
  anchorConfig,
  computeBatchId,
  startAnchorScheduler,
  stopAnchorScheduler,
};
