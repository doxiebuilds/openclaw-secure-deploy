/**
 * Measure the persistent connector against the docker-exec path it replaces.
 *
 * Run after pairing:
 *   npx tsx scripts/verify-latency.ts
 *   npx tsx scripts/verify-latency.ts --skip-baseline   (faster; no docker exec)
 *
 * Reports per-call latency for both transports on the same methods, so the
 * comparison is like for like. Never prints tokens or key material.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { PersistentGatewayConnector } from '../packages/gateway-client/src/persistent-connector.js';
import { loadFleet } from '../packages/gateway-client/src/fleet.js';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const controlPlaneRoot = join(here, '..');

const SKIP_BASELINE = process.argv.includes('--skip-baseline');
const ROUNDS = 5;
const METHOD = 'sessions.list';

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / sorted.length),
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

function fmt(label: string, s: ReturnType<typeof stats>) {
  console.log(
    `  ${label.padEnd(28)} median ${String(s.median).padStart(6)}ms   ` +
      `mean ${String(s.mean).padStart(6)}ms   min ${s.min}ms   max ${s.max}ms`
  );
}

async function main() {
  const fleet = loadFleet(undefined).gateways;
  console.log(`fleet: ${fleet.map((g) => g.id).join(', ')}\n`);

  const connector = new PersistentGatewayConnector({
    identityPath: join(controlPlaneRoot, 'data', 'device-identity.json'),
    logger: () => {},
  });

  console.log('opening persistent links…');
  const connectStart = Date.now();
  await connector.start();
  console.log(`links opened in ${Date.now() - connectStart}ms\n`);

  const statuses = connector.linkStatuses();
  for (const s of statuses) {
    console.log(`  ${s.gatewayId.padEnd(10)} ${s.state}${s.lastError ? ` — ${s.lastError}` : ''}`);
  }

  const unpaired = statuses.filter((s) => s.state === 'unpaired');
  if (unpaired.length > 0) {
    console.log(
      `\nUnpaired: ${unpaired.map((s) => s.gatewayId).join(', ')}\n` +
        `Run:  node scripts/bootstrap/pair-control-plane.mjs\n`
    );
    connector.close();
    process.exit(1);
  }

  const ready = statuses.filter((s) => s.state === 'ready');
  if (ready.length === 0) {
    console.log('\nNo gateway links are ready; nothing to measure.');
    connector.close();
    process.exit(1);
  }

  console.log('');
  for (const s of ready) {
    const gatewayId = s.gatewayId;
    console.log(`${gatewayId}:`);

    // Warm: the first call on a fresh link is not what the UI experiences.
    await connector.tryCall(gatewayId, METHOD);

    const persistentSamples: number[] = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const t = Date.now();
      await connector.tryCall(gatewayId, METHOD);
      persistentSamples.push(Date.now() - t);
    }
    fmt('persistent WS', stats(persistentSamples));

    // The old fleet sweep issued six RPCs per gateway at once; over docker exec
    // that contended badly, so measure the same shape here.
    const parallelStart = Date.now();
    await Promise.all(
      ['health', 'status', 'agents.list', 'sessions.list', 'cron.list', 'exec.approval.list'].map(
        (m) => connector.tryCall(gatewayId, m)
      )
    );
    console.log(`  ${'6 parallel (sweep shape)'.padEnd(28)} ${Date.now() - parallelStart}ms total`);

    if (!SKIP_BASELINE) {
      const gw = fleet.find((g) => g.id === gatewayId)!;
      const dockerSamples: number[] = [];
      for (let i = 0; i < ROUNDS; i += 1) {
        const t = Date.now();
        try {
          await execFileAsync('docker', [
            'exec',
            gw.container,
            'openclaw',
            'gateway',
            'call',
            METHOD,
            '--json',
            '--params',
            '{}',
          ]);
        } catch {
          /* a failed baseline call still measures the transport cost */
        }
        dockerSamples.push(Date.now() - t);
      }
      fmt('docker exec (old path)', stats(dockerSamples));

      const speedup = stats(dockerSamples).median / Math.max(1, stats(persistentSamples).median);
      console.log(`  → ${speedup.toFixed(1)}x faster per call\n`);
    } else {
      console.log('');
    }
  }

  connector.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
