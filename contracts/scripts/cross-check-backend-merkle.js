/**
 * Cross-check: does the BACKEND's Merkle implementation agree with the CONTRACT?
 *
 * This is the one integration that fails silently. If `backend/services/merkle.js`
 * and `LexxAnchor.sol` disagree about leaf pre-hashing, pair ordering or odd-node
 * promotion, nothing throws — anchoring "succeeds", verification just always returns
 * false, and it looks like a chain problem rather than a convention mismatch.
 *
 * So we build the tree with the REAL backend module, anchor the REAL root on a real
 * deployed contract, and ask the contract to verify proofs the backend generated.
 *
 *   npx hardhat run scripts/cross-check-backend-merkle.js
 */
const hre = require('hardhat');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  // The backend is ESM; this Hardhat package is CJS.
  const merklePath = path.resolve(__dirname, '../../backend/services/merkle.js');
  const backend = await import(pathToFileURL(merklePath).href);

  const [deployer, anchor] = await hre.ethers.getSigners();
  const Lexx = await hre.ethers.getContractFactory('LexxAnchor');
  const contract = await Lexx.deploy(deployer.address, anchor.address);
  await contract.waitForDeployment();

  // Ledger entry hashes are sha256 hex, exactly as services/ledger.js produces them.
  const ledgerHash = (n) => crypto.createHash('sha256').update(`entry-${n}`).digest('hex');

  let failures = 0;
  const check = (label, ok) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failures += 1;
  };

  for (const size of [1, 2, 3, 4, 5, 8, 9, 17, 33]) {
    const entries = Array.from({ length: size }, (_, i) => ledgerHash(i));

    // --- built entirely by the BACKEND ---
    const root = backend.merkleRoot(entries);

    const batchId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`batch-${size}`));
    await (await contract.connect(anchor).anchorBatch(batchId, root, 1, size)).wait();

    // 1. The contract's own leaf derivation must match the backend's.
    const contractLeaf = await contract.leafOf(`0x${entries[0]}`);
    check(`size=${size}: leafOf agrees`, contractLeaf === backend.leafOf(entries[0]));

    // 2. Every backend-generated proof must verify ON CHAIN.
    let allVerified = true;
    for (let i = 0; i < size; i += 1) {
      const proof = backend.merkleProof(entries, i);
      const onChain = await contract.verifyEntry(batchId, `0x${entries[i]}`, proof);
      const offChain = backend.verifyProof(entries[i], proof, root);
      if (!onChain || !offChain) allVerified = false;
    }
    check(`size=${size}: all ${size} proofs verify on-chain and off-chain`, allVerified);

    // 3. A forged entry must be rejected by the contract.
    const forgedProof = backend.merkleProof(entries, 0);
    const forgedAccepted = await contract.verifyEntry(
      batchId,
      `0x${ledgerHash('forged')}`,
      forgedProof
    );
    check(`size=${size}: forged entry rejected on-chain`, forgedAccepted === false);
  }

  console.log(
    failures === 0
      ? '\nBackend Merkle implementation agrees with LexxAnchor.sol.\n'
      : `\n${failures} CHECK(S) FAILED — backend and contract disagree.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
