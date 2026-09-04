// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title LexxAnchor
 * @notice Tamper-evidence anchor for the LEXX 2.0 evidence ledger.
 *
 * @dev ==========================================================================
 *      WHAT GOES ON CHAIN — AND WHAT NEVER DOES
 *      ==========================================================================
 *
 *      This contract stores, for each batch of ledger entries, exactly three facts:
 *
 *        1. a Merkle root  — one 32-byte hash summarising the batch,
 *        2. the sequence range (fromSeq..toSeq) of ledger entries it covers,
 *        3. the block timestamp at which it was anchored, and who anchored it.
 *
 *      NOTHING ELSE IS EVER WRITTEN HERE. Specifically, this contract never
 *      receives and never stores:
 *
 *        - evidence files, or any part of their contents;
 *        - hashes of evidence files;
 *        - personal data of any kind — names, badge numbers, phone numbers,
 *          addresses, or any hash derived from them;
 *        - case identifiers, FIR numbers, station codes or court identifiers;
 *        - AI triage scores, classifications or any model output;
 *        - audit-log contents.
 *
 *      A Merkle root is a one-way summary. It proves that a set of ledger entries
 *      existed in a particular order at a particular time. It reveals nothing about
 *      what those entries say, how many there are beyond the declared sequence
 *      range, or who they concern. That asymmetry is the entire point: the public
 *      chain gives independent, permanent proof of non-tampering while the case
 *      material stays inside the jurisdiction, encrypted, and access-controlled.
 *
 *      Because Monad Testnet is a public chain, this restriction is a privacy
 *      control, not a style preference. Any change that widens what is submitted
 *      here is a data-protection decision, not a refactor.
 *
 *      ==========================================================================
 *      TARGET NETWORK
 *      ==========================================================================
 *
 *      Deployed to Monad Testnet — chain id 10143, explorer
 *      https://testnet.monadexplorer.com.
 *
 *      ==========================================================================
 *      MERKLE CONVENTION — the backend MUST build trees identically
 *      ==========================================================================
 *
 *      Verification uses OpenZeppelin's {MerkleProof}, which is *sorted-pair
 *      keccak256*. Precisely:
 *
 *        leaf   = keccak256(entryHash)                      // 32 raw bytes in
 *        node   = keccak256(min(a,b) || max(a,b))           // unsigned 256-bit compare
 *        root   = repeated pairing to a single 32-byte value
 *
 *      where `entryHash` is the LEXX ledger's own 32-byte entry hash and `||` is
 *      plain byte concatenation. Children are ordered by numeric value before
 *      hashing, so a proof carries no left/right direction bits.
 *
 *      Two details are load-bearing and silently break verification if missed:
 *
 *        - LEAVES ARE PRE-HASHED ONCE with keccak256 before entering the tree.
 *          This domain-separates leaves from internal nodes and removes the
 *          classic second-preimage attack in which an internal node is presented
 *          as if it were a leaf. Use {leafOf} — or {verifyEntry}, which applies it
 *          for you — rather than reimplementing it.
 *        - PAIRS ARE SORTED, not positional. A tree built with positional
 *          (left/right) hashing produces a different root from identical inputs.
 *
 *      An odd node at any level is promoted unchanged to the next level; the
 *      backend's tree builder must do the same. A single-leaf batch has
 *      root == leaf and an empty proof.
 *
 *      ==========================================================================
 *      SECURITY MODEL
 *      ==========================================================================
 *
 *      - ANCHOR_ROLE may submit batches. DEFAULT_ADMIN_ROLE may grant and revoke
 *        that role. Both are supplied to the constructor; there are no hardcoded
 *        addresses anywhere in this file.
 *      - Anchoring is append-only and single-shot per batchId. Re-anchoring an
 *        existing batchId reverts with {BatchAlreadyAnchored}. The backend retries
 *        on RPC failure, and a retry must never be able to create a second,
 *        divergent truth for one batch. There is no update path and no delete
 *        path, by design, for anyone — including the admin.
 *      - A compromised ANCHOR_ROLE key can anchor junk roots under new batchIds,
 *        or halt anchoring. It can NOT rewrite or erase an already-anchored batch,
 *        which is the property the evidence story actually depends on.
 */
contract LexxAnchor is AccessControl {
    // ---------------------------------------------------------------- roles ----

    /// @notice Role permitted to submit Merkle roots. Held by the backend anchor signer.
    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");

    // --------------------------------------------------------------- types ----

    /**
     * @notice One anchored batch of ledger entries.
     * @dev Storage layout — 3 slots, checked field by field:
     *
     *        slot 0 : merkleRoot                              (32 bytes, full slot)
     *        slot 1 : fromSeq | toSeq | anchoredAt            (8 + 8 + 8 = 24 bytes)
     *        slot 2 : anchoredBy                              (20 bytes)
     *
     *      The design sketch used `uint256` for fromSeq, toSeq and anchoredAt, which
     *      costs one full slot each — 4 slots for 4 fields. Tightening all three to
     *      `uint64` packs them into a single slot, so this struct stores five fields
     *      in three slots and saves one cold SSTORE (~20k gas) on every anchor, on a
     *      call made every five minutes for the life of the system.
     *
     *      The narrowing is safe with enormous margin:
     *        - fromSeq/toSeq index a Mongo-allocated ledger counter; uint64 tops out
     *          at 1.8e19 entries, which at one entry per microsecond is ~584,000
     *          years of continuous writing.
     *        - anchoredAt is a Unix second count; uint64 overflows in the year
     *          584 billion. Solidity 0.8 checked arithmetic makes the downcast of
     *          block.timestamp revert rather than wrap in the impossible case.
     *
     *      `anchoredBy` is not in the design sketch. It is added because attribution
     *      of who submitted a root is exactly the kind of question an audit asks, it
     *      is already public in the transaction's `from` field, and it costs nothing
     *      extra given the slot is otherwise unused.
     */
    struct Batch {
        bytes32 merkleRoot;
        uint64 fromSeq;
        uint64 toSeq;
        uint64 anchoredAt;
        address anchoredBy;
    }

    // ------------------------------------------------------------- storage ----

    /**
     * @notice Anchored batches by batchId.
     * @dev An unset entry reads back as an all-zero Batch. A stored batch always has
     *      a non-zero merkleRoot (enforced in {anchorBatch}), so `merkleRoot != 0` is
     *      a sound existence test — see {isAnchored}.
     */
    mapping(bytes32 batchId => Batch batch) public batches;

    // -------------------------------------------------------------- events ----

    /**
     * @notice Emitted once, and only once, per batchId.
     * @param batchId    Backend-generated identifier for this batch. Indexed.
     * @param merkleRoot Sorted-pair keccak256 root over the batch's leaves.
     * @param fromSeq    First ledger sequence number covered, inclusive.
     * @param toSeq      Last ledger sequence number covered, inclusive.
     * @param timestamp  Block timestamp at which the batch was anchored.
     * @param anchoredBy Account that submitted the batch. Indexed.
     */
    event BatchAnchored(
        bytes32 indexed batchId,
        bytes32 merkleRoot,
        uint64 fromSeq,
        uint64 toSeq,
        uint256 timestamp,
        address indexed anchoredBy
    );

    // ------------------------------------------------------------- errors -----

    /// @notice A constructor address argument was the zero address.
    error ZeroAddress();

    /// @notice batchId was bytes32(0), which is almost always an uninitialised value.
    error InvalidBatchId();

    /// @notice merkleRoot was bytes32(0); an empty batch must never be anchored.
    error EmptyMerkleRoot();

    /// @notice The sequence range was inverted (toSeq < fromSeq).
    error InvalidSeqRange(uint64 fromSeq, uint64 toSeq);

    /// @notice This batchId has already been anchored. Anchoring is single-shot.
    error BatchAlreadyAnchored(bytes32 batchId);

    // --------------------------------------------------------- constructor ----

    /**
     * @notice Deploys the anchor with its roles assigned from arguments only.
     * @dev No address is hardcoded. Both arguments are rejected if zero: granting
     *      DEFAULT_ADMIN_ROLE to address(0) would permanently orphan role
     *      administration, and granting ANCHOR_ROLE to address(0) is silently
     *      useless. `admin` and `anchor` may be the same account for a simple
     *      single-key deployment.
     * @param admin  Receives DEFAULT_ADMIN_ROLE — may grant and revoke ANCHOR_ROLE.
     * @param anchor Receives ANCHOR_ROLE — the backend's anchoring signer.
     */
    constructor(address admin, address anchor) {
        if (admin == address(0) || anchor == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ANCHOR_ROLE, anchor);
    }

    // -------------------------------------------------------------- write ----

    /**
     * @notice Anchors one batch of ledger entries by its Merkle root.
     * @dev Reverts if the batchId has already been anchored. This is the
     *      anti-replay property the backend depends on: the batcher retries on
     *      transient RPC failure, and a retry that landed twice would leave two
     *      different roots claiming to describe the same batch — two competing
     *      versions of the truth, with no on-chain way to tell which is real.
     *      A revert makes the retry safe and idempotent from the caller's side.
     *
     *      Callers must NOT pass anything derived from evidence contents, case
     *      identifiers or personal data. See the contract-level notice.
     *
     * @param batchId    Unique batch identifier from the backend. Must be non-zero.
     * @param merkleRoot Sorted-pair keccak256 root over the batch. Must be non-zero.
     * @param fromSeq    First ledger sequence covered, inclusive.
     * @param toSeq      Last ledger sequence covered, inclusive. Must be >= fromSeq.
     */
    function anchorBatch(
        bytes32 batchId,
        bytes32 merkleRoot,
        uint64 fromSeq,
        uint64 toSeq
    ) external onlyRole(ANCHOR_ROLE) {
        if (batchId == bytes32(0)) revert InvalidBatchId();
        if (merkleRoot == bytes32(0)) revert EmptyMerkleRoot();
        if (toSeq < fromSeq) revert InvalidSeqRange(fromSeq, toSeq);
        if (batches[batchId].merkleRoot != bytes32(0)) revert BatchAlreadyAnchored(batchId);

        uint64 anchoredAt = uint64(block.timestamp);

        batches[batchId] = Batch({
            merkleRoot: merkleRoot,
            fromSeq: fromSeq,
            toSeq: toSeq,
            anchoredAt: anchoredAt,
            anchoredBy: msg.sender
        });

        emit BatchAnchored(batchId, merkleRoot, fromSeq, toSeq, anchoredAt, msg.sender);
    }

    // --------------------------------------------------------------- views ----

    /**
     * @notice Returns the full stored batch record.
     * @dev An unknown batchId returns a zero-valued struct rather than reverting, so
     *      the backend's verification path can branch on {isAnchored} without
     *      try/catch. Prefer this over the auto-generated `batches` getter when you
     *      want the record as one struct.
     * @param batchId Batch identifier to read.
     * @return batch The stored record, all-zero if never anchored.
     */
    function getBatch(bytes32 batchId) external view returns (Batch memory batch) {
        return batches[batchId];
    }

    /**
     * @notice Whether a batchId has been anchored.
     * @dev True exactly when a batch was successfully stored, because {anchorBatch}
     *      rejects a zero merkleRoot and there is no path that clears one.
     * @param batchId Batch identifier to test.
     * @return anchored True if anchored, false if unknown.
     */
    function isAnchored(bytes32 batchId) external view returns (bool anchored) {
        return batches[batchId].merkleRoot != bytes32(0);
    }

    /**
     * @notice Computes the Merkle leaf for a LEXX ledger entry hash.
     * @dev leaf = keccak256(entryHash). The single pre-hash domain-separates leaves
     *      from internal nodes — without it, a 32-byte internal node could be
     *      presented as a leaf with a shortened proof and would verify. Tree
     *      builders must apply this to every entryHash before pairing.
     * @param entryHash The ledger entry's 32-byte hash.
     * @return leaf The tree leaf for that entry.
     */
    function leafOf(bytes32 entryHash) public pure returns (bytes32 leaf) {
        return keccak256(abi.encodePacked(entryHash));
    }

    /**
     * @notice Verifies that a leaf is included in an anchored batch's Merkle tree.
     * @dev Sorted-pair keccak256, via OpenZeppelin {MerkleProof}. `leaf` is the
     *      ALREADY-HASHED leaf — that is, {leafOf}(entryHash), not the raw entryHash.
     *      Pass the raw entryHash to {verifyEntry} instead if you would rather not
     *      hold that distinction yourself.
     *
     *      Returns false — it does not revert — for an unknown batchId, so a caller
     *      can treat "not anchored yet" and "not in this batch" uniformly. Use
     *      {isAnchored} to tell the two apart.
     *
     *      This function is the third-party verification path: anyone holding a
     *      ledger entry hash and its proof can check inclusion against the public
     *      chain without any access to LEXX, and without LEXX learning that they did.
     *
     * @param batchId Batch to verify against.
     * @param leaf    The tree leaf, i.e. {leafOf}(entryHash).
     * @param proof   Sibling hashes from leaf to root, bottom-up.
     * @return valid True if the proof reconstructs the stored root.
     */
    function verifyProof(
        bytes32 batchId,
        bytes32 leaf,
        bytes32[] calldata proof
    ) external view returns (bool valid) {
        bytes32 root = batches[batchId].merkleRoot;
        if (root == bytes32(0)) return false;

        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    /**
     * @notice Verifies inclusion of a raw ledger entry hash in an anchored batch.
     * @dev Convenience wrapper: applies {leafOf} then {verifyProof}'s logic, so the
     *      leaf convention cannot be got wrong at the call site. This is the
     *      recommended entry point for the backend and for any external verifier.
     * @param batchId   Batch to verify against.
     * @param entryHash The LEXX ledger entry hash, unhashed.
     * @param proof     Sibling hashes from leaf to root, bottom-up.
     * @return valid True if the proof reconstructs the stored root.
     */
    function verifyEntry(
        bytes32 batchId,
        bytes32 entryHash,
        bytes32[] calldata proof
    ) external view returns (bool valid) {
        bytes32 root = batches[batchId].merkleRoot;
        if (root == bytes32(0)) return false;

        return MerkleProof.verifyCalldata(proof, root, leafOf(entryHash));
    }
}
