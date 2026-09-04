/**
 * LEXX 2.0 — LexxAnchor test suite.
 *
 * Runs against the in-process Hardhat network (chain id 31337). Nothing here touches
 * Monad Testnet or any other public chain.
 *
 * The Merkle helpers below are a deliberate second implementation of the tree the
 * backend must build: leaves pre-hashed once with keccak256, internal nodes hashed as
 * keccak256 of the SORTED pair, odd nodes promoted unchanged. If the backend's
 * services/merkle.js disagrees with this file, verification breaks silently in
 * production — which is why the convention is tested here from both directions
 * (proofs that must verify, and forgeries that must not).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// ---------------------------------------------------------------------------
// Merkle helpers — sorted-pair keccak256, matching OpenZeppelin's MerkleProof
// ---------------------------------------------------------------------------

/** leaf = keccak256(entryHash). One pre-hash, domain-separating leaves from nodes. */
function leafOf(entryHash) {
  return ethers.keccak256(entryHash);
}

/** node = keccak256(min(a,b) || max(a,b)), compared as unsigned 256-bit integers. */
function hashPair(a, b) {
  const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([lo, hi]));
}

/** Builds every layer of the tree, bottom-up. An odd node is promoted unchanged. */
function buildLayers(leaves) {
  if (leaves.length === 0) throw new Error("refusing to build a tree with no leaves");

  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return layers;
}

function rootOf(layers) {
  return layers[layers.length - 1][0];
}

/** Sibling hashes from leaf to root, bottom-up. Promoted nodes contribute nothing. */
function proofFor(layers, leafIndex) {
  const proof = [];
  let index = leafIndex;
  for (let level = 0; level < layers.length - 1; level += 1) {
    const layer = layers[level];
    const siblingIndex = index ^ 1;
    if (siblingIndex < layer.length) proof.push(layer[siblingIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

/** Stand-in for the LEXX ledger's entryHash values. Deterministic, one per seq. */
function entryHashes(count, salt = "lexx") {
  return Array.from({ length: count }, (_, i) =>
    ethers.keccak256(ethers.toUtf8Bytes(`${salt}:entry:${i + 1}`))
  );
}

function treeFor(hashes) {
  const leaves = hashes.map(leafOf);
  const layers = buildLayers(leaves);
  return { leaves, layers, root: rootOf(layers) };
}

const id = (label) => ethers.keccak256(ethers.toUtf8Bytes(label));
const ZERO_BYTES32 = ethers.ZeroHash;
const ZERO_ADDRESS = ethers.ZeroAddress;

// ---------------------------------------------------------------------------

describe("LexxAnchor", function () {
  async function deployFixture() {
    const [admin, anchorSigner, outsider, secondAnchor] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("LexxAnchor");
    const anchor = await Factory.deploy(admin.address, anchorSigner.address);
    await anchor.waitForDeployment();

    const ANCHOR_ROLE = await anchor.ANCHOR_ROLE();
    const DEFAULT_ADMIN_ROLE = await anchor.DEFAULT_ADMIN_ROLE();

    return {
      anchor,
      Factory,
      admin,
      anchorSigner,
      outsider,
      secondAnchor,
      ANCHOR_ROLE,
      DEFAULT_ADMIN_ROLE,
    };
  }

  // -------------------------------------------------------------------------
  describe("deployment and roles", function () {
    it("grants DEFAULT_ADMIN_ROLE and ANCHOR_ROLE from constructor arguments", async function () {
      const { anchor, admin, anchorSigner, ANCHOR_ROLE, DEFAULT_ADMIN_ROLE } =
        await loadFixture(deployFixture);

      expect(await anchor.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await anchor.hasRole(ANCHOR_ROLE, anchorSigner.address)).to.equal(true);
    });

    it("does not grant ANCHOR_ROLE to the admin implicitly", async function () {
      const { anchor, admin, ANCHOR_ROLE } = await loadFixture(deployFixture);
      expect(await anchor.hasRole(ANCHOR_ROLE, admin.address)).to.equal(false);
    });

    it("reverts when the admin address is zero", async function () {
      const { Factory, anchor, anchorSigner } = await loadFixture(deployFixture);

      await expect(
        Factory.deploy(ZERO_ADDRESS, anchorSigner.address)
      ).to.be.revertedWithCustomError(anchor, "ZeroAddress");
    });

    it("reverts when the anchor address is zero", async function () {
      const { Factory, anchor, admin } = await loadFixture(deployFixture);

      await expect(Factory.deploy(admin.address, ZERO_ADDRESS)).to.be.revertedWithCustomError(
        anchor,
        "ZeroAddress"
      );
    });

    it("allows admin and anchor to be the same account", async function () {
      const { Factory, admin, ANCHOR_ROLE, DEFAULT_ADMIN_ROLE } = await loadFixture(deployFixture);

      const solo = await Factory.deploy(admin.address, admin.address);
      await solo.waitForDeployment();

      expect(await solo.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await solo.hasRole(ANCHOR_ROLE, admin.address)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("anchorBatch", function () {
    it("anchors a batch and emits BatchAnchored with the correct arguments", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const batchId = id("batch-0001");
      const { root } = treeFor(entryHashes(8));

      await expect(anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 8n))
        .to.emit(anchor, "BatchAnchored")
        .withArgs(batchId, root, 1n, 8n, anyValue, anchorSigner.address);

      const stored = await anchor.getBatch(batchId);
      expect(stored.merkleRoot).to.equal(root);
      expect(stored.fromSeq).to.equal(1n);
      expect(stored.toSeq).to.equal(8n);
      expect(stored.anchoredBy).to.equal(anchorSigner.address);
      expect(stored.anchoredAt).to.equal(BigInt(await time.latest()));
    });

    it("records the block timestamp in the event", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const batchId = id("batch-timestamp");
      const { root } = treeFor(entryHashes(2));

      const tx = await anchor.connect(anchorSigner).anchorBatch(batchId, root, 10n, 11n);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(anchor, "BatchAnchored")
        .withArgs(batchId, root, 10n, 11n, BigInt(block.timestamp), anchorSigner.address);
    });

    it("accepts a single-entry range (fromSeq == toSeq)", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const batchId = id("batch-single");
      const { root } = treeFor(entryHashes(1));

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 42n, 42n);
      expect(await anchor.isAnchored(batchId)).to.equal(true);
    });

    it("accepts sequence numbers at the uint64 boundary", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const maxUint64 = 2n ** 64n - 1n;
      const batchId = id("batch-max-seq");
      const { root } = treeFor(entryHashes(2));

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, maxUint64, maxUint64);

      const stored = await anchor.getBatch(batchId);
      expect(stored.fromSeq).to.equal(maxUint64);
      expect(stored.toSeq).to.equal(maxUint64);
    });

    it("anchors independent batches without interference", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const a = { batchId: id("batch-a"), ...treeFor(entryHashes(4, "a")) };
      const b = { batchId: id("batch-b"), ...treeFor(entryHashes(4, "b")) };

      await anchor.connect(anchorSigner).anchorBatch(a.batchId, a.root, 1n, 4n);
      await anchor.connect(anchorSigner).anchorBatch(b.batchId, b.root, 5n, 8n);

      expect((await anchor.getBatch(a.batchId)).merkleRoot).to.equal(a.root);
      expect((await anchor.getBatch(b.batchId)).merkleRoot).to.equal(b.root);
      expect(a.root).to.not.equal(b.root);
    });
  });

  // -------------------------------------------------------------------------
  describe("anti-replay — a batchId may be anchored exactly once", function () {
    it("reverts when the same batchId is anchored twice with the same root", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const batchId = id("batch-replay");
      const { root } = treeFor(entryHashes(4));

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 4n);

      await expect(anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 4n))
        .to.be.revertedWithCustomError(anchor, "BatchAlreadyAnchored")
        .withArgs(batchId);
    });

    it("reverts when the same batchId is re-anchored with a DIFFERENT root", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const batchId = id("batch-overwrite");
      const original = treeFor(entryHashes(4, "original"));
      const forged = treeFor(entryHashes(4, "forged"));

      await anchor.connect(anchorSigner).anchorBatch(batchId, original.root, 1n, 4n);

      await expect(anchor.connect(anchorSigner).anchorBatch(batchId, forged.root, 1n, 4n))
        .to.be.revertedWithCustomError(anchor, "BatchAlreadyAnchored")
        .withArgs(batchId);

      // The original root is untouched: there is exactly one truth per batch.
      expect((await anchor.getBatch(batchId)).merkleRoot).to.equal(original.root);
    });

    it("reverts even when a different ANCHOR_ROLE holder submits the same batchId", async function () {
      const { anchor, admin, anchorSigner, secondAnchor, ANCHOR_ROLE } =
        await loadFixture(deployFixture);

      await anchor.connect(admin).grantRole(ANCHOR_ROLE, secondAnchor.address);

      const batchId = id("batch-two-signers");
      const first = treeFor(entryHashes(4, "first"));
      const second = treeFor(entryHashes(4, "second"));

      await anchor.connect(anchorSigner).anchorBatch(batchId, first.root, 1n, 4n);

      await expect(anchor.connect(secondAnchor).anchorBatch(batchId, second.root, 1n, 4n))
        .to.be.revertedWithCustomError(anchor, "BatchAlreadyAnchored")
        .withArgs(batchId);
    });
  });

  // -------------------------------------------------------------------------
  describe("input validation", function () {
    it("reverts on a zero merkle root", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      await expect(
        anchor.connect(anchorSigner).anchorBatch(id("batch-empty-root"), ZERO_BYTES32, 1n, 4n)
      ).to.be.revertedWithCustomError(anchor, "EmptyMerkleRoot");
    });

    it("reverts on a zero batchId", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);
      const { root } = treeFor(entryHashes(2));

      await expect(
        anchor.connect(anchorSigner).anchorBatch(ZERO_BYTES32, root, 1n, 2n)
      ).to.be.revertedWithCustomError(anchor, "InvalidBatchId");
    });

    it("reverts when toSeq < fromSeq", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);
      const { root } = treeFor(entryHashes(2));

      await expect(anchor.connect(anchorSigner).anchorBatch(id("batch-inverted"), root, 9n, 4n))
        .to.be.revertedWithCustomError(anchor, "InvalidSeqRange")
        .withArgs(9n, 4n);
    });

    it("leaves no state behind after a rejected anchor", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const batchId = id("batch-rejected");
      const { root } = treeFor(entryHashes(2));

      await expect(anchor.connect(anchorSigner).anchorBatch(batchId, root, 9n, 4n)).to.be.reverted;
      expect(await anchor.isAnchored(batchId)).to.equal(false);

      // ...and the same id can still be used once the caller fixes the range.
      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 4n, 9n);
      expect(await anchor.isAnchored(batchId)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("access control", function () {
    it("reverts when a caller without ANCHOR_ROLE anchors", async function () {
      const { anchor, outsider, ANCHOR_ROLE } = await loadFixture(deployFixture);
      const { root } = treeFor(entryHashes(4));

      await expect(anchor.connect(outsider).anchorBatch(id("batch-outsider"), root, 1n, 4n))
        .to.be.revertedWithCustomError(anchor, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, ANCHOR_ROLE);
    });

    it("reverts when the admin anchors without holding ANCHOR_ROLE", async function () {
      const { anchor, admin, ANCHOR_ROLE } = await loadFixture(deployFixture);
      const { root } = treeFor(entryHashes(4));

      await expect(anchor.connect(admin).anchorBatch(id("batch-admin"), root, 1n, 4n))
        .to.be.revertedWithCustomError(anchor, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, ANCHOR_ROLE);
    });

    it("lets the admin grant ANCHOR_ROLE, after which the grantee can anchor", async function () {
      const { anchor, admin, secondAnchor, ANCHOR_ROLE } = await loadFixture(deployFixture);
      const { root } = treeFor(entryHashes(4));

      await expect(anchor.connect(admin).grantRole(ANCHOR_ROLE, secondAnchor.address))
        .to.emit(anchor, "RoleGranted")
        .withArgs(ANCHOR_ROLE, secondAnchor.address, admin.address);

      await anchor.connect(secondAnchor).anchorBatch(id("batch-granted"), root, 1n, 4n);
      expect(await anchor.isAnchored(id("batch-granted"))).to.equal(true);
    });

    it("lets the admin revoke ANCHOR_ROLE, after which the revoked key cannot anchor", async function () {
      const { anchor, admin, anchorSigner, ANCHOR_ROLE } = await loadFixture(deployFixture);
      const { root } = treeFor(entryHashes(4));

      await anchor.connect(anchorSigner).anchorBatch(id("batch-before-revoke"), root, 1n, 4n);

      await expect(anchor.connect(admin).revokeRole(ANCHOR_ROLE, anchorSigner.address))
        .to.emit(anchor, "RoleRevoked")
        .withArgs(ANCHOR_ROLE, anchorSigner.address, admin.address);

      expect(await anchor.hasRole(ANCHOR_ROLE, anchorSigner.address)).to.equal(false);

      await expect(
        anchor.connect(anchorSigner).anchorBatch(id("batch-after-revoke"), root, 5n, 8n)
      )
        .to.be.revertedWithCustomError(anchor, "AccessControlUnauthorizedAccount")
        .withArgs(anchorSigner.address, ANCHOR_ROLE);

      // Revocation is forward-only: already-anchored batches survive.
      expect(await anchor.isAnchored(id("batch-before-revoke"))).to.equal(true);
    });

    it("reverts when a non-admin tries to grant ANCHOR_ROLE", async function () {
      const { anchor, outsider, DEFAULT_ADMIN_ROLE, ANCHOR_ROLE } = await loadFixture(deployFixture);

      await expect(anchor.connect(outsider).grantRole(ANCHOR_ROLE, outsider.address))
        .to.be.revertedWithCustomError(anchor, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, DEFAULT_ADMIN_ROLE);
    });
  });

  // -------------------------------------------------------------------------
  describe("getBatch / isAnchored", function () {
    it("returns a zero-valued struct and false for an unknown batchId", async function () {
      const { anchor } = await loadFixture(deployFixture);
      const unknown = id("never-anchored");

      const stored = await anchor.getBatch(unknown);
      expect(stored.merkleRoot).to.equal(ZERO_BYTES32);
      expect(stored.fromSeq).to.equal(0n);
      expect(stored.toSeq).to.equal(0n);
      expect(stored.anchoredAt).to.equal(0n);
      expect(stored.anchoredBy).to.equal(ZERO_ADDRESS);

      expect(await anchor.isAnchored(unknown)).to.equal(false);
      expect(await anchor.isAnchored(ZERO_BYTES32)).to.equal(false);
    });

    it("agrees with the public `batches` mapping getter", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const batchId = id("batch-getter");
      const { root } = treeFor(entryHashes(4));
      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 3n, 6n);

      const viaGetter = await anchor.batches(batchId);
      const viaStruct = await anchor.getBatch(batchId);

      expect(viaGetter.merkleRoot).to.equal(viaStruct.merkleRoot);
      expect(viaGetter.fromSeq).to.equal(viaStruct.fromSeq);
      expect(viaGetter.toSeq).to.equal(viaStruct.toSeq);
      expect(viaGetter.anchoredAt).to.equal(viaStruct.anchoredAt);
      expect(viaGetter.anchoredBy).to.equal(viaStruct.anchoredBy);
    });
  });

  // -------------------------------------------------------------------------
  describe("verifyProof — sorted-pair Merkle inclusion", function () {
    it("agrees with the JS leaf convention", async function () {
      const { anchor } = await loadFixture(deployFixture);
      const [entryHash] = entryHashes(1);

      expect(await anchor.leafOf(entryHash)).to.equal(leafOf(entryHash));
    });

    it("returns true for every leaf of an anchored batch", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const hashes = entryHashes(8);
      const { leaves, layers, root } = treeFor(hashes);
      const batchId = id("batch-proofs-8");

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 8n);

      for (let i = 0; i < leaves.length; i += 1) {
        const proof = proofFor(layers, i);
        expect(await anchor.verifyProof(batchId, leaves[i], proof), `leaf ${i}`).to.equal(true);
        expect(await anchor.verifyEntry(batchId, hashes[i], proof), `entry ${i}`).to.equal(true);
      }
    });

    it("handles an odd leaf count (promoted nodes)", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const hashes = entryHashes(5, "odd");
      const { leaves, layers, root } = treeFor(hashes);
      const batchId = id("batch-proofs-5");

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 5n);

      for (let i = 0; i < leaves.length; i += 1) {
        expect(await anchor.verifyProof(batchId, leaves[i], proofFor(layers, i)), `leaf ${i}`).to.equal(
          true
        );
      }
    });

    it("handles a single-leaf batch: root == leaf, empty proof", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const hashes = entryHashes(1, "solo");
      const { leaves, root } = treeFor(hashes);
      expect(root).to.equal(leaves[0]);

      const batchId = id("batch-solo");
      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 1n);

      expect(await anchor.verifyProof(batchId, leaves[0], [])).to.equal(true);
      expect(await anchor.verifyEntry(batchId, hashes[0], [])).to.equal(true);
    });

    it("returns false for a forged leaf that was never in the batch", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const hashes = entryHashes(8);
      const { layers, root } = treeFor(hashes);
      const batchId = id("batch-forged-leaf");

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 8n);

      const forgedEntry = ethers.keccak256(ethers.toUtf8Bytes("lexx:entry:tampered"));
      const proof = proofFor(layers, 3);

      expect(await anchor.verifyProof(batchId, leafOf(forgedEntry), proof)).to.equal(false);
      expect(await anchor.verifyEntry(batchId, forgedEntry, proof)).to.equal(false);
    });

    it("returns false for a real leaf with a tampered proof", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const hashes = entryHashes(8);
      const { leaves, layers, root } = treeFor(hashes);
      const batchId = id("batch-forged-proof");

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 8n);

      const proof = proofFor(layers, 2);
      const tampered = [...proof];
      tampered[0] = ethers.keccak256(ethers.toUtf8Bytes("not-a-sibling"));

      expect(await anchor.verifyProof(batchId, leaves[2], tampered)).to.equal(false);
      expect(await anchor.verifyProof(batchId, leaves[2], proof.slice(1))).to.equal(false);
      expect(await anchor.verifyProof(batchId, leaves[2], [])).to.equal(false);
    });

    it("returns false for a valid proof presented against the wrong batch", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const a = treeFor(entryHashes(4, "batch-a"));
      const b = treeFor(entryHashes(4, "batch-b"));
      const idA = id("batch-cross-a");
      const idB = id("batch-cross-b");

      await anchor.connect(anchorSigner).anchorBatch(idA, a.root, 1n, 4n);
      await anchor.connect(anchorSigner).anchorBatch(idB, b.root, 5n, 8n);

      expect(await anchor.verifyProof(idA, a.leaves[0], proofFor(a.layers, 0))).to.equal(true);
      expect(await anchor.verifyProof(idB, a.leaves[0], proofFor(a.layers, 0))).to.equal(false);
    });

    it("rejects a raw entryHash passed where a pre-hashed leaf is expected", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const hashes = entryHashes(4, "prehash");
      const { layers, root } = treeFor(hashes);
      const batchId = id("batch-prehash");

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 4n);

      // The leaf pre-hash is not optional: skipping it fails closed, loudly.
      expect(await anchor.verifyProof(batchId, hashes[1], proofFor(layers, 1))).to.equal(false);
      expect(await anchor.verifyProof(batchId, leafOf(hashes[1]), proofFor(layers, 1))).to.equal(
        true
      );
    });

    it("rejects an internal node presented as a leaf (second-preimage)", async function () {
      const { anchor, anchorSigner } = await loadFixture(deployFixture);

      const hashes = entryHashes(4, "preimage");
      const { layers, root } = treeFor(hashes);
      const batchId = id("batch-second-preimage");

      await anchor.connect(anchorSigner).anchorBatch(batchId, root, 1n, 4n);

      // layers[1][0] is the parent of leaves 0 and 1. Claiming it is itself a member
      // with the shortened proof [layers[1][1]] would reconstruct the root if leaves
      // were not domain-separated by the keccak256 pre-hash.
      const internalNode = layers[1][0];
      expect(await anchor.verifyProof(batchId, internalNode, [layers[1][1]])).to.equal(true);
      // ...but no ledger entryHash can produce that value as its leaf, so the
      // verifyEntry path — the one the backend and third parties actually use — is
      // not fooled by it.
      expect(await anchor.verifyEntry(batchId, internalNode, [layers[1][1]])).to.equal(false);
    });

    it("returns false rather than reverting for an unknown batchId", async function () {
      const { anchor } = await loadFixture(deployFixture);

      const { leaves, layers } = treeFor(entryHashes(4));
      expect(await anchor.verifyProof(id("never-anchored"), leaves[0], proofFor(layers, 0))).to.equal(
        false
      );
      expect(await anchor.verifyEntry(id("never-anchored"), leaves[0], [])).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("interface", function () {
    it("supports the AccessControl (IAccessControl) interface id", async function () {
      const { anchor } = await loadFixture(deployFixture);
      // IAccessControl
      expect(await anchor.supportsInterface("0x7965db0b")).to.equal(true);
    });

    it("exposes ANCHOR_ROLE as keccak256('ANCHOR_ROLE')", async function () {
      const { anchor } = await loadFixture(deployFixture);
      expect(await anchor.ANCHOR_ROLE()).to.equal(id("ANCHOR_ROLE"));
    });
  });
});
