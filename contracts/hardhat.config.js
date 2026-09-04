/**
 * LEXX 2.0 — Hardhat configuration
 *
 * TARGET CHAIN: Monad Testnet (chain id 10143).
 *
 * Monad Testnet is the target network for anchoring digital evidence roots.
 *
 * This file is CommonJS on purpose: Hardhat 2.x loads its config synchronously and
 * is happiest with CJS. `contracts/` is an isolated npm package with its own
 * node_modules, so this does not conflict with the ESM root package.
 */

require("@nomicfoundation/hardhat-toolbox");

// Read the repo-root .env (where the backend's ANCHOR_* variables live), then any
// contracts-local .env as an override. Both are optional; dotenv never throws on a
// missing file, so `npx hardhat compile` and `npx hardhat test` work on a clean
// checkout with no environment at all.
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
require("dotenv").config();

/** Canonical Monad Testnet parameters. Keep in sync with .env.example. */
const MONAD_TESTNET_CHAIN_ID = 10143;
const MONAD_TESTNET_RPC_URL = "https://testnet-rpc.monad.xyz";
const MONAD_TESTNET_EXPLORER = "https://testnet.monadexplorer.com";
const MONAD_TESTNET_API_URL = "https://testnet.monadexplorer.com/api";

// NEVER a hardcoded private key. The signer comes from the environment, or the
// network simply has no accounts configured (read-only). An absent OR malformed key
// must not throw: `compile` and `test` have to work on a machine with no deploy
// credentials, and Hardhat rejects the whole config — not just the deploy — if it is
// handed something that does not parse as a private key.
function readAnchorAccounts() {
  const raw = (process.env.ANCHOR_PRIVATE_KEY || "").trim();
  if (raw.length === 0) return [];

  const normalised = raw.startsWith("0x") || raw.startsWith("0X") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    console.warn(
      "[hardhat.config] ANCHOR_PRIVATE_KEY is set but is not 32 hex bytes; ignoring it. " +
        "Deploys to monadTestnet will fail with 'no signer configured' until it is fixed."
    );
    return [];
  }
  return [normalised];
}

const accounts = readAnchorAccounts();

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        // Anchoring is a write-heavy, small-bytecode workload: the same function is
        // called every 5 minutes forever, so optimise for runtime gas over deploy size.
        runs: 1000,
      },
      evmVersion: "paris",
    },
  },

  networks: {
    // In-process chain used by `npm test`. Nothing here touches a public network.
    hardhat: {
      chainId: 31337,
    },
    monadTestnet: {
      url: process.env.ANCHOR_RPC_URL || MONAD_TESTNET_RPC_URL,
      chainId: MONAD_TESTNET_CHAIN_ID,
      accounts,
    },
  },

  etherscan: {
    apiKey: {
      monadTestnet: (process.env.MONAD_EXPLORER_API_KEY || "").trim(),
    },
    customChains: [
      {
        network: "monadTestnet",
        chainId: MONAD_TESTNET_CHAIN_ID,
        urls: {
          apiURL: MONAD_TESTNET_API_URL,
          browserURL: MONAD_TESTNET_EXPLORER,
        },
      },
    ],
  },

  sourcify: {
    enabled: false,
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },

  mocha: {
    timeout: 60000,
  },
};
