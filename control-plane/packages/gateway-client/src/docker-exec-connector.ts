/**
 * Phase 1/2 connector: call Gateway RPCs via `docker exec <container> openclaw gateway call`.
 *
 * Why this exists (Phase 0 finding):
 * Host WebSocket connect with shared token alone receives empty operator scopes.
 * In-container CLI calls are fully scoped and were validated across main/scout/curator.
 *
 * This is an intentional interim HostToolBridge-style path. A device-paired
 * WebSocket connector should replace hot paths later without changing the
 * GatewayConnector interface.
 */

import { spawn } from 'node:child_process';
import type { FleetGateway } from '@ocp/domain';
import { GatewayNotFoundError, getGatewayOrThrow, loadFleet } from './fleet.js';
import { GatewayCallError } from './connector.js';
import type { GatewayCallFailure, GatewayCallResult, GatewayConnector } from './connector.js';

export type DockerExecConnectorOptions = {
  fleetPath?: string;
  dockerBin?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  onCall?: (result: GatewayCallResult | GatewayCallFailure) => void;
};

/**
 * Bound on in-flight `docker exec` processes. Unlimited by default.
 *
 * Measured against this fleet, Gateway RPC throughput is pinned near 0.6
 * calls/s regardless of concurrency (serial 1.6s/call; six concurrent 10.4s
 * total), so capping cannot make a sweep finish sooner. It actively hurts when
 * another client is polling, because a wide request then queues behind that
 * client's calls instead of running alongside them. Left configurable for
 * environments where unbounded process spawn is the greater risk.
 */
const DEFAULT_MAX_CONCURRENT = Number.POSITIVE_INFINITY;

export class DockerExecConnector implements GatewayConnector {
  private readonly fleetPath?: string;
  private readonly dockerBin: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly onCall?: (result: GatewayCallResult | GatewayCallFailure) => void;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(options: DockerExecConnectorOptions = {}) {
    this.fleetPath = options.fleetPath;
    this.dockerBin = options.dockerBin ?? 'docker';
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.onCall = options.onCall;
  }

  /** Admission control: resolves once a slot is free, returns the release fn. */
  private async acquire(): Promise<() => void> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.queue.shift()?.();
    };
  }

  listGateways(): FleetGateway[] {
    return loadFleet(this.fleetPath).gateways;
  }

  getGateway(id: string): FleetGateway {
    return getGatewayOrThrow(loadFleet(this.fleetPath), id);
  }

  async call<T = unknown>(gatewayId: string, method: string, params: unknown = {}): Promise<T> {
    const gw = this.getGateway(gatewayId);
    const paramsJson = JSON.stringify(params ?? {});
    const args = [
      'exec',
      gw.container,
      'openclaw',
      'gateway',
      'call',
      method,
      '--json',
      '--timeout',
      String(Math.max(5_000, this.timeoutMs - 2_000)),
      '--params',
      paramsJson,
    ];

    const release = await this.acquire();
    let stdout: string;
    let stderr: string;
    let exitCode: number | null;
    try {
      ({ stdout, stderr, exitCode } = await runProcess(this.dockerBin, args, this.timeoutMs));
    } finally {
      release();
    }

    if (exitCode !== 0) {
      throw new GatewayCallError(gatewayId, method, exitCode, redact(stderr || stdout));
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new GatewayCallError(gatewayId, method, exitCode, 'empty response');
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch {
      throw new GatewayCallError(
        gatewayId,
        method,
        exitCode,
        `invalid JSON response: ${redact(trimmed.slice(0, 200))}`
      );
    }
  }

  async tryCall<T = unknown>(
    gatewayId: string,
    method: string,
    params: unknown = {}
  ): Promise<GatewayCallResult<T> | GatewayCallFailure> {
    const started = Date.now();
    const result = await this.runTryCall<T>(gatewayId, method, params, started);
    this.onCall?.(result);
    return result;
  }

  private async runTryCall<T>(
    gatewayId: string,
    method: string,
    params: unknown,
    started: number
  ): Promise<GatewayCallResult<T> | GatewayCallFailure> {
    try {
      const data = await this.call<T>(gatewayId, method, params);
      return {
        gatewayId,
        method,
        ok: true,
        data,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof GatewayCallError) {
        return {
          gatewayId,
          method,
          ok: false,
          error: err.message,
          exitCode: err.exitCode,
          stderr: err.stderr,
          durationMs: Date.now() - started,
        };
      }
      if (err instanceof GatewayNotFoundError) {
        return {
          gatewayId,
          method,
          ok: false,
          error: err.message,
          exitCode: null,
          stderr: err.message,
          durationMs: Date.now() - started,
        };
      }
      return {
        gatewayId,
        method,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        exitCode: null,
        stderr: '',
        durationMs: Date.now() - started,
      };
    }
  }
}

function redact(text: string): string {
  return text
    .replace(/(token|password|secret|authorization)(["'=\s:]+)([A-Za-z0-9_\-+/=]{12,})/gi, '$1$2REDACTED')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, 'REDACTED');
}

function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`docker exec timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: code });
      }
    });
  });
}
