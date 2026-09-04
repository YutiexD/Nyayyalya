#!/usr/bin/env node
/**
 * Guard against stale blockchain-network configuration (ADR-002).
 *
 * The target chain is **Monad Testnet** (chain id 10143). The system has already
 * migrated once — from Ethereum Sepolia to Arbitrum Sepolia to Monad Testnet — and
 * each migration left a class of bug behind: a config value, a hardcoded chain id, or
 * an RPC/explorer URL from the *previous* network, silently pointing the anchor
 * service somewhere wrong while everything else looks fine.
 *
 * This checker inspects configuration VALUES, not prose. Matching comments would
 * flood the output with the very documentation that records the decision (including
 * this file's own header), and a check nobody can read is a check nobody runs.
 *
 *   node scripts/check-network-references.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', 'dist', 'artifacts', 'cache', '.data', 'vault', 'deployments',
]);

/** Config and code only. Markdown is documentation and is not scanned for prose. */
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.sol', '.html', '.yml', '.yaml']);

/** This file is full of the patterns it searches for. */
const SELF = path.resolve(fileURLToPath(import.meta.url));

/** Every chain id this system has ever targeted, except the current one. */
const WRONG_CHAIN_IDS = [
  11155111, // Ethereum Sepolia
  421614, // Arbitrum Sepolia
];
const CORRECT_CHAIN_ID = 10143; // Monad Testnet

/** Network name fragments from earlier migrations. Bare or as a value, never wanted. */
const STALE_NETWORK_WORDS = ['sepolia', 'arbitrum'];

/**
 * A stale network word used as a value or key: quoted, or after `=`/`:`.
 */
function bareValuePatterns() {
  const alt = STALE_NETWORK_WORDS.join('|');
  return [
    new RegExp(`["'\`]\\s*(?:${alt})[\\w-]*\\s*["'\`]`, 'i'),
    new RegExp(`\\b(network|chain|chainName|networkName|defaultNetwork)\\s*[:=]\\s*["'\`]?(?:${alt})`, 'i'),
    new RegExp(`\\bANCHOR_NETWORK\\s*=\\s*(?:${alt})`, 'i'),
    new RegExp(`https?://[^\\s"'\`]*\\b(?:${alt})[^\\s"'\`]*`, 'i'),
  ];
}
const BARE_VALUE_PATTERNS = bareValuePatterns();

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name)) || entry.name === '.env.example') {
      yield full;
    }
  }
}

const findings = [];

for (const file of walk(ROOT)) {
  if (path.resolve(file) === SELF) continue;
  const rel = path.relative(ROOT, file);

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  content.split(/\r?\n/).forEach((line, i) => {
    // A wrong chain id, anywhere — unless the line exists precisely to reject it
    // (a deploy guard that refuses to run on a stale chain must name the number it
    // is refusing).
    for (const wrongId of WRONG_CHAIN_IDS) {
      if (!line.includes(String(wrongId))) continue;
      const isExplicitRejection =
        /supersed|is\s+not\s+the\s+target|refus|expected\s+10143/i.test(line) ||
        // A test asserting the wrong chain id is NEVER used is a guard, not a defect.
        /\.not\.toBe\(|notToBe|!==\s*\d{5,}|toBeUndefined/.test(line);
      if (!isExplicitRejection) {
        findings.push({
          file: rel,
          line: i + 1,
          text: line.trim().slice(0, 140),
          why: `stale chain id ${wrongId}`,
        });
      }
      return;
    }

    if (!STALE_NETWORK_WORDS.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(line))) return;

    // Skip comment-only lines: prose about the migration history is not configuration.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('#')) return;

    for (const re of BARE_VALUE_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      findings.push({
        file: rel,
        line: i + 1,
        text: trimmed.slice(0, 140),
        why: 'stale network name in a configuration value',
      });
      return;
    }
  });
}

if (findings.length === 0) {
  console.log(
    `[network-check] OK — no stale network configuration. Target: Monad Testnet (chain id ${CORRECT_CHAIN_ID}).`
  );
  process.exit(0);
}

console.error(`\n[network-check] ${findings.length} stale network reference(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  — ${f.why}\n    ${f.text}`);
}
console.error(`\nThe target chain is Monad Testnet (chain id ${CORRECT_CHAIN_ID}). See ADR-002.\n`);
process.exit(1);
