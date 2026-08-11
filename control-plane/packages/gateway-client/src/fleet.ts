import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetGateway } from '@ocp/domain';

type FleetFile = {
  version: number;
  openclawVersionObserved?: string;
  protocolVersion?: number;
  gateways: FleetGateway[];
};

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve default fleet.json from the monorepo (scripts/bootstrap/fleet.json). */
export function defaultFleetPath(): string {
  // dist/ -> packages/gateway-client -> control-plane
  return join(here, '../../../scripts/bootstrap/fleet.json');
}

/**
 * Parsed fleet files, keyed by resolved path and invalidated on mtime change.
 *
 * Every Gateway RPC resolves its container through loadFleet, so without this
 * a fleet-wide status sweep re-reads and re-parses the same file ~20 times.
 */
const fleetCache = new Map<string, { mtimeMs: number; size: number; parsed: FleetFile }>();

export function loadFleet(path?: string): FleetFile {
  const fleetPath = path && path.length > 0 ? path : defaultFleetPath();
  const resolved = isAbsolute(fleetPath) ? fleetPath : join(process.cwd(), fleetPath);

  const stat = statSync(resolved);
  const cached = fleetCache.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.parsed;
  }

  const raw = readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as FleetFile;
  if (!parsed.gateways || !Array.isArray(parsed.gateways)) {
    throw new Error(`Invalid fleet file at ${resolved}: missing gateways[]`);
  }
  fleetCache.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed;
}

export function getGatewayOrThrow(fleet: FleetFile, id: string): FleetGateway {
  const gw = fleet.gateways.find((g) => g.id === id);
  if (!gw) {
    throw new GatewayNotFoundError(id);
  }
  return gw;
}

export class GatewayNotFoundError extends Error {
  readonly code = 'gateway_not_found';
  constructor(public readonly gatewayId: string) {
    super(`Unknown gateway: ${gatewayId}`);
    this.name = 'GatewayNotFoundError';
  }
}
