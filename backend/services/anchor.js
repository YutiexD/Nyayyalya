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

/** Deterministic 32-byte batch id from the sequence range it covers. */
export function computeBatchId(fromSeq, toSeq) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`lexx-batch:${ANCHOR_NETWORK}:${fromSeq}-${toSeq}`)
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
  const entries = await getUnanchored(limit);
  if (entries.length === 0) return { batched: false, reason: 'NOTHING_TO_ANCHOR' };

  const fromSeq = entries[0].seq;
  const toSeq = entries.at(-1).seq;
  const batchId = computeBatchId(fromSeq, toSeq);
  const leafHashes = entries.map((e) => e.entryHash);
  const root = merkleRoot(leafHashes);

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
    if (err?.code === 11000) {
      log.warn({ fromSeq, toSeq }, 'batch for this range already exists; skipping');
      return { batched: false, reason: 'BATCH_ALREADY_EXISTS' };
    }
    throw err;
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

  return submitBatch(batch, entries);
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
    batch.status = ANCHOR_STATUS.FAILED;
    // Provider errors can be enormous and can echo request bodies; keep a short,
    // operator-facing summary and nothing else.
    batch.failureReason = String(err?.shortMessage ?? err?.code ?? err?.message ?? 'UNKNOWN').slice(0, 200);
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

  const batch = await AnchorBatch.findOne({ batchId: entry.anchorBatchId }).lean();
  if (!batch) return { ok: false, reason: 'BATCH_NOT_FOUND' };

  const entries = await Ledger.find({ anchorBatchId: batch.batchId }).sort({ seq: 1 }).lean();
  const hashes = entries.map((e) => e.entryHash);
  const recomputedRoot = merkleRoot(hashes);

  if (recomputedRoot.toLowerCase() !== batch.merkleRoot.toLowerCase()) {
    return {
      ok: false,
      reason: 'ROOT_MISMATCH',
      publishedRoot: batch.merkleRoot,
      computedRoot: recomputedRoot,
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

// ---------------------------------------------------------------- scheduler ----

let timer = null;

/** Start the periodic batcher. Idempotent — calling twice does not double-schedule. */
export function startAnchorScheduler() {
  if (timer) return timer;
  if (!env.ANCHOR_ENABLED) {
    log.info('anchor scheduler disabled (ANCHOR_ENABLED=false)');
    return null;
  }

  log.info(
    { intervalMs: env.ANCHOR_INTERVAL_MS, network: ANCHOR_NETWORK, canSubmit: anchorCanSubmit },
    'anchor scheduler started'
  );

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
  computeBatchId,
  startAnchorScheduler,
  stopAnchorScheduler,
};
