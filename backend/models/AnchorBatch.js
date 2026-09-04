/**
 * A batch of ledger entries whose Merkle root has been (or will be) anchored
 * on MONAD TESTNET.
 *
 * What goes on chain is ONLY: batchId, merkleRoot, fromSeq, toSeq.
 * No evidence, no file contents, no PII, no case identifiers, no AI triage.
 *
 * `status` is a real state machine, not decoration: a batch is CONFIRMED only after
 * the transaction receipt has been read back from the chain. Marking a batch
 * anchored on submission alone would let a reverted transaction masquerade as proof.
 */
import mongoose from 'mongoose';
import { ANCHOR_STATUS, ANCHOR_NETWORK, ANCHOR_CHAIN_ID, values } from './enums.js';

const { Schema } = mongoose;

const AnchorBatchSchema = new Schema(
  {
    /** 0x-prefixed 32-byte id, also the on-chain key. Unique — prevents double anchoring. */
    batchId: { type: String, required: true, unique: true, immutable: true },

    fromSeq: { type: Number, required: true, immutable: true },
    toSeq: { type: Number, required: true, immutable: true },
    leafCount: { type: Number, required: true, immutable: true },

    /** Leaves in tree order, so the root is independently recomputable. */
    leafHashes: { type: [String], default: [], immutable: true },
    merkleRoot: { type: String, required: true, immutable: true },

    // ---- chain facts (ADR-002) ----
    network: { type: String, default: ANCHOR_NETWORK, immutable: true },
    chainId: { type: Number, default: ANCHOR_CHAIN_ID, immutable: true },
    contractAddress: { type: String, default: null },
    txHash: { type: String, default: null },
    blockNumber: { type: Number, default: null },
    gasUsed: { type: String, default: null },
    anchoredAt: { type: Date, default: null },

    status: {
      type: String,
      enum: values(ANCHOR_STATUS),
      default: ANCHOR_STATUS.PENDING,
      index: true,
    },
    /** Populated on FAILED. Safe operator-facing text, never a raw provider dump. */
    failureReason: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
  },
  { collection: 'anchor_batches', timestamps: true, versionKey: false, strict: 'throw' }
);

AnchorBatchSchema.index({ status: 1, createdAt: -1 });
AnchorBatchSchema.index({ fromSeq: 1, toSeq: 1 });
AnchorBatchSchema.index({ txHash: 1 }, { sparse: true });
// A given sequence range may only be anchored once — the idempotency backstop.
AnchorBatchSchema.index(
  { fromSeq: 1, toSeq: 1 },
  { unique: true, name: 'unique_seq_range' }
);

/** Explorer link for the UI. Built from config so the network can never drift. */
AnchorBatchSchema.methods.explorerUrl = function explorerUrl(explorerBase) {
  if (!this.txHash) return null;
  return `${explorerBase.replace(/\/$/, '')}/tx/${this.txHash}`;
};

export const AnchorBatch = mongoose.model('AnchorBatch', AnchorBatchSchema);
export default AnchorBatch;
