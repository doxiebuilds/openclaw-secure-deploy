/**
 * The contract every Gateway transport implements.
 *
 * Two exist: PersistentGatewayConnector (device-paired WebSocket, the hot path)
 * and DockerExecConnector (per-call `docker exec`, kept as an escape hatch for
 * when a gateway's pairing is being re-established). Services depend on this
 * interface so switching transports is a config change, not a refactor.
 */

import type { FleetGateway } from '@ocp/domain';

export type GatewayCallResult<T = unknown> = {
  gatewayId: string;
  method: string;
  ok: true;
  data: T;
  durationMs: number;
};

export type GatewayCallFailure = {
  gatewayId: string;
  method: string;
  ok: false;
  error: string;
  /** Process exit code for the docker-exec transport; always null over WS. */
  exitCode: number | null;
  stderr: string;
  durationMs: number;
};

export class GatewayCallError extends Error {
  readonly code = 'gateway_call_failed';
  constructor(
    public readonly gatewayId: string,
    public readonly method: string,
    public readonly exitCode: number | null,
    public readonly stderr: string
  ) {
    super(`Gateway call failed (${gatewayId} ${method}): ${stderr || `exit ${exitCode}`}`);
    this.name = 'GatewayCallError';
  }
}

export interface GatewayConnector {
  listGateways(): FleetGateway[];
  getGateway(id: string): FleetGateway;
  /** Throws GatewayCallError on failure. */
  call<T = unknown>(gatewayId: string, method: string, params?: unknown): Promise<T>;
  /** Never throws for gateway-side failures; returns them as data. */
  tryCall<T = unknown>(
    gatewayId: string,
    method: string,
    params?: unknown
  ): Promise<GatewayCallResult<T> | GatewayCallFailure>;
}
