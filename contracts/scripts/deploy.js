/**
 * LEXX 2.0 — deploy LexxAnchor to Monad Testnet.
 *
 *   npm run deploy:monadTestnet          (from contracts/)
 *   npm run contracts:deploy             (from the repo root)
 *
 * Requires in the repo-root .env:
 *   ANCHOR_RPC_URL      — defaults to https://testnet-rpc.monad.xyz
 *   ANCHOR_PRIVATE_KEY  — a funded THROWAWAY Monad Testnet key. Never a mainnet key.
 *
 * Optional:
 *   ANCHOR_ADMIN_ADDRESS   — receives DEFAULT_ADMIN_ROLE (default: the deployer)
 *   ANCHOR_SIGNER_ADDRESS  — receives ANCHOR_ROLE        (default: the deployer)
 *
 * This script refuses to run against any chain other than Monad Testnet. A
 * mis-targeted deploy is a real hazard: the backend, the frontend explorer links and
 * every anchor record would point at a contract on a chain nobody reads, and the
 * failure is silent until someone tries to verify an entry in front of a judge.
 */

const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

/** Monad Testnet — the target chain for anchoring. */
const EXPECTED_CHAIN_ID = 10143;
const NETWORK_NAME = "monad-testnet";
const EXPLORER_BASE = "https://testnet.monadexplorer.com";

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");
const DEPLOYMENT_FILE = path.join(DEPLOYMENTS_DIR, `${NETWORK_NAME}.json`);

function isAddress(value) {
  return typeof value === "string" && hre.ethers.isAddress(value);
}

async function main() {
  const { ethers } = hre;

  // ---------------------------------------------------------- chain guard ----
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);

  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: connected chain id is ${chainId}, expected ${EXPECTED_CHAIN_ID} ` +
        `(Monad Testnet). Hardhat network "${hre.network.name}" resolved to the wrong chain. ` +
        `Run with --network monadTestnet and check ANCHOR_RPC_URL in your .env — it must be ` +
        `a Monad Testnet endpoint (default https://testnet-rpc.monad.xyz).`
    );
  }

  // -------------------------------------------------------------- signer ----
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "No signer configured. Set ANCHOR_PRIVATE_KEY in the repo-root .env to a funded " +
        "throwaway Monad Testnet key, then re-run."
    );
  }

  const deployer = signers[0];
  const balance = await ethers.provider.getBalance(deployer.address);

  if (balance === 0n) {
    throw new Error(
      `Deployer ${deployer.address} has zero balance on Monad Testnet. ` +
        "Fund it from a Monad Testnet faucet and re-run."
    );
  }

  // ------------------------------------------------------ role recipients ----
  const adminAddress = (process.env.ANCHOR_ADMIN_ADDRESS || "").trim() || deployer.address;
  const anchorAddress = (process.env.ANCHOR_SIGNER_ADDRESS || "").trim() || deployer.address;

  if (!isAddress(adminAddress)) {
    throw new Error(`ANCHOR_ADMIN_ADDRESS is not a valid address: "${adminAddress}"`);
  }
  if (!isAddress(anchorAddress)) {
    throw new Error(`ANCHOR_SIGNER_ADDRESS is not a valid address: "${anchorAddress}"`);
  }

  console.log("");
  console.log("LEXX 2.0 — deploying LexxAnchor");
  console.log("-------------------------------------------------------------");
  console.log(`  network        : ${NETWORK_NAME} (Monad Testnet)`);
  console.log(`  chain id       : ${chainId}`);
  console.log(`  rpc            : ${hre.network.config.url}`);
  console.log(`  deployer       : ${deployer.address}`);
  console.log(`  balance        : ${ethers.formatEther(balance)} MON`);
  console.log(`  admin role to  : ${adminAddress}`);
  console.log(`  anchor role to : ${anchorAddress}`);
  console.log("-------------------------------------------------------------");

  // -------------------------------------------------------------- deploy ----
  const factory = await ethers.getContractFactory("LexxAnchor");
  const contract = await factory.deploy(adminAddress, anchorAddress);

  const deployTx = contract.deploymentTransaction();
  console.log(`  submitted tx   : ${deployTx.hash}`);
  console.log("  waiting for confirmation...");

  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const receipt = await deployTx.wait();

  // ------------------------------------------------------------- persist ----
  const record = {
    network: NETWORK_NAME,
    chainId,
    address,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    txHash: deployTx.hash,
    blockNumber: receipt.blockNumber,
  };

  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  fs.writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  // -------------------------------------------------------------- report ----
  console.log("");
  console.log("Deployed.");
  console.log("-------------------------------------------------------------");
  console.log(`  contract       : ${address}`);
  console.log(`  chain id       : ${chainId} (Monad Testnet)`);
  console.log(`  block          : ${receipt.blockNumber}`);
  console.log(`  tx             : ${deployTx.hash}`);
  console.log(`  explorer       : ${EXPLORER_BASE}/address/${address}`);
  console.log(`  tx explorer    : ${EXPLORER_BASE}/tx/${deployTx.hash}`);
  console.log(`  written to     : ${DEPLOYMENT_FILE}`);
  console.log("-------------------------------------------------------------");
  console.log("");
  console.log("NEXT STEP — set this in the repo-root .env, or anchoring stays dark:");
  console.log("");
  console.log(`  ANCHOR_CONTRACT_ADDRESS=${address}`);
  console.log("  ANCHOR_ENABLED=true");
  console.log("");
  console.log("Then verify the source on Monad Explorer (optional):");
  console.log("");
  console.log(
    `  npx hardhat verify --network monadTestnet ${address} ${adminAddress} ${anchorAddress}`
  );
  console.log("");
  console.log(
    "Reminder: only Merkle roots and batch metadata are ever submitted to this contract."
  );
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("");
    console.error("Deployment failed.");
    console.error(error.message || error);
    console.error("");
    process.exit(1);
  });
