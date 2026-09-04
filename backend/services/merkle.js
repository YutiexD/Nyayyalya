/**
 * Merkle tree for ledger anchoring.
 *
 * # This file must agree byte-for-byte with LexxAnchor.sol
 *
 * A mismatch here does not fail loudly — it produces roots that never verify, which
 * looks like "the blockchain bit is broken" and is miserable to debug. The
 * convention, matching `contracts/contracts/LexxAnchor.sol`:
 *
 *   leaf  = keccak256(entryHashBytes)          // ONE pre-hash of the 32 raw bytes
 *   node  = keccak256(min(a,b) || max(a,b))    // SORTED pair, unsigned 256-bit compare
 *   odd node at any level is PROMOTED unchanged to the next level
 *   single leaf: root == leaf, proof == []
 *
 * Two details are easy to get wrong and both are load-bearing:
 *
 *  1. **Leaves are pre-hashed.** The ledger's `entryHash` is NOT the leaf; keccak256
 *     of it is. This domain-separates leaves from internal nodes, which is what stops
 *     an attacker presenting an internal node as if it were a leaf (second-preimage).
 *  2. **The tree is keccak256, the ledger is sha256.** The ledger's hash chain uses
 *     SHA-256 (ADR-007); the tree built over those hashes uses keccak256, because
 *     that is what the EVM verifies cheaply.
 */
import { keccak256, concat, getBytes } from 'ethers';
import { BadRequest } from '../utils/errors.js';

/** Normalise a 64-char hex ledger hash (with or without 0x) to 0x-prefixed. */
function toBytes32Hex(entryHash) {
  const hex = String(entryHash).startsWith('0x') ? String(entryHash) : `0x${entryHash}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw BadRequest('INVALID_LEDGER_HASH', 'Ledger hash must be 32 bytes of hex');
  }
  return hex.toLowerCase();
}

/** leaf = keccak256(entryHash). Must match `LexxAnchor.leafOf`. */
export const leafOf = (entryHash) => keccak256(toBytes32Hex(entryHash));

/** Sorted-pair hash. Unsigned 256-bit ordering, exactly as OpenZeppelin MerkleProof does. */
export function hashPair(a, b) {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return keccak256(concat([getBytes(lo), getBytes(hi)]));
}

/**
 * Build every level of the tree, bottom-up.
 * @param {string[]} leaves 0x-prefixed leaf hashes
 * @returns {string[][]} levels[0] is the leaves, levels.at(-1) is [root]
 */
export function buildLevels(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw BadRequest('EMPTY_MERKLE_TREE', 'Cannot build a Merkle tree with no leaves');
  }
  const levels = [leaves.slice()];
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1);
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      // An odd final node is promoted unchanged rather than paired with itself.
      // Duplicating it instead is the classic CVE-2012-2459 style malleability bug.
      next.push(i + 1 < current.length ? hashPair(current[i], current[i + 1]) : current[i]);
    }
    levels.push(next);
  }
  return levels;
}

/**
 * Merkle root over ledger entry hashes.
 * @param {string[]} entryHashes raw ledger entryHash values, in sequence order
 * @returns {string} 0x-prefixed root
 */
export function merkleRoot(entryHashes) {
  const leaves = entryHashes.map(leafOf);
  return buildLevels(leaves).at(-1)[0];
}

/**
 * Inclusion proof for one entry.
 * @returns {string[]} sibling hashes, bottom-up. Empty for a single-leaf tree.
 */
export function merkleProof(entryHashes, index) {
  if (!Number.isInteger(index) || index < 0 || index >= entryHashes.length) {
    throw BadRequest('INDEX_OUT_OF_RANGE', 'Leaf index is out of range');
  }
  const levels = buildLevels(entryHashes.map(leafOf));
  const proof = [];
  let idx = index;

  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    // A promoted odd node has no sibling at this level and contributes nothing.
    if (siblingIdx < nodes.length) proof.push(nodes[siblingIdx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify an inclusion proof locally — the same computation the contract performs.
 * Lets the verify endpoint report ANCHOR_MATCH without an RPC round trip.
 */
export function verifyProof(entryHash, proof, root) {
  let computed = leafOf(entryHash);
  for (const sibling of proof) computed = hashPair(computed, sibling);
  return computed.toLowerCase() === String(root).toLowerCase();
}

export default { leafOf, hashPair, merkleRoot, merkleProof, verifyProof, buildLevels };
