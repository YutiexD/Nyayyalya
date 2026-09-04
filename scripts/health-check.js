#!/usr/bin/env node
/**
 * Check every service the system depends on, and say plainly which one is down.
 *
 * Written for the five minutes before a demo, when "it doesn't work" needs to become
 * "the court directory isn't running" as fast as possible.
 *
 *   npm run health
 */
import mongoose from 'mongoose';

const { default: env } = await import('../backend/config/env.js');

const OK = 'OK  ';
const BAD = 'DOWN';

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

async function checkHttp(name, url, expectJson = true) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    const ms = Date.now() - started;
    if (!res.ok) return record(name, false, `HTTP ${res.status} (${ms}ms)`);

    if (expectJson) {
      const body = await res.json();
      return record(name, true, `${ms}ms · ${body.status ?? 'ok'}`);
    }
    return record(name, true, `${ms}ms`);
  } catch (err) {
    return record(name, false, err.name === 'AbortError' ? 'timeout after 3s' : err.message);
  }
}

async function checkMongo() {
  try {
    // Use the app's own configured timeout, not a separate hardcoded one. A local
    // mongod answers in milliseconds, but a fresh mongodb+srv Atlas connection does a
    // DNS SRV lookup plus a TLS handshake before it can answer at all — routinely
    // longer than a tight 3s budget on the very first connection from a new process.
    // A false DOWN here is worse than a slow OK: this tool exists to be trusted in
    // the five minutes before a demo.
    await mongoose.connect(env.MONGO_URI, {
      dbName: env.MONGO_DB_CORE,
      serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_MS,
    });
    const admin = mongoose.connection.db.admin();
    const info = await admin.serverStatus().catch(() => null);
    record('MongoDB', true, `${env.MONGO_URI} · ${info?.version ? `v${info.version}` : 'connected'}`);
    await mongoose.disconnect();
  } catch (err) {
    record('MongoDB', false, `${env.MONGO_URI} — ${err.message.split('\n')[0]}`);
  }
}

async function checkChain() {
  if (!env.ANCHOR_ENABLED) {
    return record('Monad Testnet', true, 'anchoring disabled (ANCHOR_ENABLED=false)');
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(env.ANCHOR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = await res.json();
    const chainId = parseInt(body.result, 16);

    if (chainId !== env.ANCHOR_CHAIN_ID) {
      // Pointing at the wrong chain is worse than being offline: it looks like it works.
      return record(
        'Monad Testnet',
        false,
        `WRONG CHAIN — RPC reports ${chainId}, expected ${env.ANCHOR_CHAIN_ID}`
      );
    }
    record('Monad Testnet', true, `chainId ${chainId} · ${env.ANCHOR_RPC_URL}`);
  } catch (err) {
    record('Monad Testnet', false, err.name === 'AbortError' ? 'RPC timeout' : err.message);
  }
}

console.log('\nLEXX health check\n' + '-'.repeat(64));

await checkMongo();
await checkHttp('Police directory', `${env.DIRECTORY_POLICE_URL}/healthz`);
await checkHttp('Court directory', `${env.DIRECTORY_COURT_URL}/healthz`);
await checkHttp('Legal/FSL directory', `${env.DIRECTORY_LEGAL_URL}/healthz`);
await checkHttp('Core API', `${env.PUBLIC_BASE_URL}/healthz`);
await checkChain();

for (const r of results) {
  console.log(`  [${r.ok ? OK : BAD}] ${r.name.padEnd(20)} ${r.detail}`);
}

const down = results.filter((r) => !r.ok);
console.log('-'.repeat(64));

if (down.length === 0) {
  console.log(`All ${results.length} checks passed. Network: ${env.ANCHOR_NETWORK} (${env.ANCHOR_CHAIN_ID})\n`);
  process.exit(0);
}

console.log(`${down.length} of ${results.length} checks FAILED:\n`);
for (const r of down) console.log(`  - ${r.name}: ${r.detail}`);
console.log('\nStart everything with:  npm run mongo:dev   (one terminal)');
console.log('                        npm run dev         (another)\n');
process.exit(1);
